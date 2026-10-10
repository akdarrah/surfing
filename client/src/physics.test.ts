import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brushFromVerts, loadLevel, playerMove, touching, applyBoost, len, type Level, type PlayerState, type Input, type V3, type LevelJSON } from './physics.ts';
import { autopilot } from './autopilot.ts';

const box = (min: V3, max: V3) => {
  const v: V3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) v.push([x, y, z]);
  return v;
};
const lvl = (...verts: V3[][]): Level => ({ name: 't', spawns: [], triggers: [], brushes: verts.map(v => brushFromVerts(v)) });
const idle: Input = { forward: 0, side: 0, jump: false, duck: false, yaw: 0 };
const player = (pos: V3, vel: V3 = [0, 0, 0]): PlayerState => ({ pos, vel, onGround: false, ducked: false });
const HULL: V3 = [16, 16, 72];

// Plane z = x * tan(angle) slab, as a big wedge.
const slope = (deg: number) => {
  const t = Math.tan((deg * Math.PI) / 180);
  return [[-1000, -1000, -3000], [1000, -1000, -3000], [1000, -1000, 1000 * t], [-1000, -1000, -1000 * t],
    [-1000, 1000, -3000], [1000, 1000, -3000], [1000, 1000, 1000 * t], [-1000, 1000, -1000 * t]] as V3[];
};

const meridian = (): LevelJSON => JSON.parse(readFileSync(new URL('../../levels/meridian.json', import.meta.url), 'utf8'));

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

test('booster brings speed along its direction up to its value, once', () => {
  const s = player([0, 0, 0], [0, 500, 0]);
  const t = { type: 'boost' as const, min: [0, 0, 0] as V3, max: [1, 1, 1] as V3, dir: [0, 1, 0] as V3, speed: 2000 };
  applyBoost(s, t);
  assert.equal(Math.round(s.vel[1]), 2000);
  applyBoost(s, t);
  assert.equal(Math.round(s.vel[1]), 2000);
});

test('a segmented curved ramp carries speed through the turn (seam handling)', () => {
  // 180-degree left turn, r=2000, built the same way levels/build.mjs builds chains.
  const segs = 30, hw = 384, h = 640;
  const pts: V3[] = [];
  for (let i = 0; i <= segs; i++) { const a = -Math.PI / 2 + Math.PI * i / segs; pts.push([2000 * Math.cos(a), 2000 + 2000 * Math.sin(a), 5000 - 1200 * i / segs]); }
  const tri = (j: number): V3[] => { const a = pts[Math.max(0, j - 1)], b = pts[Math.min(segs, j + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); const px = -dy / l, py = dx / l; const p = pts[j]; return [p, [p[0] + px * hw, p[1] + py * hw, p[2] - h], [p[0] - px * hw, p[1] - py * hw, p[2] - h]]; };
  const l: Level = { name: 'c', spawns: [], triggers: [], brushes: Array.from({ length: segs }, (_, i) => brushFromVerts([...tri(i), ...tri(i + 1)], '#fff', true)) };
  const s = player([pts[0][0] + 200, pts[0][1] + 40, pts[0][2] + 100], [1200, 0, 0]);
  const ap = autopilot(pts.map(p => [p[0], p[1], p[2] + 60, 0]), 0);
  let minSpeed = Infinity;
  for (let i = 0; i < 450; i++) { playerMove(l, s, ap(s)); minSpeed = Math.min(minSpeed, Math.hypot(s.vel[0], s.vel[1])); }
  assert.ok(minSpeed > 900, `speed dipped to ${minSpeed}`);
  assert.ok(s.pos[1] > 3000, `ended at ${s.pos.map(Math.round)}, should be past the far end of the turn`);
});

test('every Meridian stage is completable from a standing start', () => {
  const json = meridian();
  const l = loadLevel(json);
  l.spawns.forEach((sp, stage) => {
    const s = player([...sp.pos] as V3);
    const goal = l.triggers.find(t => (t.type === 'checkpoint' || t.type === 'end') && t.stage === stage + 1)!;
    const tp = l.triggers.find(t => t.type === 'teleport' && t.stage === stage)!;
    const ap = autopilot(json.line!, stage);
    for (let i = 0; i < 6000; i++) {
      playerMove(l, s, ap(s));
      for (const t of l.triggers) if (t.type === 'boost' && touching(t, s.pos, HULL)) applyBoost(s, t);
      if (touching(goal, s.pos, HULL)) return;
      assert.ok(!touching(tp, s.pos, HULL), `stage ${stage + 1} (${sp.name}): fell off at ${s.pos.map(Math.round)}`);
    }
    assert.fail(`stage ${stage + 1} (${sp.name}): never reached the gate, at ${s.pos.map(Math.round)}`);
  });
});

test('a full Meridian run finishes without a fail and slower than minRunMs', () => {
  const json = meridian();
  const l = loadLevel(json);
  const s = player([...l.spawns[0].pos] as V3);
  let stage = 0, ap = autopilot(json.line!, 0), t = 0;
  for (; t < 30000 && stage < l.spawns.length; t++) {
    playerMove(l, s, ap(s));
    for (const tr of l.triggers) {
      if (!touching(tr, s.pos, HULL)) continue;
      if (tr.type === 'boost') applyBoost(s, tr);
      else if (tr.type === 'checkpoint' && tr.stage === stage + 1) { stage++; ap = autopilot(json.line!, stage); }
      else if (tr.type === 'end' && tr.stage === stage + 1) stage++;
      else if (tr.type === 'teleport' && tr.stage === stage) assert.fail(`fell on stage ${stage + 1} at ${s.pos.map(Math.round)} after ${t / 100}s`);
    }
  }
  assert.equal(stage, l.spawns.length, `DNF at stage ${stage + 1}`);
  assert.ok(t * 10 > json.minRunMs!, `run ${t * 10}ms beat the floor ${json.minRunMs}`);
});
