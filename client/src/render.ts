// Three.js (WebGPU, WebGL2 fallback) world, built Z-up to match the Source-style physics.
// Static level geometry is merged into a few draws per stage; everything animated lives in vertex shaders or pools.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, uniform, time, sin, abs, color, convertToTexture, pow, oneMinus, mix, smoothstep, float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import type { Level, LevelJSON, V3 } from './physics.ts';
import { bake, mergeAll, upright, tmat, mulberry, textureFromCanvas, fit, flatMRT, enableMRT, FONT, CREAM, BLUE, GLOW, GOLD } from './gfx.ts';
import { Sky } from './sky.ts';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export { CREAM, BLUE, GLOW, GOLD, WAKE, textureFromCanvas } from './gfx.ts';
export const OCEAN_Z = -21000;

export type WallInfo = { id: number; hash: string; name: string; at?: number };
type WallMesh = { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; pos: V3; yaw: number; w: number; h: number; name: string };
type Chunks = Map<string, THREE.BufferGeometry[]>;

const SPARK_N = 160, PUFF_N = 48;
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const SUN_DIR = new THREE.Vector3(-0.42, -0.9, 0.21).normalize();

export class World {
  renderer: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 6, 420000);
  high: boolean;
  scale = 1;
  sky = new Sky();
  private pipeline: THREE.RenderPipeline | null = null;
  private uBlur = uniform(0);
  private walls = new Map<number, WallMesh>();
  private decals = new Map<string, THREE.Object3D>();
  private sun = new THREE.DirectionalLight(0xffd2a0, 2.4);
  private sparkMesh!: THREE.InstancedMesh;
  private sparkLife = new Float32Array(SPARK_N);
  private sparkPos = new Float32Array(SPARK_N * 3);
  private sparkVel = new Float32Array(SPARK_N * 3);
  private sparkSize = new Float32Array(SPARK_N);
  private sparkHead = 0;
  private puffs!: THREE.InstancedMesh;
  private puffLife = new Float32Array(PUFF_N);
  private puffMax = new Float32Array(PUFF_N);
  private puffSize = new Float32Array(PUFF_N);
  private puffPos = new Float32Array(PUFF_N * 3);
  private puffHead = 0;
  shadowTarget = new THREE.Object3D();

  constructor(mount: HTMLElement, high: boolean) {
    this.high = high;
    enableMRT(high);
    // Always the WebGPU renderer (it falls back to WebGL2 by itself); SMAA does the anti-aliasing.
    this.renderer = new THREE.WebGPURenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(this.renderer.domElement);
    addEventListener('resize', () => this.resize());
  }

  async init() {
    await this.renderer.init();
    this.resize();

    // Warm, low sun; the same direction lights the scene.
    const sky = new SkyMesh();
    sky.scale.setScalar(300000);
    sky.turbidity.value = 6;
    sky.rayleigh.value = 2.2;
    sky.mieCoefficient.value = 0.006;
    sky.mieDirectionalG.value = 0.86;
    const elev = 12 * Math.PI / 180, az = 205 * Math.PI / 180;
    const sunDir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.cos(elev) * Math.cos(az), Math.sin(elev));
    SUN_DIR.copy(sunDir);
    // SkyMesh is a Y-up shader: stand it up (local Y -> world Z) and hand it the sun in its own frame.
    sky.rotation.x = Math.PI / 2;
    sky.sunPosition.value.set(sunDir.x, sunDir.z, -sunDir.y);
    this.scene.add(sky);
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(sky as unknown as THREE.Scene);
      this.scene.environment = env.texture;
      this.scene.environmentIntensity = 0.25;
    } catch (e) {
      console.warn('environment map unavailable', e);
    }
    this.scene.fog = new THREE.Fog(0xe9d3c9, 30000, 230000);
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x9a7a66, 0.65));
    this.sun.position.copy(sunDir).multiplyScalar(20000);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -3200; sc.right = sc.top = 3200; sc.near = 4000; sc.far = 40000;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 6;
    this.sun.target = this.shadowTarget;
    this.scene.add(this.sun, this.shadowTarget);

    // Ocean far below the deck, glimpsed through gaps in the clouds.
    const normals = waterNormals();
    normals.repeat.set(400, 400);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshStandardNodeMaterial({ color: 0x2a5a8a, roughness: 0.15, metalness: 0.3, normalMap: normals, normalScale: new THREE.Vector2(0.5, 0.5) }));
    water.position.z = OCEAN_Z;
    this.scene.add(water);

    // Particle pools: one instanced draw each.
    this.sparkMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), SPARK_N);
    this.sparkMesh.frustumCulled = false;
    const puffMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });
    puffMat.mrtNode = flatMRT();
    this.puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), puffMat, PUFF_N);
    this.puffs.frustumCulled = false;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < SPARK_N; i++) { this.sparkMesh.setMatrixAt(i, _m); this.sparkMesh.setColorAt(i, _c.set(0xffffff)); }
    for (let i = 0; i < PUFF_N; i++) { this.puffs.setMatrixAt(i, _m); this.puffs.setColorAt(i, _c.set(0xffffff)); }
    this.scene.add(this.sparkMesh, this.puffs);

    // Post: bloom + SMAA always; AO and motion blur only on High.
    const scenePass = pass(this.scene, this.camera);
    const colorNode = scenePass.getTextureNode('output');
    let lit: any = colorNode;
    if (this.high) {
      scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
      const depthNode = scenePass.getTextureNode('depth');
      const aoPass = ao(depthNode, scenePass.getTextureNode('normal'), this.camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 40;
      aoPass.thickness.value = 12;
      aoPass.scale.value = 0.9;
      // AO only matters on the ramps around the player; beyond a few thousand units the depth buffer is too coarse and it
      // turns to noise. The pass's own viewZ node uses the scene camera's near/far (the TSL cameraNear/Far would be the quad's).
      const aoNear = mix(float(1), aoPass.getTextureNode(), smoothstep(float(-9000), float(-3000), scenePass.getViewZNode()));
      const blurred = convertToTexture(motionBlur(colorNode, scenePass.getTextureNode('velocity').mul(this.uBlur)));
      lit = convertToTexture(blurred.mul(aoNear));
    }
    let out: any = lit.add(bloom(lit, 0.22, 0.4, 1.25));
    out = smaa(convertToTexture(out));
    this.pipeline = new THREE.RenderPipeline(this.renderer, out);
  }

  resize() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5) * this.scale);
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // Adaptive resolution: the canvas stays full size, the drawing buffer shrinks.
  setRenderScale(s: number) { if (s !== this.scale) { this.scale = s; this.resize(); } }

  // speed in u/s; fov widens and the screen smears (High) as you go faster.
  speedFx(speed: number, dt: number) {
    const k = Math.max(0, Math.min(1, (speed - 900) / 2400));
    const fov = 74 + k * 16;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 6);
    this.camera.updateProjectionMatrix();
    this.uBlur.value = k * 0.7;
  }

  buildLevel(level: Level, json: LevelJSON) {
    const spawns = json.spawns;
    const stageOf = (x: number, y: number, z: number) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < spawns.length; i++) { const p = spawns[i].pos, d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      return best;
    };
    const chunks: Chunks = new Map();
    const put = (kind: string, stage: number, g: THREE.BufferGeometry) => { const k = `${kind}:${stage}`; (chunks.get(k) ?? chunks.set(k, []).get(k)!).push(g); };

    // Ramps: cream plastic with a per-brush tint so the big faces don't read as one flat slab.
    const rnd = mulberry(7);
    for (const b of level.brushes) {
      const pos: number[] = [], nrm: number[] = [], col: number[] = [];
      _c.set(CREAM).offsetHSL(0, 0, rnd() * 0.03 - 0.015);
      let cx = 0, cy = 0, cz = 0, cn = 0;
      for (const f of b.faces) {
        const n = faceNormal(f);
        for (let i = 1; i + 1 < f.length; i++) for (const v of [f[0], f[i], f[i + 1]]) { pos.push(v[0], v[1], v[2]); nrm.push(n[0], n[1], n[2]); col.push(_c.r, _c.g, _c.b); cx += v[0]; cy += v[1]; cz += v[2]; cn++; }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      put('ramp', stageOf(cx / cn, cy / cn, cz / cn), g);
    }
    // Trim lines along every ridge and base edge.
    const lines = new Map<number, number[]>();
    for (const e of json.edges ?? []) {
      const s = stageOf(e.pts[0][0], e.pts[0][1], e.pts[0][2]);
      const arr = lines.get(s) ?? lines.set(s, []).get(s)!;
      for (let i = 0; i + 1 < e.pts.length; i++) { const a = e.pts[i], b = e.pts[i + 1]; arr.push(a[0], a[1], a[2] + 2, b[0], b[1], b[2] + 2); }
    }

    const props = (json as any).props ?? [];
    const lookMat = (p: V3, yaw: number, lift = 0) => { const o = new THREE.Object3D(); o.position.set(p[0], p[1], p[2] + lift); const yr = yaw * Math.PI / 180; o.lookAt(p[0] + Math.cos(yr), p[1] + Math.sin(yr), p[2] + lift); o.updateMatrix(); return o.matrix; };
    const boosters: THREE.BufferGeometry[] = [];
    for (const p of props) {
      const st = stageOf(p.pos[0], p.pos[1], p.pos[2]);
      if (p.type === 'pylon') {
        const h = p.pos[2] - OCEAN_Z;
        put('cream', st, bake(upright(new THREE.CylinderGeometry(p.r, p.r * 1.6, h, 14)), tmat(p.pos[0], p.pos[1], p.pos[2] - h / 2), CREAM));
        put('cream', st, bake(new THREE.SphereGeometry(p.r * 1.05, 14, 10), tmat(p.pos[0], p.pos[1], p.pos[2], 0, 0, 0, 1, 1, 0.5), CREAM));
        put('glow', st, bake(new THREE.TorusGeometry(p.r + 14, 6, 6, 32), tmat(p.pos[0], p.pos[1], p.pos[2] - 50), BLUE));
      } else if (p.type === 'tower' || p.type === 'pillar') {
        put('cream', st, bake(upright(new THREE.CylinderGeometry(p.r, p.r, p.h, 24)), tmat(p.pos[0], p.pos[1], p.pos[2] + p.h / 2), CREAM));
        put('cream', st, bake(new THREE.SphereGeometry(p.r, 24, 12), tmat(p.pos[0], p.pos[1], p.pos[2] + p.h, 0, 0, 0, 1, 1, 0.45), CREAM));
        for (let i = 0; i < 8; i++) put('glow', st, bake(new THREE.TorusGeometry(p.r + 4, 5, 6, 48), tmat(p.pos[0], p.pos[1], p.pos[2] + (i + 0.5) * p.h / 8), i % 2 ? GLOW : BLUE));
      } else if (p.type === 'gate') {
        put('glow', st, bake(new THREE.TorusGeometry(520, 18, 8, 48), lookMat(p.pos, p.yaw, 560), p.finish ? GOLD : BLUE));
      } else if (p.type === 'booster') {
        boosters.push(bake(new THREE.PlaneGeometry(500, 360), tmat(p.pos[0], p.pos[1], p.pos[2] + 40, 0, 0, p.yaw * Math.PI / 180), GOLD));
      } else if (p.type === 'beacon') {
        put('glow', st, bake(new THREE.OctahedronGeometry(60), tmat(p.pos[0], p.pos[1], p.pos[2]), BLUE));
      }
    }
    // Spray walls: a textured board each (its own draw), backing boards and posts merged with the cream chunk.
    for (const w of (json as any).walls ?? []) {
      this.makeWall(w.id, w.name, w.pos, w.yaw, w.w, w.h);
      const st = stageOf(w.pos[0], w.pos[1], w.pos[2]);
      put('cream', st, bake(new THREE.BoxGeometry(w.w + 30, w.h + 30, 10), lookMat(w.pos, w.yaw).clone().multiply(tmat(0, 0, -6)), CREAM));
      put('cream', st, bake(upright(new THREE.CylinderGeometry(10, 12, w.h * 1.2, 10)), tmat(w.pos[0], w.pos[1], w.pos[2] - w.h * 0.6 - 60), CREAM));
    }
    for (const id of this.walls.keys()) this.setWall(id, null);

    // Materials shared across chunks.
    const rampMat = new THREE.MeshPhysicalNodeMaterial({ vertexColors: true, metalness: 0, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4, side: THREE.DoubleSide });
    rampMat.emissiveNode = color(0x6f9cff).mul(pow(oneMinus(abs(normalView.z)), 3)).mul(0.12);
    const creamMat = new THREE.MeshPhysicalNodeMaterial({ vertexColors: true, metalness: 0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const glowMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    const lineMat = new THREE.LineBasicNodeMaterial({ color: 0x4f86ff });
    for (const [k, geos] of chunks) {
      const kind = k.split(':')[0];
      const g = mergeAll(geos);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, kind === 'ramp' ? rampMat : kind === 'cream' ? creamMat : glowMat);
      mesh.receiveShadow = kind !== 'glow';
      this.scene.add(mesh);
    }
    for (const arr of lines.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeBoundingSphere();
      this.scene.add(new THREE.LineSegments(g, lineMat));
    }
    if (boosters.length) {
      const bm = new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      bm.opacityNode = abs(sin(time.mul(6))).mul(0.35).add(0.6);
      bm.mrtNode = flatMRT();
      this.scene.add(new THREE.Mesh(mergeAll(boosters)!, bm));
    }

    // Sky: everything beyond the course.
    let lo = Infinity, hi = -Infinity;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const b of json.brushes) for (const v of b.verts) {
      lo = Math.min(lo, v[2]); hi = Math.max(hi, v[2]);
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
    }
    const seaZ = lo - 4000;
    this.sky.build(json, lo, hi, seaZ, [(minX + maxX) / 2, (minY + maxY) / 2, lo]);
    this.scene.add(this.sky.group);
  }

  private makeWall(id: number, name: string, pos: V3, yaw: number, w: number, h: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = Math.round(1024 * h / w);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // A group that faces `yaw` (the direction players arrive from): the plane's +z is its front, so no mirroring.
    const group = new THREE.Group();
    group.position.set(pos[0], pos[1], pos[2]);
    const yr = yaw * Math.PI / 180;
    group.lookAt(pos[0] + Math.cos(yr), pos[1] + Math.sin(yr), pos[2]);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide }));
    group.add(mesh);
    this.scene.add(group);
    this.walls.set(id, { mesh, canvas, tex, pos, yaw, w, h, name });
  }

  wallInfo(id: number) { return this.walls.get(id); }

  // Paint a spray wall: a white board with a blue frame; empty = dashed outline inviting a spray; painted = the owner's spray with a tag.
  setWall(id: number, w: WallInfo | null, img?: ImageBitmap | null) {
    const wall = this.walls.get(id);
    if (!wall) return;
    const { canvas, tex } = wall;
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    g.fillStyle = '#f7f4ee';
    g.fillRect(0, 0, W, H);
    g.lineWidth = 22; g.strokeStyle = '#2f6fe4';
    g.strokeRect(11, 11, W - 22, H - 22);
    g.textAlign = 'center';
    if (!w || !img) {
      g.setLineDash([26, 18]); g.lineWidth = 5; g.strokeStyle = 'rgba(47,111,228,0.45)';
      g.strokeRect(54, 54, W - 108, H - 108);
      g.setLineDash([]);
      g.fillStyle = '#2f6fe4';
      g.font = `700 ${Math.round(H * 0.22)}px ${FONT}`;
      g.fillText('SPRAY HERE', W / 2, H * 0.5);
      g.font = `${Math.round(H * 0.11)}px ${FONT}`;
      g.fillStyle = '#5a6b8c';
      g.fillText(`${wall.name.toUpperCase()}  ·  PRESS T`, W / 2, H * 0.68);
      sprayCan(g, W / 2, H * 0.86, H * 0.09);
      tex.needsUpdate = true;
      return;
    }
    const side = Math.min(W, H) * 0.86;
    const x = (W - side) / 2, y = (H - side) / 2 - H * 0.04;
    g.drawImage(img, x, y, side, side);
    g.fillStyle = 'rgba(47,111,228,0.92)';
    g.fillRect(22, H - H * 0.17, W - 44, H * 0.17 - 22);
    g.fillStyle = '#ffffff';
    g.font = `700 ${Math.round(H * 0.1)}px ${FONT}`;
    g.fillText(fit(g, w.name.toUpperCase(), W * 0.8), W / 2, H - H * 0.055);
    tex.needsUpdate = true;
  }

  // A live spray decal on any surface (CS-style); one per player.
  setDecal(key: string, tex: THREE.Texture, pos: V3, normal: V3, size: number) {
    this.removeDecal(key);
    const at = new THREE.Vector3(...pos).addScaledVector(new THREE.Vector3(...normal), 0.8);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    m.position.copy(at);
    if (Math.abs(normal[2]) > 0.9) m.up.set(0, 1, 0);
    m.lookAt(at.clone().add(new THREE.Vector3(...normal)));
    this.scene.add(m);
    this.decals.set(key, m);
  }

  removeDecal(key: string) {
    const d = this.decals.get(key);
    if (d) { this.scene.remove(d); this.decals.delete(key); }
  }

  // Called per frame: camera-facing clouds, wind, giant's head.
  tickSky(now: number, dt: number, speed: number, vel: V3) {
    void now;
    this.sky.tick(dt, this.camera, speed, vel);
  }

  // Point the giant's head at the leader.
  giantLookAt(x: number, y: number) { this.sky.lookAt(x, y); }

  sparks(at: V3, dir: V3, n: number, col = GLOW) {
    _c.set(col);
    for (let i = 0; i < n; i++) {
      const k = this.sparkHead; this.sparkHead = (this.sparkHead + 1) % SPARK_N;
      this.sparkLife[k] = 0.35 + Math.random() * 0.3;
      this.sparkSize[k] = 3 + Math.random() * 4;
      this.sparkPos[k * 3] = at[0] + (Math.random() - 0.5) * 20; this.sparkPos[k * 3 + 1] = at[1] + (Math.random() - 0.5) * 20; this.sparkPos[k * 3 + 2] = at[2] + Math.random() * 10;
      this.sparkVel[k * 3] = dir[0] * 300 + (Math.random() - 0.5) * 500; this.sparkVel[k * 3 + 1] = dir[1] * 300 + (Math.random() - 0.5) * 500; this.sparkVel[k * 3 + 2] = 200 + Math.random() * 400;
      this.sparkMesh.setColorAt(k, _c);
    }
    this.sparkMesh.instanceColor!.needsUpdate = true;
  }

  puff(at: V3, size: number, col = 0xcfdcee, life = 0.6) {
    const k = this.puffHead; this.puffHead = (this.puffHead + 1) % PUFF_N;
    this.puffLife[k] = life; this.puffMax[k] = life; this.puffSize[k] = size;
    this.puffPos[k * 3] = at[0]; this.puffPos[k * 3 + 1] = at[1]; this.puffPos[k * 3 + 2] = at[2];
    this.puffs.setColorAt(k, _c.set(col));
    this.puffs.instanceColor!.needsUpdate = true;
  }

  tickFx(now: number, dt: number) {
    void now;
    _q.identity();
    let any = false;
    for (let i = 0; i < SPARK_N; i++) {
      if (this.sparkLife[i] <= 0) continue;
      any = true;
      this.sparkLife[i] -= dt;
      const o = i * 3;
      this.sparkVel[o + 2] -= 800 * dt;
      this.sparkPos[o] += this.sparkVel[o] * dt; this.sparkPos[o + 1] += this.sparkVel[o + 1] * dt; this.sparkPos[o + 2] += this.sparkVel[o + 2] * dt;
      const s = this.sparkLife[i] <= 0 ? 0 : this.sparkSize[i] * Math.min(1, this.sparkLife[i] * 3);
      this.sparkMesh.setMatrixAt(i, _m.compose(_v.set(this.sparkPos[o], this.sparkPos[o + 1], this.sparkPos[o + 2]), _q, _s.setScalar(s)));
    }
    if (any) this.sparkMesh.instanceMatrix.needsUpdate = true;
    any = false;
    for (let i = 0; i < PUFF_N; i++) {
      if (this.puffLife[i] <= 0) continue;
      any = true;
      this.puffLife[i] -= dt;
      const o = i * 3;
      const age = 1 - this.puffLife[i] / this.puffMax[i];
      const s = this.puffLife[i] <= 0 ? 0 : this.puffSize[i] * (1 + age * 1.5) * Math.min(1, (1 - age) * 3);
      this.puffs.setMatrixAt(i, _m.compose(_v.set(this.puffPos[o], this.puffPos[o + 1], this.puffPos[o + 2]), _q, _s.setScalar(s)));
    }
    if (any) this.puffs.instanceMatrix.needsUpdate = true;
  }

  render() {
    // Keep the shadow frustum on the player.
    this.sun.position.copy(this.shadowTarget.position).addScaledVector(SUN_DIR, 20000);
    if (this.pipeline) this.pipeline.render(); else this.renderer.render(this.scene, this.camera);
  }
}

export const fmtMs = (ms: number) => `${Math.floor(ms / 60000)}:${((ms / 1000) % 60).toFixed(2).padStart(5, '0')}`;

function faceNormal(f: V3[]): V3 {
  const ax = f[1][0] - f[0][0], ay = f[1][1] - f[0][1], az = f[1][2] - f[0][2];
  const bx = f[2][0] - f[0][0], by = f[2][1] - f[0][1], bz = f[2][2] - f[0][2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// Image textures by content hash, fetched once and shared by every boat/wall using them.
const textures = new Map<string, Promise<{ tex: THREE.Texture; bmp: ImageBitmap }>>();
export function imageTexture(hash: string) {
  let t = textures.get(hash);
  if (!t) {
    t = fetch(`/img/${hash}`)
      .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then(b => createImageBitmap(b))
      .then(bmp => {
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        return { tex: textureFromCanvas(c), bmp };
      });
    textures.set(hash, t);
  }
  return t;
}

// Procedural water normal map: a few octaves of value noise turned into normals.
function waterNormals() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const h = new Float32Array(S * S);
  const rnd = mulberry(3);
  for (let o = 0; o < 4; o++) {
    const f = 4 << o, amp = 1 / (1 << o);
    const grid = new Float32Array((f + 1) * (f + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const gx = x / S * f, gy = y / S * f, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = grid[y0 * (f + 1) + x0], b = grid[y0 * (f + 1) + x0 + 1], cc = grid[(y0 + 1) * (f + 1) + x0], d = grid[(y0 + 1) * (f + 1) + x0 + 1];
      h[y * S + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (cc * (1 - sx) + d * sx) * sy);
    }
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = h[y * S + (x + S - 1) % S], r = h[y * S + (x + 1) % S], u = h[((y + S - 1) % S) * S + x], d = h[((y + 1) % S) * S + x];
    const nx = (l - r) * 3, ny = (u - d) * 3, nz = 1, len = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = 128 + nx / len * 127; img.data[i + 1] = 128 + ny / len * 127; img.data[i + 2] = 128 + nz / len * 127; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// A little spray-can glyph for empty walls.
function sprayCan(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.fillStyle = '#2f6fe4';
  g.fillRect(x - r * 0.5, y - r, r, r * 2);
  g.fillStyle = '#1d2b4a';
  g.fillRect(x - r * 0.5, y - r * 1.5, r, r * 0.5);
  g.fillStyle = '#8ec5ff';
  g.fillRect(x - r * 0.15, y - r * 1.8, r * 0.3, r * 0.3);
  g.fillStyle = 'rgba(47,111,228,0.45)';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(x + r * (0.9 + i * 0.35), y - r * (1.7 + Math.sin(i) * 0.3), r * (0.12 + i * 0.05), 0, Math.PI * 2); g.fill(); }
}
