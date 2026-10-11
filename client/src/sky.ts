// Sky environment: an instanced cloud sea and wisps, rounded cream islands, haze columns, birds and wind
// streaks, all animated in the vertex shader; plus the two giants. Nothing here is touched per object per frame.
import * as THREE from 'three/webgpu';
import { uniform, attribute, positionGeometry, positionLocal, time, sin, cos, vec3, mod, normalize } from 'three/tsl';
import { bake, mergeAll, mulberry, canvasTexture, puffTexture, upright, tmat, flatMRT, CREAM, TEAL, GLOW, BLUE } from './gfx.ts';
import { Giant } from './giant.ts';
import type { LevelJSON, V3 } from './physics.ts';

export const GIANT_H = 90000; // it should loom: from the course it fills most of the sky in that direction

type Puff = [number, number, number, number, number, number]; // x, y, z, w, h, drift factor

export class Sky {
  group = new THREE.Group();
  giants: Giant[] = [];
  giantPos: V3 = [0, 0, 0];
  private uRight = uniform(new THREE.Vector3(1, 0, 0));
  private uUp = uniform(new THREE.Vector3(0, 0, 1));
  private uCam = uniform(new THREE.Vector3());
  private uVel = uniform(new THREE.Vector3(1, 0, 0));
  private uWindLen = uniform(30);
  private uWindK = uniform(0);
  private uFlock = uniform(new THREE.Vector3());
  private emissive: THREE.BufferGeometry[] = [];

  build(json: LevelJSON, lo: number, hi: number, seaZ: number, centre: V3) {
    const rnd = mulberry(11);
    const puffTex = puffTexture();

    // The near giant: 60k from the course centre, down the course so the start pad faces it; the far one on the horizon.
    const a1 = 70 * Math.PI / 180;
    this.giantPos = [centre[0] + Math.cos(a1) * 48000, centre[1] + Math.sin(a1) * 48000, seaZ - GIANT_H * 0.45];
    const g1 = new Giant(GIANT_H);
    g1.group.position.set(...this.giantPos);
    g1.group.rotation.z = Math.atan2(centre[1] - this.giantPos[1], centre[0] - this.giantPos[0]) - Math.PI / 2;
    const a2 = 118 * Math.PI / 180;
    const g2 = new Giant(GIANT_H, true);
    g2.group.position.set(centre[0] + Math.cos(a2) * 250000, centre[1] + Math.sin(a2) * 250000, seaZ - GIANT_H * 0.4);
    g2.group.rotation.z = a2 + Math.PI / 2 + 0.6;
    this.giants.push(g1, g2);
    this.group.add(g1.group, g2.group);

    // Cloud sea: a dense field of soft puffs across the whole visible deck, a thicker band under the course,
    // and a ring of big puffs around the giant's waist.
    const puffs: Puff[] = [];
    for (let i = 0; i < 1500; i++) {
      const r = 2200 + rnd() * 4200;
      puffs.push([-64000 + rnd() * 128000, -60000 + rnd() * 140000, seaZ - 900 + rnd() * 2600 + (rnd() < 0.06 ? 6000 : 0), r, r * 0.46, 0.6 + rnd() * 0.8]);
    }
    for (let i = 0; i < 700; i++) {
      const r = 1600 + rnd() * 3000;
      puffs.push([-30000 + rnd() * 60000, -46000 + rnd() * 86000, seaZ - 500 + rnd() * 2000, r, r * 0.44, 0.6 + rnd() * 0.8]);
    }
    for (let i = 0; i < 220; i++) {
      const ang = rnd() * Math.PI * 2, d = GIANT_H * (0.08 + rnd() * 0.3);
      const r = 5000 + rnd() * 9000;
      puffs.push([this.giantPos[0] + Math.cos(ang) * d, this.giantPos[1] + Math.sin(ang) * d, seaZ - 1200 + rnd() * 3200, r, r * 0.5, 0]);
    }
    this.group.add(this.puffMesh(puffs, puffTex, 0xfbf6f3, 0.92, 40, 66000));
    // Thin wisps above the course that the launch gap flies through.
    const wisps: Puff[] = [];
    for (let i = 0; i < 110; i++) {
      const r = 4000 + rnd() * 7000;
      wisps.push([-22000 + rnd() * 44000, -30000 + rnd() * 60000, hi + 2500 + rnd() * 7000, r, r * 0.18, 0.8 + rnd() * 0.6]);
    }
    this.group.add(this.puffMesh(wisps, puffTex, 0xffffff, 0.22, 90, 24000));
    // Bright deck far below.
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(260000, 260000), new THREE.MeshBasicNodeMaterial({ color: 0xf7f1f0, map: deckTexture() }));
    deck.position.z = seaZ - 2600;
    this.group.add(deck);

    // Rounded cream islands with blue-green tops, bobbing gently (per-vertex phase, vertex shader).
    const islands: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 44; i++) {
      const size = 300 + rnd() * 900;
      const ph = rnd() * 7;
      const at = tmat(-16000 + rnd() * 32000, -28000 + rnd() * 56000, lo + rnd() * (hi - lo), 0, 0, rnd() * 6, 0.8 + rnd() * 0.5, 0.8 + rnd() * 0.5, 0.55 + rnd() * 0.2);
      islands.push(bake(new THREE.IcosahedronGeometry(size, 2), at, CREAM, ph));
      islands.push(bake(new THREE.SphereGeometry(size * 0.8, 14, 8), at.clone().multiply(tmat(0, 0, size * 0.92, 0, 0, 0, 1, 1, 0.38)), TEAL, ph));
      islands.push(bake(new THREE.SphereGeometry(size * 0.5, 10, 7), at.clone().multiply(tmat(size * 0.3, 0, -size * 0.5, 0, 0, 0, 1, 1, 0.9)), CREAM, ph));
    }
    const islandMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
    islandMat.positionNode = positionLocal.add(vec3(0, 0, sin(time.mul(0.35).add(attribute('phase', 'float'))).mul(45)));
    const islandMesh = new THREE.Mesh(mergeAll(islands)!, islandMat);
    islandMesh.castShadow = islandMesh.receiveShadow = true;
    this.group.add(islandMesh);

    // Soft haze columns on the horizon with blue lights.
    const cols: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, d = 90000 + rnd() * 60000, h = 40000 + rnd() * 50000;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      cols.push(bake(upright(new THREE.CylinderGeometry(1800 + rnd() * 2500, 2600 + rnd() * 3000, h, 14)), tmat(x, y, seaZ - 20000 + h / 2), 0xe3d6dc));
      cols.push(bake(new THREE.SphereGeometry(2200 + rnd() * 2000, 14, 10), tmat(x, y, seaZ - 20000 + h, 0, 0, 0, 1, 1, 0.5), 0xe3d6dc));
      for (let k = 0; k < 4; k++) this.emissive.push(bake(new THREE.SphereGeometry(300, 8, 6), tmat(x, y, seaZ - 20000 + h * (0.45 + k * 0.15)), k % 2 ? GLOW : BLUE));
    }
    this.group.add(new THREE.Mesh(mergeAll(cols)!, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9 })));
    this.group.add(new THREE.Mesh(mergeAll(this.emissive)!, new THREE.MeshBasicNodeMaterial({ vertexColors: true })));

    // Moon, pale in the warm sky.
    const moon = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: moonTexture(), transparent: true, depthWrite: false, fog: false }));
    moon.scale.set(46000, 46000, 1);
    moon.position.set(120000, 230000, 90000);
    this.group.add(moon);

    // Birds: a flock circling under the course, flapping and orbiting in the vertex shader.
    const flock: V3 = [json.spawns[1]?.pos[0] ?? 0, json.spawns[1]?.pos[1] ?? 0, (json.spawns[1]?.pos[2] ?? 0) - 2500];
    this.uFlock.value.set(...flock);
    this.group.add(this.birds(36));

    // Wind streaks: a world-fixed lattice of short lines wrapped around the camera, stretched along velocity.
    this.group.add(this.wind(160));
  }

  private puffMesh(puffs: Puff[], tex: THREE.Texture, color: number, opacity: number, drift: number, wrapHalf: number) {
    const n = puffs.length;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(base.index);
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const centre = new Float32Array(n * 3), size = new Float32Array(n * 2), seed = new Float32Array(n);
    puffs.forEach((p, i) => { centre.set([p[0], p[1], p[2]], i * 3); size.set([p[3], p[4]], i * 2); seed[i] = p[5]; });
    geo.setAttribute('iCentre', new THREE.InstancedBufferAttribute(centre, 3));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 2));
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = n;
    const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false, color, opacity });
    mat.mrtNode = flatMRT();
    const c = attribute('iCentre', 'vec3'), s = attribute('iSize', 'vec2'), sd = attribute('iSeed', 'float');
    const x = mod(c.x.add(time.mul(drift).mul(sd)).add(wrapHalf), wrapHalf * 2).sub(wrapHalf);
    const at = vec3(x, c.y, c.z);
    mat.positionNode = at.add(this.uRight.mul(positionGeometry.x.mul(s.x))).add(this.uUp.mul(positionGeometry.y.mul(s.y)));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  private birds(n: number) {
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-40, 0, 0, 0, 0, 12, 40, 0, 0, 0, -22, -2, 0, 22, -2, 0, 0, 12], 3));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.attributes.position);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) seed[i] = i;
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = n;
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0x3a3f52, side: THREE.DoubleSide });
    const i = attribute('iSeed', 'float');
    const a = time.mul(0.35).add(i.mul(0.37));
    const r = mod(i, 7).mul(260).add(1500);
    const flap = sin(time.mul(9).add(i)).mul(positionGeometry.x.abs()).mul(0.45);
    const lx = positionGeometry.x, ly = positionGeometry.y, lz = positionGeometry.z.add(flap);
    const h = a.add(Math.PI / 2);
    const rx = lx.mul(cos(h)).sub(ly.mul(sin(h))), ry = lx.mul(sin(h)).add(ly.mul(cos(h)));
    const centre = this.uFlock.add(vec3(cos(a).mul(r), sin(a).mul(r), sin(time.add(i)).mul(200).add(mod(i, 5).mul(120))));
    mat.positionNode = centre.add(vec3(rx, ry, lz));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  private wind(n: number) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 6), seed = new Float32Array(n * 6), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const sx = Math.random() * 1800, sy = Math.random() * 1800, sz = Math.random() * 1400;
      seed.set([sx, sy, sz, sx, sy, sz], i * 6);
      end[i * 2 + 1] = 1;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('end', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.LineBasicNodeMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    mat.mrtNode = flatMRT();
    const box = vec3(1800, 1800, 1400);
    const sd = attribute('seed', 'vec3'), e = attribute('end', 'float');
    const p = this.uCam.add(mod(sd.sub(this.uCam), box)).sub(box.mul(0.5));
    const dir = normalize(this.uVel);
    mat.positionNode = p.sub(dir.mul(this.uWindLen).mul(e));
    mat.opacityNode = this.uWindK;
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    return lines;
  }

  // Per frame: camera axes for the billboards, wind uniforms, giant head.
  tick(dt: number, camera: THREE.Camera, speed: number, vel: V3) {
    const e = camera.matrixWorld.elements;
    this.uRight.value.set(e[0], e[1], e[2]);
    this.uUp.value.set(e[4], e[5], e[6]);
    this.uCam.value.copy(camera.position);
    const vl = Math.hypot(vel[0], vel[1], vel[2]);
    if (vl > 1) this.uVel.value.set(vel[0], vel[1], vel[2]);
    const k = Math.max(0, (speed - 700) / 2500);
    this.uWindLen.value = 30 + k * 400;
    this.uWindK.value = Math.min(0.5, k * 0.6);
    this.giants[0]?.tick(dt);
  }

  lookAt(x: number, y: number) { this.giants[0]?.lookAt(x, y); }

}

function deckTexture() {
  const t = canvasTexture(512, 512, g => {
    const rnd = mulberry(5);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i++) {
      const r = 10 + rnd() * 60;
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, 'rgba(214,196,206,0.3)'); grad.addColorStop(1, 'rgba(214,196,206,0)');
      g.save(); g.translate(rnd() * 512, rnd() * 512); g.fillStyle = grad; g.fillRect(-r, -r, r * 2, r * 2); g.restore();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  return t;
}

function moonTexture() {
  return canvasTexture(256, 256, g => {
    const r = g.createRadialGradient(118, 118, 20, 128, 128, 120);
    r.addColorStop(0, 'rgba(246,238,240,1)'); r.addColorStop(0.85, 'rgba(226,212,220,0.9)'); r.addColorStop(1, 'rgba(226,212,220,0)');
    g.fillStyle = r; g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(150,130,160,0.2)';
    for (const [x, y, s] of [[90, 100, 22], [150, 80, 14], [160, 150, 28], [100, 170, 12]]) { g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill(); }
  });
}
