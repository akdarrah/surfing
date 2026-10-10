// The server only needs a level's spawns, triggers and billboard slots; brushes are client-side physics.
use serde::Deserialize;

pub type V3 = [f32; 3];
pub const HULL_MIN: V3 = [-16.0, -16.0, 0.0];
pub const HULL_MAX: V3 = [16.0, 16.0, 72.0];

#[derive(Deserialize)]
pub struct Spawn {
    pub pos: V3,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Start,
    Checkpoint,
    End,
    Teleport,
    Boost,
}

#[derive(Deserialize)]
pub struct Trigger {
    #[serde(rename = "type")]
    pub kind: Kind,
    pub min: V3,
    pub max: V3,
    pub stage: Option<usize>,
}

#[derive(Deserialize)]
pub struct BillboardSlot {
    pub id: u32,
}

#[derive(Deserialize)]
pub struct Level {
    pub name: String,
    // Fastest believable full run; anything quicker is a modified client.
    #[serde(rename = "minRunMs", default)]
    pub min_run_ms: u32,
    pub spawns: Vec<Spawn>,
    pub triggers: Vec<Trigger>,
    #[serde(default)]
    pub billboards: Vec<BillboardSlot>,
}

impl Level {
    pub fn load(path: &str) -> Level {
        let s = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading level {path}: {e}"));
        serde_json::from_str(&s).unwrap_or_else(|e| panic!("parsing level {path}: {e}"))
    }

    pub fn near_spawn(&self, p: V3) -> Option<usize> {
        self.spawns.iter().position(|s| (0..3).all(|i| (s.pos[i] - p[i]).abs() < 48.0))
    }
}

// Does a player hull swept from a to b overlap the trigger? Slab test against the trigger grown by the hull.
pub fn swept_touch(t: &Trigger, a: V3, b: V3) -> bool {
    let (mut t0, mut t1) = (0.0f32, 1.0f32);
    for i in 0..3 {
        let lo = t.min[i] - HULL_MAX[i];
        let hi = t.max[i] - HULL_MIN[i];
        let d = b[i] - a[i];
        if d.abs() < 1e-6 {
            if a[i] <= lo || a[i] >= hi {
                return false;
            }
        } else {
            let (mut e, mut x) = ((lo - a[i]) / d, (hi - a[i]) / d);
            if e > x {
                std::mem::swap(&mut e, &mut x);
            }
            t0 = t0.max(e);
            t1 = t1.min(x);
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trig() -> Trigger {
        Trigger { kind: Kind::Checkpoint, min: [0.0, 0.0, 0.0], max: [100.0, 100.0, 100.0], stage: Some(1) }
    }

    #[test]
    fn sweep_catches_fast_pass_through() {
        assert!(swept_touch(&trig(), [-500.0, 50.0, 10.0], [600.0, 50.0, 10.0]));
        assert!(!swept_touch(&trig(), [-500.0, 500.0, 10.0], [600.0, 500.0, 10.0]));
    }

    #[test]
    fn real_level_loads() {
        let l = Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/meridian.json"));
        assert_eq!(l.spawns.len(), 6);
        assert!(l.triggers.iter().any(|t| t.kind == Kind::End));
        assert_eq!(l.billboards.len(), 8);
        assert!(l.min_run_ms > 10_000);
    }
}
