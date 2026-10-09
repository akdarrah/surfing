// Binary wire format; see client/src/net.ts for the layout table.
use crate::level::V3;

pub enum ClientMsg {
    State { pos: V3, yaw: u16, pitch: i16, flags: u8 },
    Shot { origin: V3, dir: V3, view_time: u32, weapon: u8 },
}

fn f32_at(b: &[u8], i: usize) -> f32 {
    f32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}

fn v3_at(b: &[u8], i: usize) -> V3 {
    [f32_at(b, i), f32_at(b, i + 4), f32_at(b, i + 8)]
}

pub fn decode(b: &[u8]) -> Option<ClientMsg> {
    let m = match (b.first()?, b.len()) {
        (1, 18) => ClientMsg::State {
            pos: v3_at(b, 1),
            yaw: u16::from_le_bytes([b[13], b[14]]),
            pitch: i16::from_le_bytes([b[15], b[16]]),
            flags: b[17],
        },
        (2, 30) => ClientMsg::Shot {
            origin: v3_at(b, 1),
            dir: v3_at(b, 13),
            view_time: u32::from_le_bytes(b[25..29].try_into().unwrap()),
            weapon: b[29],
        },
        _ => return None,
    };
    // Untrusted input: NaN/inf would poison every distance check downstream.
    let finite = |v: &V3| v.iter().all(|x| x.is_finite() && x.abs() < 1e6);
    match &m {
        ClientMsg::State { pos, .. } if !finite(pos) => None,
        ClientMsg::Shot { origin, dir, .. } if !finite(origin) || !finite(dir) => None,
        _ => Some(m),
    }
}

pub const SNAP_HEADER: usize = 7;
pub const SNAP_RECORD: usize = 11;

pub fn snap_header(buf: &mut Vec<u8>, time: u32, n: u16) {
    buf.push(1);
    buf.extend_from_slice(&time.to_le_bytes());
    buf.extend_from_slice(&n.to_le_bytes());
}

// ponytail: i16 positions at 1-unit resolution cap levels to +/-32767 units; quantize coarser if a level outgrows it.
pub fn snap_record(buf: &mut Vec<u8>, id: u16, pos: V3, yaw: u16, pitch: i16, flags: u8) {
    buf.extend_from_slice(&id.to_le_bytes());
    for v in pos {
        buf.extend_from_slice(&(v.round().clamp(-32767.0, 32767.0) as i16).to_le_bytes());
    }
    buf.push((yaw >> 8) as u8);
    buf.push((pitch >> 8) as i8 as u8);
    buf.push(flags);
}

pub fn fx(shooter: u16, weapon: u8, origin: V3, dir: V3) -> Vec<u8> {
    let mut b = Vec::with_capacity(28);
    b.push(2);
    b.extend_from_slice(&shooter.to_le_bytes());
    b.push(weapon);
    for v in origin.iter().chain(dir.iter()) {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trip_and_rejects_nan() {
        let mut b = vec![1u8];
        for v in [1.5f32, -2.0, 3.0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&1234u16.to_le_bytes());
        b.extend_from_slice(&(-55i16).to_le_bytes());
        b.push(7);
        match decode(&b) {
            Some(ClientMsg::State { pos, yaw, pitch, flags }) => assert_eq!((pos, yaw, pitch, flags), ([1.5, -2.0, 3.0], 1234, -55, 7)),
            _ => panic!("decode failed"),
        }
        b[1..5].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode(&b).is_none());
        assert!(decode(&b[..10]).is_none());
    }

    #[test]
    fn snapshot_record_is_11_bytes() {
        let mut b = Vec::new();
        snap_record(&mut b, 3, [10.4, -20.6, 99999.0], 0xffff, -32767, 5);
        assert_eq!(b.len(), SNAP_RECORD);
        assert_eq!(i16::from_le_bytes([b[2], b[3]]), 10);
        assert_eq!(i16::from_le_bytes([b[6], b[7]]), 32767);
    }
}
