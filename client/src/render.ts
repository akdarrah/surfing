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

export type WallInfo = { id: number; hash: string; name: string; at?: number };
type WallMesh = { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; frame: THREE.Mesh; pos: V3; yaw: number; w: number; h: number; name: string };

export class World {
  renderer: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 4, 400000);
  high: boolean;
  private pipeline: THREE.RenderPipeline | null = null;
  private uBlur = uniform(0);
  private uCA = uniform(0);
  private fx: { obj: THREE.Object3D; until: number; mat: THREE.Material; vel?: V3 }[] = [];
  private walls = new Map<number, WallMesh>();
  private decals = new Map<string, THREE.Object3D>();
  private drifters: { obj: THREE.Object3D; vel: V3; phase: number; kind: 'cloud' | 'whale' | 'bird' | 'wisp' }[] = [];
  private wind: THREE.LineSegments | null = null;
  private windPos: Float32Array | null = null;
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

    for (const w of (json as any).walls ?? []) this.makeWall(w.id, w.name, w.pos, w.yaw, w.w, w.h);
    for (const id of this.walls.keys()) this.setWall(id, null);
    for (const p of props) if (p.type === 'beacon') {
      const b = new THREE.Mesh(new THREE.OctahedronGeometry(60), new THREE.MeshBasicNodeMaterial({ color: MAGENTA }));
      b.position.set(p.pos[0], p.pos[1], p.pos[2]);
      this.scene.add(b);
      this.gates.push(b);
    }
    this.buildSky(json);
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
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 30, h + 30), new THREE.MeshStandardNodeMaterial({ color: 0x2a3140, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }));
    frame.position.z = -1;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(10, 12, h * 1.2), new THREE.MeshStandardNodeMaterial({ color: 0x3a4455, metalness: 0.3, roughness: 0.4 }));
    post.rotation.x = Math.PI / 2;
    post.position.set(pos[0], pos[1], pos[2] - h * 0.6 - 60);
    group.add(mesh, frame);
    this.scene.add(group, post);
    this.walls.set(id, { mesh, canvas, tex, frame, pos, yaw, w, h, name });
  }

  wallInfo(id: number) { return this.walls.get(id); }

  // Paint a spray wall: empty = bare panel inviting a spray; painted = the owner's spray with a small tag.
  setWall(id: number, w: WallInfo | null, img?: ImageBitmap | null) {
    const wall = this.walls.get(id);
    if (!wall) return;
    const { canvas, tex } = wall;
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    // Brushed metal panel.
    g.fillStyle = '#4c5566';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 40; i++) g.fillRect((i * 173) % W, (i * 97) % H, 60 + (i * 37) % 200, 2);
    g.textAlign = 'center';
    if (!w || !img) {
      g.setLineDash([24, 16]); g.lineWidth = 8; g.strokeStyle = '#35f0ff';
      g.strokeRect(30, 30, W - 60, H - 60);
      g.setLineDash([]);
      g.fillStyle = 'rgba(53,240,255,0.9)';
      g.font = `700 ${Math.round(H * 0.22)}px ${FONT}`;
      g.fillText('SPRAY HERE', W / 2, H * 0.5);
      g.font = `${Math.round(H * 0.11)}px ${FONT}`;
      g.fillStyle = '#eef2f7';
      g.fillText(`${wall.name.toUpperCase()}  ·  PRESS T`, W / 2, H * 0.68);
      sprayCan(g, W / 2, H * 0.86, H * 0.09);
      tex.needsUpdate = true;
      return;
    }
    // Owner's spray, contain-fit, with paint drips and a stencil tag.
    const side = Math.min(W, H) * 0.92;
    const x = (W - side) / 2, y = (H - side) / 2 - H * 0.04;
    g.drawImage(img, x, y, side, side);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, H - H * 0.16, W, H * 0.16);
    g.fillStyle = '#ffffff';
    g.font = `700 ${Math.round(H * 0.1)}px ${FONT}`;
    g.fillText(fit(g, w.name.toUpperCase(), W * 0.8), W / 2, H - H * 0.045);
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

  // --- sky: clouds below and above, floating rocks, distant megastructures, a moon, birds, and the big ones --------
  private buildSky(json: LevelJSON) {
    const rnd = mulberry(11);
    let lo = Infinity, hi = -Infinity;
    for (const b of json.brushes) for (const v of b.verts) { lo = Math.min(lo, v[2]); hi = Math.max(hi, v[2]); }
    const seaZ = lo - 4000;

    // Cloud sea: big soft puffs drifting slowly, plus a dense deck far below.
    const puffTex = puffTexture();
    const cloudMat = new THREE.SpriteNodeMaterial({ map: puffTex, transparent: true, opacity: 0.85, depthWrite: false, color: 0xf4e4e8 });
    for (let i = 0; i < 520; i++) {
      const sp = new THREE.Sprite(cloudMat);
      const r = 1800 + rnd() * 3200;
      sp.scale.set(r, r * 0.42, 1);
      sp.position.set(-30000 + rnd() * 60000, -36000 + rnd() * 72000, seaZ - 600 + rnd() * 2200 + (rnd() < 0.08 ? 6000 : 0));
      this.scene.add(sp);
      this.drifters.push({ obj: sp, vel: [30 + rnd() * 40, 10 - rnd() * 20, 0], phase: rnd() * 7, kind: 'cloud' });
    }
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(240000, 240000), new THREE.MeshBasicNodeMaterial({ color: 0xd9c6cc, transparent: true, opacity: 0.9, map: deckTexture() }));
    deck.position.z = seaZ - 2600;
    this.scene.add(deck);
    // Thin wisps above the course that the Launch gap flies through.
    const wispMat = new THREE.SpriteNodeMaterial({ map: puffTex, transparent: true, opacity: 0.22, depthWrite: false, color: 0xffffff });
    for (let i = 0; i < 90; i++) {
      const sp = new THREE.Sprite(wispMat);
      const r = 4000 + rnd() * 6000;
      sp.scale.set(r, r * 0.18, 1);
      sp.position.set(-20000 + rnd() * 40000, -26000 + rnd() * 52000, hi + 2500 + rnd() * 7000);
      this.scene.add(sp);
      this.drifters.push({ obj: sp, vel: [60 + rnd() * 60, 0, 0], phase: rnd() * 7, kind: 'wisp' });
    }

    // Floating rocks with mossy tops; a few carry beacons.
    const rockMat = new THREE.MeshStandardNodeMaterial({ color: 0x4b4650, roughness: 0.95, flatShading: true });
    const mossMat = new THREE.MeshStandardNodeMaterial({ color: 0x4f8a5a, roughness: 1, flatShading: true });
    for (let i = 0; i < 44; i++) {
      const size = 300 + rnd() * 900;
      const geo = new THREE.IcosahedronGeometry(size, 1);
      const pa = geo.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pa.count; k++) pa.setXYZ(k, pa.getX(k) * (0.7 + rnd() * 0.6), pa.getY(k) * (0.7 + rnd() * 0.6), pa.getZ(k) * (0.5 + rnd() * 0.5));
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.set(-16000 + rnd() * 32000, -28000 + rnd() * 56000, lo + rnd() * (hi - lo));
      rock.castShadow = rock.receiveShadow = true;
      const moss = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.8, size * 0.9, size * 0.12, 7), mossMat);
      moss.rotation.x = Math.PI / 2;
      moss.position.z = size * 0.5;
      rock.add(moss);
      // Roots dangling below.
      for (let r = 0; r < 3; r++) {
        const root = new THREE.Mesh(new THREE.CylinderGeometry(4, 14, size * (1 + rnd())), rockMat);
        root.rotation.x = Math.PI / 2 + (rnd() - 0.5) * 0.4;
        root.position.set((rnd() - 0.5) * size, (rnd() - 0.5) * size, -size * (0.8 + rnd() * 0.6));
        rock.add(root);
      }
      this.scene.add(rock);
      this.drifters.push({ obj: rock, vel: [0, 0, 0], phase: rnd() * 7, kind: 'cloud' });
    }

    // Distant megastructures on the horizon with blinking lights.
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, d = 90000 + rnd() * 60000, h = 40000 + rnd() * 50000;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1800 + rnd() * 2500, 2600 + rnd() * 3000, h, 10), new THREE.MeshStandardNodeMaterial({ color: 0x1b2030, roughness: 0.8, metalness: 0.2 }));
      col.rotation.x = Math.PI / 2;
      col.position.set(Math.cos(a) * d, Math.sin(a) * d, seaZ - 20000 + h / 2);
      this.scene.add(col);
      for (let k = 0; k < 5; k++) {
        const light = new THREE.Mesh(new THREE.SphereGeometry(260), new THREE.MeshBasicNodeMaterial({ color: k % 2 ? 0xff3b3b : CYAN }));
        light.position.set(col.position.x, col.position.y, seaZ - 20000 + h * (0.45 + k * 0.13));
        this.scene.add(light);
        this.gates.push(light);
      }
    }

    // Moon.
    const moon = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: moonTexture(), transparent: true, depthWrite: false, fog: false }));
    moon.scale.set(46000, 46000, 1);
    moon.position.set(120000, 230000, 90000);
    this.scene.add(moon);

    // The big ones: sky leviathans cruising the cloud sea, slow as weather. Megalophobia bait.
    for (let i = 0; i < 4; i++) {
      const L = 14000 + rnd() * 12000;
      const whale = leviathan(L, rnd);
      const a = rnd() * Math.PI * 2;
      whale.position.set(-20000 + rnd() * 40000, -30000 + rnd() * 60000, seaZ - 1200 + rnd() * 3000 - (i === 0 ? 0 : 0));
      whale.rotation.z = a;
      this.scene.add(whale);
      this.drifters.push({ obj: whale, vel: [Math.cos(a) * 140, Math.sin(a) * 140, 0], phase: rnd() * 7, kind: 'whale' });
    }
    // One colossus standing in the clouds on the horizon, a silhouette the size of a weather system.
    this.scene.add(colossus(seaZ));

    // Birds: a flock circling under the course.
    const birdGeo = new THREE.BufferGeometry();
    birdGeo.setAttribute('position', new THREE.Float32BufferAttribute([-40, 0, 0, 0, 0, 12, 40, 0, 0, 0, -22, -2, 0, 22, -2, 0, 0, 12], 3));
    const birds = new THREE.InstancedMesh(birdGeo, new THREE.MeshBasicNodeMaterial({ color: 0x0c0f14, side: THREE.DoubleSide }), 36);
    (birds as any).__center = [json.spawns[1]?.pos[0] ?? 0, json.spawns[1]?.pos[1] ?? 0, (json.spawns[1]?.pos[2] ?? 0) - 2500];
    this.scene.add(birds);
    this.drifters.push({ obj: birds, vel: [0, 0, 0], phase: 0, kind: 'bird' });

    // Wind streaks around the camera, stretched by speed.
    const N = 160;
    this.windPos = new Float32Array(N * 6);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(this.windPos, 3));
    this.wind = new THREE.LineSegments(wg, new THREE.LineBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.wind.frustumCulled = false;
    this.scene.add(this.wind);
  }

  // Called per frame: drift clouds and leviathans, flap birds, blow wind past the camera.
  tickSky(now: number, dt: number, speed: number, vel: V3) {
    const camp = this.camera.position;
    for (const d of this.drifters) {
      const o = d.obj;
      if (d.kind === 'cloud' || d.kind === 'wisp') {
        o.position.x += d.vel[0] * dt; o.position.y += d.vel[1] * dt;
        if (o.position.x > 34000) o.position.x = -34000;
        if (d.kind === 'cloud' && !(o as any).isSprite) o.position.z += Math.sin(now * 0.3 + d.phase) * 0.4;
      } else if (d.kind === 'whale') {
        o.position.x += d.vel[0] * dt; o.position.y += d.vel[1] * dt;
        o.position.z += Math.sin(now * 0.25 + d.phase) * 2.5;
        if (Math.hypot(o.position.x, o.position.y) > 46000) { o.rotation.z += Math.PI; d.vel = [-d.vel[0], -d.vel[1], 0]; }
        const tail = o.getObjectByName('tail');
        if (tail) tail.rotation.y = Math.sin(now * 0.6 + d.phase) * 0.25;
      } else if (d.kind === 'bird') {
        const im = o as THREE.InstancedMesh;
        const c = (im as any).__center as V3;
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
        for (let i = 0; i < im.count; i++) {
          const a = now * 0.35 + i * 0.37, r = 1500 + (i % 7) * 260;
          p.set(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2] + Math.sin(now + i) * 200 + (i % 5) * 120);
          q.setFromEuler(new THREE.Euler(Math.sin(now * 9 + i) * 0.5, 0, a + Math.PI / 2));
          im.setMatrixAt(i, m.compose(p, q, sc));
        }
        im.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.wind && this.windPos) {
      const k = Math.max(0, (speed - 700) / 2500);
      const len = 30 + k * 400;
      for (let i = 0; i < this.windPos.length / 6; i++) {
        const o = i * 6;
        // Respawn streaks that fell behind; keep them in a box around the camera.
        if (this.windPos[o] === 0 || Math.abs(this.windPos[o] - camp.x) > 900 || Math.abs(this.windPos[o + 1] - camp.y) > 900 || Math.abs(this.windPos[o + 2] - camp.z) > 900) {
          this.windPos[o] = camp.x + (Math.random() - 0.5) * 1600 + vel[0] * 0.5;
          this.windPos[o + 1] = camp.y + (Math.random() - 0.5) * 1600 + vel[1] * 0.5;
          this.windPos[o + 2] = camp.z + (Math.random() - 0.5) * 1200 + vel[2] * 0.5;
        }
        const vl = Math.max(1, Math.hypot(vel[0], vel[1], vel[2]));
        this.windPos[o + 3] = this.windPos[o] - vel[0] / vl * len;
        this.windPos[o + 4] = this.windPos[o + 1] - vel[1] / vl * len;
        this.windPos[o + 5] = this.windPos[o + 2] - vel[2] / vl * len;
      }
      (this.wind.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.wind.material as any).opacity = Math.min(0.5, k * 0.6);
    }
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
    void now;
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


function puffTexture() {
  return canvasTexture(256, 256, g => {
    const r = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    r.addColorStop(0, 'rgba(255,255,255,0.95)'); r.addColorStop(0.45, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  });
}

function deckTexture() {
  const t = canvasTexture(512, 512, g => {
    const rnd = mulberry(5);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i++) {
      const r = 10 + rnd() * 60;
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, 'rgba(190,170,180,0.35)'); grad.addColorStop(1, 'rgba(190,170,180,0)');
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
    r.addColorStop(0, 'rgba(236,230,240,1)'); r.addColorStop(0.85, 'rgba(206,196,216,0.9)'); r.addColorStop(1, 'rgba(206,196,216,0)');
    g.fillStyle = r; g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(120,110,140,0.25)';
    for (const [x, y, s] of [[90, 100, 22], [150, 80, 14], [160, 150, 28], [100, 170, 12]]) { g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill(); }
  });
}

// A sky leviathan: a long, smooth body with pectoral fins and a tail fluke. Dark against the clouds, lit from above.
function leviathan(L: number, rnd: () => number) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardNodeMaterial({ color: 0x1a2130, roughness: 0.85, metalness: 0.05, flatShading: false });
  const belly = new THREE.MeshStandardNodeMaterial({ color: 0x5a6a86, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skin);
  body.scale.set(L / 2, L / 7, L / 8);
  const under = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), belly);
  under.scale.set(L / 2.1, L / 7.5, L / 9);
  under.position.z = -L / 60;
  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
  head.scale.set(L / 7, L / 7.5, L / 9);
  head.position.x = L / 2.4;
  const finGeo = new THREE.ConeGeometry(L / 14, L / 3.2, 6);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(finGeo, skin);
    fin.rotation.x = s * Math.PI / 2;
    fin.rotation.z = s * -0.5;
    fin.position.set(L / 8, s * L / 7, -L / 40);
    fin.scale.set(0.5, 1, 1.4);
    g.add(fin);
  }
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.x = -L / 2.1;
  for (const s of [-1, 1]) {
    const fluke = new THREE.Mesh(finGeo, skin);
    fluke.rotation.z = Math.PI / 2 + s * 0.6;
    fluke.position.set(-L / 10, s * L / 8, 0);
    fluke.scale.set(0.35, 1.1, 1.2);
    tail.add(fluke);
  }
  const eye = new THREE.Mesh(new THREE.SphereGeometry(L / 120), new THREE.MeshBasicNodeMaterial({ color: 0xffd27a }));
  for (const s of [-1, 1]) { const e = eye.clone(); e.position.set(L / 2.2, s * L / 11, L / 40); g.add(e); }
  // Bioluminescent lines along the flank.
  for (let i = 0; i < 9; i++) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(L / 160), new THREE.MeshBasicNodeMaterial({ color: CYAN }));
    for (const s of [-1, 1]) { const d = dot.clone(); d.position.set(L / 2.6 - i * L / 10, s * L / 7.3, 0); g.add(d); }
  }
  g.add(body, under, head, tail);
  void rnd;
  return g;
}

// A colossus wading in the cloud sea on the horizon: head, shoulders and one raised arm, pure silhouette in the haze.
function colossus(seaZ: number) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x141821, roughness: 1 });
  const H = 70000;
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.12, H * 0.16, H * 0.5, 9), mat);
  torso.rotation.x = Math.PI / 2;
  torso.position.z = H * 0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.085, 10, 8), mat);
  head.position.z = H * 0.56;
  const shoulderL = new THREE.Mesh(new THREE.SphereGeometry(H * 0.08, 8, 6), mat);
  shoulderL.position.set(-H * 0.17, 0, H * 0.47);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = H * 0.17;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.04, H * 0.05, H * 0.5, 8), mat);
  arm.position.set(H * 0.22, 0, H * 0.66);
  arm.rotation.z = -0.25;
  arm.rotation.x = Math.PI / 2;
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(H * 0.012), new THREE.MeshBasicNodeMaterial({ color: 0xff3b3b, fog: false }));
  eyeL.position.set(-H * 0.03, -H * 0.07, H * 0.57);
  const eyeR = eyeL.clone(); eyeR.position.x = H * 0.03;
  g.add(torso, head, shoulderL, shoulderR, arm, eyeL, eyeR);
  g.position.set(-150000, 170000, seaZ - H * 0.12);
  g.rotation.z = -0.6;
  return g;
}

// A little spray-can glyph for empty walls.
function sprayCan(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.fillStyle = '#eef2f7';
  g.fillRect(x - r * 0.5, y - r, r, r * 2);
  g.fillStyle = '#ff2bd6';
  g.fillRect(x - r * 0.5, y - r * 1.5, r, r * 0.5);
  g.fillStyle = '#35f0ff';
  g.fillRect(x - r * 0.15, y - r * 1.8, r * 0.3, r * 0.3);
  g.fillStyle = 'rgba(53,240,255,0.5)';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(x + r * (0.9 + i * 0.35), y - r * (1.7 + Math.sin(i) * 0.3), r * (0.12 + i * 0.05), 0, Math.PI * 2); g.fill(); }
}
