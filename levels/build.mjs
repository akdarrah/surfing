// Generates levels/*.json. Run: node levels/build.mjs
//
// A level is walked by a turtle: straight(), turn(), gap(), platform() … Each ramp is a chain of
// mitered triangular prisms (one convex brush per segment), so curves and spirals are just turns.
// The turtle also records the ideal line (ridge points), used by the autopilot test, the lobby
// flythrough and the ghost camera.
import { writeFileSync } from 'node:fs';

const D2R = Math.PI / 180;
const PROFILES = {
  gentle: { hw: 440, h: 540 }, // 51°: forgiving
  std: { hw: 384, h: 640 },    // 59°
  fast: { hw: 320, h: 720 },   // 66°: narrow and quick
  mega: { hw: 640, h: 960 },   // 56°, wide landing ramp
};

function box(min, max, color) {
  const v = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) v.push([x, y, z]);
  return { verts: v, color };
}

// Mitered prism chain along ridge points. Width is corrected at joints so the ramp stays the same width through turns.
function prismChain(pts, { hw, h }, color) {
  const out = [];
  const dirs = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  });
  const tri = i => {
    const [x, y, z] = pts[i], [dx, dy] = dirs[i];
    let px = -dy, py = dx;
    if (i > 0 && i < pts.length - 1) {
      const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      const half = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) / 2;
      const k = 1 / Math.max(0.5, Math.cos(half));
      px *= k; py *= k;
    }
    return [[x, y, z], [x + px * hw, y + py * hw, z - h], [x - px * hw, y - py * hw, z - h]];
  };
  for (let i = 0; i + 1 < pts.length; i++) out.push({ verts: [...tri(i), ...tri(i + 1)], color, chain: true });
  return out;
}

class Turtle {
  constructor(level, line = level.line) {
    this.L = level; this.line = line;
    this.pos = [0, 0, 0]; this.heading = 90; // degrees, +y
    this.path = null; this.profile = PROFILES.std; this.color = '#8fa3b8';
    this.si = -1; this.stageBounds = null; this.stageMinZ = Infinity;
  }
  dir() { return [Math.cos(this.heading * D2R), Math.sin(this.heading * D2R)]; }
  left() { return [-Math.sin(this.heading * D2R), Math.cos(this.heading * D2R)]; }
  at(dx = 0, dl = 0, dz = 0) {
    const d = this.dir(), l = this.left();
    return [this.pos[0] + d[0] * dx + l[0] * dl, this.pos[1] + d[1] * dx + l[1] * dl, this.pos[2] + dz];
  }
  track(p, h = 0) {
    const b = this.stageBounds;
    if (b) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    this.stageMinZ = Math.min(this.stageMinZ, p[2] - h);
  }
  // --- ramps -------------------------------------------------------------
  // `inside` = +1/-1 when this ridge point is in a turn: the racing line then hugs that face (only the inside
  // face of a bend can hold you at speed), so the autopilot and the ghost ride where a real surfer would.
  ridge(p, inside = 0) {
    if (!this.path) this.path = [p.slice()]; else this.path.push(p.slice());
    const l = this.left(), off = inside * Math.min(170, this.profile.hw * 0.4);
    const dz = Math.abs(off) * this.profile.h / this.profile.hw;
    this.line.push([p[0] + l[0] * off, p[1] + l[1] * off, p[2] - dz + 60, this.si]);
    this.track(p, this.profile.h);
  }
  begin() { this.flush(); this.ridge(this.pos); }
  flush() {
    if (this.path && this.path.length > 1) this.L.brushes.push(...prismChain(this.path, this.profile, this.color));
    this.path = null;
  }
  straight(len, drop) {
    if (!this.path) this.begin();
    this.pos = this.at(len, 0, -drop);
    this.ridge(this.pos);
    return this;
  }
  // sign +1 = left, -1 = right
  turn(sign, deg, r, drop) {
    if (!this.path) this.begin();
    const l = this.left();
    const c = [this.pos[0] + sign * l[0] * r, this.pos[1] + sign * l[1] * r];
    const a0 = (this.heading - sign * 90) * D2R;
    const n = Math.max(2, Math.ceil(deg / 6));
    const z0 = this.pos[2];
    for (let i = 1; i <= n; i++) {
      const t = i / n, a = a0 + sign * deg * t * D2R;
      this.pos = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z0 - drop * t];
      this.heading += sign * deg / n;
      this.ridge(this.pos, sign);
    }
    return this;
  }
  gap(len, drop, lateral = 0) {
    this.flush();
    this.pos = this.at(len, lateral, -drop);
    this.line.push([this.pos[0], this.pos[1], this.pos[2] + 60, this.si, 'air']);
    return this;
  }
  rotate(deg) { this.heading += deg; return this; }
  // --- platforms, stages, props ---------------------------------------
  // A rotated slab (8 verts), so the platform follows the course heading. Returns its axis-aligned bounds for triggers.
  platform(len, half, color = '#2b3340') {
    this.flush();
    const corners = [this.at(0, -half), this.at(0, half), this.at(len, half), this.at(len, -half)];
    const verts = corners.flatMap(c => [[c[0], c[1], this.pos[2] - 128], [c[0], c[1], this.pos[2]]]);
    this.L.brushes.push({ verts, color });
    const min = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), this.pos[2] - 128];
    const max = [Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1])), this.pos[2]];
    this.track(min); this.track(max);
    this.L.props.push({ type: 'pylon', pos: this.at(len / 2, 0, -128), r: Math.min(half, len / 2) * 0.6 });
    return [min, max];
  }
  endStage() {
    if (this.si < 0) return;
    const b = this.stageBounds;
    this.L.triggers.push({ type: 'teleport', stage: this.si, min: [b[0] - 2500, b[1] - 2500, -32000], max: [b[2] + 2500, b[3] + 2500, this.stageMinZ - 700] });
  }
  // A stage start: a platform you spawn on; arriving players fly over it. The checkpoint covers the platform and the air above.
  stage(name, len = 1024, half = 512) {
    this.endStage();
    this.si++;
    this.stageBounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.stageMinZ = Infinity;
    const [min, max] = this.platform(len, half);
    const sp = this.at(len * 0.25, 0, 1);
    this.L.spawns.push({ pos: sp, yaw: this.heading * D2R, name });
    // Tall gate: arriving players may fly far above (or a little below) the platform at speed.
    if (this.si > 0) this.L.triggers.push({ type: 'checkpoint', stage: this.si, min: [min[0], min[1], max[2] - 1200], max: [max[0], max[1], max[2] + 5000] });
    else this.L.triggers.push({ type: 'start', min: [min[0], min[1], max[2]], max: [max[0], max[1], max[2] + 300] });
    this.L.props.push({ type: 'gate', pos: this.at(len, 0, 0), yaw: this.heading, stage: this.si });
    this.line.push([sp[0], sp[1], sp[2] + 60, this.si]);
    this.pos = this.at(len, 0, -192);
    return this;
  }
  finish(len = 1400, half = 900) {
    const [min, max] = this.platform(len, half, '#3a2f4a');
    this.L.triggers.push({ type: 'end', stage: this.si + 1, min: [min[0], min[1], max[2] - 1200], max: [max[0], max[1], max[2] + 5000] });
    this.L.props.push({ type: 'gate', pos: this.at(len * 0.3, 0, 0), yaw: this.heading, finish: true });
    this.line.push([...this.at(len * 0.5, 0, 60), this.si]);
    this.endStage();
  }
  billboard(id, w, h, dl = 0, dz = 600, facing = 180) {
    this.L.billboards.push({ id, pos: this.at(0, dl, dz), yaw: this.heading + facing, w, h });
  }
  boost(speed, len = 400) {
    const d = this.dir(), a = this.at(0, -this.profile.hw, -this.profile.h), b = this.at(len, this.profile.hw, 120);
    this.L.triggers.push({ type: 'boost', dir: [d[0], d[1], 0.15], speed, min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), b[2]] });
    this.L.props.push({ type: 'booster', pos: this.at(len / 2, 0, 0), yaw: this.heading });
  }
  use(profile, color) { this.flush(); this.profile = PROFILES[profile]; if (color) this.color = color; return this; }
}

function meridian() {
  const L = { name: 'meridian', spawns: [], brushes: [], triggers: [], props: [], billboards: [], line: [], altLine: [] };
  const t = new Turtle(L);
  t.pos = [0, 0, 20000];

  // 1. THE LAUNCH — one long steep ramp, then a gap only a committed launch clears.
  t.stage('The Launch');
  t.billboard(0, 2200, 1100, -1500, 900, 150); // record holder, beside the start gate
  t.billboard(1, 1600, 800, 1500, 800, 210);
  t.use('std', '#8fa3b8').straight(3600, 1800);
  t.gap(2600, 2900);
  t.use('mega', '#6f8aa6').straight(3200, 1000).turn(-1, 25, 2400, 500);
  t.gap(900, 1900); // arrivals are diving at ~28°: the next platform sits well below the flight path

  // 2. THE SERPENT — long S-curves, carry speed through the bends.
  t.stage('The Serpent');
  t.billboard(2, 1400, 700, 0, 1400, 180);
  // Wide opening: players arrive from the Launch at 3000+ u/s.
  // At 3400 u/s a strafe alone holds r >= ~3900 (v²/3000 u/s²); this bend is holdable from either face.
  t.use('mega', '#7fb0c9').straight(2000, 700).turn(-1, 70, 4600, 1100);
  // Long straights between the bends: at 3000 u/s you need the room to cross the ridge onto the inside face.
  t.use('std', '#7fb0c9').straight(2200, 700).turn(1, 140, 3800, 1500).straight(2000, 600).turn(-1, 75, 3400, 900);
  t.gap(1600, 900);

  // 3. TRANSFERS — alternate ramps with widening gaps; jump across the ridge of each.
  t.stage('Transfers');
  t.billboard(3, 1400, 700, -1200, 900, 160);
  t.use('gentle', '#9bb3c4').straight(1800, 700);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 ? -1 : 1;
    t.gap(300 + i * 120, 320, side * 460);
    t.straight(1900, 760);
  }
  t.gap(1200, 700);

  // 4. THE HELIX — 540° around a tower. Skip: at the half-loop you are right above the exit, drop onto it.
  t.stage('The Helix');
  t.use('fast', '#c99bd9').straight(900, 300);
  const helixStart = t.pos.slice(), helixHeading = t.heading;
  t.turn(1, 540, 1500, 3200);
  {
    const l = [-Math.sin(helixHeading * D2R), Math.cos(helixHeading * D2R)];
    const c = [helixStart[0] + l[0] * 1500, helixStart[1] + l[1] * 1500];
    L.props.push({ type: 'tower', pos: [c[0], c[1], helixStart[2] - 4400], r: 760, h: 5600 });
    L.billboards.push({ id: 4, pos: [c[0], c[1], helixStart[2] - 1500], yaw: helixHeading + 90, w: 1300, h: 650, onTower: true });
  }
  t.straight(1400, 500);
  t.gap(1200, 600);

  // 5. THE GAUNTLET — low safe line, or the high narrow line with a booster.
  t.stage('The Gauntlet');
  t.billboard(5, 1400, 700, 1300, 1000, 200);
  t.use('gentle', '#8fa3b8').straight(3000, 900).turn(1, 45, 1800, 500).straight(1400, 400);
  const lowEnd = t.pos.slice(), lowHeading = t.heading;
  // High line: same path, 1000 up and offset to the right, narrow and fast, booster in the middle.
  {
    const hi = new Turtle(L, L.altLine);
    hi.si = t.si; hi.stageBounds = t.stageBounds; hi.stageMinZ = t.stageMinZ;
    hi.pos = [...L.spawns[4].pos]; hi.heading = L.spawns[4].yaw / D2R;
    hi.pos = hi.at(1024, -900, 700);
    hi.use('fast', '#d9b86b').straight(1400, 450);
    hi.boost(2400);
    hi.straight(1600, 500).turn(1, 45, 1800, 500).straight(1400, 400);
    hi.flush();
    L.brushes.push(box([hi.pos[0], hi.pos[1], hi.pos[2]].map((v, i) => v - [300, 300, 400][i]), [hi.pos[0] + 300, hi.pos[1] + 300, hi.pos[2] - 300], '#2b3340'));
    t.stageMinZ = Math.min(t.stageMinZ, hi.stageMinZ);
  }
  t.pos = lowEnd; t.heading = lowHeading;
  t.gap(1400, 900);

  // 6. THE DROP — walk off the edge, fall 3000 units onto one huge ramp, and get slung through the finish.
  t.stage('The Drop', 1400, 700);
  t.billboard(6, 1600, 800, 0, 1200, 180);
  t.gap(500, 3000);
  t.use('mega', '#e07a5f').straight(3200, 1400).turn(-1, 30, 3000, 600).straight(2400, 600);
  t.gap(1400, 700);
  t.billboard(7, 2000, 1000, 0, 1100, 180);
  t.finish();

  L.minRunMs = Math.floor(lineLength(L.line) / 3500 * 1000);
  return L;
}

function lineLength(line) {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], line[i][2] - line[i - 1][2]);
  return s;
}

const L = meridian();
// Centre the course on the origin: snapshots encode positions as i16, so everything must sit within ±32767.
{
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of L.brushes) for (const v of b.verts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
  const off = lo.map((l, i) => -Math.round((l + hi[i]) / 2));
  const sh = p => { for (let i = 0; i < 3; i++) p[i] += off[i]; return p; };
  for (const b of L.brushes) b.verts.forEach(sh);
  for (const s of L.spawns) sh(s.pos);
  for (const t of L.triggers) { sh(t.min); sh(t.max); }
  for (const p of L.props) sh(p.pos);
  for (const b of L.billboards) sh(b.pos);
  for (const p of L.line) sh(p);
  for (const p of L.altLine) sh(p);
  const span = hi.map((h, i) => h - lo[i]);
  if (Math.max(...span) > 65000) throw new Error(`level too big for i16 positions: ${span}`);
}
const r = v => Math.round(v * 10) / 10;
L.brushes.forEach(b => (b.verts = b.verts.map(v => v.map(r))));
L.line = L.line.map(p => [r(p[0]), r(p[1]), r(p[2]), ...p.slice(3)]);
writeFileSync(new URL('./meridian.json', import.meta.url), JSON.stringify(L));
console.log(`wrote levels/meridian.json: ${L.brushes.length} brushes, ${L.spawns.length} stages, ${L.billboards.length} billboards, line ${Math.round(lineLength(L.line))}u, minRunMs ${L.minRunMs}`);
