// One task owns all game state. Sockets talk to it over channels, so there are no locks on the hot path.
use crate::{filter, level::*, proto};
use axum::extract::ws::{Message, Utf8Bytes};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
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
const INTERMISSION_MS: u32 = 15_000;
const PROMO_WINDOW_MS: u32 = 20_000;
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
}

impl Player {
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
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    best: Vec<Best>,
    wins: Vec<Wins>,
    promo: Option<Promo>,
    banned: Vec<String>,
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
    promo_ips: HashMap<String, u32>,
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
    pub fn new(level: Level, data_dir: Option<PathBuf>, max_per_ip: usize) -> Game {
        let data_path = data_dir.map(|d| {
            std::fs::create_dir_all(&d).expect("creating data dir");
            d.join("state.json")
        });
        let saved = data_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
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
            promo_ips: HashMap::new(),
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
                if !self.saved.banned.contains(&ip) {
                    self.saved.banned.push(ip);
                }
                self.save();
            }
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
        }
    }

    fn on_json(&mut self, id: u16, serial: u32, v: Value) {
        let now = self.now();
        let Some(p) = self.player(id, serial) else { return };
        match v["t"].as_str() {
            Some("hello") if !p.named => {
                p.name = filter::name(v["name"].as_str().unwrap_or(""), id);
                p.named = true;
                let (name, color) = (p.name.clone(), p.color.clone());
                let players: Vec<Value> = self.players.iter().enumerate().filter_map(|(i, p)| p.as_ref().filter(|p| p.named).map(|p| json!({ "id": i, "name": p.name, "color": p.color }))).collect();
                let welcome = json!({ "t": "welcome", "id": id, "level": self.level.name, "round": self.round(), "promo": self.saved.promo, "board": self.board(), "players": players });
                self.players[id as usize].as_ref().unwrap().json(welcome);
                self.broadcast(json!({ "t": "join", "id": id, "name": name, "color": color }));
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
        let mut sunk = Vec::new();
        for (q, (dmg, kb)) in &hits {
            let v = self.players[*q as usize].as_mut().unwrap();
            v.hp -= dmg;
            v.json(json!({ "t": "hit", "hp": v.hp.max(0), "kb": kb, "by": shooter_name }));
            if v.hp <= 0 {
                v.dead_until = Some(now + RESPAWN_MS);
                sunk.push((*q, json!({ "t": "sunk", "id": q, "name": v.name, "by": id, "byName": shooter_name })));
            }
        }
        if !hits.is_empty() {
            self.players[id as usize].as_ref().unwrap().json(json!({ "t": "hitmark" }));
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

        // Tracers ride along with the next snapshot to everyone near the shooter.
        self.fx.entry(cell_of(origin)).or_default().extend_from_slice(&proto::fx(id, w as u8, origin, dir));
    }

    pub fn tick(&mut self) {
        let now = self.now();
        self.ticks += 1;

        if now >= self.phase_ends {
            if self.phase == Phase::Race {
                self.phase = Phase::Intermission;
                self.phase_ends = now + INTERMISSION_MS;
                self.broadcast(json!({ "t": "round", "phase": "intermission", "endsAt": self.phase_ends }));
            } else {
                self.phase = Phase::Race;
                self.phase_ends = now + ROUND_MS;
                self.promo_pending = None;
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
        Game::new(Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/cloud-harbor.json")), None, 100)
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
}
