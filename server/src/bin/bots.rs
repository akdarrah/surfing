// Load-bot: N fake racers riding the level's ideal line at surf speeds, finishing and restarting forever.
// Usage: cargo run --release --bin bots -- <count> [ws://localhost:8080/ws] [seconds] [levels/meridian.json]
// The server must allow many connections from one IP: MAX_CONN_PER_IP=100000.
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Default)]
struct Stats {
    connected: AtomicU64,
    bytes_in: AtomicU64,
    msgs_in: AtomicU64,
    sent: AtomicU64,
    finishes: AtomicU64,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(100);
    let url = args.get(2).cloned().unwrap_or_else(|| "ws://localhost:8080/ws".into());
    let secs: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let level = args.get(4).cloned().unwrap_or_else(|| "levels/meridian.json".into());
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&level).expect("level json")).unwrap();
    let line: Arc<Vec<[f32; 3]>> = Arc::new(
        json["line"].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap() as f32, p[1].as_f64().unwrap() as f32, p[2].as_f64().unwrap() as f32 - 60.0]).collect(),
    );
    let stats = Arc::new(Stats::default());

    for i in 0..n {
        let (url, stats, line) = (url.clone(), stats.clone(), line.clone());
        tokio::spawn(async move { bot(i, &url, &stats, &line).await });
        if i % 50 == 49 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    let start = Instant::now();
    let mut last = (0u64, 0u64);
    while start.elapsed().as_secs() < secs {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let (b, m) = (stats.bytes_in.load(Relaxed), stats.msgs_in.load(Relaxed));
        let c = stats.connected.load(Relaxed).max(1);
        println!(
            "t={:>3}s connected={} in: {:.1} KB/s per bot, {:.0} msgs/s per bot | total {:.1} MB/s out of server | sent {} | finishes {}",
            start.elapsed().as_secs(),
            c,
            (b - last.0) as f64 / 5.0 / c as f64 / 1024.0,
            (m - last.1) as f64 / 5.0 / c as f64,
            (b - last.0) as f64 / 5.0 / 1048576.0,
            stats.sent.load(Relaxed),
            stats.finishes.load(Relaxed),
        );
        last = (b, m);
    }
}

fn state(pos: [f32; 3], yaw: u16, flags: u8) -> Vec<u8> {
    let mut b = vec![1u8];
    for v in pos {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&yaw.to_le_bytes());
    b.extend_from_slice(&0i16.to_le_bytes());
    b.push(flags);
    b
}

async fn bot(i: usize, url: &str, stats: &Stats, line: &[[f32; 3]]) {
    let Ok((ws, _)) = connect_async(url).await else {
        eprintln!("bot {i}: connect failed");
        return;
    };
    stats.connected.fetch_add(1, Relaxed);
    let (mut tx, mut rx) = ws.split();
    let _ = tx.send(Message::text(format!(r#"{{"t":"hello","name":"Bot {i}","sponsor":"Bot Co"}}"#))).await;

    let reader = async {
        while let Some(Ok(m)) = rx.next().await {
            stats.bytes_in.fetch_add(m.len() as u64, Relaxed);
            stats.msgs_in.fetch_add(1, Relaxed);
            if let Message::Text(t) = &m {
                if t.contains("\"t\":\"finish\"") {
                    stats.finishes.fetch_add(1, Relaxed);
                }
            }
        }
    };
    let writer = async {
        // Ride the line at 1200-2200 u/s, starting at a random point so the field is spread along the course.
        let speed = 1200.0 + (i % 11) as f32 * 100.0;
        let mut seg = i * 7 % (line.len() - 1);
        let mut t = (i as f32 * 0.37) % 1.0;
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        loop {
            tick.tick().await;
            let (a, b) = (line[seg], line[seg + 1]);
            let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt().max(1.0);
            t += speed * 0.05 / len;
            let mut flags = 0;
            while t >= 1.0 {
                t -= 1.0;
                seg += 1;
                if seg >= line.len() - 1 {
                    seg = 0;
                    flags = 2; // teleported back to the start
                }
            }
            let (a, b) = (line[seg], line[seg + 1]);
            let pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + 2.0];
            let yaw = ((b[1] - a[1]).atan2(b[0] - a[0]) / std::f32::consts::TAU * 65535.0) as i32 as u16;
            if tx.send(Message::binary(state(pos, yaw, flags))).await.is_err() {
                return;
            }
            stats.sent.fetch_add(1, Relaxed);
        }
    };
    tokio::select! { _ = reader => {}, _ = writer => {} }
    stats.connected.fetch_sub(1, Relaxed);
}
