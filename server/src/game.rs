// One task owns all game state. Sockets talk to it over channels, so there are no locks on the hot path.
use crate::{filter, images, level::*, proto};
use axum::extract::ws::{Message, Utf8Bytes};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, Instant, MissedTickBehavior, interval};

const TICK_MS: u64 = 50;
const FAR_EVERY: u64 = 20; // far view once a second; nearby cells every tick
const FAR_CAP: usize = 256;
const NEAR_CAP: usize = 96;
const CELL: f32 = 2048.0;
pub const LOBBY_MS: u32 = 20_000;
pub const RACE_MS: u32 = 4 * 60 * 1000;
pub const AFTER_FIRST_MS: u32 = 30_000;
pub const PODIUM_MS: u32 = 12_000;
const UPLOAD_EVERY_MS: u32 = 5_000;
const MAX_SPEED: f32 = 6063.0; // sv_maxvelocity 3500 per axis -> 3500 * sqrt(3)
const GHOST_HZ_DIV: u32 = 2; // record every 2nd state packet (20 Hz -> 10 Hz)
const GHOST_CAP: usize = 2400; // 4 min at 10 Hz
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
    ListBillboards(oneshot::Sender<Value>),
    RemoveBillboard(u32),
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
    states: u32,
    stage: usize,
    in_start: bool,
    run_start: Option<u32>,
    valid: bool,
    finished: Option<u32>, // ms of the finished run this round (0 = invalid finish)
    place: Option<u32>,
    late: bool,
    ghost: Vec<(V3, u16)>,
    sponsor: String,
    flag: Option<String>,
    last_upload: u32,
}

impl Player {
    fn send(&self, m: Message) {
        // A full queue means a slow client: drop the frame rather than buffer without bound.
        let _ = self.out.try_send(m);
    }

    fn json(&self, v: Value) {
        self.send(Message::Text(v.to_string().into()));
    }

    fn info(&self, id: u16) -> Value {
        json!({ "id": id, "name": self.name, "color": self.color, "sponsor": self.sponsor, "flag": self.flag })
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
    sponsor: String,
    ms: u32,
    flag: Option<String>,
    at: u64,
}
// A round winner's ad on one of the course's holographic slots.
#[derive(Serialize, Deserialize, Clone)]
struct Billboard {
    slot: u32,
    hash: Option<String>,
    text: String,
    url: Option<String>,
    name: String,
    sponsor: String,
    at: u64,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    ip: String,
}

impl Billboard {
    fn public(&self) -> Value {
        json!({ "slot": self.slot, "hash": self.hash, "text": self.text, "url": self.url, "name": self.name, "sponsor": self.sponsor, "at": self.at })
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    best: Vec<Best>,
    wins: Vec<Wins>,
    banned: Vec<String>,
    #[serde(default)]
    billboards: Vec<Billboard>,
    #[serde(default)]
    record: Option<Record>,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Phase {
    Lobby,
    Race,
    Podium,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub struct Game {
    level: Level,
    players: Vec<Option<Player>>,
    free: Vec<u16>,
    serial: u32,
    start: Instant,
    phase: Phase,
    phase_ends: u32,
    go: u32,
    next_place: u32,
    results: Vec<(u16, u32, u32)>, // (id, place, ms) this round
    billboard_pending: Option<(u16, u32, u32)>, // winner id, slot, until
    saved: Saved,
    data_dir: Option<PathBuf>,
    images: images::Store,
    ghost: Vec<(V3, u16)>, // the record run
    ghost_frame: Bytes,
    max_per_ip: usize,
    cells: HashMap<(i32, i32, i32), Vec<u16>>,
    ticks: u64,
}

fn cell_of(p: V3) -> (i32, i32, i32) {
    ((p[0] / CELL).floor() as i32, (p[1] / CELL).floor() as i32, (p[2] / CELL).floor() as i32)
}

fn color_for(id: u16) -> String {
    const C: [&str; 10] = ["#ff4d6d", "#ffb703", "#80ed99", "#48cae4", "#b388ff", "#ff7b00", "#00f5d4", "#f72585", "#4cc9f0", "#c9f24a"];
    C[id as usize % C.len()].into()
}

impl Game {
    pub fn new(level: Level, data_dir: Option<PathBuf>, max_per_ip: usize, images: images::Store) -> Game {
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
        for h in saved.billboards.iter().filter_map(|b| b.hash.as_deref()).chain(saved.record.iter().filter_map(|r| r.flag.as_deref())) {
            images.load_persisted(h);
        }
        let ghost_frame = Bytes::from(proto::ghost(&ghost));
        Game {
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
            billboard_pending: None,
            saved,
            data_dir,
            images,
            ghost,
            ghost_frame,
            max_per_ip,
            cells: HashMap::new(),
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

    fn player(&mut self, id: u16, serial: u32) -> Option<&mut Player> {
        self.players.get_mut(id as usize)?.as_mut().filter(|p| p.serial == serial)
    }

    fn broadcast(&self, v: Value) {
        let s: Utf8Bytes = v.to_string().into();
        for p in self.players.iter().flatten().filter(|p| p.named) {
            p.send(Message::Text(s.clone()));
        }
    }

    fn broadcast_bin(&self, b: &Bytes) {
        for p in self.players.iter().flatten().filter(|p| p.named) {
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

    fn phase_name(&self) -> &'static str {
        match self.phase {
            Phase::Lobby => "lobby",
            Phase::Race => "race",
            Phase::Podium => "podium",
        }
    }

    fn round(&self) -> Value {
        json!({ "phase": self.phase_name(), "endsAt": self.phase_ends, "go": self.go, "now": self.now() })
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
                let slots: Vec<u32> = self.saved.billboards.iter().filter(|b| b.ip == ip).map(|b| b.slot).collect();
                self.remove_billboards(&slots);
                if !self.saved.banned.contains(&ip) {
                    self.saved.banned.push(ip);
                }
                self.save();
            }
            Inbound::Admin(Admin::ClearImages) => {
                for p in self.players.iter_mut().flatten() {
                    p.flag = None;
                }
                self.gc_images();
                self.broadcast(json!({ "t": "clearImages" }));
            }
            Inbound::Admin(Admin::ListBillboards(reply)) => {
                let list: Vec<Value> = self.saved.billboards.iter().map(|b| json!({ "slot": b.slot, "image": b.hash.as_ref().map(|h| format!("/img/{h}")), "text": b.text, "url": b.url, "name": b.name, "sponsor": b.sponsor, "ip": b.ip, "at": b.at })).collect();
                let _ = reply.send(json!({ "billboards": list, "record": self.saved.record }));
            }
            Inbound::Admin(Admin::RemoveBillboard(slot)) => self.remove_billboards(&[slot]),
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
            sponsor: String::new(),
            flag: None,
            last_upload: 0,
        });
        Some((id, self.serial))
    }

    fn remove(&mut self, id: u16) {
        if let Some(p) = self.players[id as usize].take() {
            self.free.push(id);
            if p.named {
                self.broadcast(json!({ "t": "leave", "id": id }));
            }
            if p.flag.is_some() {
                self.gc_images();
            }
        }
    }

    fn gc_images(&self) {
        let live: HashSet<String> = self.players.iter().flatten().filter_map(|p| p.flag.clone()).collect();
        let permanent: HashSet<String> = self.saved.billboards.iter().filter_map(|b| b.hash.clone()).chain(self.saved.record.iter().filter_map(|r| r.flag.clone())).collect();
        self.images.retain(&live, &permanent);
    }

    fn remove_billboards(&mut self, slots: &[u32]) {
        if slots.is_empty() {
            return;
        }
        self.saved.billboards.retain(|b| !slots.contains(&b.slot));
        self.save();
        self.gc_images();
        self.broadcast(json!({ "t": "unbillboard", "slots": slots }));
    }

    fn on_image(&mut self, id: u16, serial: u32, b: Bytes) {
        let now = self.now();
        let Some(p) = self.player(id, serial).filter(|p| p.named) else { return };
        if p.last_upload != 0 && now < p.last_upload + UPLOAD_EVERY_MS {
            return p.json(json!({ "t": "notice", "text": "slow down on the uploads" }));
        }
        p.last_upload = now.max(1);
        let Some(h) = self.images.put(b) else {
            return self.players[id as usize].as_ref().unwrap().json(json!({ "t": "notice", "text": "that image didn't work, try a JPG or PNG" }));
        };
        let p = self.players[id as usize].as_mut().unwrap();
        p.flag = Some(h);
        let mut m = p.info(id);
        m["t"] = json!("profile");
        self.gc_images();
        self.broadcast(m);
    }

    fn on_json(&mut self, id: u16, serial: u32, v: Value) {
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
                let billboards: Vec<Value> = self.saved.billboards.iter().map(Billboard::public).collect();
                let welcome = json!({
                    "t": "welcome", "id": id, "level": self.level.name, "round": self.round(), "board": self.board(),
                    "players": players, "billboards": billboards, "record": self.saved.record, "minRunMs": self.level.min_run_ms,
                });
                let me = self.players[id as usize].as_ref().unwrap();
                me.json(welcome);
                if !self.ghost.is_empty() {
                    me.send(Message::Binary(self.ghost_frame.clone()));
                }
                self.broadcast(join);
            }
            Some("billboard") => self.on_billboard(id, v["text"].as_str().unwrap_or(""), v["url"].as_str().unwrap_or("")),
            _ => {}
        }
    }

    fn on_billboard(&mut self, id: u16, text: &str, url: &str) {
        let now = self.now();
        let Some((_, slot, _)) = self.billboard_pending.filter(|(w, _, until)| *w == id && now <= *until) else { return };
        let p = self.players[id as usize].as_ref().unwrap();
        let text = filter::clean_text(text, 80);
        if !filter::is_clean(&text) {
            return p.json(json!({ "t": "notice", "text": "let's keep it friendly" }));
        }
        let url = match filter::url(url) {
            Ok(u) => u,
            Err(e) => return p.json(json!({ "t": "notice", "text": e })),
        };
        self.billboard_pending = None;
        if let Some(b) = self.saved.billboards.iter_mut().find(|b| b.slot == slot) {
            b.text = text;
            b.url = url;
            let public = b.public();
            self.save();
            self.broadcast(json!({ "t": "billboard", "board": public }));
        }
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
                p.finished = None; // an invalid finish doesn't lock the round out
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
        // Record the run for a possible ghost, only while it could still beat the record.
        if let Some(rs) = p.run_start {
            if p.valid && p.finished.is_none() && p.states % GHOST_HZ_DIV == 0 && record_ms.is_none_or(|r| now - rs < r + 500) && p.ghost.len() < GHOST_CAP {
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
        let now = self.now();
        let p = self.players[id as usize].as_mut().unwrap();
        let (name, sponsor, flag, late) = (p.name.clone(), p.sponsor.clone(), p.flag.clone(), p.late);
        let ghost = std::mem::take(&mut p.ghost);

        let best = &mut self.saved.best;
        match best.iter_mut().find(|b| b.name == name) {
            Some(b) if ms < b.ms => b.ms = ms,
            Some(_) => {}
            None => best.push(Best { name: name.clone(), ms }),
        }
        best.sort_by_key(|b| b.ms);
        best.truncate(10);

        let mut is_record = false;
        if self.saved.record.as_ref().is_none_or(|r| ms < r.ms) {
            is_record = true;
            if let Some(h) = &flag {
                self.images.persist(h);
            }
            self.saved.record = Some(Record { name: name.clone(), sponsor: sponsor.clone(), ms, flag: flag.clone(), at: unix_now() });
            if !ghost.is_empty() {
                self.ghost = ghost;
                self.ghost_frame = Bytes::from(proto::ghost(&self.ghost));
                self.save_ghost();
                self.broadcast_bin(&self.ghost_frame);
            }
            self.broadcast(json!({ "t": "record", "record": self.saved.record }));
        }

        let mut place = None;
        if racing && !late {
            let pl = self.next_place;
            self.next_place += 1;
            place = Some(pl);
            self.results.push((id, pl, ms));
            self.players[id as usize].as_mut().unwrap().place = Some(pl);
            if pl == 1 {
                self.phase_ends = self.phase_ends.min(now + AFTER_FIRST_MS);
                match self.saved.wins.iter_mut().find(|w| w.name == name) {
                    Some(w) => w.wins += 1,
                    None => self.saved.wins.push(Wins { name: name.clone(), wins: 1 }),
                }
                self.saved.wins.sort_by(|a, b| b.wins.cmp(&a.wins));
                self.saved.wins.truncate(10);
                self.claim_billboard(id, name.clone(), sponsor, flag);
            }
            self.broadcast(json!({ "t": "placed", "id": id, "name": name, "place": pl, "ms": ms, "endsAt": self.phase_ends }));
        }
        self.players[id as usize].as_ref().unwrap().json(json!({ "t": "finish", "ms": ms, "place": place, "record": is_record, "late": late || !racing }));
        self.save();
        self.broadcast(self.board());
    }

    // The round winner takes the best free slot, or bumps the oldest ad on the course.
    fn claim_billboard(&mut self, id: u16, name: String, sponsor: String, flag: Option<String>) {
        let taken: HashSet<u32> = self.saved.billboards.iter().map(|b| b.slot).collect();
        let slot = match self.level.billboards.iter().map(|s| s.id).filter(|s| *s != 0 && !taken.contains(s)).min() {
            Some(s) => s,
            None => match self.saved.billboards.iter().min_by_key(|b| b.at).map(|b| b.slot) {
                Some(s) => s,
                None => return,
            },
        };
        self.saved.billboards.retain(|b| b.slot != slot);
        if let Some(h) = &flag {
            self.images.persist(h);
        }
        let ip = self.players[id as usize].as_ref().unwrap().ip.clone();
        let b = Billboard { slot, hash: flag, text: String::new(), url: None, name, sponsor, at: unix_now(), ip };
        let public = b.public();
        self.saved.billboards.push(b);
        self.save();
        self.gc_images();
        self.billboard_pending = Some((id, slot, self.now() + PODIUM_MS + LOBBY_MS + AFTER_FIRST_MS));
        self.broadcast(json!({ "t": "billboard", "board": public, "winner": id }));
        self.players[id as usize].as_ref().unwrap().json(json!({ "t": "promptBillboard", "slot": slot }));
    }

    fn set_phase(&mut self, phase: Phase) {
        let now = self.now();
        self.phase = phase;
        match phase {
            Phase::Lobby => {
                self.phase_ends = now + LOBBY_MS;
                self.broadcast(json!({ "t": "round", "phase": "lobby", "endsAt": self.phase_ends, "now": now }));
            }
            Phase::Race => {
                self.go = now;
                self.phase_ends = now + RACE_MS;
                self.next_place = 1;
                self.results.clear();
                for p in self.players.iter_mut().flatten() {
                    p.reset_run();
                    p.late = false;
                }
                self.broadcast(json!({ "t": "round", "phase": "race", "endsAt": self.phase_ends, "go": now, "now": now }));
            }
            Phase::Podium => {
                self.phase_ends = now + PODIUM_MS;
                let results: Vec<Value> = self.results.iter().take(3).map(|(id, place, ms)| {
                    let p = self.players[*id as usize].as_ref();
                    json!({ "id": id, "place": place, "ms": ms, "name": p.map(|p| p.name.clone()), "sponsor": p.map(|p| p.sponsor.clone()), "flag": p.and_then(|p| p.flag.clone()) })
                }).collect();
                let finishers = self.results.len();
                self.broadcast(json!({ "t": "round", "phase": "podium", "endsAt": self.phase_ends, "now": now, "results": results, "finishers": finishers }));
            }
        }
    }

    pub fn tick(&mut self) {
        let now = self.now();
        self.ticks += 1;

        if now >= self.phase_ends {
            match self.phase {
                Phase::Lobby => self.set_phase(Phase::Race),
                Phase::Race => self.set_phase(Phase::Podium),
                Phase::Podium => self.set_phase(Phase::Lobby),
            }
        }

        // Scoreboard numbers, once a second. ponytail: skipped on huge servers, where it'd be O(N^2) per second.
        let named = self.players.iter().flatten().filter(|p| p.named).count();
        if self.ticks % FAR_EVERY == 10 && named <= ROSTER_MAX {
            let rows: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| {
                let p = p.as_ref().filter(|p| p.named)?;
                Some(json!([i, p.stage, p.finished.unwrap_or(0), p.place.unwrap_or(0), p.late]))
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
                // Crowded? Send a rotating window so every glider still updates, just less often.
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
        Game::new(level(), None, 100, images::Store::new(None))
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

    // Packets may only move ~300u at test speed, so put the player just short of `pos` first, then step into it.
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

    fn bins(rx: &mut mpsc::Receiver<Message>) -> Vec<Bytes> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            if let Message::Binary(b) = m {
                out.push(b);
            }
        }
        out
    }

    fn png(seed: u8) -> Bytes {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[seed; 32]);
        b.into()
    }

    // Leaves the start zone (clock starts) then, `run_ms` later, crosses the finish line via real packets.
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
        // run_start is in the past, so the finish's elapsed time is `run_ms` + a few ms.
    }

    #[test]
    fn a_legit_run_advances_stages_through_real_packets() {
        let mut g = game();
        g.set_phase(Phase::Race);
        let (a, sa, mut ra) = join(&mut g, "Legit");
        let sp = g.level.spawns[0].pos;
        let cp = g.level.triggers.iter().find(|t| t.kind == Kind::Checkpoint && t.stage == Some(1)).unwrap();
        let (cx, cy, cz) = ((cp.min[0] + cp.max[0]) / 2.0, cp.min[1], (cp.min[2] + cp.max[2]) / 2.0);
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(&mut g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]); // leave the start zone: clock starts
        assert!(g.players[a as usize].as_ref().unwrap().run_start.is_some());
        walk(&mut g, a, sa, [cx, cy + 60.0, cz]);
        let p = g.players[a as usize].as_ref().unwrap();
        assert_eq!(p.stage, 1);
        assert!(p.valid);
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "split" && m["stage"] == 1));
    }

    #[test]
    fn skips_and_speed_hacks_are_rejected() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Cheater");
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(&mut g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]);
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[3].pos, 2))); // teleport to a spawn you haven't earned
        assert!(texts(&mut ra).iter().any(|m| m["t"] == "invalid"));
        let (b, sb, mut rb) = join(&mut g, "Speedy");
        g.handle(Inbound::Bin(b, sb, state(sp, 0)));
        g.handle(Inbound::Bin(b, sb, state([sp[0], sp[1] + 20000.0, sp[2]], 0)));
        assert!(texts(&mut rb).iter().any(|m| m["t"] == "invalid" && m["reason"] == "moved impossibly fast"));
        let mut g2 = game();
        g2.level.min_run_ms = 30_000;
        g2.set_phase(Phase::Race);
        let (c, sc, mut rc) = join(&mut g2, "Hacker");
        race(&mut g2, c, sc, 5_000);
        assert!(texts(&mut rc).iter().any(|m| m["t"] == "invalid" && m["reason"].as_str().unwrap().contains("faster")));
        assert!(g2.saved.wins.is_empty());
    }

    #[test]
    fn placement_winner_billboard_and_late_joiners() {
        let mut g = game();
        let (a, sa, mut ra) = join(&mut g, "Alpha");
        let (b, sb, mut rb) = join(&mut g, "Bravo");
        g.handle(Inbound::Bin(a, sa, state(g.level.spawns[0].pos, 0)));
        g.handle(Inbound::Bin(b, sb, state(g.level.spawns[0].pos, 0)));
        g.handle(Inbound::Bin(a, sa, upload(&png(1))));
        g.set_phase(Phase::Race);
        texts(&mut ra);
        texts(&mut rb);
        race(&mut g, a, sa, 40_000);
        race(&mut g, b, sb, 41_000);
        let fa = texts(&mut ra).into_iter().find(|m| m["t"] == "finish").unwrap();
        assert_eq!(fa["place"], 1);
        assert_eq!(fa["record"], true);
        let fb = texts(&mut rb).into_iter().find(|m| m["t"] == "finish").unwrap();
        assert_eq!(fb["place"], 2);
        // Winner claimed slot 1 with their flag, and only they can write its text.
        assert_eq!(g.saved.billboards.len(), 1);
        assert_eq!(g.saved.billboards[0].slot, 1);
        assert_eq!(g.saved.billboards[0].hash, Some(images::hash(&png(1))));
        g.handle(Inbound::Text(b, sb, json!({ "t": "billboard", "text": "Bravo was here" }).to_string().into()));
        assert_eq!(g.saved.billboards[0].text, "");
        g.handle(Inbound::Text(a, sa, json!({ "t": "billboard", "text": "Alpha Pizza, best in town", "url": "https://alpha.pizza" }).to_string().into()));
        assert_eq!(g.saved.billboards[0].text, "Alpha Pizza, best in town");
        assert_eq!(g.saved.record.as_ref().unwrap().name, "Alpha");
        // A late joiner finishing faster doesn't place and doesn't take the win.
        let (c, sc, mut rc) = join(&mut g, "Late");
        assert!(g.players[c as usize].as_ref().unwrap().late);
        race(&mut g, c, sc, 30_000);
        let fc = texts(&mut rc).into_iter().find(|m| m["t"] == "finish").unwrap();
        assert!(fc["place"].is_null());
        assert_eq!(g.saved.wins[0].name, "Alpha");
        // The round ends 30s after the first finisher, and the podium lists both placers.
        assert!(g.phase_ends <= g.now() + AFTER_FIRST_MS);
        g.set_phase(Phase::Podium);
        let podium = texts(&mut rb).into_iter().find(|m| m["t"] == "round" && m["phase"] == "podium").unwrap();
        assert_eq!(podium["results"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn billboard_slots_fill_then_bump_the_oldest() {
        let mut g = game();
        let n = g.level.billboards.iter().filter(|s| s.id != 0).count() as u32;
        for i in 0..n + 1 {
            let (a, sa, _ra) = join(&mut g, &format!("W{i}"));
            g.handle(Inbound::Bin(a, sa, state(g.level.spawns[0].pos, 0)));
            g.set_phase(Phase::Race);
            race(&mut g, a, sa, 60_000 + i * 1000);
            if i < n {
                g.saved.billboards.iter_mut().find(|b| b.name == format!("W{i}")).unwrap().at = 1000 + i as u64;
            }
        }
        assert_eq!(g.saved.billboards.len() as u32, n);
        assert!(g.saved.billboards.iter().all(|b| b.name != "W0"), "oldest bumped");
        assert!(g.saved.billboards.iter().any(|b| b.name == format!("W{n}") && b.slot == 1));
        g.handle(Inbound::Admin(Admin::Ban("1.2.3.4".into())));
        assert!(g.saved.billboards.is_empty());
    }

    #[test]
    fn record_ghost_is_recorded_persisted_and_sent_to_joiners() {
        let dir = std::env::temp_dir().join(format!("skysurf-v2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))));
        g.set_phase(Phase::Race);
        let (a, sa, _ra) = join(&mut g, "Ghost");
        let sp = g.level.spawns[0].pos;
        g.handle(Inbound::Bin(a, sa, state(sp, 0)));
        walk(&mut g, a, sa, [sp[0], sp[1] + 900.0, sp[2]]);
        for i in 0..40 {
            g.handle(Inbound::Bin(a, sa, state([sp[0], sp[1] + 900.0 + i as f32 * 50.0, sp[2]], 0)));
        }
        assert!(g.players[a as usize].as_ref().unwrap().ghost.len() >= 19);
        race(&mut g, a, sa, 50_000);
        assert!(!g.ghost.is_empty());
        drop(g);
        let mut g = Game::new(level(), Some(dir.clone()), 100, images::Store::new(Some(dir.join("img"))));
        assert!(!g.ghost.is_empty(), "ghost reloaded from disk");
        assert_eq!(g.saved.record.as_ref().unwrap().name, "Ghost");
        let (_b, _sb, mut rb) = join(&mut g, "Newbie");
        assert!(bins(&mut rb).iter().any(|b| b.first() == Some(&3)), "ghost frame sent on welcome");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
