mod filter;
mod game;
mod images;
mod level;
mod proto;

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use game::{Admin, Inbound};
use std::{collections::HashMap, net::SocketAddr};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

#[derive(Clone)]
struct App {
    tx: mpsc::Sender<Inbound>,
    images: images::Store,
    admin_token: Option<String>,
}

fn env(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let level = level::Level::load(&env("LEVEL", "levels/meridian.json"));
    let data_dir: std::path::PathBuf = env("DATA_DIR", "data").into();
    let max_per_ip = env("MAX_CONN_PER_IP", "8").parse().unwrap_or(8);
    let images = images::Store::new(Some(data_dir.join("img")));
    let (tx, rx) = mpsc::channel(65536);
    tokio::spawn(game::Game::new(level, Some(data_dir), max_per_ip, images.clone()).run(rx));

    let app = App { tx, images, admin_token: std::env::var("ADMIN_TOKEN").ok().filter(|t| t.len() >= 16) };
    let frame_ancestors = env("FRAME_ANCESTORS", "'self' https://akdarrah.com https://www.akdarrah.com");
    let router = Router::new()
        .route("/ws", get(ws))
        .route("/up", get(|| async { "ok" }))
        .route("/admin/ban", post(ban))
        .route("/admin/clear-images", post(clear_images))
        .route("/admin/billboards", get(list_billboards))
        .route("/admin/billboards/{slot}/remove", post(remove_billboard))
        .route("/img/{hash}", get(image))
        .fallback_service(ServeDir::new(env("STATIC_DIR", "client/dist")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&format!("frame-ancestors {frame_ancestors}")).unwrap(),
        ))
        .with_state(app);

    let addr = format!("0.0.0.0:{}", env("PORT", "8080"));
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("sky surf listening on {addr}");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}

// kamal-proxy terminates TLS and forwards the real client IP.
fn client_ip(headers: &HeaderMap, addr: SocketAddr) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| addr.ip().to_string())
}

async fn ws(ws: WebSocketUpgrade, headers: HeaderMap, ConnectInfo(addr): ConnectInfo<SocketAddr>, State(app): State<App>) -> impl IntoResponse {
    let ip = client_ip(&headers, addr);
    ws.max_message_size(images::MAX_BYTES + 1024).on_upgrade(move |socket| conn(socket, ip, app))
}

async fn conn(socket: WebSocket, ip: String, app: App) {
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let (reply_tx, reply_rx) = oneshot::channel();
    if app.tx.send(Inbound::Join { ip, out: out_tx, reply: reply_tx }).await.is_err() {
        return;
    }
    let Ok(Some((id, serial))) = reply_rx.await else { return };
    let (mut sink, mut stream) = socket.split();

    let writer = async {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    };
    let reader = async {
        // Token bucket: ~60 msgs/s sustained (20 Hz state + JSON), bursts to 120.
        let (mut tokens, mut last) = (120.0f32, Instant::now());
        while let Some(Ok(m)) = stream.next().await {
            let now = Instant::now();
            tokens = (tokens + now.duration_since(last).as_secs_f32() * 60.0).min(120.0);
            last = now;
            if tokens < 1.0 {
                continue;
            }
            tokens -= 1.0;
            let msg = match m {
                Message::Binary(b) => Inbound::Bin(id, serial, b),
                Message::Text(t) => Inbound::Text(id, serial, t),
                Message::Close(_) => break,
                _ => continue,
            };
            if app.tx.try_send(msg).is_err() {
                continue; // game loop is saturated: shed load instead of queueing
            }
        }
    };
    tokio::select! {
        _ = writer => {},
        _ = reader => {},
    }
    let _ = app.tx.send(Inbound::Leave(id, serial)).await;
}

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let given = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    matches!((&app.admin_token, given), (Some(t), Some(g)) if t.len() == g.len() && t.bytes().zip(g.bytes()).fold(0, |a, (x, y)| a | (x ^ y)) == 0)
}

async fn image(State(app): State<App>, Path(hash): Path<String>) -> Response {
    match app.images.get(&hash) {
        Some((bytes, mime)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn ban(State(app): State<App>, headers: HeaderMap, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>) -> StatusCode {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(ip) = q.get("ip").filter(|ip| !ip.is_empty()) else { return StatusCode::BAD_REQUEST };
    let _ = app.tx.send(Inbound::Admin(Admin::Ban(ip.clone()))).await;
    StatusCode::NO_CONTENT
}

async fn clear_images(State(app): State<App>, headers: HeaderMap) -> StatusCode {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let _ = app.tx.send(Inbound::Admin(Admin::ClearImages)).await;
    StatusCode::NO_CONTENT
}

async fn list_billboards(State(app): State<App>, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let (tx, rx) = oneshot::channel();
    let _ = app.tx.send(Inbound::Admin(Admin::ListBillboards(tx))).await;
    rx.await.map(Json).map_or_else(|_| StatusCode::SERVICE_UNAVAILABLE.into_response(), IntoResponse::into_response)
}

async fn remove_billboard(State(app): State<App>, headers: HeaderMap, Path(slot): Path<u32>) -> StatusCode {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let _ = app.tx.send(Inbound::Admin(Admin::RemoveBillboard(slot))).await;
    StatusCode::NO_CONTENT
}
