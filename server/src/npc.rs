// NPC racers: server-driven players that ride the racing line with a bit of personality.
use crate::level::{LinePoint, V3};

pub const NAMES: [&str; 16] = ["KOBALT", "MIRA", "DUSK", "VANTA", "JUNO", "RIFT", "HALCYON", "SABLE", "ORRIN", "LYRA", "TESSERACT", "NOVA", "ZEPHYR", "IRIS", "CINDER", "PIXEL"];
pub const LINES: [&str; 12] = ["gg", "nice line", "who put a skull on my wall", "the spiral is cursed", "ok THAT was clean", "lol", "brb painting", "someone beat the ghost already", "long gap or nothing", "that speed gap never gets old", "ez", "wall's mine now"];

pub struct Npc {
    pub idx: usize, // index into the line
    pub t: f32,     // progress along segment idx -> idx+1
    pub speed: f32,
    pub skill: f32, // 0..1: fewer fails, faster
    pub wobble: f32,
    pub wait_until: u32,
    pub done: bool,
    pub chat_at: u32,
    rng: u64,
}

impl Npc {
    pub fn new(seed: u64, now: u32) -> Npc {
        let mut n = Npc { idx: 0, t: 0.0, speed: 0.0, skill: 0.0, wobble: 0.0, wait_until: now, done: false, chat_at: now + 20_000, rng: seed | 1 };
        n.skill = 0.25 + n.rand() * 0.7;
        n.speed = 2300.0 + n.skill * 1100.0; // 46-69 s over the 158k-unit line: the good ones finish, the rest make the podium chase real
        n.wobble = 20.0 + n.rand() * 40.0;
        n.chat_at = now + 30_000 + (n.rand() * 60_000.0) as u32;
        n
    }

    pub fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 40) as f32 / (1u64 << 24) as f32
    }

    // A new race: back to the line's start after a human-like reaction delay.
    pub fn restart(&mut self, now: u32) {
        self.idx = 0;
        self.t = 0.0;
        self.done = false;
        self.wait_until = now + 400 + (self.rand() * 2600.0) as u32;
    }

    // One 50 ms step. Returns the position to report, plus whether this step is a fail-teleport (flags=2).
    pub fn step(&mut self, line: &[LinePoint], spawns: &[V3], now: u32) -> Option<(V3, u16, bool)> {
        if line.len() < 2 || now < self.wait_until || self.done {
            return None;
        }
        let stage = line[self.idx].stage;
        // Occasional fails, fewer for skilled NPCs, never on the first segment of a stage.
        if self.idx > 0 && line[self.idx - 1].stage == stage && self.rand() < 0.0035 * (1.0 - self.skill) {
            while self.idx > 0 && line[self.idx - 1].stage == stage {
                self.idx -= 1;
            }
            self.t = 0.0;
            self.wait_until = now + 1200;
            let sp = spawns[stage.min(spawns.len() - 1)];
            return Some((sp, self.yaw(line), true));
        }
        let mut dist = self.speed * 0.05;
        while dist > 0.0 {
            let (a, b) = (line[self.idx].pos, line[(self.idx + 1).min(line.len() - 1)].pos);
            let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt().max(1.0);
            let left = (1.0 - self.t) * len;
            if dist < left {
                self.t += dist / len;
                dist = 0.0;
            } else {
                dist -= left;
                self.t = 0.0;
                self.idx += 1;
                if self.idx + 1 >= line.len() {
                    self.idx = line.len() - 2;
                    self.t = 1.0;
                    self.done = true;
                    break;
                }
            }
        }
        let (a, b) = (line[self.idx].pos, line[self.idx + 1].pos);
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let l = (dx * dx + dy * dy).sqrt().max(1.0);
        let w = (now as f32 / 700.0).sin() * self.wobble;
        let pos = [a[0] + dx * self.t - dy / l * w, a[1] + dy * self.t + dx / l * w, a[2] + (b[2] - a[2]) * self.t];
        Some((pos, self.yaw(line), false))
    }

    fn yaw(&self, line: &[LinePoint]) -> u16 {
        let (a, b) = (line[self.idx].pos, line[(self.idx + 1).min(line.len() - 1)].pos);
        ((b[1] - a[1]).atan2(b[0] - a[0]) / std::f32::consts::TAU * 65535.0) as i32 as u16
    }
}
