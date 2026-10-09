// Generates levels/*.json from ramp primitives. Run: node levels/build.mjs
// Each stage is a lane along +y. Stage end platforms teleport you to the next stage start.
import { writeFileSync } from 'node:fs';

const RAMP = ['#fdfbf7', '#f6efe4'];
const PLATFORM = '#ffd6a5';

function box(min, max, color = PLATFORM) {
  const v = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) v.push([x, y, z]);
  return { verts: v, color };
}

// Triangular-prism surf ramp running along +y. Faces slope at atan(h/hw) (~59 deg: surfable, never ground).
function ramp({ x, y, length, top, drop = 512, hw = 384, h = 640 }, color) {
  const v = [];
  for (const [yy, dz] of [[y, 0], [y + length, drop]]) {
    v.push([x - hw, yy, top - dz - h], [x + hw, yy, top - dz - h], [x, yy, top - dz]);
  }
  return { verts: v, color };
}

const trig = (type, min, max, extra = {}) => ({ type, min, max, ...extra });

function cloudHarbor() {
  const brushes = [], triggers = [], spawns = [];
  // [side offsets of each ramp] per stage; +1 = ramp to the right (surf its left face), -1 = to the left.
  const stages = [
    [1, -1, 1],
    [-1, 1, -1, 1],
    [1, 1, -1],
    [-1, 1, -1, 1],
    [1, -1, 1, -1],
    [-1, 1, -1, 1, -1],
  ];
  stages.forEach((sides, s) => {
    const lx = s * 6000;
    const z0 = 4096;
    spawns.push({ pos: [lx, 0, z0 + 1], yaw: Math.PI / 2 });
    brushes.push(box([lx - 256, -256, z0 - 128], [lx + 256, 256, z0]));
    if (s === 0) triggers.push(trig('start', [lx - 256, -256, z0], [lx + 256, 256, z0 + 200]));

    let y = 400, top = z0 - 192, minZ = Infinity;
    sides.forEach((side, i) => {
      const length = 2560 + (i % 2) * 512;
      const r = { x: lx + side * 280, y, length, top };
      brushes.push(ramp(r, RAMP[i % 2]));
      minZ = Math.min(minZ, top - 512 - 640);
      // Risky pickups: just above a ridge near its end (stage 2), and a far-off side ledge (stage 4).
      if (s === 1 && i === 2) {
        const py = y + length - 400, ridge = top - (512 * (length - 352)) / length;
        triggers.push(trig('pickup', [r.x - 48, py, ridge + 40], [r.x + 48, py + 96, ridge + 136], { weapon: 1 }));
      }
      if (s === 3 && i === 1) {
        const lx2 = lx + side * 1400, ly = y + length + 200, lz = top - 700;
        brushes.push(box([lx2 - 160, ly - 160, lz - 64], [lx2 + 160, ly + 160, lz], '#caffbf'));
        triggers.push(trig('pickup', [lx2 - 48, ly - 48, lz], [lx2 + 48, ly + 48, lz + 96], { weapon: 2 }));
      }
      y += length + 448;
      top -= 512 + 320;
    });
    const pz = top - 640;
    brushes.push(box([lx - 512, y, pz - 128], [lx + 512, y + 1024, pz]));
    const last = s === stages.length - 1;
    if (last) {
      // Lighthouse on the finish island.
      brushes.push(box([lx - 64, y + 704, pz], [lx + 64, y + 832, pz + 512], '#ff6b6b'));
      brushes.push(box([lx - 96, y + 672, pz + 512], [lx + 96, y + 864, pz + 576], '#ffffff'));
    }
    triggers.push(trig(last ? 'end' : 'checkpoint', [lx - 512, y + 200, pz], [lx + 512, y + 1024, pz + 256], { stage: s + 1 }));
    minZ = Math.min(minZ, pz - 128);
    triggers.push(trig('teleport', [lx - 3000, -4000, -20000], [lx + 3000, y + 6000, minZ - 600], { stage: s }));
  });
  return { name: 'cloud-harbor', spawns, brushes, triggers };
}

writeFileSync(new URL('./cloud-harbor.json', import.meta.url), JSON.stringify(cloudHarbor()));
console.log('wrote levels/cloud-harbor.json');
