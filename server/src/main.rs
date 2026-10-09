mod filter;
mod game;
mod level;
mod proto;

use axum::{
    Router,
    extract::{ConnectInfo, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::IntoResponse,
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
    admin_token: Option<String>,
}

fn env(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let level = level::Level::load(&env("LEVEL", "levels/cloud-harbor.json"));
    let data_dir = Some(env("DATA_DIR", "data").into());
    let max_per_ip = env("MAX_CONN_PER_IP", "8").parse().unwrap_or(8);
    let (tx, rx) = mpsc::channel(65536);
    tokio::spawn(game::Game::new(level, data_dir, max_per_ip).run(rx));

    let app = App { tx, admin_token: std::env::var("ADMIN_TOKEN").ok().filter(|t| t.len() >= 16) };
    let frame_ancestors = env("FRAME_ANCESTORS", "'self' https://akdarrah.com https://www.akdarrah.com");
    let router = Router::new()
        .route("/ws", get(ws))
        .route("/up", get(|| async { "ok" }))
        .route("/admin/clear-promo", post(clear_promo))
        .route("/admin/ban", post(ban))
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
    ws.max_message_size(4096).on_upgrade(move |socket| conn(socket, ip, app))
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
        // Token bucket: ~60 msgs/s sustained (20 Hz state + shots + chat-ish JSON), bursts to 120.
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
    matches!((&app.admin_token, given), (Some(t), Some(g)) if t.as_bytes().len() == g.len() && t.bytes().zip(g.bytes()).fold(0, |a, (x, y)| a | (x ^ y)) == 0)
}

async fn clear_promo(State(app): State<App>, headers: HeaderMap) -> StatusCode {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let _ = app.tx.send(Inbound::Admin(Admin::ClearPromo)).await;
    StatusCode::NO_CONTENT
}

async fn ban(State(app): State<App>, headers: HeaderMap, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>) -> StatusCode {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let Some(ip) = q.get("ip").filter(|ip| !ip.is_empty()) else { return StatusCode::BAD_REQUEST };
    let _ = app.tx.send(Inbound::Admin(Admin::Ban(ip.clone()))).await;
    StatusCode::NO_CONTENT
}
