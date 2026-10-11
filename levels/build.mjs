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
  surf: { hw: 900, h: 1100 },   // 51°, 1,800 wide: the course ramp. Shallower = ~800 u/s² of strafe recovery (vs ~560 on 56°), and 1,100 of face to drift on
  catch: { hw: 1600, h: 2400 }, // 56°, 3,200 wide: the funnel both branches of a fork land on
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
  // Pitch changes are eased along a ~5000-unit radius (5° steps) on the 51° course profile. Measured: at 2,800 u/s on a 6,500 radius the joint shove (0.46·v²/R) exactly cancelled the ~600 u/s² a rider can strafe back toward the ridge, so riders drifted off the face at constant speed. A concave kink shoves a face-rider outward by
  // about 0.46·v·Δ, so the bend must be long enough for strafing (~1000 u/s² back toward the ridge at best) to keep
  // up; a sharp convex one launches you off the ridge into a steep landing.
  pitchTo(deg) {
    if (!this.path || this.path.length < 2) return;
    const cur = this.pitch(), n = Math.floor(Math.abs(deg - cur) / 5), step = 5000 * 5 * D2R;
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
    // Wide gate: riders arrive anywhere across a catcher's width, well off the pad's axis.
    if (this.si > 0) this.L.triggers.push({ type: 'checkpoint', stage: this.si, min: [min[0] - 1300, min[1] - 1300, max[2] - 1200], max: [max[0] + 1300, max[1] + 1300, max[2] + 5000] });
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

// --- classic-surf course helper ------------------------------------------------------------------
// Tracks the surfer's speed by energy (v² = v0² + 2g·drop, minus a small loss per landing) so every gap is sized to
// the speed you actually have there. A ramp dives (gains speed) and eases into a short climb; you loft off its end
// across a gap and land on the next ramp, which is pitched to the arrival angle of a glider 25% SLOWER than the
// design speed: fast riders come down further along it at a flatter angle (harmless), slow riders still make it,
// and a walking start falls short. Reads like a map: ramp, jump, land, ramp, jump…
const G = 800;
// Horizontal length of the loft from a ramp end at `pitch`° to an `arrival`° landing for a glider at `margin` speed.
function gapFor(v, pitch, arrival, margin) {
  const vs = v * margin, vx = vs * Math.cos(pitch * D2R), vz = vs * Math.sin(pitch * D2R);
  return vx * (vz + vx * Math.tan(-arrival * D2R)) / G;
}
function flight(v, pitchDeg, dist) {
  const p = pitchDeg * D2R, vx = v * Math.cos(p), vz0 = v * Math.sin(p), t = dist / vx;
  return { drop: -(vz0 * t - 0.5 * G * t * t), angle: Math.atan2(vz0 - G * t, vx) / D2R, t };
}
class Course {
  constructor(t, v) { this.t = t; this.v = v; this.zRef = t.pos[2]; this.vRef = v; this.loss = 0; this.pending = null; this.target = 2000; }
  speed() { const dz = this.zRef - this.t.pos[2]; return Math.sqrt(Math.max(0, this.vRef * this.vRef + 2 * G * dz)) * (1 - this.loss); }
  lose(f) { this.vRef = this.speed() * (1 - f); this.zRef = this.t.pos[2]; this.loss = 0; }
  // A classic ramp: dive `len` at `pitch`°, then ease into a climb at `up`° so the exit lofts you. The climb's length
  // defaults to whatever brings the speed back to the course target (plus the ~500 of drop the loft and landing
  // will add), so every cycle is energy-neutral and the course never runs away: more speed would mean longer lofts,
  // longer landing ramps, more drop, more speed.
  ramp(len, pitch, upLen = null, up = 10) {
    const t = this.t;
    // Two-sided governor: below target the dive deepens (up to 600 extra, pitch capped at 28°); above it the
    // climb grows. The loft and landing add ~500 of drop, so the climb aims 500 above neutral.
    const v0 = this.speed(), deficit = Math.max(0, (this.target * this.target - v0 * v0) / (2 * G));
    let drop = Math.tan(pitch * D2R) * len + Math.min(600, deficit);
    if (Math.atan2(drop, len) / D2R > 28) len = drop / Math.tan(28 * D2R);
    t.straight(len, drop);
    if (upLen === null && up > 0) {
      const v = this.speed(), rise = Math.max(120, (v * v - this.target * this.target) / (2 * G) + 300);
      upLen = Math.round(rise / Math.tan(up * D2R));
    }
    if (upLen) t.straight(upLen, -Math.tan(up * D2R) * upLen);
    return this;
  }
  // Loft off the current ramp end. The gap is whatever the loft gives: it ends where a glider at `margin` of the
  // design speed comes down at `arrival`° (so slower riders still make it, a walking start never does), and the
  // landing ramp is pitched to that angle; `land()` makes it long enough for a full-speed rider, who comes down
  // further along at a flatter, harmless angle. `lateral` is strafed across mid-air.
  jump(arrival = -10, lateral = 0, margin = 0.92) {
    const t = this.t, v = this.speed(), p = t.pitch();
    if (p < 4) throw new Error(`jump needs a climbing ramp end to loft from (pitch ${p.toFixed(1)}° at ${Math.round(v)} u/s)`);
    const vs = v * margin, vxs = vs * Math.cos(p * D2R), vzs = vs * Math.sin(p * D2R);
    const ts = (vzs + vxs * Math.tan(-arrival * D2R)) / G, dist = vxs * ts;
    const slow = flight(vs, p, dist);
    // The landing ramp is 8° flatter than the slow arrival: pitched at the arrival angle it would run almost parallel
    // to a full-speed rider's arc, who would come down thousands of units later on a long steep ramp (runaway speed).
    const landPitch = Math.max(8, -slow.angle); // tangent for the slow rider; the fast one comes down ~1,000 further at ~9° relative. The extra drop of this steeper landing is paid back by the next ramp's auto-climb.
    const vx = v * Math.cos(p * D2R), vz0 = v * Math.sin(p * D2R), tanA = Math.tan(landPitch * D2R);
    let x = dist, zf = 0;
    for (; x < dist + 12000; x += 25) {
      const tt = x / vx; zf = vz0 * tt - 0.5 * G * tt * tt; const zr = -slow.drop - (x - dist) * tanA;
      if (zf <= zr) break;
    }
    const fast = flight(v, p, x);
    this.pending = { pitch: landPitch, minLen: x - dist + 600, v, dist, fastRel: -fast.angle - landPitch };
    if (process.env.VERBOSE) console.log('   jump'.padEnd(26), 'gap', Math.round(dist), 'drop', Math.round(slow.drop), 'land pitch', landPitch.toFixed(0) + '°', 'fast lands +' + Math.round(x - dist), 'at', this.pending.fastRel.toFixed(0) + '° rel');
    t.gap(dist, slow.drop, lateral);
    return this;
  }
  // The landing ramp after a jump: at least long enough for the fast rider to come down on it, then it is a normal
  // ramp again (a following ramp() eases the pitch).
  land(len = 700) {
    const q = this.pending; if (!q) throw new Error('land() without jump()');
    const L = Math.max(len, q.minLen);
    if (process.env.VERBOSE) console.log('   land'.padEnd(26), 'len', Math.round(L), 'pitch', q.pitch.toFixed(0) + '°', 'gap was', Math.round(q.dist));
    this.t.straight(L, Math.tan(q.pitch * D2R) * L);
    this.lose(0.02); // the landing costs a little (calibrated: real runs come out faster than a 4% model)
    this.pending = null;
    return this;
  }
  // A banked bend sized to the current speed (equilibrium radius v²/(g·tanφ) on a 56° face), holding the pitch.
  bowl(sign, deg, pitchDeg = this.t.pitch()) {
    const v = this.speed(), r = Math.max(1800, Math.round(v * v / (G * 1.5) / 100) * 100);
    const arc = r * deg * D2R;
    this.t.turn(sign, deg, r, -Math.tan(pitchDeg * D2R) * arc); // pitch > 0 climbs; turn() takes a drop
    this.lose(0.03);
    return this;
  }
}

function meridian() {
  const L = { name: 'meridian', spawns: [], brushes: [], triggers: [], props: [], walls: [], routes: [], line: [], altLine: [], edges: [] };
  const t = new Turtle(L);
  t.pos = [0, 0, 20000];
  const say = (label) => { if (process.env.VERBOSE) console.log(label.padEnd(26), 'v≈' + Math.round(c.speed()), 'pitch', t.pitch().toFixed(1)); };
  // Every ramp here: a short dive, then a climb sized to bring the speed back to the course target, then a loft off
  // its end across a gap onto the next one. Small pitch changes (-12° landing to +8° climb) keep the joint shove on
  // the eased transitions well inside what a rider can strafe back.

  // START — the pad drops you onto the first ramp; two warm-up ramps with growing gaps build the speed.
  t.stage('Start');
  t.wall(0, 'Start Gate', 2200, 1100, -1500, 900, 150);
  t.wall(1, 'Launch Pad', 1600, 800, 1500, 800, 210);
  t.use('surf', '#f3efe6');
  const c = new Course(t, 300);
  c.ramp(2000, 13); say('warm-up 1');
  c.jump(-10).land().ramp(800, 18); say('into the split');

  // FORK 1 — THE SPLIT. Safe line: one more ramp and gap. Fast line: a bigger loft over a wide gap, with a wall on
  // the ledge beside the landing. Both come down on the same wide catcher.
  t.stage('The Split');
  t.padBoost(2000);
  t.wall(2, 'Split Gate', 1400, 700, 0, 1400, 180);
  fork(L, t, c, {
    name: 'The Long Gap', wall: 10, sign: -1, catcherLen: 2200,
    main: (t, c) => { c.ramp(900, 13).jump(-10).land(); },
    fast: (b, bc) => {
      bc.target = 2300;
      bc.ramp(1200, 13).jump(-16, 0, 0.9).land();
      b.perch(10, 'Long Gap Ledge', b.at(600, -1500, -500), b.heading, 1000);
    },
  });
  say('after catcher 1');

  // TRANSFERS — ramp, gap, ramp, gap.
  t.stage('Transfers');
  t.padBoost(2000);
  t.wall(3, 'Transfer Deck', 1400, 700, -1200, 900, 160);
  c.ramp(800, 13).jump(-10).land(); say('transfer');
  c.bowl(1, 180, -4).ramp(800, 16); // the course snakes back on itself, like a surf map in its box

  // FORK 2 — THE PIPE. Safe line: a ramp and gap. Fast line: a full spiral loop away from the safe track, with a wall
  // at its bottom. Catcher again.
  t.stage('The Pipe');
  t.padBoost(2000);
  t.wall(4, 'Pipe Gate', 1300, 650, 0, 1300, 180);
  fork(L, t, c, {
    name: 'The Spiral', wall: 11, sign: 1, catcherLen: 2200,
    main: (t, c) => { c.ramp(900, 13).jump(-10).land(); },
    fast: (b, bc) => {
      bc.ramp(900, 13).jump(-10).land();
      bc.bowl(-1, 360, -4); // a full loop AWAY from the safe track (which is on the left), back on heading; -4° drops ~1,600 over the loop so the end clears the 1,100-deep ramp it started on
      b.wall(11, 'Spiral Wall', 1200, 650, -1400, 900, 120);
    },
  });

  // SPEED GAPS — two escalating gaps; the second needs the full line.
  t.stage('Speed Gaps');
  t.padBoost(2300);
  t.wall(5, 'Gap Gate', 1400, 700, 1300, 1000, 200);
  c.target = 2250; // this section is about speed
  c.ramp(800, 13).jump(-16, 0, 0.93).land(); say('speed gap');
  t.perch(12, 'Over the Gap', t.at(600, 1500, 300), t.heading, 1000);
  c.target = 2000;
  c.ramp(800, 13);

  // THE RUN-IN — a last ramp and gap, with a ledge off to the right, into the finish.
  t.stage('The Run-in');
  t.padBoost(2000);
  t.wall(6, 'Run-in Gate', 1600, 800, 0, 1200, 180);
  c.ramp(900, 13).jump(-10).land();
  t.perch(13, 'Run-in Ledge', t.at(900, -1600, -300), t.heading, 1000); // off the right edge of the landing
  c.ramp(900, 13); say('final ramp');
  c.jump(-10);
  t.wall(7, 'Finish Line', 2000, 1000, 0, 1100, 180);
  t.pos = t.at(0, 0, -450); // the pad sits under the line: cross the gate flying, land on it only if you want to stop
  t.finish(1800, 1100);
  t.perch(14, 'Finish Lookout', t.at(3000, 0, -900), t.heading, 3000);

  L.minRunMs = Math.floor(lineLength(L.line) / 3500 * 1000);
  return L;
}

// A fork: from a ramp end, the safe line strafe-jumps 900 to one side and the fast line 900 to the other; they run
// straight and parallel (1,800 apart: 520 of air between the ramps), and both strafe back onto a shared 3,200-wide
// catcher. Dry runs measure each branch's length and end height so the shorter one is padded with a level straight
// and the lower one climbs on its lead-in (a climb bleeds speed; a dive would pump it).
function fork(L, t, c, o) {
  const start = { pos: t.pos.slice(), heading: t.heading, v: c.speed(), si: t.si, pitch: t.pitch() };
  const dir = [Math.cos(start.heading * D2R), Math.sin(start.heading * D2R)];
  const alongOf = p => (p[0] - start.pos[0]) * dir[0] + (p[1] - start.pos[1]) * dir[1];
  const side = o.sign; // safe line goes to this side
  const dry = (build, which, pad = 0) => {
    const L0 = { brushes: [], triggers: [], props: [], walls: [], line: [], altLine: [], edges: [], spawns: [], routes: [] };
    const tt = new Turtle(L0, L0.altLine); tt.pos = start.pos.slice(); tt.heading = start.heading; tt.use('surf'); tt.si = start.si;
    tt.stageBounds = [Infinity, Infinity, -Infinity, -Infinity]; tt.path = [tt.pos.slice(), tt.pos.slice()]; // pretend we are on a ramp end
    tt.path[0][0] -= dir[0] * 1000; tt.path[0][1] -= dir[1] * 1000; tt.path[0][2] -= Math.tan(start.pitch * D2R) * 1000;
    const cc = new Course(tt, start.v);
    cc.jump(-10, which * 900).land(); const a1 = alongOf(tt.pos); build(tt, cc); const a2 = alongOf(tt.pos); if (pad) cc.ramp(pad, 0, 0);
    if (process.env.VERBOSE) console.log('   dry'.padEnd(26), which > 0 === (side > 0) ? 'safe' : 'fast', 'split', Math.round(a1), 'elements', Math.round(a2 - a1), 'pad', Math.round(pad));
    return { along: alongOf(tt.pos), z: tt.pos[2], v: cc.speed() };
  };
  const m0 = dry(o.main, side), f0 = dry(o.fast, -side);
  // Pad the shorter branch. A pad also brings ~1,000 of pitch easing, so iterate; never go negative (if the easing
  // alone overshoots, pad the other branch by the overshoot instead).
  let padMain = 0, padFast = 0;
  for (let k = 0; k < 3; k++) {
    const dm = dry(o.main, side, padMain).along, df = dry(o.fast, -side, padFast).along, diff = df - dm;
    if (Math.abs(diff) < 60) break;
    if (diff > 0) { if (padFast > 0) padFast = Math.max(0, padFast - diff); else padMain += diff; }
    else { if (padMain > 0) padMain = Math.max(0, padMain + diff); else padFast -= diff; }
  }
  const endF = dry(o.fast, -side, padFast), endM = dry(o.main, side, padMain);
  const need = 460 - (endF.z - endM.z); // > 0: the fast line ends too low. Target: launch level ~300 above the catcher start (the safe lead's climb puts the catcher ~260 above the safe end; a level launch 1,800 back falls ~200 on the way)
  const CLIMB = 20;
  let lenM = 1600, pitchM = 0, lenF = 1600, pitchF = 0;
  // Split the balance: the lower branch climbs half of it, the higher one dives half, so neither bleeds or pumps much.
  const half = Math.abs(need) / 2;
  if (need > 0) { lenF = Math.max(1600, half / Math.tan(CLIMB * D2R)); pitchF = Math.atan2(half, lenF) / D2R; lenM = Math.max(1600, half / Math.tan(25 * D2R)); pitchM = -Math.atan2(half, lenM) / D2R; }
  else { lenM = Math.max(1600, half / Math.tan(CLIMB * D2R)); pitchM = Math.atan2(half, lenM) / D2R; lenF = Math.max(1600, half / Math.tan(25 * D2R)); pitchF = -Math.atan2(half, lenF) / D2R; }
  const vM = Math.sqrt(Math.max(1, endM.v * endM.v + 2 * G * (lenM * Math.tan(-pitchM * D2R) - 212)));
  const gapM = gapFor(vM, 10, -10, 0.92);
  // (+1,500 below: the fast lead is re-aimed steeper after its easing, which lengthens its footprint; surplus becomes a level run-in.)
  // The fast lead's real footprint: ~2,000 of easing into its climb, the climb, ~1,100 easing back to level, a level
  // 400, then 1,800 of loft. The safe lead (+ its 1,000 climb + its loft gap) must reach at least that far.
  { const dzM = lenM * Math.tan(pitchM * D2R); lenM = Math.max(lenM, (Math.floor((Math.abs(pitchF) + 12) / 5) + 1) * 436 + 400 + lenF + 1100 + 400 + 1800 - gapM - 1000 + 600); pitchM = Math.atan2(dzM, lenM) / D2R; } // keep the planned climb/dive over the final length
  // Safe line, for real.
  c.jump(-10, side * 900).land(); o.main(t, c); if (padMain) c.ramp(padMain, 0, 0);
  c.ramp(lenM, -pitchM, 1000, 12).jump(-10, -side * 900);
  const catcher = { start: t.pos.slice(), heading: t.heading, pitch: c.pending.pitch, len: Math.max(o.catcherLen, c.pending.minLen) };
  t.use('catch', '#f3efe6');
  c.land(o.catcherLen);
  // Fast line, on the alt line.
  const b = new Turtle(L, L.altLine); b.si = start.si; b.stageBounds = t.stageBounds; b.stageMinZ = t.stageMinZ;
  b.pos = start.pos.slice(); b.heading = start.heading; b.use('surf', '#f3efe6'); b.inside = 0;
  b.path = [start.pos.slice(), start.pos.slice()]; b.path[0][0] -= dir[0] * 1000; b.path[0][1] -= dir[1] * 1000; b.path[0][2] -= Math.tan(start.pitch * D2R) * 1000;
  const bc = new Course(b, start.v);
  const line0 = L.altLine.length;
  bc.jump(-10, -side * 900).land(); o.fast(b, bc); if (padFast) bc.ramp(padFast, 0, 0);
  if (process.env.VERBOSE) console.log(('fork ' + o.name).padEnd(26), 'safe', Math.round(m0.along), 'fast', Math.round(f0.along), 'pad', Math.round(padMain || padFast), 'fast ends', Math.round(endF.z - endM.z), 'above the safe end; leads', Math.round(lenM) + '@' + pitchM.toFixed(0), Math.round(lenF) + '@' + pitchF.toFixed(0));
  // The fast lead, solved by dry runs: a climb (or dive) at pitch pf, eased back to level, ending 1,800 before the
  // catcher at the height a level launch needs to come down ~250 past its start. The easing in and out of the climb
  // changes both height and length, so guess pf, dry-build, correct, repeat.
  {
    const d = dir;
    const vF0 = bc.speed(), fall = 0.5 * G * (1800 / vF0) * (1800 / vF0);
    const want = catcher.start[2] + fall + 250 - b.pos[2];
    const build = (tt, cc, pf) => {
      const alongTo = () => (catcher.start[0] - tt.pos[0]) * d[0] + (catcher.start[1] - tt.pos[1]) * d[1];
      cc.ramp(400, -pf, 0);
      const easeOut = (Math.floor(Math.abs(pf) / 5) + 1) * 436;
      const len = Math.max(600, alongTo() - 1800 - 400 - easeOut);
      cc.ramp(len, -pf, 400, 0);
      const a3 = alongTo();
      if (a3 > 1900) tt.straight(a3 - 1800, 0);
      lever = len + 400;
      return alongTo();
    };
    let lever = 3000, pf = Math.atan2(want, 3000) / D2R;
    for (let k = 0; k < 8; k++) {
      const L0 = { brushes: [], triggers: [], props: [], walls: [], line: [], altLine: [], edges: [], spawns: [], routes: [] };
      const tt = new Turtle(L0, L0.altLine); tt.pos = b.pos.slice(); tt.heading = b.heading; tt.profile = b.profile; tt.inside = b.inside; tt.path = b.path.map(q => q.slice()); tt.si = b.si;
      tt.stageBounds = [Infinity, Infinity, -Infinity, -Infinity];
      const cc = new Course(tt, bc.speed());
      build(tt, cc, pf);
      const rise = tt.pos[2] - b.pos[2];
      if (Math.abs(rise - want) < 40) break;
      pf = Math.max(-32, Math.min(32, pf + 0.7 * Math.atan2(want - rise, lever) / D2R)); // the lead's real length is the lever
    }
    if (Math.abs(pf) > 32) throw new Error(`fork ${o.name}: fast lead would need ${pf.toFixed(0)}° to change ${Math.round(want)}`);
    const zS = b.pos[2];
    const along3 = build(b, bc, pf);
    if (process.env.VERBOSE) console.log('   fast lead'.padEnd(26), 'v0', Math.round(vF0), 'v1', Math.round(bc.speed()), 'pitch', pf.toFixed(1), 'rose', Math.round(b.pos[2] - zS), 'wanted', Math.round(want), 'launch is', Math.round(b.pos[2] - catcher.start[2]), 'above the catcher start,', Math.round(along3), 'before it');
  }
  aimAt(b, bc, catcher, 'fast line ' + o.name);
  L.routes.push({ name: o.name, wall: o.wall, rejoin: true, line: L.altLine.slice(line0).map(p => p.slice()) });
  t.stageMinZ = Math.min(t.stageMinZ, b.stageMinZ);
  // Back to the normal width with a loft, not a morph (a narrower floor under a rider off-centre is a hole).
  c.ramp(300, 13).jump(-10); t.use('surf', '#f3efe6'); c.land();
}

// Steer a fast line onto a catcher ramp: turn to the catcher's heading, then place one last ramp whose loft comes
// down on the catcher's ridge line within 500 laterally. Asserts, so a mis-sized fast line fails the build.
function aimAt(b, bc, catcher, label) {
  const d = [Math.cos(catcher.heading * D2R), Math.sin(catcher.heading * D2R)], l = [-d[1], d[0]];
  // Align heading with a bend (signed by which side the catcher axis is on).
  let dh = ((catcher.heading - b.heading + 540) % 360) - 180;
  if (Math.abs(dh) > 1) bc.bowl(Math.sign(dh), Math.abs(dh), b.pitch());
  const rel = [b.pos[0] - catcher.start[0], b.pos[1] - catcher.start[1]];
  const along = rel[0] * d[0] + rel[1] * d[1], lat = rel[0] * l[0] + rel[1] * l[1];
  if (Math.abs(lat) > 1100) throw new Error(`${label}: ends ${Math.round(lat)} units off the catcher axis (limit 1100)`);
  if (along > -600) throw new Error(`${label}: ends ${Math.round(-along)} short of/ past the catcher start`);
  // Launch now; the catcher is the landing ramp. Its ridge: z = z0 - x·tan(pitch) for x past the start.
  const v = bc.speed(), p = b.pitch(), vx = v * Math.cos(p * D2R), vz0 = v * Math.sin(p * D2R), dist = -along;
  const cp = catcher.pitch ?? 30; // catcher pitch is set by its own land(): approximate from the main line
  let hit = null;
  for (let x = dist; x < dist + (catcher.len ?? 4200); x += 25) {
    const tt = x / vx, zf = b.pos[2] + vz0 * tt - 0.5 * G * tt * tt, zr = catcher.start[2] - (x - dist) * Math.tan(cp * D2R);
    if (zf <= zr) { hit = { x, zf, angle: Math.atan2(vz0 - G * tt, vx) / D2R }; break; }
  }
  if (!hit) { const tt = (dist + (catcher.len ?? 4200)) / vx, zEnd = b.pos[2] + vz0 * tt - 0.5 * G * tt * tt, rEnd = catcher.start[2] - (catcher.len ?? 4200) * Math.tan(cp * D2R); throw new Error(`${label}: never comes down on the catcher (starts ${Math.round(b.pos[2] - catcher.start[2])} above it, ${Math.round(dist)} before it; v ${Math.round(v)} pitch ${p.toFixed(0)}; at the catcher's end (${catcher.len}) the glider is ${Math.round(zEnd - rEnd)} above the ramp, catcher pitch ${cp.toFixed(0)})`); }
  if (hit.x === dist) throw new Error(`${label}: arrives below the catcher's start (${Math.round(hit.zf - catcher.start[2])}): the fast line ends too low or too far back`);
  const relAngle = -hit.angle - cp;
  if (process.env.VERBOSE) console.log(('   aim ' + label).padEnd(26), 'v', Math.round(v), 'pitch', p.toFixed(0), 'along', Math.round(dist), 'dz to catcher start', Math.round(b.pos[2] - catcher.start[2]), 'hit +' + Math.round(hit.x - dist), 'arrival', hit.angle.toFixed(0), 'catcher pitch', cp.toFixed(0));
  if (relAngle > 25) throw new Error(`${label}: lands on the catcher at ${relAngle.toFixed(0)}° relative (limit 25)`);
  b.gap(hit.x, b.pos[2] - hit.zf, -lat);
  if (process.env.VERBOSE) console.log(label.padEnd(26), 'lands', Math.round(hit.x - dist), 'into the catcher at', relAngle.toFixed(0) + '° rel, lat', Math.round(lat));
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
