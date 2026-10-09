import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brushFromVerts, loadLevel, playerMove, touching, len, type Level, type PlayerState, type Input, type V3, type LevelJSON } from './physics.ts';

const box = (min: V3, max: V3) => {
  const v: V3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) v.push([x, y, z]);
  return v;
};
const lvl = (...verts: V3[][]): Level => ({ name: 't', spawns: [], triggers: [], brushes: verts.map(v => brushFromVerts(v)) });
const idle: Input = { forward: 0, side: 0, jump: false, duck: false, yaw: 0 };
const player = (pos: V3, vel: V3 = [0, 0, 0]): PlayerState => ({ pos, vel, onGround: false, ducked: false });

// Plane z = x * tan(angle) slab, as a big wedge.
const slope = (deg: number) => {
  const t = Math.tan((deg * Math.PI) / 180);
  return [[-1000, -1000, -3000], [1000, -1000, -3000], [1000, -1000, 1000 * t], [-1000, -1000, -1000 * t],
    [-1000, 1000, -3000], [1000, 1000, -3000], [1000, 1000, 1000 * t], [-1000, 1000, -1000 * t]] as V3[];
};

test('ramp prism has 5 real faces', () => {
  const b = brushFromVerts([[-384, 0, 0], [384, 0, 0], [0, 0, 640], [-384, 1000, 0], [384, 1000, 0], [0, 1000, 640]]);
  assert.equal(b.faces.length, 5);
});

test('flat floor is ground, player rests on it', () => {
  const l = lvl(box([-500, -500, -100], [500, 500, 0]));
  const s = player([0, 0, 10]);
  for (let i = 0; i < 100; i++) playerMove(l, s, idle);
  assert.ok(s.onGround);
  assert.ok(Math.abs(s.pos[2]) < 0.1, `z=${s.pos[2]}`);
});

test('0.7 normal threshold: 40deg slope is ground, 50deg is surf', () => {
  for (const [deg, ground] of [[40, true], [50, false]] as const) {
    const l = lvl(slope(deg));
    const s = player([0, 0, 40]);
    for (let i = 0; i < 50; i++) playerMove(l, s, idle);
    assert.equal(s.onGround, ground, `${deg}deg`);
  }
});

test('surfing a steep ramp: never grounded, slides and speeds up', () => {
  const l = lvl(slope(60));
  const s = player([0, 0, 40]);
  let grounded = false;
  for (let i = 0; i < 60; i++) { playerMove(l, s, idle); grounded ||= s.onGround; }
  assert.ok(!grounded);
  assert.ok(s.pos[0] < -10 && len(s.vel) > 200, `slid to x=${s.pos[0]} at ${len(s.vel)}`);
});

test('air strafing gains speed (A + turning left)', () => {
  const l = lvl();
  const s = player([0, 0, 100000], [300, 0, 0]);
  let yaw = 0;
  for (let i = 0; i < 300; i++) {
    yaw += 0.02;
    playerMove(l, s, { ...idle, side: -1, yaw });
  }
  const h = Math.hypot(s.vel[0], s.vel[1]);
  assert.ok(h > 450, `horizontal speed ${h}`);
});

test('no tunneling through an 8u wall at 3500 u/s', () => {
  const l = lvl(box([100, -500, -500], [108, 500, 500]));
  const s = player([0, 0, 0], [3500, 0, 0]);
  for (let i = 0; i < 20; i++) playerMove(l, s, idle);
  assert.ok(s.pos[0] < 100, `x=${s.pos[0]}`);
});

test('every cloud-harbor stage is surfable by strafing into each ramp', () => {
  const json: LevelJSON = JSON.parse(readFileSync(new URL('../../levels/cloud-harbor.json', import.meta.url), 'utf8'));
  const l = loadLevel(json);
  l.spawns.forEach((sp, stage) => {
    const s = player([...sp.pos] as V3);
    const lane = sp.pos[0];
    const goal = l.triggers.find(t => (t.type === 'checkpoint' || t.type === 'end') && t.stage === stage + 1)!;
    const tp = l.triggers.find(t => t.type === 'teleport' && t.stage === stage)!;
    // Ridge x of each ramp in this lane (top vertex) and where it ends, in course order.
    const ramps = json.brushes.filter(b => b.verts.length === 6 && Math.abs(b.verts[0][0] - lane) < 1000)
      .map(b => ({ x: b.verts[2][0], y1: b.verts[5][1] }));
    for (let i = 0; i < 4000; i++) {
      // Strafe toward the ridge of the ramp we're over (or the next one ahead), like a player aiming a transfer.
      const r = ramps.find(r => r.y1 > s.pos[1] + 200) ?? ramps[ramps.length - 1];
      const side = Math.sign(r.x - s.pos[0]);
      playerMove(l, s, { forward: s.onGround ? 1 : 0, side: s.onGround ? 0 : side, jump: false, duck: false, yaw: sp.yaw });
      if (touching(goal, s.pos, [16, 16, 72])) return;
      assert.ok(!touching(tp, s.pos, [16, 16, 72]), `stage ${stage + 1}: fell off at y=${s.pos[1].toFixed(0)} z=${s.pos[2].toFixed(0)}`);
    }
    assert.fail(`stage ${stage + 1}: never reached the end, at ${s.pos.map(Math.round)}`);
  });
});
