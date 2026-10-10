// One task owns all game state. Sockets talk to it over channels, so there are no locks on the hot path.
use crate::npc::Npc;
use crate::{filter, images, level::*, npc, proto};
use axum::extract::ws::{Message, Utf8Bytes};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, Instant, MissedTickBehavior, interval};

const TICK_MS: u64 = 50;
const FAR_EVERY: u64 = 20; // far view once a second; nearby cells every tick
const FAR_CAP: usize = 256;
const NEAR_CAP: usize = 96;
const CELL: f32 = 2048.0;
pub const LOBBY_MS: u32 = 15_000;
pub const RACE_MS: u32 = 105_000; // lobby + race = a clean 2:00 loop
const UPLOAD_EVERY_MS: u32 = 5_000;
const SPRAY_EVERY_MS: u32 = 15_000;
const WALL_EVERY_MS: u32 = 10_000;
const SPRAY_RANGE: f32 = 450.0;
const SPRAYS_PER_SEC: f32 = 20.0; // server-wide cap on spray broadcasts
const CHAT_MAX: usize = 200;
const CHAT_BURST: usize = 3;
const CHAT_WINDOW_MS: u32 = 5_000;
const MAX_SPEED: f32 = 6063.0; // sv_maxvelocity 3500 per axis -> 3500 * sqrt(3)
const GHOST_HZ_DIV: u32 = 2; // record every 2nd state packet (20 Hz -> 10 Hz)
const GHOST_CAP: usize = 2400;
const ROSTER_MAX: usize = 300;

pub enum Inbound {
    Join { ip: String, out: mpsc::Sender<Message>, reply: oneshot::Sender<Option<(u16, u32)>> },
    Leave(u16, u32),
    Bin(u16, u32, Bytes),
    Text(u16, u32, Utf8Bytes),
    Admin(Admin),
}

pub enum Admin {
    Ban(String),
    ClearImages,
    ListWalls(oneshot::Sender<Value>),
    RemoveWall(u32),
}

struct Player {
    serial: u32,
    name: String,
    color: String,
    ip: String,
    out: mpsc::Sender<Message>,
    named: bool,
    bot: Option<Npc>,
    pos: V3,
    yaw: u16,
    pitch: i16,
    flags: u8,
    has_state: bool,
    last_state: u32,
    states: u32,
    stage: usize,
    in_start: bool,
    run_start: Option<u32>,
    valid: bool,
    finished: Option<u32>, // ms of the finished run this round (0 = invalid finish)
    place: Option<u32>,
    late: bool,
    ghost: Vec<(V3, u16)>,
    spray: Option<String>,
    last_upload: u32,
    next_spray: u32,
    next_wall: u32,
    live_spray: Option<(V3, V3)>,
    chat_times: VecDeque<u32>,
}

impl Player {
    fn send(&self, m: Message) {
        // A full queue means a slow client: drop the frame rather than buffer without bound. NPCs have no socket.
        let _ = self.out.try_send(m);
    }

    fn json(&self, v: Value) {
        self.send(Message::Text(v.to_string().into()));
    }

    fn info(&self, id: u16) -> Value {
        json!({ "id": id, "name": self.name, "color": self.color, "spray": self.spray, "bot": self.bot.is_some() })
    }

    fn eye(&self) -> V3 {
        [self.pos[0], self.pos[1], self.pos[2] + if self.flags & 1 != 0 { 28.0 } else { 64.0 }]
    }

    fn reset_run(&mut self) {
        self.stage = 0;
        self.run_start = None;
        self.valid = true;
        self.finished = None;
        self.place = None;
        self.ghost.clear();
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Best {
    name: String,
    ms: u32,
}
#[derive(Serialize, Deserialize, Clone)]
struct Wins {
    name: String,
    wins: u32,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Record {
    name: String,
    ms: u32,
    spray: Option<String>,
    at: u64,
}
// A painted spray wall. Whoever reaches it and sprays last owns it.
#[derive(Serialize, Deserialize, Clone)]
struct Wall {
    id: u32,
    hash: String,
    name: String,
    at: u64,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    ip: String,
}

impl Wall {
    fn public(&self) -> Value {
        json!({ "id": self.id, "hash": self.hash, "name": self.name, "at": self.at })
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    best: Vec<Best>,
    wins: Vec<Wins>,
    banned: Vec<String>,
    #[serde(default)]
    walls: Vec<Wall>,
    #[serde(default)]
    record: Option<Record>,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Phase {
    Lobby,
    Race,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn dist(a: V3, b: V3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn v3(v: &Value) -> Option<V3> {
    let a = v.as_array().filter(|a| a.len() == 3)?;
    let f = |i: usize| a[i].as_f64().map(|x| x as f32).filter(|x| x.is_finite() && x.abs() < 1e6);
    Some([f(0)?, f(1)?, f(2)?])
}

fn unit_normal(v: &Value) -> Option<V3> {
    let n = v3(v)?;
    let l = dist(n, [0.0; 3]);
    (0.9..1.1).contains(&l).then(|| n.map(|x| x / l))
}

pub struct Game {
    level: Level,
    line: Vec<LinePoint>,
    spawns: Vec<V3>,
    players: Vec<Option<Player>>,
    free: Vec<u16>,
    serial: u32,
    start: Instant,
    phase: Phase,
    phase_ends: u32,
    go: u32,
    next_place: u32,
    results: Vec<(u16, u32, u32)>, // (id, place, ms) this race
    last_results: Value,
    saved: Saved,
    data_dir: Option<PathBuf>,
    images: images::Store,
    ghost: Vec<(V3, u16)>,
    ghost_frame: Bytes,
    max_per_ip: usize,
    cells: HashMap<(i32, i32, i32), Vec<u16>>,
    spray_tokens: f32,
    spray_refill: u32,
    ticks: u64,
    rng: u64,
}

fn cell_of(p: V3) -> (i32, i32, i32) {
    ((p[0] / CELL).floor() as i32, (p[1] / CELL).floor() as i32, (p[2] / CELL).floor() as i32)
}

fn color_for(id: u16) -> String {
    const C: [&str; 10] = ["#ff4d6d", "#ffb703", "#80ed99", "#48cae4", "#b388ff", "#ff7b00", "#00f5d4", "#f72585", "#4cc9f0", "#c9f24a"];
    C[id as usize % C.len()].into()
}

impl Game {
    pub fn new(level: Level, data_dir: Option<PathBuf>, max_per_ip: usize, images: images::Store, npcs: usize) -> Game {
        if let Some(d) = &data_dir {
            std::fs::create_dir_all(d).expect("creating data dir");
        }
        let saved: Saved = data_dir
            .as_ref()
            .and_then(|d| std::fs::read(d.join("state.json")).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let ghost = data_dir
            .as_ref()
            .and_then(|d| std::fs::read(d.join("ghost.bin")).ok())
            .and_then(|b| proto::parse_ghost(&b))
            .unwrap_or_default();
        for h in saved.walls.iter().map(|w| w.hash.as_str()).chain(saved.record.iter().filter_map(|r| r.spray.as_deref())) {
            images.load_persisted(h);
        }
        let ghost_frame = Bytes::from(proto::ghost(&ghost));
        let mut g = Game {
            line: level.line(),
            spawns: level.spawns.iter().map(|s| s.pos).collect(),
            level,
            players: Vec::new(),
            free: Vec::new(),
            serial: 0,
            start: Instant::now(),
            phase: Phase::Lobby,
            phase_ends: LOBBY_MS,
            go: 0,
            next_place: 1,
            results: Vec::new(),
            last_results: json!([]),
            saved,
            data_dir,
            images,
            ghost,
            ghost_frame,
            max_per_ip,
            cells: HashMap::new(),
            spray_tokens: SPRAYS_PER_SEC,
            spray_refill: 0,
            ticks: 0,
            rng: 0x9e3779b97f4a7c15,
        };
        for i in 0..npcs {
            g.spawn_npc(i);
        }
        g
    }

    fn spawn_npc(&mut self, i: usize) {
        let (tx, _rx) = mpsc::channel(1); // no socket: sends fail silently
        let Some((id, _)) = self.join("npc".into(), tx) else { return };
        let now = self.now();
        let p = self.players[id as usize].as_mut().unwrap();
        p.name = npc::NAMES[i % npc::NAMES.len()].to_string();
        if i >= npc::NAMES.len() {
            p.name.push_str(&format!("{}", i / npc::NAMES.len() + 1));
        }
        p.named = true;
        p.bot = Some(Npc::new(0xc0ffee + i as u64 * 7919, now));
        p.pos = self.spawns[0];
        p.has_state = true;
        p.in_start = true;
    }

    pub async fn run(mut self, mut rx: mpsc::Receiver<Inbound>) {
        let mut tick = interval(Duration::from_millis(TICK_MS));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(m) => self.handle(m),
                    None => return,
                },
                _ = tick.tick() => self.tick(),
            }
        }
    }

    fn now(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }

    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 40) as f32 / (1u64 << 24) as f32
    }

    fn player(&mut self, id: u16, serial: u32) -> Option<&mut Player> {
        self.players.get_mut(id as usize)?.as_mut().filter(|p| p.serial == serial)
    }

    fn broadcast(&self, v: Value) {
        let s: Utf8Bytes = v.to_string().into();
        for p in self.players.iter().flatten().filter(|p| p.named && p.bot.is_none()) {
            p.send(Message::Text(s.clone()));
        }
    }

    fn broadcast_bin(&self, b: &Bytes) {
        for p in self.players.iter().flatten().filter(|p| p.named && p.bot.is_none()) {
            p.send(Message::Binary(b.clone()));
        }
    }

    fn save(&self) {
        if let Some(d) = &self.data_dir {
            if let Err(e) = std::fs::write(d.join("state.json"), serde_json::to_vec(&self.saved).unwrap()) {
                eprintln!("saving state: {e}");
            }
        }
    }

    fn save_ghost(&self) {
        if let Some(d) = &self.data_dir {
            if let Err(e) = std::fs::write(d.join("ghost.bin"), &self.ghost_frame) {
                eprintln!("saving ghost: {e}");
            }
        }
    }

    fn board(&self) -> Value {
        json!({ "t": "board", "best": self.saved.best, "wins": self.saved.wins })
    }

    fn round(&self) -> Value {
        let now = self.now();
        json!({ "phase": if self.phase == Phase::Lobby { "lobby" } else { "race" }, "endsAt": self.phase_ends, "go": self.go, "now": now, "results": self.last_results })
    }

    pub fn handle(&mut self, m: Inbound) {
        match m {
            Inbound::Join { ip, out, reply } => {
                let _ = reply.send(self.join(ip, out));
            }
            Inbound::Leave(id, serial) => {
                if self.player(id, serial).is_some() {
                    self.remove(id);
                }
            }
            Inbound::Bin(id, serial, b) if b.first() == Some(&3) => self.on_image(id, serial, b.slice(1..)),
            Inbound::Bin(id, serial, b) => {
                if let Some(proto::ClientMsg::State { pos, yaw, pitch, flags }) = proto::decode(&b) {
                    self.on_state(id, serial, pos, yaw, pitch, flags);
                }
            }
            Inbound::Text(id, serial, t) => {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    self.on_json(id, serial, v);
                }
            }
            Inbound::Admin(Admin::Ban(ip)) => {
                let kick: Vec<u16> = (0..self.players.len()).filter(|&i| self.players[i].as_ref().is_some_and(|p| p.ip == ip)).map(|i| i as u16).collect();
                for id in kick {
                    self.remove(id);
                }
                let ids: Vec<u32> = self.saved.walls.iter().filter(|w| w.ip == ip).map(|w| w.id).collect();
                self.remove_walls(&ids);
                if !self.saved.banned.contains(&ip) {
                    self.saved.banned.push(ip);
                }
                self.save();
            }
            Inbound::Admin(Admin::ClearImages) => {
                for p in self.players.iter_mut().flatten() {
                    p.spray = None;
                    p.live_spray = None;
                }
                self.gc_images();
                self.broadcast(json!({ "t": "clearImages" }));
            }
            Inbound::Admin(Admin::ListWalls(reply)) => {
                let list: Vec<Value> = self.saved.walls.iter().map(|w| json!({ "id": w.id, "image": format!("/img/{}", w.hash), "name": w.name, "ip": w.ip, "at": w.at })).collect();
                let _ = reply.send(json!({ "walls": list, "record": self.saved.record }));
            }
            Inbound::Admin(Admin::RemoveWall(id)) => self.remove_walls(&[id]),
        }
    }

    fn join(&mut self, ip: String, out: mpsc::Sender<Message>) -> Option<(u16, u32)> {
        if self.saved.banned.contains(&ip) || self.players.iter().flatten().filter(|p| p.ip == ip).count() >= self.max_per_ip {
            return None;
        }
        let id = match self.free.pop() {
            Some(id) => id,
            None if self.players.len() < u16::MAX as usize => {
                self.players.push(None);
                (self.players.len() - 1) as u16
            }
            None => return None,
        };
        self.serial += 1;
        self.players[id as usize] = Some(Player {
            serial: self.serial,
            name: String::new(),
            color: color_for(id),
            ip,
            out,
            named: false,
            bot: None,
            pos: [0.0; 3],
            yaw: 0,
            pitch: 0,
            flags: 0,
            has_state: false,
            last_state: 0,
            states: 0,
            stage: 0,
            in_start: false,
            run_start: None,
            valid: true,
            finished: None,
            place: None,
            late: self.phase == Phase::Race,
            ghost: Vec::new(),
            spray: None,
            last_upload: 0,
            next_spray: 0,
            next_wall: 0,
            live_spray: None,
            chat_times: VecDeque::new(),
        });
        Some((id, self.serial))
    }

    fn remove(&mut self, id: u16) {
        if let Some(p) = self.players[id as usize].take() {
            self.free.push(id);
            if p.named {
                self.broadcast(json!({ "t": "leave", "id": id }));
            }
            if p.spray.is_some() {
                self.gc_images();
            }
        }
    }

    fn gc_images(&self) {
        let live: HashSet<String> = self.players.iter().flatten().filter_map(|p| p.spray.clone()).collect();
        let permanent: HashSet<String> = self.saved.walls.iter().map(|w| w.hash.clone()).chain(self.saved.record.iter().filter_map(|r| r.spray.clone())).collect();
        self.images.retain(&live, &permanent);
    }

    fn remove_walls(&mut self, ids: &[u32]) {
        if ids.is_empty() {
            return;
        }
        self.saved.walls.retain(|w| !ids.contains(&w.id));
        self.save();
        self.gc_images();
        self.broadcast(json!({ "t": "unwall", "ids": ids }));
    }

    fn on_image(&mut self, id: u16, serial: u32, b: Bytes) {
        let now = self.now();
        let Some(p) = self.player(id, serial).filter(|p| p.named) else { return };
        if p.last_upload != 0 && now < p.last_upload + UPLOAD_EVERY_MS {
            return p.json(json!({ "t": "notice", "text": "slow down on the uploads" }));
        }
        p.last_upload = now.max(1);
        let Some(h) = self.images.put(b) else {
            return self.players[id as usize].as_ref().unwrap().json(json!({ "t": "notice", "text": "that image didn't work, try a PNG or JPG" }));
        };
        let p = self.players[id as usize].as_mut().unwrap();
        p.spray = Some(h);
        let mut m = p.info(id);
        m["t"] = json!("profile");
        self.gc_images();
        self.broadcast(m);
    }

    fn on_json(&mut self, id: u16, serial: u32, v: Value) {
        let now = self.now();
        let Some(p) = self.player(id, serial) else { return };
        match v["t"].as_str() {
            Some("hello") if !p.named => {
                p.name = filter::name(v["name"].as_str().unwrap_or(""), id);
                p.named = true;
                let mut join = p.info(id);
                join["t"] = json!("join");
                let players: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| p.as_ref().filter(|p| p.named).map(|p| p.info(i as u16))).collect();
                let walls: Vec<Value> = self.saved.walls.iter().map(Wall::public).collect();
                let sprays: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| {
                    let p = p.as_ref()?;
                    let (pos, normal) = p.live_spray?;
                    Some(json!({ "id": i, "pos": pos, "normal": normal, "hash": p.spray }))
                }).collect();
                let welcome = json!({
                    "t": "welcome", "id": id, "level": self.level.name, "round": self.round(), "board": self.board(),
                    "players": players, "walls": walls, "sprays": sprays, "record": self.saved.record, "minRunMs": self.level.min_run_ms,
                });
                let me = self.players[id as usize].as_ref().unwrap();
                me.json(welcome);
                if !self.ghost.is_empty() {
                    me.send(Message::Binary(self.ghost_frame.clone()));
                }
                self.broadcast(join);
            }
            Some("chat") => {
                while p.chat_times.front().is_some_and(|t| t + CHAT_WINDOW_MS < now) {
                    p.chat_times.pop_front();
                }
                if p.chat_times.len() >= CHAT_BURST {
                    return p.json(json!({ "t": "notice", "text": "easy on the chat" }));
                }
                let text = filter::clean_text(v["text"].as_str().unwrap_or(""), CHAT_MAX);
                if text.is_empty() {
                    return;
                }
                p.chat_times.push_back(now);
                let m = json!({ "t": "chat", "id": id, "name": p.name, "color": p.color, "text": text, "bot": false });
                self.broadcast(m);
            }
            Some("spray") => {
                if let (Some(pos), Some(normal)) = (v3(&v["pos"]), unit_normal(&v["normal"])) {
                    self.on_spray(id, pos, normal);
                }
            }
            Some("wall") => {
                if let Some(w) = v["id"].as_u64() {
                    self.on_wall(id, w as u32);
                }
            }
            _ => {}
        }
    }

    // A CS-style spray on the level: one live spray per player, replaced by the next.
    fn on_spray(&mut self, id: u16, pos: V3, normal: V3) {
        let now = self.now();
        let p = self.players[id as usize].as_ref().unwrap();
        let Some(hash) = p.spray.clone() else { return p.json(json!({ "t": "notice", "text": "pick a spray in the menu first" })) };
        if !p.has_state || dist(pos, p.eye()) > SPRAY_RANGE || now < p.next_spray {
            return;
        }
        if self.spray_tokens < 1.0 {
            return p.json(json!({ "t": "notice", "text": "too much paint in the air, try again in a sec" }));
        }
        self.spray_tokens -= 1.0;
        let p = self.players[id as usize].as_mut().unwrap();
        p.next_spray = now + SPRAY_EVERY_MS;
        p.live_spray = Some((pos, normal));
        self.broadcast(json!({ "t": "spray", "id": id, "pos": pos, "normal": normal, "hash": hash }));
    }

    // A spray wall: free for anyone who is standing (or flying) in front of it. NPCs never paint.
    fn on_wall(&mut self, id: u16, wall: u32) {
        let now = self.now();
        let p = self.players[id as usize].as_ref().unwrap();
        if p.bot.is_some() {
            return;
        }
        let Some(hash) = p.spray.clone() else { return p.json(json!({ "t": "notice", "text": "pick a spray in the menu first" })) };
        if !p.has_state || now < p.next_wall {
            return;
        }
        let Some(t) = self.level.triggers.iter().find(|t| t.kind == Kind::Wall && t.id == Some(wall)) else { return };
        if !Level::inside(t, p.pos) {
            return p.json(json!({ "t": "notice", "text": "get closer to the wall" }));
        }
        let w = Wall { id: wall, hash, name: p.name.clone(), at: unix_now(), ip: p.ip.clone() };
        let (name, ip) = (w.name.clone(), w.ip.clone());
        self.images.persist(&w.hash);
        let public = w.public();
        self.saved.walls.retain(|x| x.id != wall);
        self.saved.walls.push(w);
        self.save();
        self.gc_images();
        let p = self.players[id as usize].as_mut().unwrap();
        p.next_wall = now + WALL_EVERY_MS;
        let _ = ip;
        let wall_name = self.level.walls.iter().find(|s| s.id == wall).map(|s| s.name.clone()).unwrap_or_default();
        self.broadcast(json!({ "t": "wall", "wall": public, "by": id, "name": name, "wallName": wall_name }));
    }

    fn on_state(&mut self, id: u16, serial: u32, pos: V3, yaw: u16, pitch: i16, flags: u8) {
        let now = self.now();
        let racing = self.phase == Phase::Race;
        let go = self.go;
        let record_ms = self.saved.record.as_ref().map(|r| r.ms);
        let Some(p) = self.players.get_mut(id as usize).and_then(|p| p.as_mut()).filter(|p| p.serial == serial && p.named) else { return };
        let level = &self.level;
        let mut events: Vec<Value> = Vec::new();
        let mut finished_ms = None;

        if p.has_state {
            if flags & 2 != 0 {
                match level.near_spawn(pos) {
                    Some(k) if k <= p.stage => p.stage = k,
                    _ if p.valid => {
                        p.valid = false;
                        events.push(json!({ "t": "invalid", "reason": "teleported somewhere odd" }));
                    }
                    _ => {}
                }
            } else {
                let dt = now.saturating_sub(p.last_state).max(1) as f32 / 1000.0;
                let d = dist(pos, p.pos);
                if d > MAX_SPEED * dt + 300.0 && p.valid {
                    p.valid = false;
                    events.push(json!({ "t": "invalid", "reason": "moved impossibly fast" }));
                }
                for t in &level.triggers {
                    if !swept_touch(t, p.pos, pos) {
                        continue;
                    }
                    match t.kind {
                        Kind::Checkpoint if t.stage == Some(p.stage + 1) => {
                            p.stage += 1;
                            if let Some(rs) = p.run_start {
                                events.push(json!({ "t": "split", "stage": p.stage, "ms": now - rs }));
                            }
                        }
                        Kind::End if t.stage == Some(p.stage + 1) && p.finished.is_none() => {
                            match (p.run_start, p.valid) {
                                (Some(rs), true) if now - rs < level.min_run_ms => events.push(json!({ "t": "invalid", "reason": "that run was faster than physics allows" })),
                                (Some(rs), true) => finished_ms = Some(now - rs),
                                (Some(_), false) => events.push(json!({ "t": "invalid", "reason": "this run had a problem; it doesn't count" })),
                                (None, _) => {}
                            }
                            p.finished = Some(finished_ms.unwrap_or(0));
                        }
                        _ => {}
                    }
                }
            }
        }

        // The run clock starts when you leave the start zone; standing in it resets the run.
        let in_start = level.triggers.iter().any(|t| t.kind == Kind::Start && swept_touch(t, pos, pos));
        if in_start {
            p.stage = 0;
            p.run_start = None;
            p.valid = true;
            p.ghost.clear();
            if p.finished == Some(0) {
                p.finished = None;
            }
        } else if p.in_start {
            p.run_start = Some(now);
            // Starting before GO (or having joined mid-race) is a practice run: it can't place.
            p.late = p.late || now < go || !racing;
        }
        p.in_start = in_start;

        p.pos = pos;
        p.yaw = yaw;
        p.pitch = pitch;
        p.flags = flags & !2;
        p.has_state = true;
        p.last_state = now;
        p.states += 1;
        if let Some(rs) = p.run_start {
            if p.bot.is_none() && p.valid && p.finished.is_none() && p.states % GHOST_HZ_DIV == 0 && record_ms.is_none_or(|r| now - rs < r + 500) && p.ghost.len() < GHOST_CAP {
                p.ghost.push((pos, yaw));
            }
        }
        for e in events {
            p.json(e);
        }
        if let Some(ms) = finished_ms {
            self.finish(id, ms, racing);
        }
    }

    fn finish(&mut self, id: u16, ms: u32, racing: bool) {
        let p = self.players[id as usize].as_mut().unwrap();
        let (name, spray, late, bot) = (p.name.clone(), p.spray.clone(), p.late, p.bot.is_some());
        let ghost = std::mem::take(&mut p.ghost);

        let mut is_record = false;
        if !bot {
            let best = &mut self.saved.best;
            match best.iter_mut().find(|b| b.name == name) {
                Some(b) if ms < b.ms => b.ms = ms,
                Some(_) => {}
                None => best.push(Best { name: name.clone(), ms }),
            }
            best.sort_by_key(|b| b.ms);
            best.truncate(10);
            // NPCs race and place, but the record and its ghost are human-only.
            if self.saved.record.as_ref().is_none_or(|r| ms < r.ms) {
                is_record = true;
                if let Some(h) = &spray {
                    self.images.persist(h);
                }
                self.saved.record = Some(Record { name: name.clone(), ms, spray: spray.clone(), at: unix_now() });
                if !ghost.is_empty() {
                    self.ghost = ghost;
                    self.ghost_frame = Bytes::from(proto::ghost(&self.ghost));
                    self.save_ghost();
                    self.broadcast_bin(&self.ghost_frame);
                }
                self.broadcast(json!({ "t": "record", "record": self.saved.record }));
            }
        }

        let mut place = None;
        if racing && !late {
            let pl = self.next_place;
            self.next_place += 1;
            place = Some(pl);
            self.results.push((id, pl, ms));
            self.players[id as usize].as_mut().unwrap().place = Some(pl);
            if pl == 1 && !bot {
                match self.saved.wins.iter_mut().find(|w| w.name == name) {
                    Some(w) => w.wins += 1,
                    None => self.saved.wins.push(Wins { name: name.clone(), wins: 1 }),
                }
                self.saved.wins.sort_by(|a, b| b.wins.cmp(&a.wins));
                self.saved.wins.truncate(10);
            }
            self.broadcast(json!({ "t": "placed", "id": id, "name": name, "place": pl, "ms": ms, "bot": bot }));
        }
        self.players[id as usize].as_ref().unwrap().json(json!({ "t": "finish", "ms": ms, "place": place, "record": is_record, "late": late || !racing }));
        if bot && self.rand() < 0.5 {
            let line = if place == Some(1) { "ez" } else { "gg" };
            self.npc_chat(id, line);
        }
        self.save();
        self.broadcast(self.board());
    }

    fn npc_chat(&self, id: u16, text: &str) {
        let p = self.players[id as usize].as_ref().unwrap();
        self.broadcast(json!({ "t": "chat", "id": id, "name": p.name, "color": p.color, "text": text, "bot": true }));
    }

    fn set_phase(&mut self, phase: Phase) {
        let now = self.now();
        self.phase = phase;
        match phase {
            Phase::Lobby => {
                self.phase_ends = now + LOBBY_MS;
                let results: Vec<Value> = self.results.iter().take(3).map(|(id, place, ms)| {
                    let p = self.players[*id as usize].as_ref();
                    json!({ "id": id, "place": place, "ms": ms, "name": p.map(|p| p.name.clone()), "spray": p.and_then(|p| p.spray.clone()), "bot": p.is_some_and(|p| p.bot.is_some()) })
                }).collect();
                self.last_results = json!({ "top": results, "finishers": self.results.len() });
                self.broadcast(json!({ "t": "round", "phase": "lobby", "endsAt": self.phase_ends, "now": now, "results": self.last_results }));
                for p in self.players.iter_mut().flatten() {
                    if let Some(b) = &mut p.bot {
                        b.done = true; // hold at the gate until GO
                    }
                }
            }
            Phase::Race => {
                self.go = now;
                self.phase_ends = now + RACE_MS;
                self.next_place = 1;
                self.results.clear();
                for p in self.players.iter_mut().flatten() {
                    p.reset_run();
                    p.late = false;
                    if let Some(b) = &mut p.bot {
                        b.restart(now);
                    }
                }
                self.broadcast(json!({ "t": "round", "phase": "race", "endsAt": self.phase_ends, "go": now, "now": now }));
            }
        }
    }

    // Drive the NPCs: in the lobby they sit at the gate; in a race they ride the line.
    fn tick_npcs(&mut self, now: u32) {
        let spawn0 = self.spawns[0];
        let racing = self.phase == Phase::Race;
        let mut moves: Vec<(u16, u32, V3, u16, u8)> = Vec::new();
        let mut chats: Vec<(u16, &'static str)> = Vec::new();
        for (i, p) in self.players.iter_mut().enumerate() {
            let Some(p) = p.as_mut() else { continue };
            let Some(b) = &mut p.bot else { continue };
            if !racing {
                if p.pos != spawn0 || p.stage != 0 {
                    moves.push((i as u16, p.serial, spawn0, p.yaw, 2));
                }
                continue;
            }
            if now >= b.chat_at {
                let k = (b.rand() * npc::LINES.len() as f32) as usize;
                chats.push((i as u16, npc::LINES[k.min(npc::LINES.len() - 1)]));
                b.chat_at = now + 40_000 + (b.rand() * 80_000.0) as u32;
            }
            if let Some((pos, yaw, fail)) = b.step(&self.line, &self.spawns, now) {
                moves.push((i as u16, p.serial, pos, yaw, if fail { 2 } else { 0 }));
            }
        }
        for (id, serial, pos, yaw, flags) in moves {
            self.on_state(id, serial, pos, yaw, 0, flags);
        }
        for (id, text) in chats {
            self.npc_chat(id, text);
        }
    }

    pub fn tick(&mut self) {
        let now = self.now();
        self.ticks += 1;
        self.spray_tokens = (self.spray_tokens + SPRAYS_PER_SEC * now.saturating_sub(self.spray_refill) as f32 / 1000.0).min(SPRAYS_PER_SEC);
        self.spray_refill = now;

        if now >= self.phase_ends {
            match self.phase {
                Phase::Lobby => self.set_phase(Phase::Race),
                Phase::Race => self.set_phase(Phase::Lobby),
            }
        }
        self.tick_npcs(now);

        // Scoreboard numbers, once a second. ponytail: skipped on huge servers, where it'd be O(N^2) per second.
        let named = self.players.iter().flatten().filter(|p| p.named).count();
        if self.ticks % FAR_EVERY == 10 && named <= ROSTER_MAX {
            let rows: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| {
                let p = p.as_ref().filter(|p| p.named)?;
                Some(json!([i, p.stage, p.finished.unwrap_or(0), p.place.unwrap_or(0), p.late, p.bot.is_some()]))
            }).collect();
            self.broadcast(json!({ "t": "roster", "p": rows }));
        }

        // Interest management: bucket players by cell, encode each cell once, share the bytes.
        self.cells.clear();
        for (i, p) in self.players.iter().enumerate() {
            if let Some(p) = p.as_ref().filter(|p| p.has_state) {
                self.cells.entry(cell_of(p.pos)).or_default().push(i as u16);
            }
        }
        let record = |buf: &mut Vec<u8>, i: u16, p: &Player| {
            let flags = (p.flags & 1) | if p.finished.is_some() { 2 } else { 0 };
            proto::snap_record(buf, i, p.pos, p.yaw, p.pitch, flags);
        };
        let mut encoded: HashMap<(i32, i32, i32), Vec<u8>> = HashMap::with_capacity(self.cells.len());
        for (cell, ids) in &self.cells {
            let mut buf = Vec::with_capacity(ids.len() * proto::SNAP_RECORD);
            for &i in ids {
                record(&mut buf, i, self.players[i as usize].as_ref().unwrap());
            }
            encoded.insert(*cell, buf);
        }
        let far = (self.ticks % FAR_EVERY == 0).then(|| {
            let all: Vec<u16> = self.cells.values().flatten().copied().collect();
            let n = all.len().min(FAR_CAP);
            let off = if all.is_empty() { 0 } else { (self.ticks / FAR_EVERY) as usize * FAR_CAP % all.len() };
            let mut buf = Vec::with_capacity(proto::SNAP_HEADER + n * proto::SNAP_RECORD);
            proto::snap_header(&mut buf, now, n as u16);
            for &i in all.iter().cycle().skip(off).take(n) {
                record(&mut buf, i, self.players[i as usize].as_ref().unwrap());
            }
            Bytes::from(buf)
        });
        let mut views: HashMap<(i32, i32, i32), Bytes> = HashMap::with_capacity(self.cells.len());
        for p in self.players.iter().flatten().filter(|p| p.named && p.bot.is_none()) {
            if let Some(far) = &far {
                p.send(Message::Binary(far.clone()));
            }
            if !p.has_state {
                continue;
            }
            let c = cell_of(p.pos);
            let (encoded, ticks) = (&encoded, self.ticks as usize);
            let view = views.entry(c).or_insert_with(|| {
                let mut recs = Vec::new();
                for dx in -1..=1 {
                    for dy in -1..=1 {
                        for dz in -1..=1 {
                            recs.extend_from_slice(encoded.get(&(c.0 + dx, c.1 + dy, c.2 + dz)).map_or(&[][..], |v| v));
                        }
                    }
                }
                let total = recs.len() / proto::SNAP_RECORD;
                let n = total.min(NEAR_CAP);
                let mut buf = Vec::with_capacity(proto::SNAP_HEADER + n * proto::SNAP_RECORD);
                if n > 0 {
                    proto::snap_header(&mut buf, now, n as u16);
                    let off = ticks * NEAR_CAP % total;
                    for j in 0..n {
                        let r = (off + j) % total * proto::SNAP_RECORD;
                        buf.extend_from_slice(&recs[r..r + proto::SNAP_RECORD]);
                    }
                }
                Bytes::from(buf)
            });
            if !view.is_empty() {
                p.send(Message::Binary(view.clone()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level() -> Level {
        Level { min_run_ms: 0, ..Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/meridian.json")) }
    }

    fn game() -> Game {
        Game::new(level(), None, 100, images::Store::new(None), 0)
    }

    fn join(g: &mut Game, name: &str) -> (u16, u32, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(4096);
        let (rtx, mut rrx) = oneshot::channel();
        g.handle(Inbound::Join { ip: "1.2.3.4".into(), out: tx, reply: rtx });
        let (id, serial) = rrx.try_recv().unwrap().unwrap();
        g.handle(Inbound::Text(id, serial, json!({ "t": "hello", "name": name }).to_string().into()));
        (id, serial, rx)
    }

    fn state(pos: V3, flags: u8) -> Bytes {
        let mut b = vec![1u8];
        for v in pos {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&[0, 0, 0, 0, flags]);
        b.into()
    }

    fn walk(g: &mut Game, a: u16, sa: u32, pos: V3) {
        if let Some(p) = g.players[a as usize].as_mut() {
            if p.has_state {
                p.pos = [pos[0], pos[1] - 100.0, pos[2]];
            }
        }
        g.handle(Inbound::Bin(a, sa, state(pos, 0)));
    }

    fn upload(img: &Bytes) -> Bytes {
        let mut b = vec![3u8];
        b.extend_from_slice(img);
        b.into()
    }

    fn texts(rx: &mut mpsc::Receiver<Message>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            if let Message::Text(t) = m {
                out.push(serde_json::from_str(&t).unwrap());
            }
        }
        out
    }

    fn png(seed: u8) -> Bytes {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[seed; 32]);
        b.into()
    }

    fn race(g: &mut Game, a: u16, sa: u32, run_ms: u32) {
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]);
        let stages = g.level.spawns.len();
        let end = g.level.triggers.iter().find(|t| t.kind == Kind::End).unwrap();
        let before = [(end.min[0] + end.max[0]) / 2.0, end.min[1] - 100.0, end.min[2] + 1300.0];
        let inside = [before[0], end.min[1] + 50.0, before[2]];
        let p = g.players[a as usize].as_mut().unwrap();
        p.stage = stages - 1;
        p.run_start = Some(p.run_start.unwrap().saturating_sub(run_ms));
        p.pos = before;
        g.handle(Inbound::Bin(a, sa, state(inside, 0)));
    }

    #[test]
    fn two_minute_loop_lobby_then_race_with_results() {
        let mut g = game();
        assert_eq!(g.phase_ends, LOBBY_MS);
        let (a, sa, mut ra) = join(&mut g, "Alpha");
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[0].pos, 0)));
        g.set_phase(Phase::Race);
        texts(&mut ra);
        race(&mut g, a, sa, 40_000);
        assert_eq!(g.phase_ends, g.go + RACE_MS, "a finish doesn't shorten the race");
        g.set_phase(Phase::Lobby);
        let lobby = texts(&mut ra).into_iter().find(|m| m["t"] == "round" && m["phase"] == "lobby").unwrap();
        assert_eq!(lobby["results"]["top"][0]["name"], "Alpha");
        assert_eq!(lobby["results"]["finishers"], 1);
        assert_eq!(lobby["endsAt"].as_u64().unwrap() - lobby["now"].as_u64().unwrap(), LOBBY_MS as u64);
    }

    #[test]
    fn walls_are_free_for_all_but_you_must_be_there() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Painter");
        g.handle(Inbound::Bin(a, sa, upload(&png(1))));
        let wall = g.level.triggers.iter().find(|t| t.kind == Kind::Wall && t.id == Some(10)).unwrap();
        let inside = [(wall.min[0] + wall.max[0]) / 2.0, (wall.min[1] + wall.max[1]) / 2.0, (wall.min[2] + wall.max[2]) / 2.0];
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[0].pos, 0)));
        g.handle(Inbound::Text(a, sa, json!({ "t": "wall", "id": 10 }).to_string().into()));
        assert!(g.saved.walls.is_empty(), "too far away");
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "notice"));
        let p = g.players[a as usize].as_mut().unwrap();
        p.pos = inside;
        g.handle(Inbound::Text(a, sa, json!({ "t": "wall", "id": 10 }).to_string().into()));
        assert_eq!(g.saved.walls.len(), 1);
        assert_eq!(g.saved.walls[0].name, "Painter");
        // Someone else paints over it.
        let (b, sb, _rb) = join(&mut g, "Rival");
        g.handle(Inbound::Bin(b, sb, upload(&png(2))));
        g.handle(Inbound::Bin(b, sb, state(inside, 0)));
        g.handle(Inbound::Text(b, sb, json!({ "t": "wall", "id": 10 }).to_string().into()));
        assert_eq!(g.saved.walls.len(), 1);
        assert_eq!(g.saved.walls[0].name, "Rival");
        assert!(g.images.get(&images::hash(&png(2))).is_some());
        g.handle(Inbound::Admin(Admin::Ban("1.2.3.4".into())));
        assert!(g.saved.walls.is_empty());
    }

    #[test]
    fn npcs_race_place_and_win_but_never_set_the_record() {
        let mut g = Game::new(level(), None, 100, images::Store::new(None), 4);
        assert_eq!(g.players.iter().flatten().filter(|p| p.bot.is_some()).count(), 4);
        let (h, sh, mut rh) = join(&mut g, "Human");
        g.handle(Inbound::Bin(h, sh, state(g.level.spawns[0].pos, 0)));
        g.set_phase(Phase::Race);
        // Let the NPCs run: 4 minutes of ticks at 50 ms, advancing the clock by faking `start`.
        let mut finished = 0;
        for i in 0..4800 {
            g.start = Instant::now() - Duration::from_millis(g.go as u64 + i * 50);
            g.tick_npcs(g.now());
            finished = g.results.len();
            if finished >= 2 {
                break;
            }
        }
        assert!(finished >= 1, "NPCs should finish the course");
        assert!(g.results.iter().any(|(id, place, _)| *place == 1 && g.players[*id as usize].as_ref().unwrap().bot.is_some()));
        assert!(g.saved.record.is_none(), "NPC finishes don't set the record");
        assert!(g.saved.wins.is_empty(), "NPC wins don't go on the human win board");
        assert!(texts(&mut rh).iter().any(|m| m["t"] == "placed" && m["bot"] == true));
        // A human finishing later still gets the record.
        race(&mut g, h, sh, 50_000);
        assert_eq!(g.saved.record.as_ref().unwrap().name, "Human");
    }

    #[test]
    fn chat_is_relayed_and_rate_limited() {
        let mut g = game();
        let (a, sa, _ra) = join(&mut g, "Talker");
        let (_b, _sb, mut rb) = join(&mut g, "Listener");
        texts(&mut rb);
        for i in 0..5 {
            g.handle(Inbound::Text(a, sa, json!({ "t": "chat", "text": format!("hi {i}") }).to_string().into()));
        }
        let got = texts(&mut rb).into_iter().filter(|m| m["t"] == "chat").count();
        assert_eq!(got, CHAT_BURST);
    }

    #[test]
    fn live_sprays_need_range_and_cooldown() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Sprayer");
        g.handle(Inbound::Bin(a, sa, state([0.0, 0.0, 0.0], 0)));
        g.handle(Inbound::Bin(a, sa, upload(&png(3))));
        texts(&mut ra);
        let msg = |p: V3| json!({ "t": "spray", "pos": p, "normal": [0.0, -1.0, 0.0] }).to_string();
        g.handle(Inbound::Text(a, sa, msg([0.0, 2000.0, 64.0]).into()));
        assert!(!texts(&mut ra).iter().any(|m| m["t"] == "spray"));
        g.handle(Inbound::Text(a, sa, msg([0.0, 200.0, 64.0]).into()));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "spray"));
        g.handle(Inbound::Text(a, sa, msg([0.0, 210.0, 64.0]).into()));
        assert!(!texts(&mut ra).iter().any(|m| m["t"] == "spray"));
    }

    #[test]
    fn skips_and_speed_hacks_are_rejected() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Cheater");
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(&mut g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]);
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[3].pos, 2)));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "invalid"));
        let mut g2 = game();
        g2.level.min_run_ms = 30_000;
        g2.set_phase(Phase::Race);
        let (c, sc, mut rc) = join(&mut g2, "Hacker");
        race(&mut g2, c, sc, 5_000);
        assert!(texts(&mut rc).iter().any(|m| m["t"] == "invalid" && m["reason"].as_str().unwrap().contains("faster")));
    }

    #[test]
    fn record_ghost_is_recorded_persisted_and_sent_to_joiners() {
        let dir = std::env::temp_dir().join(format!("skysurf-v21-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))), 0);
        g.set_phase(Phase::Race);
        let (a, sa, _ra) = join(&mut g, "Ghost");
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(&mut g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]);
        for i in 0..40 {
            g.handle(Inbound::Bin(a, sa, state([sp[0], sp[1] + 900.0 + i as f32 * 50.0, sp[2]], 0)));
        }
        race(&mut g, a, sa, 50_000);
        assert!(!g.ghost.is_empty());
        drop(g);
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))), 0);
        assert!(!g.ghost.is_empty(), "ghost reloaded from disk");
        let (_b, _sb, mut rb) = join(&mut g, "Newbie");
        let mut got = false;
        while let Ok(m) = rb.try_recv() {
            if let Message::Binary(b) = m {
                got |= b.first() == Some(&3);
            }
        }
        assert!(got, "ghost frame sent on welcome");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
