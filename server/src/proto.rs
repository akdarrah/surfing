// Binary wire format; see client/src/net.ts for the layout table.
use crate::level::V3;

pub enum ClientMsg {
    State { pos: V3, yaw: u16, pitch: i16, flags: u8 },
}

fn f32_at(b: &[u8], i: usize) -> f32 {
    f32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}

pub fn decode(b: &[u8]) -> Option<ClientMsg> {
    let m = match (b.first()?, b.len()) {
        (1, 18) => ClientMsg::State {
            pos: [f32_at(b, 1), f32_at(b, 5), f32_at(b, 9)],
            yaw: u16::from_le_bytes([b[13], b[14]]),
            pitch: i16::from_le_bytes([b[15], b[16]]),
            flags: b[17],
        },
        _ => return None,
    };
    // Untrusted input: NaN/inf would poison every distance check downstream.
    let ClientMsg::State { pos, .. } = &m;
    pos.iter().all(|x| x.is_finite() && x.abs() < 1e6).then_some(m)
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

// Ghost: the record run at 10 Hz. u8 3 | u16 n | n * (i16 x,y,z | u8 yaw)
pub fn ghost(samples: &[(V3, u16)]) -> Vec<u8> {
    let mut b = Vec::with_capacity(3 + samples.len() * 7);
    b.push(3);
    b.extend_from_slice(&(samples.len() as u16).to_le_bytes());
    for (p, yaw) in samples {
        for v in p {
            b.extend_from_slice(&(v.round().clamp(-32767.0, 32767.0) as i16).to_le_bytes());
        }
        b.push((yaw >> 8) as u8);
    }
    b
}

pub fn parse_ghost(b: &[u8]) -> Option<Vec<(V3, u16)>> {
    if b.first() != Some(&3) || b.len() < 3 {
        return None;
    }
    let n = u16::from_le_bytes([b[1], b[2]]) as usize;
    if b.len() != 3 + n * 7 {
        return None;
    }
    Some((0..n).map(|i| {
        let o = 3 + i * 7;
        let c = |k: usize| i16::from_le_bytes([b[o + k], b[o + k + 1]]) as f32;
        ([c(0), c(2), c(4)], (b[o + 6] as u16) << 8)
    }).collect())
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
            None => panic!("decode failed"),
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

    #[test]
    fn ghost_round_trip() {
        let g = vec![([1.0, 2.0, 3.0], 0x1200), ([-5.0, 6.0, 7.0], 0xff00)];
        assert_eq!(parse_ghost(&ghost(&g)).unwrap(), g);
        assert!(parse_ghost(&[3, 5, 0, 1]).is_none());
    }
}
