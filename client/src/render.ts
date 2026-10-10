// Three.js (WebGPU, WebGL2 fallback) world, built Z-up to match the Source-style physics.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, uniform, float, vec2, convertToTexture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import type { Level, LevelJSON, V3 } from './physics.ts';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const CYAN = 0x35f0ff, MAGENTA = 0xff2bd6, AMBER = 0xffb000;
const FONT = '"Rajdhani", "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif';
export const OCEAN_Z = -21000;

export type Billboard = { slot: number; hash?: string | null; text: string; url?: string | null; name: string; sponsor: string; at?: number };
type BillboardMesh = { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; frame: THREE.Mesh; pos: V3; yaw: number; w: number; h: number };

export class World {
  renderer: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 4, 400000);
  high: boolean;
  private pipeline: THREE.RenderPipeline | null = null;
  private uBlur = uniform(0);
  private uCA = uniform(0);
  private fx: { obj: THREE.Object3D; until: number; mat: THREE.Material; vel?: V3 }[] = [];
  private billboards = new Map<number, BillboardMesh>();
  private boosters: THREE.Mesh[] = [];
  private gates: THREE.Mesh[] = [];
  private sun = new THREE.DirectionalLight(0xffd9a8, 3.2);
  private water: THREE.Mesh | null = null;
  shadowTarget = new THREE.Object3D();

  constructor(mount: HTMLElement, high: boolean) {
    this.high = high;
    this.renderer = new THREE.WebGPURenderer({ antialias: !high, forceWebGL: !high });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, high ? 2 : 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(this.renderer.domElement);
    addEventListener('resize', () => this.resize());
  }

  async init() {
    await this.renderer.init();
    this.resize();

    // Golden-hour sky; the same sun lights the scene and drives the ocean highlight.
    const sky = new SkyMesh();
    sky.scale.setScalar(300000);
    sky.turbidity.value = 8;
    sky.rayleigh.value = 2.6;
    sky.mieCoefficient.value = 0.004;
    sky.mieDirectionalG.value = 0.9;
    const elev = 7 * Math.PI / 180, az = 205 * Math.PI / 180;
    const sunDir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.cos(elev) * Math.cos(az), Math.sin(elev));
    // SkyMesh is a Y-up shader: stand it up (local Y -> world Z) and hand it the sun in its own frame.
    sky.rotation.x = Math.PI / 2;
    sky.sunPosition.value.set(sunDir.x, sunDir.z, -sunDir.y);
    this.scene.add(sky);
    try {
      const pmrem: any = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromSceneAsync ? await pmrem.fromSceneAsync(sky) : pmrem.fromScene(sky);
      this.scene.environment = env.texture;
      this.scene.environmentIntensity = 0.55;
    } catch (e) {
      console.warn('environment map unavailable', e);
    }
    this.scene.fog = new THREE.Fog(0xcfb6bd, 24000, 160000);
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x4a2f22, 1.1));
    this.sun.position.copy(sunDir).multiplyScalar(20000);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -3200; sc.right = sc.top = 3200; sc.near = 4000; sc.far = 40000;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 6;
    this.sun.target = this.shadowTarget;
    this.scene.add(this.sun, this.shadowTarget);

    // Ocean, far below everything.
    const normals = waterNormals();
    const geo = new THREE.PlaneGeometry(400000, 400000);
    // ponytail: a glossy normal-mapped plane; WaterMesh's planar reflections can replace it once the pipeline is settled.
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x0a2436, roughness: 0.1, metalness: 0.35, normalMap: normals, normalScale: new THREE.Vector2(0.5, 0.5) });
    normals.repeat.set(400, 400);
    this.water = new THREE.Mesh(geo, m);
    this.water.position.z = OCEAN_Z;
    this.scene.add(this.water);

    // Post-processing. Speed drives the blur and chromatic aberration uniforms.
    const scenePass = pass(this.scene, this.camera);
    const colorNode = scenePass.getTextureNode('output');
    let out: any;
    if (this.high) {
      scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
      const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), this.camera);
      aoPass.resolutionScale = 0.5;
      // Motion blur samples its input, so it runs on the raw colour texture; everything after is arithmetic on it.
      const blurred = convertToTexture(motionBlur(colorNode, scenePass.getTextureNode('velocity').mul(this.uBlur)));
      const lit = convertToTexture(blurred.mul(aoPass.getTextureNode()));
      out = lit.add(bloom(lit, 0.5, 0.5, 0.96));
      out = out.add(lensflare(lit, { threshold: 0.92, ghostSamples: 3, ghostAttenuationFactor: 18, ghostTint: new THREE.Color(0x66ccff) } as any));
      out = chromaticAberration(out, this.uCA, vec2(0.5, 0.5), float(1.02));
      out = film(convertToTexture(out), float(0.06));
      out = smaa(convertToTexture(out));
    } else {
      out = colorNode.add(bloom(colorNode, 0.45, 0.5, 0.96));
    }
    this.pipeline = new THREE.RenderPipeline(this.renderer, out);
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // speed in u/s; fov widens and the screen smears as you go faster.
  speedFx(speed: number, dt: number) {
    const k = Math.max(0, Math.min(1, (speed - 900) / 2400));
    const fov = 74 + k * 16;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 6);
    this.camera.updateProjectionMatrix();
    this.uBlur.value = k * 0.9;
    this.uCA.value = k * 0.35;
  }

  buildLevel(level: Level, json: LevelJSON) {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    for (const b of level.brushes) {
      for (const f of b.faces) {
        c.set(b.color).offsetHSL(0, 0, (f.length * 0.013) % 0.04 - 0.02).multiplyScalar(0.7);
        for (let i = 1; i + 1 < f.length; i++) for (const v of [f[0], f[i], f[i + 1]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const steel = new THREE.MeshPhysicalNodeMaterial({ vertexColors: true, metalness: 0.18, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25, flatShading: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, steel);
    // Receives glider shadows; doesn't cast, which kills shadow acne on the long grazing faces.
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // Neon strips along every ridge and base edge: thin tubes, so they have real thickness and bloom.
    const tubeMats = { cyan: new THREE.MeshBasicNodeMaterial({ color: CYAN }), magenta: new THREE.MeshBasicNodeMaterial({ color: MAGENTA }) };
    const up = new THREE.Vector3(0, 0, 1);
    for (const e of json.edges ?? []) {
      const pts = e.pts.map(p => new THREE.Vector3(...p));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(2, pts.length * 2), e.color === 'cyan' ? 7 : 5, 5, false), tubeMats[e.color]);
      tube.position.copy(up).multiplyScalar(0.5);
      this.scene.add(tube);
    }

    const props = (json as any).props ?? [];
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x3a4455, metalness: 0.3, roughness: 0.5 });
    for (const p of props) {
      if (p.type === 'pylon') {
        const h = p.pos[2] - OCEAN_Z;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 1.6, h, 8), dark);
        m.rotation.x = Math.PI / 2;
        m.position.set(p.pos[0], p.pos[1], p.pos[2] - h / 2);
        this.scene.add(m);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(p.r + 20, 6, 6, 24), new THREE.MeshBasicNodeMaterial({ color: MAGENTA }));
        ring.position.set(p.pos[0], p.pos[1], p.pos[2] - 40);
        this.scene.add(ring);
      } else if (p.type === 'tower') {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, p.h, 24), new THREE.MeshPhysicalNodeMaterial({ color: 0x3c4658, metalness: 0.35, roughness: 0.3, clearcoat: 0.8 }));
        m.rotation.x = Math.PI / 2;
        m.position.set(p.pos[0], p.pos[1], p.pos[2] + p.h / 2);
        m.receiveShadow = true;
        this.scene.add(m);
        for (let i = 0; i < 8; i++) {
          const band = new THREE.Mesh(new THREE.TorusGeometry(p.r + 4, 5, 6, 48), new THREE.MeshBasicNodeMaterial({ color: i % 2 ? CYAN : MAGENTA }));
          band.position.set(p.pos[0], p.pos[1], p.pos[2] + (i + 0.5) * p.h / 8);
          this.scene.add(band);
        }
      } else if (p.type === 'gate') {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(520, 18, 8, 48), new THREE.MeshBasicNodeMaterial({ color: p.finish ? AMBER : CYAN }));
        ring.position.set(p.pos[0], p.pos[1], p.pos[2] + 560);
        const yr = p.yaw * Math.PI / 180;
        ring.lookAt(p.pos[0] + Math.cos(yr), p.pos[1] + Math.sin(yr), p.pos[2] + 560); // torus faces +z locally
        this.scene.add(ring);
        this.gates.push(ring);
      } else if (p.type === 'booster') {
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(500, 360), new THREE.MeshBasicNodeMaterial({ color: AMBER, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
        plate.position.set(p.pos[0], p.pos[1], p.pos[2] + 40);
        plate.rotation.z = p.yaw * Math.PI / 180;
        this.scene.add(plate);
        this.boosters.push(plate);
      }
    }

    for (const b of (json as any).billboards ?? []) this.makeBillboard(b.id, b.pos, b.yaw, b.w, b.h);
    for (const slot of this.billboards.keys()) this.setBillboard(slot, null);
  }

  private makeBillboard(slot: number, pos: V3, yaw: number, w: number, h: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = Math.round(1024 * h / w);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // A group that faces `yaw` (the direction players arrive from): the plane's +z is its front, so no mirroring.
    const group = new THREE.Group();
    group.position.set(pos[0], pos[1], pos[2]);
    const yr = yaw * Math.PI / 180;
    group.lookAt(pos[0] + Math.cos(yr), pos[1] + Math.sin(yr), pos[2]);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, opacity: 0.92, side: THREE.DoubleSide }));
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 40, h + 40), new THREE.MeshBasicNodeMaterial({ color: slot === 0 ? AMBER : CYAN, side: THREE.DoubleSide }));
    frame.position.z = -1;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(10, 12, h * 1.2), new THREE.MeshStandardNodeMaterial({ color: 0x3a4455, metalness: 0.3, roughness: 0.4 }));
    post.rotation.x = Math.PI / 2;
    post.position.set(pos[0], pos[1], pos[2] - h * 0.6 - 60);
    group.add(mesh, frame);
    this.scene.add(group, post);
    this.billboards.set(slot, { mesh, canvas, tex, frame, pos, yaw, w, h });
  }

  billboardPos(slot: number) { return this.billboards.get(slot); }

  // Paint a billboard's canvas: image (if any) + headline + name/sponsor. Slot 0 is the record holder.
  setBillboard(slot: number, b: Billboard | null, img?: HTMLImageElement | ImageBitmap | null, recordMs?: number) {
    const bb = this.billboards.get(slot);
    if (!bb) return;
    const { canvas, tex } = bb;
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    g.fillStyle = '#060912';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(53,240,255,0.06)';
    for (let y = 0; y < H; y += 6) g.fillRect(0, y, W, 2);
    g.textAlign = 'center';
    if (!b) {
      g.fillStyle = slot === 0 ? '#ffb000' : '#35f0ff';
      g.font = `700 ${Math.round(H * 0.16)}px ${FONT}`;
      g.fillText(slot === 0 ? 'SERVER RECORD' : 'YOUR AD HERE', W / 2, H * 0.42);
      g.font = `${Math.round(H * 0.1)}px ${FONT}`;
      g.fillStyle = '#eef2f7';
      g.fillText(slot === 0 ? 'SET THE FASTEST RUN' : 'WIN A ROUND', W / 2, H * 0.62);
      tex.needsUpdate = true;
      return;
    }
    const imgW = img ? W * 0.42 : 0;
    if (img) {
      g.drawImage(img, 24, 24, imgW - 24, H - 48);
      g.strokeStyle = '#35f0ff'; g.lineWidth = 4; g.strokeRect(24, 24, imgW - 24, H - 48);
    }
    const cx = imgW + (W - imgW) / 2, tw = W - imgW - 60;
    g.fillStyle = slot === 0 ? '#ffb000' : '#ff2bd6';
    g.font = `${Math.round(H * 0.09)}px ${FONT}`;
    g.fillText(slot === 0 ? `SERVER RECORD  ${recordMs !== undefined ? fmtMs(recordMs) : ''}` : 'ROUND WINNER', cx, H * 0.17);
    g.fillStyle = '#ffffff';
    g.font = `700 ${Math.round(H * 0.2)}px ${FONT}`;
    g.fillText(fit(g, b.name.toUpperCase(), tw), cx, H * 0.4);
    if (b.sponsor) { g.fillStyle = '#ffb000'; g.font = `${Math.round(H * 0.11)}px ${FONT}`; g.fillText(fit(g, b.sponsor, tw), cx, H * 0.55); }
    if (b.text) { g.fillStyle = '#eef2f7'; g.font = `${Math.round(H * 0.1)}px ${FONT}`; wrap(g, b.text, cx, H * 0.72, tw, H * 0.12); }
    if (b.url) { g.fillStyle = '#35f0ff'; g.font = `${Math.round(H * 0.075)}px ${FONT}`; g.fillText(fit(g, b.url, tw), cx, H * 0.95); }
    tex.needsUpdate = true;
  }

  sparks(at: V3, dir: V3, n: number, color = CYAN) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({ color, transparent: true });
      const m = new THREE.Mesh(SPARK, mat);
      m.position.set(at[0] + (Math.random() - 0.5) * 20, at[1] + (Math.random() - 0.5) * 20, at[2] + Math.random() * 10);
      m.scale.setScalar(3 + Math.random() * 4);
      const vel: V3 = [dir[0] * 300 + (Math.random() - 0.5) * 500, dir[1] * 300 + (Math.random() - 0.5) * 500, 200 + Math.random() * 400];
      this.scene.add(m);
      this.fx.push({ obj: m, until: performance.now() / 1000 + 0.35 + Math.random() * 0.3, mat, vel });
    }
  }

  puff(at: V3, size: number, color = 0x8a9ab5, life = 0.6) {
    const mat = new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.6 });
    const m = new THREE.Mesh(PUFF, mat);
    m.position.set(...at);
    m.scale.setScalar(size);
    this.scene.add(m);
    this.fx.push({ obj: m, until: performance.now() / 1000 + life, mat });
  }

  tickFx(now: number, dt: number) {
    this.fx = this.fx.filter(f => {
      const left = f.until - now;
      if (left <= 0) { this.scene.remove(f.obj); f.mat.dispose(); return false; }
      (f.mat as any).opacity = Math.min(1, left * 3);
      if (f.vel) { f.obj.position.x += f.vel[0] * dt; f.obj.position.y += f.vel[1] * dt; f.obj.position.z += f.vel[2] * dt; f.vel[2] -= 800 * dt; }
      else f.obj.scale.multiplyScalar(1 + dt * 1.5);
      return true;
    });
    for (const [slot, b] of this.billboards) (b.mesh.material as any).opacity = 0.86 + 0.08 * Math.sin(now * 17 + slot) + (Math.random() < 0.01 ? -0.3 : 0);
    for (const g of this.gates) g.rotation.z += dt * 0.4;
    for (const b of this.boosters) (b.material as any).opacity = 0.6 + 0.35 * Math.abs(Math.sin(now * 6));
    if (this.water && 'time' in (this.water as any)) (this.water as any).time.value += dt;
  }

  render() {
    // Keep the shadow frustum on the player.
    this.sun.position.copy(this.shadowTarget.position).add(new THREE.Vector3(-0.42, -0.9, 0.16).normalize().multiplyScalar(20000));
    if (this.pipeline) this.pipeline.render(); else this.renderer.render(this.scene, this.camera);
  }
}

const SPARK = new THREE.BoxGeometry(1, 1, 1);
const PUFF = new THREE.IcosahedronGeometry(1, 0);

export const fmtMs = (ms: number) => `${Math.floor(ms / 60000)}:${((ms / 1000) % 60).toFixed(2).padStart(5, '0')}`;

// --- gliders --------------------------------------------------------------------------------------------
export class Glider {
  group = new THREE.Group();
  private body: THREE.Group;
  private label: THREE.Sprite | null = null;
  private flag: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  private trail: THREE.Mesh;
  private trailPts: { p: V3; t: number }[] = [];
  private trailPos: Float32Array;
  private trailN: number;
  private lastPos: V3 | null = null;
  readonly color: THREE.Color;

  constructor(color: string | number, name: string, sponsor = '', ghost = false) {
    this.color = new THREE.Color(color);
    this.body = new THREE.Group();
    // Delta wing: a flat four-point hull, peaked at the canopy, extruded a little.
    const wing = new THREE.BufferGeometry();
    const top = 10, bot = -6;
    const pts = [[60, 0], [-30, 58], [-44, 0], [-30, -58]];
    const v: number[] = [];
    const tri = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c);
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      tri([a[0], a[1], top], [b[0], b[1], top], [0, 0, 16]);
      tri([b[0], b[1], bot], [a[0], a[1], bot], [0, 0, bot - 2]);
      tri([a[0], a[1], top], [a[0], a[1], bot], [b[0], b[1], bot]);
      tri([a[0], a[1], top], [b[0], b[1], bot], [b[0], b[1], top]);
    }
    wing.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    wing.computeVertexNormals();
    const bodyMat = ghost
      ? new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
      : new THREE.MeshPhysicalNodeMaterial({ color: 0x151a24, metalness: 0.85, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1, flatShading: true });
    const mesh = new THREE.Mesh(wing, bodyMat);
    mesh.castShadow = !ghost;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(70, 10), new THREE.MeshBasicNodeMaterial({ color: this.color, transparent: ghost, opacity: ghost ? 0.5 : 1 }));
    strip.position.z = bot - 2.5;
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(9, 10, 8), new THREE.MeshPhysicalNodeMaterial({ color: this.color, emissive: this.color, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.1, transparent: true, opacity: ghost ? 0.4 : 0.9 }));
    canopy.position.set(8, 0, 14);
    canopy.scale.set(1.6, 1, 0.8);
    const tipL = new THREE.Mesh(new THREE.SphereGeometry(3), new THREE.MeshBasicNodeMaterial({ color: this.color }));
    tipL.position.set(-30, 58, 2);
    const tipR = tipL.clone();
    tipR.position.y = -58;
    const flagGeo = new THREE.PlaneGeometry(44, 27);
    flagGeo.rotateX(Math.PI / 2);
    flagGeo.rotateZ(-Math.PI / 2);
    this.flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicNodeMaterial({ map: DEFAULT_FLAG, side: THREE.DoubleSide, transparent: true, opacity: ghost ? 0.3 : 1 }));
    this.flag.position.set(-36, 0, 34);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 36), new THREE.MeshBasicNodeMaterial({ color: 0x9aa4b8 }));
    pole.rotation.x = Math.PI / 2;
    pole.position.set(-36, 0, 18);
    this.body.add(mesh, strip, canopy, tipL, tipR, this.flag, pole);
    this.body.position.z = 36;
    this.group.add(this.body);
    if (!ghost) this.setName(name, sponsor);

    // Light trail: a ribbon of the last ~1.4 s of positions, additive, fading toward the tail.
    const N = (this.trailN = 48);
    this.trailPos = new Float32Array(N * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    const idx: number[] = [];
    for (let i = 0; i + 1 < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    tg.setIndex(idx);
    const tm = new THREE.MeshBasicNodeMaterial({ color: ghost ? 0xffffff : this.color, transparent: true, opacity: ghost ? 0.25 : 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.trail = new THREE.Mesh(tg, tm);
    this.trail.frustumCulled = false;
  }

  addTo(scene: THREE.Scene) { scene.add(this.group, this.trail); }
  resetTrail() { this.trailPts.length = 0; this.lastPos = null; }
  removeFrom(scene: THREE.Scene) { scene.remove(this.group, this.trail); }

  setName(name: string, sponsor = '') {
    if (this.label) this.group.remove(this.label);
    this.label = nameSprite(name, sponsor);
    this.label.position.z = 90;
    this.group.add(this.label);
  }

  setFlag(tex: THREE.Texture | null) {
    this.flag.material.map = tex ?? DEFAULT_FLAG;
    this.flag.material.needsUpdate = true;
  }

  set visible(v: boolean) { this.group.visible = v; this.trail.visible = v; }
  get visible() { return this.group.visible; }

  // Pose from position + heading. Pitch/roll follow the motion so the wing banks into turns.
  pose(pos: V3, yaw: number, t: number, finished = false) {
    let prev = this.lastPos;
    if (prev && Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]) > 600) { this.trailPts.length = 0; prev = null; } // teleported
    this.group.position.set(...pos);
    let pitch = 0, roll = 0, speed = 0;
    if (prev) {
      const d: V3 = [pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]];
      const h = Math.hypot(d[0], d[1]);
      speed = Math.hypot(h, d[2]);
      if (speed > 0.5) {
        pitch = Math.atan2(d[2], Math.max(h, 1e-3)) * 0.8;
        const heading = Math.atan2(d[1], d[0]);
        let dy = heading - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        roll = Math.max(-1, Math.min(1, dy * 2));
      }
    }
    this.lastPos = pos;
    this.body.rotation.set(roll, -pitch, yaw, 'ZYX');
    this.body.position.z = 36 + Math.sin(t * 3) * 2;
    if (finished) this.body.rotation.x += Math.sin(t * 6) * 0.5;

    if (speed > 2) this.trailPts.push({ p: pos, t });
    while (this.trailPts.length && t - this.trailPts[0].t > 1.4) this.trailPts.shift();
    const N = this.trailN;
    while (this.trailPts.length > N) this.trailPts.shift();
    const pts = this.trailPts;
    for (let i = 0; i < N; i++) {
      const k = pts.length - N + i; // newest at the end
      const q = k >= 0 ? pts[k].p : pos;
      const age = k >= 0 ? (t - pts[k].t) / 1.4 : 1;
      const w = (1 - age) * 11;
      const nx = k >= 0 ? pts[Math.min(pts.length - 1, k + 1)].p : pos;
      const dx = nx[0] - q[0], dy = nx[1] - q[1], L = Math.hypot(dx, dy) || 1;
      const sx = -dy / L * w, sy = dx / L * w;
      this.trailPos.set([q[0] + sx, q[1] + sy, q[2] + 36, q[0] - sx, q[1] - sy, q[2] + 36], i * 6);
    }
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

function nameSprite(name: string, sponsor: string) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.font = `700 54px ${FONT}`;
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(name, 256, 58);
  g.fillStyle = '#ffffff';
  g.fillText(name, 256, 58);
  if (sponsor) {
    g.font = `34px ${FONT}`;
    g.lineWidth = 6;
    g.strokeText(sponsor, 256, 106);
    g.fillStyle = '#ffb000';
    g.fillText(sponsor, 256, 106);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(170, 42, 1);
  return s;
}

// Image textures by content hash, fetched once and shared by every glider/billboard using them.
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

export function textureFromCanvas(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  return textureFromCanvas(c);
}

const DEFAULT_FLAG = canvasTexture(128, 80, g => {
  const grad = g.createLinearGradient(0, 0, 128, 80);
  grad.addColorStop(0, '#35f0ff'); grad.addColorStop(1, '#ff2bd6');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 80);
  g.fillStyle = '#060912'; g.font = `700 40px ${FONT}`; g.textAlign = 'center'; g.fillText('SS', 64, 54);
});

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

function fit(g: CanvasRenderingContext2D, s: string, maxW: number) {
  while (s.length > 3 && g.measureText(s).width > maxW) s = s.slice(0, -2) + '…';
  return s;
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  let line = '';
  for (const w of text.split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); y += lh; line = w; } else line = t;
  }
  g.fillText(line, x, y);
}

function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
