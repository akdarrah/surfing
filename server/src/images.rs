// Player-uploaded flag and spray images, content-addressed and shared with the HTTP server.
use bytes::Bytes;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

pub const MAX_BYTES: usize = 48 * 1024;

#[derive(Clone, Default)]
pub struct Store {
    map: Arc<RwLock<HashMap<String, (Bytes, &'static str)>>>,
    dir: Option<PathBuf>, // permanent (tag) images live here too, so they survive restarts
}

// Only small JPEG/PNG files; the client re-encodes uploads, so anything else is someone poking at us.
pub fn mime(b: &[u8]) -> Option<&'static str> {
    if b.len() > MAX_BYTES || b.len() < 8 {
        None
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else {
        None
    }
}

pub fn hash(b: &[u8]) -> String {
    let h = b.iter().fold(0xcbf29ce484222325u64, |h, &x| (h ^ x as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

impl Store {
    pub fn new(dir: Option<PathBuf>) -> Store {
        if let Some(d) = &dir {
            std::fs::create_dir_all(d).expect("creating image dir");
        }
        Store { map: Default::default(), dir }
    }

    pub fn get(&self, h: &str) -> Option<(Bytes, &'static str)> {
        self.map.read().unwrap().get(h).cloned()
    }

    // Returns the hash, or None if it isn't an acceptable image.
    pub fn put(&self, b: Bytes) -> Option<String> {
        let m = mime(&b)?;
        let h = hash(&b);
        self.map.write().unwrap().insert(h.clone(), (b, m));
        Some(h)
    }

    fn file(dir: &Path, h: &str) -> PathBuf {
        dir.join(h)
    }

    pub fn persist(&self, h: &str) {
        let (Some(dir), Some((b, _))) = (&self.dir, self.get(h)) else { return };
        let path = Self::file(dir, h);
        if !path.exists() {
            if let Err(e) = std::fs::write(&path, &b) {
                eprintln!("saving image {h}: {e}");
            }
        }
    }

    pub fn load_persisted(&self, h: &str) {
        let Some(dir) = &self.dir else { return };
        if let Ok(b) = std::fs::read(Self::file(dir, h)) {
            self.put(b.into());
        }
    }

    // Drop everything nobody references; delete files no permanent tag references.
    pub fn retain(&self, live: &HashSet<String>, permanent: &HashSet<String>) {
        self.map.write().unwrap().retain(|h, _| live.contains(h) || permanent.contains(h));
        let Some(dir) = &self.dir else { return };
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !permanent.contains(&name) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_small_jpeg_and_png() {
        assert_eq!(mime(&[0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), Some("image/jpeg"));
        assert_eq!(mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(mime(b"<svg onload=alert(1)>"), None);
        let mut big = vec![0xff, 0xd8, 0xff];
        big.resize(MAX_BYTES + 1, 0);
        assert_eq!(mime(&big), None);
    }
}
