// Source-engine player movement (gamemovement.cpp) + Quake-style brush traces.
// Hammer units, Z up. Rendering converts to Three's Y-up.

export type V3 = [number, number, number];

export const CVARS = {
  gravity: 800,
  accelerate: 10,
  airaccelerate: 150,
  friction: 4,
  stopspeed: 75,
  maxspeed: 250,
  maxvelocity: 3500,
  jumpImpulse: 268.3281572999747, // sqrt(2 * 800 * 45)
  airSpeedCap: 30,
};

export const TICK = 1 / 100;
export const HULL_MIN: V3 = [-16, -16, 0];
export const HULL_MAX: V3 = [16, 16, 72];
export const DUCK_MAX: V3 = [16, 16, 36];
export const EYE = 64;
export const DUCK_EYE = 28;

const DIST_EPSILON = 0.03125;
const MAX_CLIP_PLANES = 5;
const NON_JUMP_VELOCITY = 140;

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

export type Plane = { n: V3; d: number; cap?: boolean };
export type Brush = { planes: Plane[]; faces: V3[][]; min: V3; max: V3; color: string; chain: boolean };
export type Trigger = {
  type: 'start' | 'checkpoint' | 'end' | 'teleport' | 'boost';
  min: V3; max: V3;
  stage?: number;
  dir?: V3;    // boost
  speed?: number;
};
export type LevelJSON = {
  name: string;
  minRunMs?: number;
  spawns: { pos: V3; yaw: number }[]; // index = stage
  brushes: { verts: V3[]; color: string; chain?: boolean }[];
  triggers: Trigger[];
};
export type Level = { name: string; spawns: LevelJSON['spawns']; brushes: Brush[]; triggers: Trigger[] };

// Planes of a convex hull from its vertices. ponytail: O(n^4) over vertex triples, fine for ramp-sized brushes (<= ~12 verts).
export function brushFromVerts(verts: V3[], color = '#fff', chain = false): Brush {
  const planes: Plane[] = [];
  const faces: V3[][] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    let normal = cross(sub(verts[j], verts[i]), sub(verts[k], verts[i]));
    if (len(normal) < 1e-6) continue;
    normal = norm(normal);
    let d = dot(normal, verts[i]);
    let pos = 0, neg = 0;
    for (const v of verts) {
      const s = dot(normal, v) - d;
      if (s > 0.01) pos++; else if (s < -0.01) neg++;
    }
    if (pos && neg) continue;
    if (pos) { normal = scale(normal, -1); d = -d; }
    if (planes.some(p => dot(p.n, normal) > 0.9999 && Math.abs(p.d - d) < 0.01)) continue;
    planes.push({ n: normal, d });
    faces.push(orderFace(verts.filter(v => Math.abs(dot(normal, v) - d) < 0.01), normal));
  }
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
  // Axial bevel planes keep box traces from snagging on sloped edges (what q3map adds).
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const nrm: V3 = [0, 0, 0]; nrm[a] = s;
    const d = s > 0 ? max[a] : -min[a];
    if (!planes.some(p => dot(p.n, nrm) > 0.9999)) planes.push({ n: nrm, d });
  }
  // Ramp chains: the vertical planes (segment caps and axial bevels) are seams between neighbouring segments, not
  // walls. They still bound the solid, but a box can't "hit" them; see clipBoxToBrush.
  if (chain) for (const p of planes) if (Math.abs(p.n[2]) < 0.05 || p.n[2] > 0.95) p.cap = true;
  return { planes, faces, min, max, color, chain };
}

function orderFace(pts: V3[], n: V3): V3[] {
  const c = scale(pts.reduce(add, [0, 0, 0] as V3), 1 / pts.length);
  const u = norm(sub(pts[0], c)), v = cross(n, u);
  return pts
    .map(p => ({ p, a: Math.atan2(dot(sub(p, c), v), dot(sub(p, c), u)) }))
    .sort((x, y) => x.a - y.a)
    .map(x => x.p);
}

export function loadLevel(json: LevelJSON): Level {
  return {
    name: json.name,
    spawns: json.spawns,
    brushes: json.brushes.map(b => brushFromVerts(b.verts, b.color, b.chain)),
    triggers: json.triggers,
  };
}

export type Trace = { fraction: number; end: V3; normal: V3 | null; startsolid: boolean; allsolid: boolean; depth: number };

// Sweep an AABB (mins/maxs relative to origin) from start to end against every brush.
export function trace(level: Level, start: V3, end: V3, mins: V3, maxs: V3): Trace {
  const tr: Trace = { fraction: 1, end, normal: null, startsolid: false, allsolid: false, depth: 0 };
  const lo: V3 = [0, 0, 0], hi: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(start[a], end[a]) + mins[a] - 1;
    hi[a] = Math.max(start[a], end[a]) + maxs[a] + 1;
  }
  for (const b of level.brushes) {
    if (b.max[0] < lo[0] || b.min[0] > hi[0] || b.max[1] < lo[1] || b.min[1] > hi[1] || b.max[2] < lo[2] || b.min[2] > hi[2]) continue;
    clipBoxToBrush(tr, b, start, end, mins, maxs);
    if (tr.allsolid) {
      if ((globalThis as any).__physDebug) console.log('  allsolid in brush', level.brushes.indexOf(b), 'dists', b.planes.map(p => { const ofs: V3 = [p.n[0] < 0 ? maxs[0] : mins[0], p.n[1] < 0 ? maxs[1] : mins[1], p.n[2] < 0 ? maxs[2] : mins[2]]; return (dot(start, p.n) - (p.d - dot(ofs, p.n))).toFixed(1) + (p.cap ? 'c' : ''); }).join(' '), 'start', start.map(Math.round).join(','));
      break;
    }
  }
  tr.end = tr.fraction === 1 ? end : add(start, scale(sub(end, start), tr.fraction));
  return tr;
}

function clipBoxToBrush(tr: Trace, b: Brush, start: V3, end: V3, mins: V3, maxs: V3) {
  let enter = -1, leave = 1, getout = false, startout = false;
  let clip: Plane | null = null;
  // Closest real face when the box starts inside a ramp segment (it slid in through a seam).
  let seam: Plane | null = null, seamDepth = Infinity;
  for (const p of b.planes) {
    const ofs: V3 = [p.n[0] < 0 ? maxs[0] : mins[0], p.n[1] < 0 ? maxs[1] : mins[1], p.n[2] < 0 ? maxs[2] : mins[2]];
    const dist = p.d - dot(ofs, p.n);
    const d1 = dot(start, p.n) - dist;
    const d2 = dot(end, p.n) - dist;
    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
    if (!p.cap && -d1 < seamDepth) { seamDepth = -d1; seam = p; }
    if (d1 <= 0 && d2 <= 0) continue;
    if (d1 > d2) {
      const f = Math.max(0, (d1 - DIST_EPSILON) / (d1 - d2));
      if (f > enter && !p.cap) { enter = f; clip = p; }
    } else {
      const f = Math.min(1, (d1 + DIST_EPSILON) / (d1 - d2));
      if (f < leave) leave = f;
    }
  }
  if (!startout) {
    if (b.chain && seam) {
      // Inside a ramp segment (slid in through a seam, or flew into its end): report its nearest face at fraction 0
      // so the move clips along that face and pushes the box back out onto it.
      if (tr.fraction > 0 || seamDepth > tr.depth) { tr.fraction = 0; tr.normal = seam.n; tr.depth = seamDepth; }
      return;
    }
    tr.startsolid = true;
    if (!getout) { tr.allsolid = true; tr.fraction = 0; }
    return;
  }
  if (enter < leave && enter > -1 && enter < tr.fraction) {
    tr.fraction = Math.max(0, enter);
    tr.normal = clip!.n;
  }
}

export type Input = { forward: number; side: number; jump: boolean; duck: boolean; yaw: number }; // forward/side in [-1,1], yaw radians
export type PlayerState = { pos: V3; vel: V3; onGround: boolean; ducked: boolean; contact?: V3 | null }; // contact = last surface normal touched this tick

export const hullMax = (s: PlayerState) => (s.ducked ? DUCK_MAX : HULL_MAX);

function clipVelocity(v: V3, n: V3, overbounce: number): V3 {
  const out = sub(v, scale(n, dot(v, n) * overbounce));
  const adjust = dot(out, n);
  return adjust < 0 ? sub(out, scale(n, adjust)) : out;
}

function categorize(level: Level, s: PlayerState) {
  if (s.vel[2] > NON_JUMP_VELOCITY) { s.onGround = false; return; }
  const down: V3 = [s.pos[0], s.pos[1], s.pos[2] - 2];
  const tr = trace(level, s.pos, down, HULL_MIN, hullMax(s));
  // The surf rule: anything steeper than normal.z 0.7 (~45.6 deg) is never ground.
  s.onGround = !!tr.normal && tr.normal[2] > 0.7 && !tr.startsolid;
  if (s.onGround) s.pos = tr.end;
}

function accelerate(s: PlayerState, wishdir: V3, wishspeed: number, accel: number, cap = Infinity) {
  const wishspd = Math.min(wishspeed, cap);
  const addspeed = wishspd - dot(s.vel, wishdir);
  if (addspeed <= 0) return;
  const accelspeed = Math.min(accel * wishspeed * TICK, addspeed);
  s.vel = add(s.vel, scale(wishdir, accelspeed));
}

function friction(s: PlayerState) {
  const speed = len(s.vel);
  if (speed < 0.1) return;
  const control = Math.max(speed, CVARS.stopspeed);
  const newspeed = Math.max(0, speed - control * CVARS.friction * TICK);
  s.vel = scale(s.vel, newspeed / speed);
}

function tryPlayerMove(level: Level, s: PlayerState) {
  const maxs = hullMax(s);
  const planes: V3[] = [];
  s.contact = null;
  const primal = s.vel;
  let original = s.vel;
  let timeLeft = TICK;
  for (let bump = 0; bump < 4; bump++) {
    if (len(s.vel) === 0) break;
    const end = add(s.pos, scale(s.vel, timeLeft));
    const tr = trace(level, s.pos, end, HULL_MIN, maxs);
    if (tr.allsolid) { s.vel = [0, 0, 0]; return; }
    if (tr.fraction > 0) { s.pos = tr.end; original = s.vel; planes.length = 0; }
    if (tr.depth > 0) s.pos = add(s.pos, scale(tr.normal!, tr.depth + DIST_EPSILON)); // out of the seam
    if (tr.fraction === 1) break;
    timeLeft -= timeLeft * tr.fraction;
    if (planes.length >= MAX_CLIP_PLANES) { s.vel = [0, 0, 0]; break; }
    // Hitting the same plane twice would give a zero crease direction; nudge off it instead (Quake 2 PM_StepSlideMove).
    if (planes.some(p => dot(p, tr.normal!) > 0.99)) { s.vel = add(s.vel, tr.normal!); continue; }
    planes.push(tr.normal!);
    s.contact = tr.normal!;
    if ((globalThis as any).__physDebug) console.log('  bump', bump, 'frac', tr.fraction.toFixed(3), 'n', tr.normal!.map(x => x.toFixed(2)).join(','), 'planes', planes.length, 'vel', s.vel.map(Math.round).join(','));
    if (planes.length === 1 && !s.onGround) {
      s.vel = original = clipVelocity(original, planes[0], 1);
    } else {
      let i = 0;
      for (; i < planes.length; i++) {
        s.vel = clipVelocity(original, planes[i], 1);
        let ok = true;
        for (let j = 0; j < planes.length; j++) if (j !== i && dot(s.vel, planes[j]) < 0) { ok = false; break; }
        if (ok) break;
      }
      if (i === planes.length) {
        if ((globalThis as any).__physDebug) console.log('  crease', planes.map(p => p.map(x => x.toFixed(2)).join(',')).join(' | '));
        if (planes.length !== 2) { s.vel = [0, 0, 0]; break; }
        const dir = cross(planes[0], planes[1]);
        s.vel = scale(dir, dot(dir, s.vel));
      }
    }
    if (dot(s.vel, primal) <= 0) { if ((globalThis as any).__physDebug) console.log('  reversed -> stop'); s.vel = [0, 0, 0]; break; }
  }
}

// One 100 Hz tick. Mutates s.
export function playerMove(level: Level, s: PlayerState, inp: Input) {
  if (inp.duck !== s.ducked) {
    if (inp.duck) s.ducked = true;
    else {
      // Only stand up if there's room.
      const tr = trace(level, s.pos, s.pos, HULL_MIN, HULL_MAX);
      if (!tr.startsolid) s.ducked = false;
    }
  }
  const fwd: V3 = [Math.cos(inp.yaw), Math.sin(inp.yaw), 0];
  const right: V3 = [Math.sin(inp.yaw), -Math.cos(inp.yaw), 0];
  const wishvel = add(scale(fwd, inp.forward * 400), scale(right, inp.side * 400));
  let wishspeed = len(wishvel);
  const wishdir = wishspeed ? scale(wishvel, 1 / wishspeed) : ([0, 0, 0] as V3);
  wishspeed = Math.min(wishspeed, CVARS.maxspeed * (s.ducked && s.onGround ? 0.34 : 1));

  s.vel[2] -= CVARS.gravity * 0.5 * TICK;
  // ponytail: autobhop (holding space re-jumps on landing), like most surf servers.
  if (inp.jump && s.onGround) { s.vel[2] = CVARS.jumpImpulse; s.onGround = false; }

  if (s.onGround) {
    s.vel[2] = 0;
    friction(s);
    accelerate(s, wishdir, wishspeed, CVARS.accelerate);
    s.vel[2] = 0;
  } else {
    accelerate(s, wishdir, wishspeed, CVARS.airaccelerate, CVARS.airSpeedCap);
  }
  // ponytail: no StepMove (18u stairs); surf levels don't need stairs.
  tryPlayerMove(level, s);
  if (!s.onGround) s.vel[2] -= CVARS.gravity * 0.5 * TICK;
  for (let a = 0; a < 3; a++) s.vel[a] = Math.max(-CVARS.maxvelocity, Math.min(CVARS.maxvelocity, s.vel[a]));
  categorize(level, s);
  if (s.onGround) s.vel[2] = 0;
}

// A booster pad: bring the velocity component along its direction up to `speed`. Re-applying while inside is a no-op.
export function applyBoost(s: PlayerState, t: Trigger) {
  const d = norm(t.dir ?? [0, 1, 0]);
  const along = dot(s.vel, d);
  if (along < (t.speed ?? 0)) s.vel = add(s.vel, scale(d, (t.speed ?? 0) - along));
}

export function touching(t: Trigger, pos: V3, maxs: V3) {
  return pos[0] + HULL_MIN[0] < t.max[0] && pos[0] + maxs[0] > t.min[0]
    && pos[1] + HULL_MIN[1] < t.max[1] && pos[1] + maxs[1] > t.min[1]
    && pos[2] + HULL_MIN[2] < t.max[2] && pos[2] + maxs[2] > t.min[2];
}
