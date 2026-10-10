// Drives a player along a level's ideal line the way a surfer does: look where you're going and
// strafe toward where you want the velocity to curve. A strafe perpendicular to the velocity only
// ever adds speed (air-accelerate), so this gains through turns instead of braking.
// Used by the physics test (proves every stage is completable) and the ghost when no record exists.
import type { Input, LinePoint, PlayerState, V3 } from './physics.ts';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function autopilot(line: LinePoint[], stage: number, opts: { lookahead?: number } = {}) {
  const lookahead = opts.lookahead ?? 420;
  const pts = line.filter(p => p[3] === stage);
  let idx = 0;
  let yaw = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
  let target: V3 = [pts[0][0], pts[0][1], pts[0][2]];
  const fn = (s: PlayerState): Input => {
    const speed = Math.hypot(s.vel[0], s.vel[1]);
    const ahead = Math.min(900, Math.max(lookahead, speed * 0.3));
    const dist = (i: number) => Math.hypot(pts[i][0] - s.pos[0], pts[i][1] - s.pos[1]);
    // Advance past points within the lookahead, and past any point we have already flown by (the next one is closer).
    while (idx + 1 < pts.length && (dist(idx) < ahead || dist(idx + 1) < dist(idx))) idx++;
    const t = pts[Math.min(idx, pts.length - 1)];
    target = [t[0], t[1], t[2]];
    const want = Math.atan2(t[1] - s.pos[1], t[0] - s.pos[0]);
    if (speed > 60) yaw = Math.atan2(s.vel[1], s.vel[0]); else yaw = want;
    const d = wrap(want - yaw);
    // A (side -1) curves the velocity left, D curves it right.
    let side = Math.abs(d) < 0.01 ? 0 : d > 0 ? -1 : 1;
    if (s.contact && !s.onGround && speed > 60) {
      // On a ramp face the face does the turning; strafing toward the bend only pushes you down the inside face.
      // Hold your lateral position against the line instead: push toward it, and the face lifts or lowers you.
      let best = Infinity, lat = 0, off = 0, vlat = 0;
      for (let j = Math.max(1, idx - 4); j <= Math.min(idx, pts.length - 1); j++) {
        const a = pts[j - 1], b = pts[j], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((s.pos[0] - a[0]) * dx + (s.pos[1] - a[1]) * dy) / L2));
        const qx = a[0] + dx * u, qy = a[1] + dy * u, dist = Math.hypot(s.pos[0] - qx, s.pos[1] - qy);
        if (dist < best) {
          best = dist; lat = (dx * (s.pos[1] - qy) - dy * (s.pos[0] - qx)) / Math.sqrt(L2);
          vlat = (dx * s.vel[1] - dy * s.vel[0]) / Math.sqrt(L2);
          const oa = Number(a[5]) || 0, ob = Number(b[5]) || 0;
          off = oa + (ob - oa) * u;
        }
      }
      // Where the line sits on the ridge (offset ~0: after a landing, before the first bend) ride ~100 down whichever
      // face you are on: the ridge itself squeezes you up and off, and crossing it is a hop. Once the line commits to
      // a face, track it.
      const want = Math.abs(off) < 60 ? Math.sign(lat || 1) * 100 : 0;
      // Steer on where we will be in 0.4 s: climbing a face builds along-face speed that nothing but gravity bleeds,
      // so steering on the current error overshoots the ridge and hops off it.
      const ahead = lat + vlat * 0.4;
      side = ahead > want + 40 ? 1 : ahead < want - 40 ? -1 : 0; // left of where we want to be → D (right), right → A (left)
    }
    return { forward: s.onGround ? 1 : 0, side, jump: false, duck: false, yaw };
  };
  fn.target = () => target;
  return fn;
}
