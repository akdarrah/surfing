// Drives a player along a level's ideal line the way a surfer does: look where you're going and
// strafe toward where you want the velocity to curve. A strafe perpendicular to the velocity only
// ever adds speed (air-accelerate), so this gains through turns instead of braking.
// Used by the physics test (proves every stage is completable) and the ghost when no record exists.
import type { Input, PlayerState, V3 } from './physics.ts';

export type LinePoint = [number, number, number, number, ...string[]];

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
    while (idx + 1 < pts.length && Math.hypot(pts[idx][0] - s.pos[0], pts[idx][1] - s.pos[1]) < ahead) idx++;
    const t = pts[Math.min(idx, pts.length - 1)];
    target = [t[0], t[1], t[2]];
    const want = Math.atan2(t[1] - s.pos[1], t[0] - s.pos[0]);
    if (speed > 60) yaw = Math.atan2(s.vel[1], s.vel[0]); else yaw = want;
    const d = wrap(want - yaw);
    // A (side -1) curves the velocity left, D curves it right.
    const side = Math.abs(d) < 0.01 ? 0 : d > 0 ? -1 : 1;
    return { forward: s.onGround ? 1 : 0, side, jump: false, duck: false, yaw };
  };
  fn.target = () => target;
  return fn;
}
