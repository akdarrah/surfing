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
  wide: { hw: 640, h: 1440 },  // 66° but as wide as mega: holds a fast spiral without a narrow edge to fall off
};
// Never morph the main line onto a narrower profile: the line hugs a face 170 out, riders sit deeper still, and a
// narrower ramp pulls the floor out from under them.

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
    this.inside = 0; // which face the line hugs: 0 = undecided (ride whichever face you landed on); straights keep the last bend's, so a crossing only happens where a bend demands it
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
  ridge(p, inside = this.inside) {
    if (!this.path) this.path = [p.slice()]; else this.path.push(p.slice());
    const l = this.left(), off = inside * Math.min(170, this.profile.hw * 0.4);
    const dz = Math.abs(off) * this.profile.h / this.profile.hw;
    this.line.push([p[0] + l[0] * off, p[1] + l[1] * off, p[2] - dz + 60, this.si, null, off]); // [5] = offset from the ridge (left +)
    this.track(p, this.profile.h);
  }
  begin() { this.flush(); this.ridge(this.pos); }
  flush() {
    if (this.path && this.path.length > 1) {
      this.L.brushes.push(...prismChain(this.path, this.profile, this.color));
      // Neon strips: the ridge and both base edges of the ramp.
      const { hw, h } = this.profile, pts = this.path;
      const sideLine = sgn => pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return [p[0] - dy / l * hw * sgn, p[1] + dx / l * hw * sgn, p[2] - h];
      });
      this.L.edges.push({ color: 'cyan', pts: pts.map(p => p.slice()) }, { color: 'magenta', pts: sideLine(1) }, { color: 'magenta', pts: sideLine(-1) });
    }
    this.path = null;
  }
  // Pitch of the last ridge segment, degrees, positive = climbing.
  pitch() {
    const p = this.path;
    if (!p || p.length < 2) return 0;
    const a = p[p.length - 2], b = p[p.length - 1];
    return Math.atan2(b[2] - a[2], Math.hypot(b[0] - a[0], b[1] - a[1])) / D2R;
  }
  // Pitch changes are eased along a ~4500-unit radius (5° steps). A concave kink shoves a face-rider outward by
  // about 0.46·v·Δ, so the bend must be long enough for strafing (~1000 u/s² back toward the ridge at best) to keep
  // up; a sharp convex one launches you off the ridge into a steep landing.
  pitchTo(deg) {
    if (!this.path || this.path.length < 2) return;
    const cur = this.pitch(), n = Math.floor(Math.abs(deg - cur) / 5), step = 4500 * 5 * D2R;
    for (let i = 1; i <= n; i++) {
      const q = cur + (deg - cur) * i / (n + 1);
      this.pos = this.at(step, 0, Math.tan(q * D2R) * step);
      this.ridge(this.pos);
    }
  }
  straight(len, drop) {
    if (!this.path) this.begin();
    this.pitchTo(Math.atan2(-drop, len) / D2R);
    this.pos = this.at(len, 0, -drop);
    this.ridge(this.pos);
    return this;
  }
  // sign +1 = left, -1 = right
  turn(sign, deg, r, drop) {
    if (!this.path) this.begin();
    this.pitchTo(Math.atan2(-drop, r * deg * D2R) / D2R);
    const l = this.left();
    // Pull the end of the preceding straight onto this bend's inside face, so a surfer following the line crosses
    // the ridge early, on the straight, rather than popping over it in the bend.
    const last = this.line[this.line.length - 1], p = this.path[this.path.length - 1];
    if (last && last[4] !== 'air' && this.inside !== sign) {
      const off = sign * Math.min(170, this.profile.hw * 0.4), dz = Math.abs(off) * this.profile.h / this.profile.hw;
      last[0] = p[0] + l[0] * off; last[1] = p[1] + l[1] * off; last[2] = p[2] - dz + 60; last[5] = off;
    }
    this.inside = sign;
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
    this.inside = 0; // after a flight you land on whichever face you land on
    this.pos = this.at(len, lateral, -drop);
    this.line.push([this.pos[0], this.pos[1], this.pos[2] + 60, this.si, 'air']);
    return this;
  }
  rotate(deg) { this.heading += deg; return this; }
  // --- platforms, stages, props ---------------------------------------
  // A rotated slab (8 verts), so the platform follows the course heading. Returns its axis-aligned bounds for triggers.
  platform(len, half, color = '#5b6678') {
    this.flush();
    const corners = [this.at(0, -half), this.at(0, half), this.at(len, half), this.at(len, -half)];
    const verts = corners.flatMap(c => [[c[0], c[1], this.pos[2] - 128], [c[0], c[1], this.pos[2]]]);
    this.L.brushes.push({ verts, color });
    this.L.edges.push({ color: 'cyan', pts: [...corners, corners[0]].map(c => [c[0], c[1], this.pos[2] + 2]) });
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
  // A stage start: a bridge pad 350 above the ridge. Spawning players drop off its end onto the ridge; arriving
  // surfers ride straight under it, because the ridge (and whoever is on its faces, up to a ramp-height below it)
  // continues unbroken. The checkpoint covers the pad and the air above and below it.
  stage(name, len = 700, half = 512) {
    this.endStage();
    this.si++;
    this.stageBounds = [Infinity, Infinity, -Infinity, -Infinity];
    this.stageMinZ = Infinity;
    // The ridge keeps its pitch under the pad (a crest at speed is a launch); the pad clears its higher end by 350.
    const rise = Math.tan(this.pitch() * D2R) * len, z0 = this.pos[2], z1 = z0 + rise;
    const ridge = this.path; this.path = null; // platform() flushes; keep the chain alive under the bridge
    this.pos[2] = Math.max(z0, z1) + 350;
    const [min, max] = this.platform(len, half);
    this.pad = { top: this.pos[2], len, half };
    const sp = this.at(len * 0.25, 0, 1);
    this.L.spawns.push({ pos: sp, yaw: this.heading * D2R, name });
    // Tall gate: arriving players may fly far above (or a little below) the platform at speed.
    if (this.si > 0) this.L.triggers.push({ type: 'checkpoint', stage: this.si, min: [min[0], min[1], max[2] - 1200], max: [max[0], max[1], max[2] + 5000] });
    else this.L.triggers.push({ type: 'start', min: [min[0], min[1], max[2]], max: [max[0], max[1], max[2] + 300] });
    this.L.props.push({ type: 'gate', pos: this.at(len, 0, 0), yaw: this.heading, stage: this.si });
    this.line.push([sp[0], sp[1], sp[2] + 60, this.si]);
    this.pos = this.at(len, 0, z1 - this.pos[2]);
    this.path = ridge;
    if (ridge) this.ridge(this.pos);
    return this;
  }
  finish(len = 1400, half = 900) {
    const [min, max] = this.platform(len, half, '#6a5a7a');
    this.L.triggers.push({ type: 'end', stage: this.si + 1, min: [min[0], min[1], max[2] - 1200], max: [max[0], max[1], max[2] + 5000] });
    this.L.props.push({ type: 'gate', pos: this.at(len * 0.3, 0, 0), yaw: this.heading, finish: true });
    this.line.push([...this.at(len * 0.5, 0, 60), this.si]);
    this.endStage();
  }
  // A spray wall: a panel prop plus the volume in front of it you must be inside to paint it.
  wall(id, name, w, h, dl = 0, dz = 600, facing = 180) {
    const pos = this.at(0, dl, dz), yaw = this.heading + facing;
    this.L.walls.push({ id, name, pos, yaw, w, h });
    const f = [Math.cos(yaw * D2R), Math.sin(yaw * D2R)], l = [-f[1], f[0]];
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [pos[0] + f[0] * (a > 0 ? 1100 : -80) + l[0] * b * (w / 2 + 300), pos[1] + f[1] * (a > 0 ? 1100 : -80) + l[1] * b * (w / 2 + 300)]);
    this.L.triggers.push({ type: 'wall', id, min: [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), pos[2] - h / 2 - 500], max: [Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1])), pos[2] + h / 2 + 300] });
  }
  // Side-route helper: a floating slab you can land on, with a wall on it and a neon marker.
  perch(id, name, pos, heading, size = 900) {
    const t = new Turtle(this.L, this.L.altLine);
    t.si = this.si; t.pos = [pos[0], pos[1], pos[2]]; t.heading = heading;
    t.stageBounds = [Infinity, Infinity, -Infinity, -Infinity]; t.stageMinZ = Infinity;
    const [min, max] = t.platform(size, size / 2, '#4f5b6e');
    t.pos = t.at(size * 0.5, 0, 0);
    t.wall(id, name, 900, 560, 0, 420, 0);
    this.L.props.push({ type: 'beacon', pos: t.at(0, 0, 700) });
    // Keep the stage's fall volume below the perch too.
    this.stageMinZ = Math.min(this.stageMinZ, min[2]);
    this.track(min); this.track(max);
    return [min, max];
  }
  // A booster across the end of the stage pad: catches a standing start before it steps off (arrivals pass under the pad).
  padBoost(speed, up = 0) {
    const { top, len, half } = this.pad, d = this.dir();
    const a = this.at(-500, -half, top - this.pos[2]), b = this.at(0, half, top - this.pos[2] + 200);
    this.L.triggers.push({ type: 'boost', dir: [d[0], d[1], up], speed, min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), b[2]] });
    this.L.props.push({ type: 'booster', pos: this.at(-250, 0, top - this.pos[2]), yaw: this.heading });
  }
  boost(speed, len = 400, up = 0.15) {
    const d = this.dir(), a = this.at(0, -this.profile.hw, -this.profile.h), b = this.at(len, this.profile.hw, 120);
    this.L.triggers.push({ type: 'boost', dir: [d[0], d[1], up], speed, min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), b[2]] });
    this.L.props.push({ type: 'booster', pos: this.at(len / 2, 0, 0), yaw: this.heading });
  }
  // Changing profile mid-ramp morphs the cross-section over 400 units: a plain restart would leave a vertical
  // end-cap that anyone riding low on the old face slams into.
  use(profile, color) {
    const next = PROFILES[profile];
    if (this.path && next !== this.profile) {
      const pitch = this.pitch();
      this.flush();
      const a = this.pos, l = this.left(), b = this.at(1200, 0, Math.tan(pitch * D2R) * 1200); // long: a shallower face rising under a deep rider is a concave kink
      const tri = (p, { hw, h }) => [[p[0], p[1], p[2]], [p[0] + l[0] * hw, p[1] + l[1] * hw, p[2] - h], [p[0] - l[0] * hw, p[1] - l[1] * hw, p[2] - h]];
      const ta = tri(a, this.profile), tb = tri(b, next);
      this.L.brushes.push({ verts: [...ta, ...tb], color: color ?? this.color, chain: true });
      const cp = (...ps) => ps.map(q => q.slice()); // centering shifts points in place: never share arrays with the brush
      this.L.edges.push({ color: 'cyan', pts: cp(ta[0], tb[0]) }, { color: 'magenta', pts: cp(ta[1], tb[1]) }, { color: 'magenta', pts: cp(ta[2], tb[2]) });
      this.pos = b;
      this.path = null;
      this.profile = next;
      this.ridge(b);
    } else this.flush();
    this.profile = next; if (color) this.color = color; return this;
  }
}

function meridian() {
  const L = { name: 'meridian', spawns: [], brushes: [], triggers: [], props: [], walls: [], routes: [], line: [], altLine: [], edges: [] };
  const t = new Turtle(L);
  t.pos = [0, 0, 20000];

  // 1. THE LAUNCH — one long steep ramp, then a gap only a committed launch clears.
  t.stage('The Launch');
  t.wall(0, 'Start Gate', 2200, 1100, -1500, 900, 150); // the record holder's wall, until someone paints it
  t.wall(1, 'Launch Pad', 1600, 800, 1500, 800, 210);
  t.use('std', '#8fa3b8').straight(3600, 1500);
  // The drop: the landing ramp continues the launch's line at 38°, the pitch a 1,500 u/s launch falls back onto it
  // at, so you land near the ridge with your velocity along the ramp instead of sliding down the face. Then ease out.
  t.gap(1500, 1155);
  t.use('mega', '#6f8aa6').straight(2000, 1540).straight(1400, 500).straight(1600, 150);

  // 2. THE SERPENT — long S-curves, carry speed through the bends.
  t.stage('The Serpent');
  t.wall(2, 'Serpent Gate', 1400, 700, 0, 1400, 180);
  // Wide opening: players arrive from the Launch at 3000+ u/s.
  // At 3400 u/s a strafe alone holds r >= ~3900 (v²/3000 u/s²); this bend is holdable from either face.
  t.use('mega', '#7fb0c9').straight(2600, -200).turn(-1, 65, 7000, 800);
  // Long, gently climbing straights between the bends: crossing the ridge onto the next inside face always hops you
  // off it, and on a climb the hop comes straight back down.
  t.use('mega', '#7fb0c9').straight(3600, -400).turn(1, 70, 6000, 300);
  {
    // Serpent Island: fly straight off the outside of the bend's apex and you land on it.
    const island = t.at(1800, -1500, -600);
    t.perch(10, 'Serpent Island', island, t.heading, 1000);
  }
  t.turn(1, 70, 6000, 300).straight(3600, -350).turn(-1, 75, 5500, 400);

  // 3. TRANSFERS — alternate ramps with widening gaps; jump across the ridge of each.
  t.stage('Transfers');
  t.wall(3, 'Transfer Deck', 1400, 700, -1200, 900, 160);
  // Flatter than it looks: transfers are about the sideways hops, not more speed.
  t.use('mega', '#9bb3c4').straight(2600, 300);
  for (let i = 0; i < 4; i++) {
    const side = i % 2 ? -1 : 1;
    t.gap(300 + i * 120, 320, side * 220); // a staircase of offset ramps: from anywhere on the near face you land by the next ridge
    t.straight(1900, 420);
  }
  t.boost(2600); // a standing start can't make the climb on its own
  t.straight(9000, -1500); // long shallow climb into the tower: bleeds speed for the helix without a crest to launch off

  // 4. THE HELIX — 540° around a tower. Skip: at the half-loop you are right above the exit, drop onto it.
  t.stage('The Helix');
  // A climb into the helix scrubs speed before the spiral.
  // The climb carries on from the Transfers: no crest at the pad, so nobody gets launched into a steep landing.
  t.use('mega', '#c99bd9');
  t.boost(2600); // standing starts can't make the climb on their own; arrivals are already faster than this
  t.straight(8000, -1600);
  const branch = t.pos.slice(), branchHeading = t.heading;
  t.turn(1, 90, 6000, -100); // a wide climbing bend keeps you pressed on the face instead of launching you off the top of the climb
  t.use('wide', '#c99bd9');
  const helixStart = t.pos.slice(), helixHeading = t.heading;
  t.turn(1, 270, 3000, 1300).turn(1, 180, 4200, 300); // 450° widening spiral: the second loop passes under the entry bend's approach, so it must drop past that prism (960 deep) first; the exit heads away from the climb
  {
    const l = [-Math.sin(helixHeading * D2R), Math.cos(helixHeading * D2R)];
    const c = [helixStart[0] + l[0] * 3000, helixStart[1] + l[1] * 3000];
    L.props.push({ type: 'tower', pos: [c[0], c[1], helixStart[2] - 2200], r: 1800, h: 3600 });
    // Crow's Nest: at the top of the spiral, ride the outer face and jump off it: a crown floats ahead and to the
    // right, where a 2,000-2,400 u/s fly-off comes down. The second loop passes well underneath it.
    const top = new Turtle(L, L.altLine); // positions relative to the helix start (t is at the spiral's end by now)
    top.pos = helixStart.slice(); top.heading = helixHeading;
    const jump = top.at(600, 0, 0);
    const nest = new Turtle(L, L.altLine);
    nest.si = t.si; nest.stageBounds = t.stageBounds; nest.stageMinZ = t.stageMinZ;
    nest.pos = top.at(2000, -1000, -800); nest.heading = helixHeading;
    nest.platform(2400, 800, '#3f4a5c');
    L.routes.push({ name: "Crow's Nest", wall: 11, line: [[...jump, t.si], [...nest.at(1200, 0, 60), t.si]] });
    nest.pos = nest.at(1200, 0, 0);
    nest.wall(11, "Crow's Nest", 1100, 650, 0, 480, 0);
    L.props.push({ type: 'beacon', pos: [nest.pos[0], nest.pos[1], nest.pos[2] + 900] });
    L.walls.push({ id: 4, name: 'Helix Tower', pos: [c[0], c[1], helixStart[2] - 1500], yaw: helixHeading + 90, w: 1300, h: 650, onTower: true });
    L.triggers.push({ type: 'wall', id: 4, min: [c[0] - 3400, c[1] - 3400, helixStart[2] - 2400], max: [c[0] + 3400, c[1] + 3400, helixStart[2] - 600] });
  }
  t.straight(3600, 300); // long exit: carries the stage-5 gate clear of the entry arc overhead

  // 5. THE GAUNTLET — low safe line, or the high narrow line with a booster.
  t.stage('The Gauntlet');
  t.wall(5, 'Gauntlet Wall', 1400, 700, 1300, 1000, 200);
  t.use('mega', '#8fa3b8').straight(4400, 1200).turn(1, 45, 5200, 600).straight(1400, 400);
  const lowEnd = t.pos.slice(), lowHeading = t.heading;
  // High line: same path, 1000 up and offset to the right, narrow and fast, booster in the middle.
  {
    const hi = new Turtle(L, L.altLine);
    hi.si = t.si; hi.stageBounds = t.stageBounds; hi.stageMinZ = t.stageMinZ;
    hi.pos = [...L.spawns[4].pos]; hi.heading = L.spawns[4].yaw / D2R;
    hi.pos = hi.at(1024, -900, 700);
    hi.use('fast', '#d9b86b').straight(1400, 450);
    hi.boost(2400);
    hi.straight(3000, 800).turn(1, 45, 5200, 600).straight(1400, 400);
    hi.flush();
    hi.pos = hi.at(500, -900, 150);
    t.perch(12, 'High Line', hi.pos, hi.heading, 1000);
    t.stageMinZ = Math.min(t.stageMinZ, hi.stageMinZ);
  }
  t.pos = lowEnd; t.heading = lowHeading;

  // 6. THE DROP — launch off the edge, fall 1,300 across a 3,000 gap onto one huge 28° ramp (where the parabola of a
  // ~3,000 u/s exit comes down, at the angle it comes down: a ramp much steeper than that would sling you past 4,000
  // u/s, and no ease-out survives that), and get slung through the finish.
  t.stage('The Drop', 1400, 700);
  t.wall(6, 'Drop Zone', 1600, 800, 0, 1200, 180);
  // Under the Drop: veer left off the edge and there's a ledge 1,200 down instead of the long fall.
  t.perch(13, 'Under the Drop', t.at(300, 1300, -1300), t.heading, 900);
  t.padBoost(2600, -0.45); // a standing start would fall short of the ramp; the dive puts it on an arrival's parabola
  t.gap(3000, 1300);
  t.use('mega', '#e07a5f').straight(2400, 1276).straight(2000, 700);
  t.gap(1400, 1000); // deep enough that a rider low on the face still clears the platform's edge
  t.wall(7, 'Finish Line', 2000, 1000, 0, 1100, 180);
  t.finish();
  // Finish Lookout: don't stop at the line. Bunny-hop the landing so friction doesn't eat your speed, fly off the end
  // of the finish platform, and the column is where a ~3,000+ u/s exit comes down.
  t.perch(14, 'Finish Lookout', t.at(5000, 0, -900), t.heading, 2600);

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
  for (const b of L.walls) sh(b.pos);
  for (const r of L.routes) r.line.forEach(sh);
  for (const p of L.line) sh(p);
  for (const p of L.altLine) sh(p);
  for (const e of L.edges) e.pts.forEach(sh);
  const span = hi.map((h, i) => h - lo[i]);
  if (Math.max(...span) > 130000) throw new Error(`level too big for i16 positions at 2-unit steps: ${span}`);
}
const r = v => Math.round(v * 10) / 10;
L.brushes.forEach(b => (b.verts = b.verts.map(v => v.map(r))));
L.line = L.line.map(p => [r(p[0]), r(p[1]), r(p[2]), ...p.slice(3)]);
L.edges.forEach(e => (e.pts = e.pts.map(p => p.map(r))));
writeFileSync(new URL('./meridian.json', import.meta.url), JSON.stringify(L));
console.log(`wrote levels/meridian.json: ${L.brushes.length} brushes, ${L.spawns.length} stages, ${L.walls.length} walls, line ${Math.round(lineLength(L.line))}u, minRunMs ${L.minRunMs}`);
