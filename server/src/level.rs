// The server only needs a level's spawns and triggers; brushes are client-side physics.
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
    Pickup,
}

#[derive(Deserialize)]
pub struct Trigger {
    #[serde(rename = "type")]
    pub kind: Kind,
    pub min: V3,
    pub max: V3,
    pub stage: Option<usize>,
    pub weapon: Option<usize>,
}

#[derive(Deserialize)]
pub struct Level {
    pub name: String,
    pub spawns: Vec<Spawn>,
    pub triggers: Vec<Trigger>,
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

// Ray vs axis-aligned box; returns the hit distance along the (unit) direction.
pub fn ray_box(o: V3, d: V3, min: V3, max: V3) -> Option<f32> {
    let (mut t0, mut t1) = (0.0f32, f32::MAX);
    for i in 0..3 {
        if d[i].abs() < 1e-8 {
            if o[i] < min[i] || o[i] > max[i] {
                return None;
            }
        } else {
            let (mut e, mut x) = ((min[i] - o[i]) / d[i], (max[i] - o[i]) / d[i]);
            if e > x {
                std::mem::swap(&mut e, &mut x);
            }
            t0 = t0.max(e);
            t1 = t1.min(x);
            if t0 > t1 {
                return None;
            }
        }
    }
    Some(t0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trig() -> Trigger {
        Trigger { kind: Kind::Checkpoint, min: [0.0, 0.0, 0.0], max: [100.0, 100.0, 100.0], stage: Some(1), weapon: None }
    }

    #[test]
    fn sweep_catches_fast_pass_through() {
        assert!(swept_touch(&trig(), [-500.0, 50.0, 10.0], [600.0, 50.0, 10.0]));
        assert!(!swept_touch(&trig(), [-500.0, 500.0, 10.0], [600.0, 500.0, 10.0]));
    }

    #[test]
    fn ray_hits_box() {
        assert_eq!(ray_box([-10.0, 50.0, 50.0], [1.0, 0.0, 0.0], [0.0; 3], [100.0; 3]), Some(10.0));
        assert_eq!(ray_box([-10.0, 500.0, 50.0], [1.0, 0.0, 0.0], [0.0; 3], [100.0; 3]), None);
    }

    #[test]
    fn real_level_loads() {
        let l = Level::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../levels/cloud-harbor.json"));
        assert_eq!(l.spawns.len(), 6);
        assert!(l.triggers.iter().any(|t| t.kind == Kind::End));
    }
}
