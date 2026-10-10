// One task owns all game state. Sockets talk to it over channels, so there are no locks on the hot path.
use crate::{filter, images, level::*, proto};
use axum::extract::ws::{Message, Utf8Bytes};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, Instant, MissedTickBehavior, interval};

pub struct Weapon {
    dmg: i32,
    cd: u32,
    mag: u8,
    reload: u32,
    pellets: u32,
    spread: f32,
    kb: f32,
    radius: f32,
}

// Shared with client/src/main.ts — keep in sync.
const WEAPONS: [Weapon; 3] = [
    Weapon { dmg: 18, cd: 150, mag: 12, reload: 1400, pellets: 1, spread: 0.01, kb: 120.0, radius: 0.0 },
    Weapon { dmg: 9, cd: 900, mag: 4, reload: 2000, pellets: 8, spread: 0.08, kb: 70.0, radius: 0.0 },
    Weapon { dmg: 75, cd: 1200, mag: 2, reload: 2400, pellets: 1, spread: 0.0, kb: 650.0, radius: 20.0 },
];

const TICK_MS: u64 = 50;
const FAR_EVERY: u64 = 20; // far view once a second; nearby cells every tick
const FAR_CAP: usize = 256;
const NEAR_CAP: usize = 96;
const CELL: f32 = 2048.0;
const ROUND_MS: u32 = 6 * 60 * 1000;
const INTERMISSION_MS: u32 = 20_000;
const PROMO_WINDOW_MS: u32 = 30_000;
const UPLOAD_EVERY_MS: u32 = 5_000;
const SPRAY_EVERY_MS: u32 = 15_000;
const SPRAY_RANGE: f32 = 400.0;
const SPRAYS_PER_SEC: f32 = 20.0; // server-wide cap on spray broadcasts, each one goes to everyone
const TAG_COVER: f32 = 128.0;
const TAG_CAP: usize = 64;
const ROSTER_MAX: usize = 300;
const PROMO_PER_IP_MS: u32 = 60 * 60 * 1000;
const RESPAWN_MS: u32 = 2000;
const MAX_SPEED: f32 = 6063.0; // sv_maxvelocity 3500 per axis -> 3500 * sqrt(3)
const SHOT_RANGE: f32 = 8192.0;

pub enum Inbound {
    Join { ip: String, out: mpsc::Sender<Message>, reply: oneshot::Sender<Option<(u16, u32)>> },
    Leave(u16, u32),
    Bin(u16, u32, Bytes),
    Text(u16, u32, Utf8Bytes),
    Admin(Admin),
}

pub enum Admin {
    ClearPromo,
    Ban(String),
    ClearImages,
    ListTags(oneshot::Sender<Value>),
    RemoveTag(u32),
}

struct Player {
    serial: u32,
    name: String,
    color: String,
    ip: String,
    out: mpsc::Sender<Message>,
    named: bool,
    pos: V3,
    yaw: u16,
    pitch: i16,
    flags: u8,
    has_state: bool,
    last_state: u32,
    hist: VecDeque<(u32, V3, bool)>,
    hp: i32,
    dead_until: Option<u32>,
    stage: usize,
    in_start: bool,
    run_start: Option<u32>,
    valid: bool,
    finished: bool,
    owned: [bool; 3],
    ammo: [u8; 3],
    reload_until: Option<(usize, u32)>,
    next_fire: u32,
    sponsor: String,
    flag: Option<String>,
    spray: Option<String>,
    last_upload: [u32; 2], // per kind: flag, spray
    next_spray: u32,
    live_spray: Option<(V3, V3)>,
    kills: u32,
    deaths: u32,
}

impl Player {
    fn eye(&self) -> V3 {
        [self.pos[0], self.pos[1], self.pos[2] + if self.ducked() { 28.0 } else { 64.0 }]
    }

    fn info(&self, id: u16) -> Value {
        json!({ "id": id, "name": self.name, "color": self.color, "sponsor": self.sponsor, "flag": self.flag, "spray": self.spray })
    }

    fn ducked(&self) -> bool {
        self.flags & 1 != 0
    }

    fn send(&self, m: Message) {
        // A full queue means a slow client: drop the frame rather than buffer without bound.
        let _ = self.out.try_send(m);
    }

    fn json(&self, v: Value) {
        self.send(Message::Text(v.to_string().into()));
    }

    // Lag compensation: where this player was at server time t.
    fn pos_at(&self, t: u32) -> (V3, bool) {
        let h = &self.hist;
        let Some(i) = h.iter().position(|e| e.0 >= t) else { return (self.pos, self.ducked()) };
        if i == 0 {
            return (h[0].1, h[0].2);
        }
        let (a, b) = (&h[i - 1], &h[i]);
        let k = (t - a.0) as f32 / (b.0 - a.0).max(1) as f32;
        ([0, 1, 2].map(|j| a.1[j] + (b.1[j] - a.1[j]) * k), b.2)
    }

    fn reset_run(&mut self) {
        self.stage = 0;
        self.run_start = None;
        self.valid = true;
        self.finished = false;
        self.owned = [true, false, false];
        self.ammo = WEAPONS.each_ref().map(|w| w.mag);
        self.reload_until = None;
        self.hp = 100;
        self.dead_until = None;
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
struct Promo {
    text: String,
    url: Option<String>,
    by: String,
}
// A round winner's spray, painted on the map until another winner covers it.
#[derive(Serialize, Deserialize, Clone)]
struct Tag {
    id: u32,
    hash: String,
    pos: V3,
    normal: V3,
    name: String,
    sponsor: String,
    at: u64,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    ip: String,
}

impl Tag {
    fn public(&self) -> Value {
        json!({ "id": self.id, "hash": self.hash, "pos": self.pos, "normal": self.normal, "name": self.name, "sponsor": self.sponsor, "at": self.at })
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    best: Vec<Best>,
    wins: Vec<Wins>,
    promo: Option<Promo>,
    banned: Vec<String>,
    #[serde(default)]
    tags: Vec<Tag>,
    #[serde(default)]
    next_tag: u32,
}

fn dist(a: V3, b: V3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn unit_normal(v: &Value) -> Option<V3> {
    let n = v3(v)?;
    let l = dist(n, [0.0; 3]);
    (0.9..1.1).contains(&l).then(|| n.map(|x| x / l))
}

fn v3(v: &Value) -> Option<V3> {
    let a = v.as_array().filter(|a| a.len() == 3)?;
    let f = |i: usize| a[i].as_f64().map(|x| x as f32).filter(|x| x.is_finite() && x.abs() < 1e6);
    Some([f(0)?, f(1)?, f(2)?])
}

#[derive(PartialEq)]
enum Phase {
    Race,
    Intermission,
}

pub struct Game {
    level: Level,
    players: Vec<Option<Player>>,
    free: Vec<u16>,
    serial: u32,
    start: Instant,
    phase: Phase,
    phase_ends: u32,
    saved: Saved,
    data_path: Option<PathBuf>,
    promo_pending: Option<(u16, u32)>,
    tag_pending: Option<(u16, u32)>,
    promo_ips: HashMap<String, u32>,
    images: images::Store,
    spray_tokens: f32,
    spray_refill: u32,
    max_per_ip: usize,
    cells: HashMap<(i32, i32, i32), Vec<u16>>,
    fx: HashMap<(i32, i32, i32), Vec<u8>>,
    rng: u64,
    ticks: u64,
}

fn cell_of(p: V3) -> (i32, i32, i32) {
    ((p[0] / CELL).floor() as i32, (p[1] / CELL).floor() as i32, (p[2] / CELL).floor() as i32)
}

fn color_for(id: u16) -> String {
    const C: [&str; 10] = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#f15bb5", "#00bbf9", "#00f5d4", "#fb5607", "#9b5de5"];
    C[id as usize % C.len()].into()
}

impl Game {
    pub fn new(level: Level, data_dir: Option<PathBuf>, max_per_ip: usize, images: images::Store) -> Game {
        let data_path = data_dir.map(|d| {
            std::fs::create_dir_all(&d).expect("creating data dir");
            d.join("state.json")
        });
        let saved = data_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let saved: Saved = saved;
        for t in &saved.tags {
            images.load_persisted(&t.hash);
        }
        Game {
            level,
            players: Vec::new(),
            free: Vec::new(),
            serial: 0,
            start: Instant::now(),
            phase: Phase::Race,
            phase_ends: ROUND_MS,
            saved,
            data_path,
            promo_pending: None,
            tag_pending: None,
            promo_ips: HashMap::new(),
            images,
            spray_tokens: SPRAYS_PER_SEC,
            spray_refill: 0,
            max_per_ip,
            cells: HashMap::new(),
            fx: HashMap::new(),
            rng: 0x9e3779b97f4a7c15,
            ticks: 0,
        }
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
        for p in self.players.iter().flatten().filter(|p| p.named) {
            p.send(Message::Text(s.clone()));
        }
    }

    fn save(&self) {
        if let Some(path) = &self.data_path {
            if let Err(e) = std::fs::write(path, serde_json::to_vec(&self.saved).unwrap()) {
                eprintln!("saving state: {e}");
            }
        }
    }

    fn board(&self) -> Value {
        json!({ "t": "board", "best": self.saved.best, "wins": self.saved.wins })
    }

    fn round(&self) -> Value {
        json!({ "phase": if self.phase == Phase::Race { "race" } else { "intermission" }, "endsAt": self.phase_ends })
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
            Inbound::Bin(id, serial, b) if matches!(b.first(), Some(3 | 4)) => self.on_image(id, serial, b[0] == 4, b.slice(1..)),
            Inbound::Bin(id, serial, b) => match proto::decode(&b) {
                Some(proto::ClientMsg::State { pos, yaw, pitch, flags }) => self.on_state(id, serial, pos, yaw, pitch, flags),
                Some(proto::ClientMsg::Shot { origin, dir, view_time, weapon }) => self.on_shot(id, serial, origin, dir, view_time, weapon as usize),
                None => {}
            },
            Inbound::Text(id, serial, t) => {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    self.on_json(id, serial, v);
                }
            }
            Inbound::Admin(Admin::ClearPromo) => {
                self.saved.promo = None;
                self.save();
                self.broadcast(json!({ "t": "promo", "promo": null }));
            }
            Inbound::Admin(Admin::Ban(ip)) => {
                let kick: Vec<u16> = (0..self.players.len()).filter(|&i| self.players[i].as_ref().is_some_and(|p| p.ip == ip)).map(|i| i as u16).collect();
                for id in kick {
                    self.remove(id);
                }
                let ids: Vec<u32> = self.saved.tags.iter().filter(|t| t.ip == ip).map(|t| t.id).collect();
                self.remove_tags(&ids);
                if !self.saved.banned.contains(&ip) {
                    self.saved.banned.push(ip);
                }
                self.save();
            }
            Inbound::Admin(Admin::ClearImages) => {
                for p in self.players.iter_mut().flatten() {
                    p.flag = None;
                    p.spray = None;
                    p.live_spray = None;
                }
                self.gc_images();
                self.broadcast(json!({ "t": "clearImages" }));
            }
            Inbound::Admin(Admin::ListTags(reply)) => {
                let tags: Vec<Value> = self.saved.tags.iter().map(|t| json!({ "id": t.id, "image": format!("/img/{}", t.hash), "name": t.name, "sponsor": t.sponsor, "ip": t.ip, "at": t.at, "pos": t.pos })).collect();
                let _ = reply.send(json!(tags));
            }
            Inbound::Admin(Admin::RemoveTag(id)) => self.remove_tags(&[id]),
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
        let mut p = Player {
            serial: self.serial,
            name: String::new(),
            color: color_for(id),
            ip,
            out,
            named: false,
            pos: [0.0; 3],
            yaw: 0,
            pitch: 0,
            flags: 0,
            has_state: false,
            last_state: 0,
            hist: VecDeque::new(),
            hp: 100,
            dead_until: None,
            stage: 0,
            in_start: false,
            run_start: None,
            valid: true,
            finished: false,
            owned: [true, false, false],
            ammo: [0; 3],
            reload_until: None,
            next_fire: 0,
            sponsor: String::new(),
            flag: None,
            spray: None,
            last_upload: [0; 2],
            next_spray: 0,
            live_spray: None,
            kills: 0,
            deaths: 0,
        };
        p.reset_run();
        self.players[id as usize] = Some(p);
        Some((id, self.serial))
    }

    fn remove(&mut self, id: u16) {
        if let Some(p) = self.players[id as usize].take() {
            self.free.push(id);
            if p.named {
                self.broadcast(json!({ "t": "leave", "id": id }));
            }
            if p.flag.is_some() || p.spray.is_some() {
                self.gc_images();
            }
        }
    }

    fn gc_images(&self) {
        let live: HashSet<String> = self.players.iter().flatten().flat_map(|p| [p.flag.clone(), p.spray.clone()]).flatten().collect();
        let permanent: HashSet<String> = self.saved.tags.iter().map(|t| t.hash.clone()).collect();
        self.images.retain(&live, &permanent);
    }

    fn remove_tags(&mut self, ids: &[u32]) {
        if ids.is_empty() {
            return;
        }
        self.saved.tags.retain(|t| !ids.contains(&t.id));
        self.save();
        self.gc_images();
        self.broadcast(json!({ "t": "untag", "ids": ids }));
    }

    fn on_image(&mut self, id: u16, serial: u32, spray: bool, b: Bytes) {
        let now = self.now();
        let Some(p) = self.player(id, serial).filter(|p| p.named) else { return };
        let k = spray as usize;
        if p.last_upload[k] != 0 && now < p.last_upload[k] + UPLOAD_EVERY_MS {
            return p.json(json!({ "t": "notice", "text": "slow down on the uploads" }));
        }
        p.last_upload[k] = now.max(1);
        let Some(h) = self.images.put(b) else {
            return self.players[id as usize].as_ref().unwrap().json(json!({ "t": "notice", "text": "that image didn't work, try a JPG or PNG" }));
        };
        let p = self.players[id as usize].as_mut().unwrap();
        if spray {
            p.spray = Some(h);
        } else {
            p.flag = Some(h);
        }
        let info = p.info(id);
        self.gc_images();
        let mut m = info;
        m["t"] = json!("profile");
        self.broadcast(m);
    }

    fn on_spray(&mut self, id: u16, pos: V3, normal: V3, permanent: bool) {
        let now = self.now();
        let p = self.players[id as usize].as_ref().unwrap();
        let Some(hash) = p.spray.clone().or_else(|| if permanent { p.flag.clone() } else { None }) else {
            return p.json(json!({ "t": "notice", "text": "set a spray image first (menu)" }));
        };
        if !p.has_state || dist(pos, p.eye()) > SPRAY_RANGE {
            return;
        }
        if permanent {
            if self.tag_pending.is_none_or(|(w, until)| w != id || now > until) {
                return;
            }
            self.tag_pending = None;
            // Painting over an existing tag on the same surface replaces it: winners fight over the best walls.
            let mut removed: Vec<u32> = self.saved.tags.iter().filter(|t| dist(t.pos, pos) < TAG_COVER && t.normal.iter().zip(normal).map(|(a, b)| a * b).sum::<f32>() > 0.7).map(|t| t.id).collect();
            self.saved.tags.retain(|t| !removed.contains(&t.id));
            while self.saved.tags.len() >= TAG_CAP {
                removed.push(self.saved.tags.remove(0).id);
            }
            self.saved.next_tag += 1;
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let tag = Tag { id: self.saved.next_tag, hash, pos, normal, name: p.name.clone(), sponsor: p.sponsor.clone(), at, ip: p.ip.clone() };
            self.images.persist(&tag.hash);
            let public = tag.public();
            self.saved.tags.push(tag);
            self.save();
            self.gc_images();
            self.broadcast(json!({ "t": "tag", "tag": public, "removed": removed, "by": id }));
            return;
        }
        if now < p.next_spray {
            return;
        }
        if self.spray_tokens < 1.0 {
            return p.json(json!({ "t": "notice", "text": "the sky is full of paint, try again in a sec" }));
        }
        self.spray_tokens -= 1.0;
        let p = self.players[id as usize].as_mut().unwrap();
        p.next_spray = now + SPRAY_EVERY_MS;
        p.live_spray = Some((pos, normal));
        self.broadcast(json!({ "t": "spray", "id": id, "pos": pos, "normal": normal, "hash": hash }));
    }

    fn on_json(&mut self, id: u16, serial: u32, v: Value) {
        let now = self.now();
        let Some(p) = self.player(id, serial) else { return };
        match v["t"].as_str() {
            Some("hello") if !p.named => {
                p.name = filter::name(v["name"].as_str().unwrap_or(""), id);
                let sponsor = filter::clean_text(v["sponsor"].as_str().unwrap_or(""), 32);
                p.sponsor = if filter::is_clean(&sponsor) { sponsor } else { String::new() };
                p.named = true;
                let mut join = p.info(id);
                join["t"] = json!("join");
                let players: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| p.as_ref().filter(|p| p.named).map(|p| p.info(i as u16))).collect();
                let sprays: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| {
                    let p = p.as_ref()?;
                    let (pos, normal) = p.live_spray?;
                    Some(json!({ "id": i, "pos": pos, "normal": normal, "hash": p.spray }))
                }).collect();
                let tags: Vec<Value> = self.saved.tags.iter().map(Tag::public).collect();
                let welcome = json!({ "t": "welcome", "id": id, "level": self.level.name, "round": self.round(), "promo": self.saved.promo, "board": self.board(), "players": players, "sprays": sprays, "tags": tags });
                self.players[id as usize].as_ref().unwrap().json(welcome);
                self.broadcast(join);
            }
            Some(t @ ("spray" | "tag")) => {
                if let (Some(pos), Some(normal)) = (v3(&v["pos"]), unit_normal(&v["normal"])) {
                    self.on_spray(id, pos, normal, t == "tag");
                }
            }
            Some("reload") => {
                let w = (p.flags >> 2) as usize % 3;
                if p.reload_until.is_none() {
                    p.reload_until = Some((w, now + WEAPONS[w].reload));
                }
            }
            Some("promo") => self.on_promo(id, v["text"].as_str().unwrap_or(""), v["url"].as_str().unwrap_or("")),
            _ => {}
        }
    }

    fn on_promo(&mut self, id: u16, text: &str, url: &str) {
        let now = self.now();
        if self.promo_pending.is_none_or(|(w, until)| w != id || now > until) {
            return;
        }
        let p = self.players[id as usize].as_ref().unwrap();
        let text = filter::clean_text(text, 80);
        let err = if text.is_empty() {
            Some("write something first")
        } else if !filter::is_clean(&text) {
            Some("let's keep it friendly")
        } else if self.promo_ips.get(&p.ip).is_some_and(|t| now < t + PROMO_PER_IP_MS) {
            Some("one promo per hour, captain")
        } else {
            None
        };
        let url = match (err, filter::url(url)) {
            (None, Ok(u)) => u,
            (Some(e), _) | (None, Err(e)) => return p.json(json!({ "t": "notice", "text": e })),
        };
        self.promo_ips.insert(p.ip.clone(), now);
        self.promo_pending = None;
        self.saved.promo = Some(Promo { text, url, by: p.name.clone() });
        self.save();
        self.broadcast(json!({ "t": "promo", "promo": self.saved.promo }));
    }

    fn on_state(&mut self, id: u16, serial: u32, pos: V3, yaw: u16, pitch: i16, flags: u8) {
        let now = self.now();
        let racing = self.phase == Phase::Race;
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
                let d = ((pos[0] - p.pos[0]).powi(2) + (pos[1] - p.pos[1]).powi(2) + (pos[2] - p.pos[2]).powi(2)).sqrt();
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
                        Kind::End if t.stage == Some(p.stage + 1) && !p.finished => {
                            p.finished = true;
                            match (p.run_start, p.valid) {
                                (Some(rs), true) if now - rs < level.min_run_ms => events.push(json!({ "t": "invalid", "reason": "that run was faster than physics allows" })),
                                (Some(rs), true) => finished_ms = Some(now - rs),
                                (Some(_), false) => events.push(json!({ "t": "invalid", "reason": "this run had a problem; restart from the start zone" })),
                                (None, _) => {}
                            }
                        }
                        Kind::Pickup => {
                            let w = t.weapon.unwrap_or(0).min(2);
                            if !p.owned[w] {
                                p.owned[w] = true;
                                p.ammo[w] = WEAPONS[w].mag;
                                events.push(json!({ "t": "pickup", "weapon": w }));
                            }
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
            p.finished = false;
        } else if p.in_start {
            p.run_start = Some(now);
        }
        p.in_start = in_start;

        p.pos = pos;
        p.yaw = yaw;
        p.pitch = pitch;
        p.flags = flags & !2;
        p.has_state = true;
        p.last_state = now;
        p.hist.push_back((now, pos, flags & 1 != 0));
        while p.hist.front().is_some_and(|e| e.0 + 1100 < now) {
            p.hist.pop_front();
        }
        for e in events {
            p.json(e);
        }
        if let Some(ms) = finished_ms {
            let name = p.name.clone();
            self.finish(id, name, ms, racing);
        }
    }

    fn finish(&mut self, id: u16, name: String, ms: u32, racing: bool) {
        let best = &mut self.saved.best;
        match best.iter_mut().find(|b| b.name == name) {
            Some(b) if ms < b.ms => b.ms = ms,
            Some(_) => {}
            None => best.push(Best { name: name.clone(), ms }),
        }
        best.sort_by_key(|b| b.ms);
        best.truncate(10);
        if racing {
            match self.saved.wins.iter_mut().find(|w| w.name == name) {
                Some(w) => w.wins += 1,
                None => self.saved.wins.push(Wins { name: name.clone(), wins: 1 }),
            }
            self.saved.wins.sort_by(|a, b| b.wins.cmp(&a.wins));
            self.saved.wins.truncate(10);
            let now = self.now();
            self.phase = Phase::Intermission;
            self.phase_ends = now + INTERMISSION_MS;
            self.promo_pending = Some((id, now + PROMO_WINDOW_MS));
            self.tag_pending = Some((id, now + INTERMISSION_MS));
            self.broadcast(json!({ "t": "round", "phase": "intermission", "endsAt": self.phase_ends, "winner": name, "ms": ms }));
            self.players[id as usize].as_ref().unwrap().json(json!({ "t": "promptPromo" }));
        }
        self.save();
        self.broadcast(self.board());
    }

    fn on_shot(&mut self, id: u16, serial: u32, origin: V3, dir: V3, view_time: u32, w: usize) {
        let now = self.now();
        if self.phase != Phase::Race || w >= WEAPONS.len() {
            return;
        }
        let wp = &WEAPONS[w];
        let Some(p) = self.player(id, serial) else { return };
        if p.dead_until.is_some() || !p.owned[w] || !p.has_state {
            return;
        }
        if let Some((rw, until)) = p.reload_until {
            if now >= until {
                p.ammo[rw] = WEAPONS[rw].mag;
                p.reload_until = None;
            } else if rw == w {
                return;
            }
        }
        // 30ms of slack for network jitter between consecutive shots.
        if now + 30 < p.next_fire {
            return;
        }
        if p.ammo[w] == 0 {
            p.reload_until = Some((w, now + wp.reload));
            return;
        }
        let eye = [p.pos[0], p.pos[1], p.pos[2] + if p.ducked() { 28.0 } else { 64.0 }];
        let off = ((origin[0] - eye[0]).powi(2) + (origin[1] - eye[1]).powi(2) + (origin[2] - eye[2]).powi(2)).sqrt();
        let dl = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        // The server's copy of the shooter is up to a state packet stale; at surf speeds that's a few hundred units.
        if off > 450.0 || dl < 0.5 {
            return;
        }
        p.next_fire = now + wp.cd;
        p.ammo[w] -= 1;
        let dir = dir.map(|v| v / dl);
        let t = view_time.clamp(now.saturating_sub(1000), now);

        let mut hits: HashMap<u16, (i32, V3)> = HashMap::new();
        for _ in 0..wp.pellets {
            let (a, b, c) = (self.rand() - 0.5, self.rand() - 0.5, self.rand() - 0.5);
            let s = wp.spread * 2.0;
            let d = [dir[0] + a * s, dir[1] + b * s, dir[2] + c * s];
            let mut best: Option<(f32, u16)> = None;
            for (qi, q) in self.players.iter().enumerate() {
                let Some(q) = q else { continue };
                if qi == id as usize || !q.has_state || q.dead_until.is_some() {
                    continue;
                }
                let (qp, ducked) = q.pos_at(t);
                let r = wp.radius;
                let min = [qp[0] + HULL_MIN[0] - r, qp[1] + HULL_MIN[1] - r, qp[2] - r];
                let max = [qp[0] + HULL_MAX[0] + r, qp[1] + HULL_MAX[1] + r, qp[2] + if ducked { 36.0 } else { 72.0 } + r];
                if let Some(dist) = ray_box(origin, d, min, max) {
                    if dist < SHOT_RANGE && best.is_none_or(|b| dist < b.0) {
                        best = Some((dist, qi as u16));
                    }
                }
            }
            if let Some((_, q)) = best {
                let e = hits.entry(q).or_insert((0, [0.0; 3]));
                e.0 += wp.dmg;
                for i in 0..3 {
                    e.1[i] += dir[i] * wp.kb;
                }
            }
        }

        let shooter_name = self.players[id as usize].as_ref().unwrap().name.clone();
        let mut sunk: Vec<(u16, Value)> = Vec::new();
        for (q, (dmg, kb)) in &hits {
            let v = self.players[*q as usize].as_mut().unwrap();
            v.hp -= dmg;
            v.json(json!({ "t": "hit", "hp": v.hp.max(0), "kb": kb, "by": shooter_name }));
            if v.hp <= 0 {
                v.dead_until = Some(now + RESPAWN_MS);
                v.deaths += 1;
                sunk.push((*q, json!({ "t": "sunk", "id": q, "name": v.name, "by": id, "byName": shooter_name, "w": w })));
            }
        }
        if !hits.is_empty() {
            let shooter = self.players[id as usize].as_mut().unwrap();
            shooter.kills += sunk.len() as u32;
            shooter.json(json!({ "t": "hitmark" }));
        }
        // Killfeed goes to the shooter and whoever is nearby; a full-server broadcast per sinking is O(N^2) in a crowd.
        for (q, s) in sunk {
            let txt: Utf8Bytes = s.to_string().into();
            let (cx, cy, cz) = cell_of(self.players[q as usize].as_ref().unwrap().pos);
            let mut sent_shooter = false;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        for &r in self.cells.get(&(cx + dx, cy + dy, cz + dz)).into_iter().flatten() {
                            if let Some(Some(r)) = self.players.get(r as usize) {
                                r.send(Message::Text(txt.clone()));
                            }
                            sent_shooter |= r == id;
                        }
                    }
                }
            }
            if !sent_shooter {
                self.players[id as usize].as_ref().unwrap().send(Message::Text(txt.clone()));
            }
        }

        // ponytail: rays ignore level geometry (no shooting through ramps check); add a brush ray test if cover matters.
        // Tracers ride along with the next snapshot to everyone near the shooter.
        self.fx.entry(cell_of(origin)).or_default().extend_from_slice(&proto::fx(id, w as u8, origin, dir));
    }

    pub fn tick(&mut self) {
        let now = self.now();
        self.ticks += 1;
        self.spray_tokens = (self.spray_tokens + SPRAYS_PER_SEC * (now - self.spray_refill.min(now)) as f32 / 1000.0).min(SPRAYS_PER_SEC);
        self.spray_refill = now;
        // Scoreboard numbers, once a second. ponytail: skipped on huge servers, where it'd be O(N^2) per second.
        let named = self.players.iter().flatten().filter(|p| p.named).count();
        if self.ticks % FAR_EVERY == 10 && named <= ROSTER_MAX {
            let rows: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| {
                let p = p.as_ref().filter(|p| p.named)?;
                Some(json!([i, p.stage, p.kills, p.deaths, p.finished]))
            }).collect();
            self.broadcast(json!({ "t": "roster", "p": rows }));
        }

        if now >= self.phase_ends {
            if self.phase == Phase::Race {
                self.phase = Phase::Intermission;
                self.phase_ends = now + INTERMISSION_MS;
                self.broadcast(json!({ "t": "round", "phase": "intermission", "endsAt": self.phase_ends }));
            } else {
                self.phase = Phase::Race;
                self.phase_ends = now + ROUND_MS;
                self.promo_pending = None;
                self.tag_pending = None;
                for p in self.players.iter_mut().flatten() {
                    p.reset_run();
                }
                self.broadcast(json!({ "t": "round", "phase": "race", "endsAt": self.phase_ends }));
            }
        }
        for p in self.players.iter_mut().flatten() {
            if p.dead_until.is_some_and(|t| now >= t) {
                p.dead_until = None;
                p.hp = 100;
            }
        }

        // Interest management: bucket players by cell, encode each cell once, share the bytes.
        self.cells.clear();
        for (i, p) in self.players.iter().enumerate() {
            if let Some(p) = p.as_ref().filter(|p| p.has_state) {
                self.cells.entry(cell_of(p.pos)).or_default().push(i as u16);
            }
        }
        let record = |buf: &mut Vec<u8>, i: u16, p: &Player| {
            let flags = (p.flags & 1) | if p.dead_until.is_some() { 2 } else { 0 } | (p.flags & 0b1100);
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
        // Far view: a rotating window of everyone, so bandwidth stays flat as the server fills up.
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
        // Everyone in the same cell sees the same 3x3x3 neighbourhood: build it once, share it.
        let mut views: HashMap<(i32, i32, i32), Bytes> = HashMap::with_capacity(self.cells.len());
        for p in self.players.iter().flatten().filter(|p| p.named) {
            if let Some(far) = &far {
                p.send(Message::Binary(far.clone()));
            }
            if !p.has_state {
                continue;
            }
            let c = cell_of(p.pos);
            let (encoded, fx, ticks) = (&encoded, &self.fx, self.ticks as usize);
            let view = views.entry(c).or_insert_with(|| {
                let mut recs = Vec::new();
                let mut fxs = Vec::new();
                for dx in -1..=1 {
                    for dy in -1..=1 {
                        for dz in -1..=1 {
                            let k = (c.0 + dx, c.1 + dy, c.2 + dz);
                            recs.extend_from_slice(encoded.get(&k).map_or(&[][..], |v| v));
                            fxs.extend_from_slice(fx.get(&k).map_or(&[][..], |v| v));
                        }
                    }
                }
                // Crowded? Send a rotating window so every boat still updates, just less often.
                let total = recs.len() / proto::SNAP_RECORD;
                let n = total.min(NEAR_CAP);
                let mut buf = Vec::with_capacity(proto::SNAP_HEADER + n * proto::SNAP_RECORD + fxs.len());
                if n > 0 {
                    proto::snap_header(&mut buf, now, n as u16);
                    let off = ticks * NEAR_CAP % total;
                    for j in 0..n {
                        let r = (off + j) % total * proto::SNAP_RECORD;
                        buf.extend_from_slice(&recs[r..r + proto::SNAP_RECORD]);
                    }
                }
                buf.extend_from_slice(&fxs);
                Bytes::from(buf)
            });
            if !view.is_empty() {
                p.send(Message::Binary(view.clone()));
            }
        }
        self.fx.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game() -> Game {
        // Test clocks start at ~0ms, so simulated wins would trip the level's real minRunMs floor.
        let mut g = Game::new(Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/cloud-harbor.json")), None, 100, images::Store::new(None));
        g.level.min_run_ms = 0;
        g
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

    fn shot(origin: V3, dir: V3, t: u32) -> Bytes {
        let mut b = vec![2u8];
        for v in origin.iter().chain(dir.iter()) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&t.to_le_bytes());
        b.push(0);
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

    #[test]
    fn lag_compensated_shot_hits_where_target_was() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Shooter");
        let (b, sb, mut rb) = join(&mut g, "Target");
        g.handle(Inbound::Bin(a, sa, state([0.0, 0.0, 0.0], 0)));
        // Target was at x=500 at time t0, then moved far away.
        g.players[b as usize].as_mut().unwrap().hist.push_back((0, [500.0, 0.0, 0.0], false));
        g.handle(Inbound::Bin(b, sb, state([500.0, 3000.0, 0.0], 0)));
        texts(&mut ra);
        texts(&mut rb);
        g.handle(Inbound::Bin(a, sa, shot([0.0, 0.0, 64.0], [1.0, 0.0, -0.05], 0)));
        let hit = texts(&mut rb).into_iter().find(|m| m["t"] == "hit").expect("target should be hit at its old position");
        assert_eq!(hit["hp"], 100 - WEAPONS[0].dmg);
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "hitmark"));
    }

    #[test]
    fn checkpoint_skip_and_speed_hacks_are_rejected() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Cheater");
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        g.handle(Inbound::Bin(a, sa, state([sp[0], sp[1] + 400.0, sp[2]], 0))); // leave the start zone
        assert!(g.players[a as usize].as_ref().unwrap().run_start.is_some());
        // Teleporting to stage 3's spawn without earning it.
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[3].pos, 2)));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "invalid"));
        assert!(!g.players[a as usize].as_ref().unwrap().valid);

        let (b, sb, mut rb) = join(&mut g, "Speedy");
        g.handle(Inbound::Bin(b, sb, state(sp, 0)));
        g.handle(Inbound::Bin(b, sb, state([sp[0], sp[1] + 20000.0, sp[2]], 0)));
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "invalid" && m["reason"] == "moved impossibly fast"));
    }

    #[test]
    fn a_legit_run_advances_stages_through_real_packets() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Legit");
        let sp = g.level.spawns[0].pos;
        let cp = g.level.triggers.iter().find(|t| t.kind == Kind::Checkpoint && t.stage == Some(1)).unwrap();
        let (cx, cy, cz, sp1) = ((cp.min[0] + cp.max[0]) / 2.0, cp.min[1], cp.min[2] + 10.0, g.level.spawns[1].pos);
        let mid = |y: f32| [cx, y, cz];
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        g.handle(Inbound::Bin(a, sa, state([sp[0], sp[1] + 300.0, sp[2]], 0))); // leave the start zone: clock starts
        // Surf along (teleport to the platform's approach is fine as long as speed stays plausible)...
        let p = g.players[a as usize].as_mut().unwrap();
        p.pos = mid(cy - 200.0);
        // ...cross into the checkpoint, then the client's pre-teleport flush, then the teleport to stage 2's spawn.
        g.handle(Inbound::Bin(a, sa, state(mid(cy + 40.0), 0)));
        g.handle(Inbound::Bin(a, sa, state(mid(cy + 60.0), 0)));
        g.handle(Inbound::Bin(a, sa, state(sp1, 2)));
        let p = g.players[a as usize].as_ref().unwrap();
        assert_eq!(p.stage, 1);
        assert!(p.valid, "{:?}", texts(&mut ra));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "split" && m["stage"] == 1));
    }

    #[test]
    fn first_valid_finish_wins_the_round_and_gets_the_promo() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Winner");
        let (_b, _sb, mut rb) = join(&mut g, "Watcher");
        let now = g.now();
        let stages = g.level.spawns.len();
        let end = g.level.triggers.iter().find(|t| t.kind == Kind::End).unwrap();
        let before = [(end.min[0] + end.max[0]) / 2.0, end.min[1] - 100.0, end.min[2] + 10.0];
        let inside = [before[0], end.min[1] + 50.0, before[2]];
        let p = g.players[a as usize].as_mut().unwrap();
        // Pretend a legit run: on the last stage, clock running, standing just before the end trigger.
        p.stage = stages - 1;
        p.run_start = Some(0);
        p.has_state = true;
        p.pos = before;
        p.last_state = now;
        g.handle(Inbound::Bin(a, sa, state(inside, 0)));
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "round" && m["winner"] == "Winner"));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "promptPromo"));
        g.handle(Inbound::Text(a, sa, json!({ "t": "promo", "text": "Visit my bakery", "url": "https://bakery.example" }).to_string().into()));
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "promo" && m["promo"]["text"] == "Visit my bakery"));
        assert_eq!(g.saved.wins[0].name, "Winner");
    }

    fn png(seed: u8) -> Bytes {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[seed; 32]);
        b.into()
    }

    fn upload(kind: u8, img: &Bytes) -> Bytes {
        let mut b = vec![kind];
        b.extend_from_slice(img);
        b.into()
    }

    // Puts player `a` one packet away from a valid finish, then crosses the line.
    fn win(g: &mut Game, a: u16, sa: u32, run_ms: u32) {
        let now = g.now();
        let stages = g.level.spawns.len();
        let end = g.level.triggers.iter().find(|t| t.kind == Kind::End).unwrap();
        let before = [(end.min[0] + end.max[0]) / 2.0, end.min[1] - 100.0, end.min[2] + 10.0];
        let inside = [before[0], end.min[1] + 50.0, before[2]];
        let p = g.players[a as usize].as_mut().unwrap();
        p.stage = stages - 1;
        p.run_start = Some(now.saturating_sub(run_ms));
        p.has_state = true;
        p.pos = before;
        p.last_state = now;
        g.handle(Inbound::Bin(a, sa, state(inside, 0)));
    }

    fn spray_msg(t: &str, pos: V3) -> Utf8Bytes {
        json!({ "t": t, "pos": pos, "normal": [0.0, -1.0, 0.0] }).to_string().into()
    }

    #[test]
    fn uploads_must_be_images_and_are_freed_on_leave() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Uploader");
        let (_b, _sb, mut rb) = join(&mut g, "Viewer");
        g.handle(Inbound::Bin(a, sa, upload(3, &Bytes::from_static(b"<svg onload=alert(1)></svg>"))));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "notice"));
        g.players[a as usize].as_mut().unwrap().last_upload = [0; 2];
        g.handle(Inbound::Bin(a, sa, upload(3, &png(1))));
        let h = images::hash(&png(1));
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "profile" && m["flag"] == h.as_str()));
        assert!(g.images.get(&h).is_some());
        g.handle(Inbound::Leave(a, sa));
        assert!(g.images.get(&h).is_none(), "image should be freed when its owner leaves");
    }

    #[test]
    fn sprays_need_range_and_cooldown() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Tagger");
        g.handle(Inbound::Bin(a, sa, state([0.0, 0.0, 0.0], 0)));
        g.handle(Inbound::Bin(a, sa, upload(4, &png(2))));
        texts(&mut ra);
        g.handle(Inbound::Text(a, sa, spray_msg("spray", [0.0, 2000.0, 64.0]))); // too far
        assert!(!texts(&mut ra).iter().any(|m| m["t"] == "spray"));
        g.handle(Inbound::Text(a, sa, spray_msg("spray", [0.0, 200.0, 64.0])));
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "spray"));
        g.handle(Inbound::Text(a, sa, spray_msg("spray", [0.0, 210.0, 64.0]))); // cooldown
        assert!(!texts(&mut ra).iter().any(|m| m["t"] == "spray"));
    }

    #[test]
    fn winners_tag_the_map_permanently_and_can_be_painted_over() {
        let dir = std::env::temp_dir().join(format!("skysurf-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let level = || Level { min_run_ms: 0, ..Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/cloud-harbor.json")) };
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))));
        let (a, sa, mut ra) = join(&mut g, "Champ");
        let (b, sb, mut rb) = join(&mut g, "Loser");
        g.handle(Inbound::Bin(a, sa, upload(4, &png(3))));
        // Losers can't tag.
        let wall = |g: &Game, id: u16| { let e = g.players[id as usize].as_ref().unwrap().eye(); [e[0], e[1] + 100.0, e[2]] };
        g.handle(Inbound::Bin(b, sb, state([0.0, 0.0, 0.0], 0)));
        g.handle(Inbound::Text(b, sb, spray_msg("tag", wall(&g, b))));
        assert!(g.saved.tags.is_empty());

        win(&mut g, a, sa, 60_000);
        let spot = wall(&g, a);
        g.handle(Inbound::Text(a, sa, spray_msg("tag", spot)));
        assert_eq!(g.saved.tags.len(), 1);
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "tag" && m["tag"]["name"] == "Champ"));
        g.handle(Inbound::Text(a, sa, spray_msg("tag", spot))); // only one tag per win
        assert_eq!(g.saved.tags.len(), 1);
        texts(&mut ra);

        // Survives a restart, image included.
        drop(g);
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))));
        assert_eq!(g.saved.tags.len(), 1);
        assert!(g.images.get(&images::hash(&png(3))).is_some());

        // A new winner spraying the same spot paints over the old tag.
        let (c, sc, _rc) = join(&mut g, "Usurper");
        g.handle(Inbound::Bin(c, sc, upload(4, &png(4))));
        win(&mut g, c, sc, 60_000);
        let p = g.players[c as usize].as_mut().unwrap();
        p.pos = [spot[0], spot[1] - 100.0, spot[2] - 64.0];
        g.handle(Inbound::Text(c, sc, spray_msg("tag", spot)));
        assert_eq!(g.saved.tags.len(), 1);
        assert_eq!(g.saved.tags[0].name, "Usurper");
        assert!(g.images.get(&images::hash(&png(3))).is_none(), "covered tag's image is freed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tag_cap_evicts_the_oldest_and_bans_remove_tags() {
        let mut g = game();
        for i in 0..TAG_CAP as u32 {
            g.saved.tags.push(Tag { id: i + 1, hash: "x".into(), pos: [i as f32 * 1000.0, 0.0, 0.0], normal: [0.0, -1.0, 0.0], name: "old".into(), sponsor: String::new(), at: 0, ip: "9.9.9.9".into() });
        }
        g.saved.next_tag = TAG_CAP as u32;
        let (a, sa, _ra) = join(&mut g, "Newest");
        g.handle(Inbound::Bin(a, sa, upload(4, &png(5))));
        win(&mut g, a, sa, 60_000);
        let e = g.players[a as usize].as_ref().unwrap().eye();
        g.handle(Inbound::Text(a, sa, spray_msg("tag", [e[0], e[1] + 100.0, e[2]])));
        assert_eq!(g.saved.tags.len(), TAG_CAP);
        assert!(g.saved.tags.iter().all(|t| t.id != 1), "oldest evicted");
        g.handle(Inbound::Admin(Admin::Ban("9.9.9.9".into())));
        assert_eq!(g.saved.tags.len(), 1);
    }

    #[test]
    fn impossibly_fast_runs_are_rejected() {
        let mut g = game();
        g.level.min_run_ms = 30_000;
        let (a, sa, mut ra) = join(&mut g, "Hacker");
        win(&mut g, a, sa, 5_000);
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "invalid"));
        assert!(g.saved.wins.is_empty());
    }
}
