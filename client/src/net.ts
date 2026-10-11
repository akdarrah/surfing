// Wire protocol. Hot paths are binary (little-endian); rare events are JSON text frames.
// C->S  STATE 1: f32 x,y,z | u16 yaw | i16 pitch | u8 flags(ducked=1, teleported=2)                18 bytes
// C->S  FLAG  3: raw JPEG/PNG bytes (<= 48 KB), already resized client-side
// S->C  frame = blocks back to back:
//   SNAP  1: u32 time | u16 n | n * (u16 id | i16 x,y,z | u8 yaw | i8 pitch | u8 flags(ducked=1, finished=2))
//   GHOST 3: u16 n | n * (i16 x,y,z | u8 yaw)   the record run at 10 Hz
import type { V3 } from './physics.ts';

const TAU = Math.PI * 2;
const QUANT = 2; // i16 positions are in 2-unit steps
const RING = 32; // snapshots kept per remote

const stateBuf = new ArrayBuffer(18);
const stateView = new DataView(stateBuf);
export function encodeState(pos: V3, yaw: number, pitch: number, flags: number) {
  const b = stateView;
  b.setUint8(0, 1);
  b.setFloat32(1, pos[0], true); b.setFloat32(5, pos[1], true); b.setFloat32(9, pos[2], true);
  b.setUint16(13, Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65535), true);
  b.setInt16(15, Math.round((pitch / (Math.PI / 2)) * 32767), true);
  b.setUint8(17, flags);
  return stateBuf;
}

export function encodeImage(img: Uint8Array) {
  const b = new Uint8Array(img.length + 1);
  b[0] = 3;
  b.set(img, 1);
  return b.buffer;
}

export type Snap = { t: number; pos: V3; yaw: number; pitch: number; flags: number };
// Snapshots live in a ring of typed arrays: no objects per packet, no Array.shift.
export type Remote = { id: number; t: Float64Array; p: Float32Array; yaw: Float32Array; pitch: Float32Array; flags: Uint8Array; head: number; len: number };
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

  // Server clock as seen by this client; remote boats render 100ms behind it so we always interpolate.
  serverNow() { return performance.now() + this.offset; }
  renderTime() { return this.serverNow() - 100; }

  private remote(id: number) {
    let r = this.remotes.get(id);
    if (!r) this.remotes.set(id, (r = { id, t: new Float64Array(RING), p: new Float32Array(RING * 3), yaw: new Float32Array(RING), pitch: new Float32Array(RING), flags: new Uint8Array(RING), head: 0, len: 0 }));
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
          const lastT = r.len ? r.t[(r.head + r.len - 1) % RING] : -Infinity;
          if (t <= lastT) continue;
          const k = (r.head + r.len) % RING;
          if (r.len === RING) r.head = (r.head + 1) % RING; else r.len++;
          r.t[k] = t;
          r.p[k * 3] = b.getInt16(o + 2, true) * QUANT; r.p[k * 3 + 1] = b.getInt16(o + 4, true) * QUANT; r.p[k * 3 + 2] = b.getInt16(o + 6, true) * QUANT;
          r.yaw[k] = (b.getUint8(o + 8) / 256) * TAU;
          r.pitch[k] = (b.getInt8(o + 9) / 127) * (Math.PI / 2);
          r.flags[k] = b.getUint8(o + 10);
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

// Interpolated pose of a remote at server time t, written into `out`; false if we have nothing recent.
export function samplePose(r: Remote, t: number, out: Snap) {
  if (!r.len) return false;
  const newest = (r.head + r.len - 1) % RING;
  // Far boats only refresh every few seconds on a busy server, so keep showing them a while.
  if (t - r.t[newest] > 12000) return false;
  let i = r.len - 1;
  while (i > 0 && r.t[(r.head + i - 1) % RING] > t) i--;
  const ia = (r.head + Math.max(0, i - 1)) % RING, ib = (r.head + i) % RING;
  out.t = t;
  if (ia === ib || t >= r.t[ib]) {
    out.pos[0] = r.p[ib * 3]; out.pos[1] = r.p[ib * 3 + 1]; out.pos[2] = r.p[ib * 3 + 2];
    out.yaw = r.yaw[ib]; out.pitch = r.pitch[ib]; out.flags = r.flags[ib];
    return true;
  }
  const k = Math.max(0, Math.min(1, (t - r.t[ia]) / (r.t[ib] - r.t[ia])));
  let dy = r.yaw[ib] - r.yaw[ia];
  if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
  for (let j = 0; j < 3; j++) out.pos[j] = r.p[ia * 3 + j] + (r.p[ib * 3 + j] - r.p[ia * 3 + j]) * k;
  out.yaw = r.yaw[ia] + dy * k;
  out.pitch = r.pitch[ia] + (r.pitch[ib] - r.pitch[ia]) * k;
  out.flags = r.flags[ib];
  return true;
}
