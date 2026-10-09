// Wire protocol. Hot paths are binary (little-endian); rare events are JSON text frames.
// C->S  STATE 1: f32 x,y,z | u16 yaw | i16 pitch | u8 flags(ducked=1, teleported=2, weapon<<2)        18 bytes
// C->S  SHOT  2: f32 origin xyz | f32 dir xyz | u32 viewTime(server ms) | u8 weapon                     30 bytes
// S->C  frame = blocks back to back:
//   SNAP 1: u32 time | u16 n | n * (u16 id | i16 x,y,z | u8 yaw | i8 pitch | u8 flags(ducked=1, dead=2, weapon<<2))
//   FX   2: u16 shooter | u8 weapon | f32 origin xyz | f32 dir xyz   (28 bytes)
import type { V3 } from './physics.ts';

export const MSG_STATE = 1, MSG_SHOT = 2;
const TAU = Math.PI * 2;

export function encodeState(pos: V3, yaw: number, pitch: number, flags: number) {
  const b = new DataView(new ArrayBuffer(18));
  b.setUint8(0, MSG_STATE);
  pos.forEach((v, i) => b.setFloat32(1 + i * 4, v, true));
  b.setUint16(13, Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65535), true);
  b.setInt16(15, Math.round((pitch / (Math.PI / 2)) * 32767), true);
  b.setUint8(17, flags);
  return b.buffer;
}

export function encodeShot(origin: V3, dir: V3, viewTime: number, weapon: number) {
  const b = new DataView(new ArrayBuffer(30));
  b.setUint8(0, MSG_SHOT);
  [...origin, ...dir].forEach((v, i) => b.setFloat32(1 + i * 4, v, true));
  b.setUint32(25, viewTime >>> 0, true);
  b.setUint8(29, weapon);
  return b.buffer;
}

export type Remote = {
  id: number; name: string; color: string;
  snaps: { t: number; pos: V3; yaw: number; pitch: number; flags: number }[];
};

export type Handlers = {
  onJson: (m: any) => void;
  onFx: (shooter: number, weapon: number, origin: V3, dir: V3) => void;
};

export class Net {
  ws: WebSocket | null = null;
  remotes = new Map<number, Remote>();
  offset = -Infinity; // serverTime - performance.now()
  connected = false;

  constructor(private h: Handlers) {}

  connect(name: string) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.connected = true; ws.send(JSON.stringify({ t: 'hello', name })); };
    ws.onclose = () => { this.connected = false; this.remotes.clear(); setTimeout(() => this.connect(name), 3000); };
    ws.onmessage = e => (typeof e.data === 'string' ? this.json(JSON.parse(e.data)) : this.binary(new DataView(e.data)));
  }

  send(data: ArrayBuffer | object) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
  }

  // Server clock as seen by this client; remote boats render 100ms behind it so we always interpolate.
  serverNow() { return performance.now() + this.offset; }
  renderTime() { return this.serverNow() - 100; }

  private json(m: any) {
    if (m.t === 'welcome' || m.t === 'join') for (const p of m.players ?? [m]) this.remote(p.id, p.name, p.color);
    if (m.t === 'leave') this.remotes.delete(m.id);
    this.h.onJson(m);
  }

  private remote(id: number, name = '?', color = '#fff') {
    let r = this.remotes.get(id);
    if (!r) this.remotes.set(id, (r = { id, name, color, snaps: [] }));
    else if (name !== '?') { r.name = name; r.color = color; }
    return r;
  }

  // A frame is a run of blocks: snapshots (one per nearby cell, or the far view) and shot tracers.
  private binary(b: DataView) {
    for (let o = 0; o < b.byteLength; ) {
      const type = b.getUint8(o);
      if (type === 1) {
        const t = b.getUint32(o + 1, true);
        // The newest packet bounds the clock offset from above, so creep toward it slowly.
        const sample = t - performance.now();
        this.offset = sample > this.offset ? sample : this.offset - 0.02;
        const n = b.getUint16(o + 5, true);
        o += 7;
        for (let i = 0; i < n; i++, o += 11) {
          const r = this.remote(b.getUint16(o, true));
          const snap = {
            t,
            pos: [b.getInt16(o + 2, true), b.getInt16(o + 4, true), b.getInt16(o + 6, true)] as V3,
            yaw: (b.getUint8(o + 8) / 256) * TAU,
            pitch: (b.getInt8(o + 9) / 127) * (Math.PI / 2),
            flags: b.getUint8(o + 10),
          };
          const last = r.snaps[r.snaps.length - 1];
          if (!last || t > last.t) r.snaps.push(snap);
          if (r.snaps.length > 30) r.snaps.shift();
        }
      } else if (type === 2) {
        const f = (i: number) => b.getFloat32(o + i, true);
        this.h.onFx(b.getUint16(o + 1, true), b.getUint8(o + 3), [f(4), f(8), f(12)], [f(16), f(20), f(24)]);
        o += 28;
      } else return;
    }
  }
}

// Interpolated pose of a remote at server time t; null if we have nothing recent.
export function samplePose(r: Remote, t: number) {
  const s = r.snaps;
  // Far boats only refresh every few seconds on a busy server, so keep showing them a while.
  if (!s.length || t - s[s.length - 1].t > 12000) return null;
  let i = s.length - 1;
  while (i > 0 && s[i - 1].t > t) i--;
  const a = s[Math.max(0, i - 1)], b = s[i];
  if (a === b || t >= b.t) return b;
  const k = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  let dy = b.yaw - a.yaw;
  if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
  return {
    t,
    pos: [0, 1, 2].map(j => a.pos[j] + (b.pos[j] - a.pos[j]) * k) as V3,
    yaw: a.yaw + dy * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    flags: b.flags,
  };
}
