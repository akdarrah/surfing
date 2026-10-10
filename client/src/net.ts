// Wire protocol. Hot paths are binary (little-endian); rare events are JSON text frames.
// C->S  STATE 1: f32 x,y,z | u16 yaw | i16 pitch | u8 flags(ducked=1, teleported=2)                18 bytes
// C->S  FLAG  3: raw JPEG/PNG bytes (<= 48 KB), already resized client-side
// S->C  frame = blocks back to back:
//   SNAP  1: u32 time | u16 n | n * (u16 id | i16 x,y,z | u8 yaw | i8 pitch | u8 flags(ducked=1, finished=2))
//   GHOST 3: u16 n | n * (i16 x,y,z | u8 yaw)   the record run at 10 Hz
import type { V3 } from './physics.ts';

const TAU = Math.PI * 2;
const QUANT = 2; // i16 positions are in 2-unit steps

export function encodeState(pos: V3, yaw: number, pitch: number, flags: number) {
  const b = new DataView(new ArrayBuffer(18));
  b.setUint8(0, 1);
  pos.forEach((v, i) => b.setFloat32(1 + i * 4, v, true));
  b.setUint16(13, Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65535), true);
  b.setInt16(15, Math.round((pitch / (Math.PI / 2)) * 32767), true);
  b.setUint8(17, flags);
  return b.buffer;
}

export function encodeImage(img: Uint8Array) {
  const b = new Uint8Array(img.length + 1);
  b[0] = 3;
  b.set(img, 1);
  return b.buffer;
}

export type Snap = { t: number; pos: V3; yaw: number; pitch: number; flags: number };
export type Remote = { id: number; snaps: Snap[] };
export type GhostFrame = { pos: V3; yaw: number };

export type Handlers = {
  onJson: (m: any) => void;
  onGhost: (frames: GhostFrame[]) => void;
};

export class Net {
  ws: WebSocket | null = null;
  remotes = new Map<number, Remote>();
  offset = -Infinity; // serverTime - performance.now()
  connected = false;

  constructor(private h: Handlers) {}

  connect(hello: () => object) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = (this.ws = new WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.connected = true; ws.send(JSON.stringify({ t: 'hello', ...hello() })); };
    ws.onclose = () => { this.connected = false; this.remotes.clear(); setTimeout(() => this.connect(hello), 3000); };
    ws.onmessage = e => (typeof e.data === 'string' ? this.h.onJson(JSON.parse(e.data)) : this.binary(new DataView(e.data)));
  }

  send(data: ArrayBuffer | object) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
  }

  // Server clock as seen by this client; remote gliders render 100ms behind it so we always interpolate.
  serverNow() { return performance.now() + this.offset; }
  renderTime() { return this.serverNow() - 100; }

  private remote(id: number) {
    let r = this.remotes.get(id);
    if (!r) this.remotes.set(id, (r = { id, snaps: [] }));
    return r;
  }

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
          const snap: Snap = {
            t,
            pos: [b.getInt16(o + 2, true) * QUANT, b.getInt16(o + 4, true) * QUANT, b.getInt16(o + 6, true) * QUANT],
            yaw: (b.getUint8(o + 8) / 256) * TAU,
            pitch: (b.getInt8(o + 9) / 127) * (Math.PI / 2),
            flags: b.getUint8(o + 10),
          };
          const last = r.snaps[r.snaps.length - 1];
          if (!last || t > last.t) r.snaps.push(snap);
          if (r.snaps.length > 30) r.snaps.shift();
        }
      } else if (type === 3) {
        const n = b.getUint16(o + 1, true);
        const frames: GhostFrame[] = [];
        o += 3;
        for (let i = 0; i < n; i++, o += 7) frames.push({ pos: [b.getInt16(o, true) * QUANT, b.getInt16(o + 2, true) * QUANT, b.getInt16(o + 4, true) * QUANT], yaw: (b.getUint8(o + 6) / 256) * TAU });
        this.h.onGhost(frames);
      } else return;
    }
  }
}

// Interpolated pose of a remote at server time t; null if we have nothing recent.
export function samplePose(r: Remote, t: number): Snap | null {
  const s = r.snaps;
  // Far gliders only refresh every few seconds on a busy server, so keep showing them a while.
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
