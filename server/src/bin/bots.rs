// Load-bot: N fake sailors that surf back and forth along the level's lanes and shoot.
// Usage: cargo run --release --bin bots -- <count> [ws://localhost:8080/ws] [seconds]
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
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(100);
    let url = args.get(2).cloned().unwrap_or_else(|| "ws://localhost:8080/ws".into());
    let secs: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let stats = Arc::new(Stats::default());

    for i in 0..n {
        let (url, stats) = (url.clone(), stats.clone());
        tokio::spawn(async move { bot(i, &url, &stats).await });
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
            "t={:>3}s connected={} in: {:.1} KB/s per bot, {:.0} msgs/s per bot | total {:.1} MB/s out of server | sent {}",
            start.elapsed().as_secs(),
            c,
            (b - last.0) as f64 / 5.0 / c as f64 / 1024.0,
            (m - last.1) as f64 / 5.0 / c as f64,
            (b - last.0) as f64 / 5.0 / 1048576.0,
            stats.sent.load(Relaxed),
        );
        last = (b, m);
    }
}

fn state(pos: [f32; 3], yaw: u16) -> Vec<u8> {
    let mut b = vec![1u8];
    for v in pos {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&yaw.to_le_bytes());
    b.extend_from_slice(&0i16.to_le_bytes());
    b.push(0);
    b
}

fn shot(origin: [f32; 3], dir: [f32; 3]) -> Vec<u8> {
    let mut b = vec![2u8];
    for v in origin.iter().chain(dir.iter()) {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&0u32.to_le_bytes()); // view time 0 -> server clamps to now - 1s
    b.push(0);
    b
}

async fn bot(i: usize, url: &str, stats: &Stats) {
    let Ok((ws, _)) = connect_async(url).await else {
        eprintln!("bot {i}: connect failed");
        return;
    };
    stats.connected.fetch_add(1, Relaxed);
    let (mut tx, mut rx) = ws.split();
    let _ = tx.send(Message::text(format!(r#"{{"t":"hello","name":"Bot {i}"}}"#))).await;

    let reader = async {
        while let Some(Ok(m)) = rx.next().await {
            stats.bytes_in.fetch_add(m.len() as u64, Relaxed);
            stats.msgs_in.fetch_add(1, Relaxed);
        }
    };
    let writer = async {
        // Each bot rides one of the 6 lanes, sweeping up and down it at surf speed.
        let lane = (i % 6) as f32 * 6000.0;
        let phase = (i as f32 * 0.37) % 1.0;
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        let t0 = Instant::now();
        let mut k = 0u64;
        loop {
            tick.tick().await;
            let t = t0.elapsed().as_secs_f32() / 20.0 + phase;
            let y = 400.0 + (t * std::f32::consts::TAU).sin().abs() * 9000.0;
            let pos = [lane + (t * 7.0).sin() * 200.0, y, 3500.0 - y * 0.2];
            if tx.send(Message::binary(state(pos, (i * 997) as u16))).await.is_err() {
                return;
            }
            k += 1;
            if k % 40 == (i % 40) as u64 {
                let a = (i + k as usize) as f32;
                let _ = tx.send(Message::binary(shot([pos[0], pos[1], pos[2] + 64.0], [a.cos(), a.sin(), 0.0]))).await;
            }
            stats.sent.fetch_add(1, Relaxed);
        }
    };
    tokio::select! { _ = reader => {}, _ = writer => {} }
    stats.connected.fetch_sub(1, Relaxed);
}
