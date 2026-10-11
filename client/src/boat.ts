// The player: a hovering sailboat. One shared body geometry, a sail that carries the spray, a callsign pennant,
// blue hover pods and a pale-blue wake. The same mesh is used for the local player, remotes, NPCs and the ghost.
import * as THREE from 'three/webgpu';
import { uniform, positionLocal, uv, time, sin, vec3, color as tslColor } from 'three/tsl';
import { bake, mergeAll, upright, tmat, flatMRT, FONT, canvasTexture, textureFromCanvas, CREAM, BLUE, GLOW, WAKE } from './gfx.ts';
import type { V3 } from './physics.ts';

const BASE_Z = 36;        // hull centre above the player's feet
const BOB = 12, BOB_PERIOD = 1.2;
const WAKE_N = 48, WAKE_LIFE = 1.4;
const SAIL_YAW = -0.55; // boom swung out to starboard so the sail reads from behind and from the side

// --- shared geometry -----------------------------------------------------------------------------------
function hullGeometry() {
  const prof = [[-52, 0], [-50, 10], [-40, 17], [-20, 21], [0, 22], [20, 21], [40, 16], [52, 8], [56, 0]].map(([y, r]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(prof, 24);
  g.rotateZ(-Math.PI / 2); // lathe axis Y -> +X (forward)
  g.scale(1, 1, 0.55);
  return g;
}

function bodyGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(bake(hullGeometry(), null, CREAM));
  // Gunwale: a blue line around the hull at the waterline.
  parts.push(bake(new THREE.TorusGeometry(22, 1.4, 6, 40), tmat(2, 0, 1, 0, 0, 0, 2.45, 1, 1), BLUE));
  // Hover pods.
  for (const s of [-1, 1]) {
    const pod = new THREE.CapsuleGeometry(6, 26, 4, 12);
    pod.rotateZ(Math.PI / 2);
    parts.push(bake(pod, tmat(-2, s * 19, -13), BLUE));
    parts.push(bake(new THREE.CylinderGeometry(2.5, 2.5, 8, 6), tmat(-2, s * 19, -8, Math.PI / 2), CREAM));
  }
  // Mast and boom.
  parts.push(bake(upright(new THREE.CylinderGeometry(1.5, 2, 74, 8)), tmat(3, 0, 35), CREAM));
  parts.push(bake(new THREE.SphereGeometry(2.6, 8, 6), tmat(3, 0, 73), BLUE));
  const boom = new THREE.CylinderGeometry(1.1, 1.1, 56, 6);
  boom.rotateZ(Math.PI / 2);
  boom.translate(-27, 0, 18);
  boom.rotateZ(SAIL_YAW);
  parts.push(bake(boom, tmat(3, 0, 0), BLUE));
  return mergeAll(parts)!;
}

function glowGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    parts.push(bake(new THREE.SphereGeometry(9, 12, 8), tmat(-2, s * 19, -19, 0, 0, 0, 1.3, 1, 0.45), GLOW));
  }
  return mergeAll(parts)!;
}

function sailGeometry() {
  const g = new THREE.PlaneGeometry(54, 50, 8, 8);
  g.rotateX(Math.PI / 2); // stand it in the XZ plane; u runs aft -> mast, v bottom -> top
  g.translate(-27, 0, 44);
  g.rotateZ(SAIL_YAW);
  g.translate(3, 0, 0);
  return g;
}

function pennantGeometry() {
  const g = new THREE.PlaneGeometry(26, 9, 6, 1);
  g.rotateX(Math.PI / 2);
  g.translate(-10, 0, 73.5);
  return g;
}

const BODY_GEO = bodyGeometry();
const GLOW_GEO = glowGeometry();
const SAIL_GEO = sailGeometry();
const PENNANT_GEO = pennantGeometry();
const BODY_MAT = new THREE.MeshPhysicalNodeMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3 });
const GHOST_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });

const SAIL_W = 256, SAIL_H = 240;
function sailCanvas() {
  const c = document.createElement('canvas');
  c.width = SAIL_W; c.height = SAIL_H;
  return c;
}
// The sail: cream cloth with a blue hem; the spray is contain-fit in the middle. `img` is any drawable image.
function paintSail(c: HTMLCanvasElement, img: CanvasImageSource | null) {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, SAIL_W, SAIL_H);
  g.fillStyle = '#f7f3ea';
  g.fillRect(0, 0, SAIL_W, SAIL_H);
  g.fillStyle = 'rgba(47,111,228,0.9)';
  g.fillRect(0, 0, SAIL_W, 7); g.fillRect(0, SAIL_H - 7, SAIL_W, 7); g.fillRect(0, 0, 7, SAIL_H); g.fillRect(SAIL_W - 7, 0, 7, SAIL_H);
  g.fillStyle = 'rgba(47,111,228,0.18)';
  for (let y = 24; y < SAIL_H - 12; y += 40) g.fillRect(12, y, SAIL_W - 24, 2);
  if (img) {
    const side = Math.min(SAIL_W, SAIL_H) * 0.72;
    g.drawImage(img, (SAIL_W - side) / 2, (SAIL_H - side) / 2, side, side);
  } else {
    g.fillStyle = '#2f6fe4';
    g.font = `700 92px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SS', SAIL_W / 2, SAIL_H / 2);
  }
}

function pennantTexture(name: string) {
  return canvasTexture(256, 96, g => {
    g.fillStyle = '#2f6fe4';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(256, 0); g.lineTo(256, 96); g.lineTo(0, 96); g.lineTo(40, 48); g.closePath(); g.fill();
    g.fillStyle = '#f7f3ea';
    g.font = `700 54px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    let s = name.toUpperCase();
    while (s.length > 2 && g.measureText(s).width > 190) s = s.slice(0, -1);
    g.fillText(s, 150, 50);
  });
}

function nameSprite(name: string, sponsor: string) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.font = `700 54px ${FONT}`;
  g.lineWidth = 8; g.strokeStyle = 'rgba(29,43,74,0.85)';
  g.strokeText(name, 256, 58);
  g.fillStyle = '#ffffff';
  g.fillText(name, 256, 58);
  if (sponsor) {
    g.font = `34px ${FONT}`;
    g.lineWidth = 6;
    g.strokeText(sponsor, 256, 106);
    g.fillStyle = '#ffb84a';
    g.fillText(sponsor, 256, 106);
  }
  const tex = textureFromCanvas(c);
  const s = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(170, 42, 1);
  return s;
}

export class Boat {
  group = new THREE.Group();
  readonly color: THREE.Color;
  private body = new THREE.Group();
  private label: THREE.Sprite | null = null;
  private sailMat: THREE.MeshBasicNodeMaterial;
  private sailCanvas = sailCanvas();
  private sailTex: THREE.CanvasTexture;
  private pennant: THREE.Mesh;
  private uBillow = uniform(2);
  private uGlow = uniform(0.6);
  private phase = Math.random() * 7;
  private roll = 0;
  private lastPos: V3 | null = null;
  private lastT = 0;
  private px = 0; private py = 0; private pz = 0;
  // Wake ring buffer: positions + timestamps, newest at (tail + len - 1) % N.
  private wake: THREE.Mesh;
  private wakePos: Float32Array;
  private ring = new Float32Array(WAKE_N * 3);
  private ringT = new Float32Array(WAKE_N);
  private tail = 0; private len = 0;

  constructor(color: string | number, name: string, sponsor = '', ghost = false) {
    this.color = new THREE.Color(color);
    const body = new THREE.Mesh(BODY_GEO, ghost ? GHOST_MAT : BODY_MAT);
    body.castShadow = !ghost;
    this.body.add(body);

    this.sailTex = textureFromCanvas(this.sailCanvas);
    paintSail(this.sailCanvas, null);
    this.sailMat = new THREE.MeshBasicNodeMaterial({ map: this.sailTex, side: THREE.DoubleSide, transparent: ghost, opacity: ghost ? 0.3 : 1 });
    // Billow: bulge to starboard, strongest mid-sail, fluttering faster with speed.
    const u = uv().x, v = uv().y;
    const bulge = sin(u.mul(Math.PI)).mul(sin(v.mul(Math.PI)).mul(0.5).add(0.5));
    const flutter = sin(time.mul(7).add(u.mul(9)).add(v.mul(3))).mul(0.22).add(1);
    this.sailMat.positionNode = positionLocal.add(vec3(-Math.sin(SAIL_YAW), -Math.cos(SAIL_YAW), 0).mul(bulge.mul(flutter).mul(this.uBillow)));
    const sail = new THREE.Mesh(SAIL_GEO, this.sailMat);
    sail.castShadow = !ghost;
    this.body.add(sail);

    const pennantMat = new THREE.MeshBasicNodeMaterial({ map: pennantTexture(name || ' '), side: THREE.DoubleSide, transparent: true, opacity: ghost ? 0.3 : 1 });
    const pu = uv().x;
    pennantMat.positionNode = positionLocal.add(vec3(0, sin(time.mul(9).add(pu.mul(8))).mul(pu.oneMinus()).mul(2.5), 0));
    this.pennant = new THREE.Mesh(PENNANT_GEO, pennantMat);
    this.body.add(this.pennant);

    const glowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    glowMat.colorNode = tslColor(GLOW).mul(this.uGlow);
    glowMat.opacityNode = uniform(ghost ? 0.2 : 0.9);
    glowMat.mrtNode = flatMRT();
    this.body.add(new THREE.Mesh(GLOW_GEO, glowMat));

    this.body.position.z = BASE_Z;
    this.group.add(this.body);
    if (!ghost) this.setName(name, sponsor);

    this.wakePos = new Float32Array(WAKE_N * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.wakePos, 3));
    const idx: number[] = [];
    for (let i = 0; i + 1 < WAKE_N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    tg.setIndex(idx);
    const tm = new THREE.MeshBasicNodeMaterial({ color: ghost ? 0xffffff : WAKE, transparent: true, opacity: ghost ? 0.2 : 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    tm.mrtNode = flatMRT();
    this.wake = new THREE.Mesh(tg, tm);
    this.wake.frustumCulled = false;
  }

  addTo(scene: THREE.Scene) { scene.add(this.group, this.wake); }
  removeFrom(scene: THREE.Scene) { scene.remove(this.group, this.wake); }
  resetTrail() { this.len = 0; this.lastPos = null; }

  setName(name: string, sponsor = '') {
    if (this.label) this.group.remove(this.label);
    this.label = nameSprite(name, sponsor);
    this.label.position.z = 100;
    this.group.add(this.label);
    (this.pennant.material as THREE.MeshBasicNodeMaterial).map = pennantTexture(name || ' ');
    (this.pennant.material as THREE.MeshBasicNodeMaterial).needsUpdate = true;
  }

  // The spray goes on the sail. Any texture whose image is drawable (canvas / bitmap / image) works.
  setFlag(tex: THREE.Texture | null) {
    const img = (tex?.image ?? null) as CanvasImageSource | null;
    paintSail(this.sailCanvas, img && 'width' in img ? img : null);
    this.sailTex.needsUpdate = true;
  }

  set visible(v: boolean) { this.group.visible = v; this.wake.visible = v; }
  get visible() { return this.group.visible; }

  // Pose from position + heading: hover bob, heel into lateral velocity, pitch with climb, billow and glow with speed.
  pose(pos: V3, yaw: number, t: number, finished = false) {
    let prev = this.lastPos;
    if (prev && Math.hypot(pos[0] - this.px, pos[1] - this.py, pos[2] - this.pz) > 600) { this.len = 0; prev = null; } // teleported
    this.group.position.set(pos[0], pos[1], pos[2]);
    const dts = Math.max(1 / 240, Math.min(0.25, t - this.lastT));
    let pitch = 0, speed = 0, rollTarget = 0;
    if (prev) {
      const dx = pos[0] - this.px, dy = pos[1] - this.py, dz = pos[2] - this.pz;
      const h = Math.hypot(dx, dy);
      const dist = Math.hypot(h, dz);
      speed = dist / dts;
      if (dist > 0.5) {
        pitch = Math.atan2(dz, Math.max(h, 1e-3)) * 0.35;
        const lat = (-Math.sin(yaw) * dx + Math.cos(yaw) * dy) / dts; // left-positive
        rollTarget = -Math.max(-1, Math.min(1, lat / 900)) * 0.5;
      }
    }
    this.px = pos[0]; this.py = pos[1]; this.pz = pos[2];
    this.lastPos = pos;
    this.lastT = t;
    this.roll += (rollTarget - this.roll) * Math.min(1, dts * 6);
    this.body.rotation.set(this.roll, -pitch, yaw, 'ZYX');
    this.body.position.z = BASE_Z + Math.sin(t * (Math.PI * 2 / BOB_PERIOD) + this.phase) * BOB;
    if (finished) this.body.rotation.x += Math.sin(t * 6) * 0.4;
    const k = Math.max(0, Math.min(1, (speed - 250) / 2200));
    this.uBillow.value = 2 + k * 9;
    this.uGlow.value = 0.55 + k * 1.6;

    // Wake ribbon.
    if (speed * dts > 2) {
      const i = (this.tail + this.len) % WAKE_N;
      if (this.len === WAKE_N) this.tail = (this.tail + 1) % WAKE_N; else this.len++;
      this.ring[i * 3] = pos[0]; this.ring[i * 3 + 1] = pos[1]; this.ring[i * 3 + 2] = pos[2];
      this.ringT[i] = t;
    }
    while (this.len && t - this.ringT[this.tail] > WAKE_LIFE) { this.tail = (this.tail + 1) % WAKE_N; this.len--; }
    const wp = this.wakePos, r = this.ring;
    for (let i = 0; i < WAKE_N; i++) {
      const k2 = this.len - WAKE_N + i; // newest at the end
      let qx = pos[0], qy = pos[1], qz = pos[2], age = 1, nx = pos[0], ny = pos[1];
      if (k2 >= 0) {
        const j = ((this.tail + k2) % WAKE_N) * 3;
        qx = r[j]; qy = r[j + 1]; qz = r[j + 2];
        age = (t - this.ringT[j / 3]) / WAKE_LIFE;
        const jn = ((this.tail + Math.min(this.len - 1, k2 + 1)) % WAKE_N) * 3;
        nx = r[jn]; ny = r[jn + 1];
      }
      const w = (1 - age) * 14;
      const ddx = nx - qx, ddy = ny - qy, L = Math.hypot(ddx, ddy) || 1;
      const sx = -ddy / L * w, sy = ddx / L * w;
      const o = i * 6;
      wp[o] = qx + sx; wp[o + 1] = qy + sy; wp[o + 2] = qz + 18;
      wp[o + 3] = qx - sx; wp[o + 4] = qy - sy; wp[o + 5] = qz + 18;
    }
    (this.wake.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
