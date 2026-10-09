// Three.js world, built Z-up to match the Source-style physics.
import * as THREE from 'three';
import type { Level, V3 } from './physics.ts';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class World {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 2, 80000);
  private fx: { obj: THREE.Object3D; until: number; fade?: THREE.Material }[] = [];
  private pickups: { mesh: THREE.Object3D; weapon: number }[] = [];
  promoSail?: { tex: THREE.CanvasTexture; canvas: HTMLCanvasElement };

  constructor(mount: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    mount.appendChild(this.renderer.domElement);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0xcfe8ff, 6000, 30000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c8ff, 2.2));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(sun);
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  buildLevel(level: Level) {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const edges = new THREE.Group();
    for (const b of level.brushes) {
      for (const f of b.faces) {
        // Faint per-face shade variation keeps flat-shaded surfaces readable at speed.
        c.set(b.color).offsetHSL(0, 0, (f.length * 0.013) % 0.04 - 0.02);
        for (let i = 1; i + 1 < f.length; i++) for (const v of [f[0], f[i], f[i + 1]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
        // Candy-stripe outlines on every edge.
        const pts = [...f, f[0]].map(v => new THREE.Vector3(...v));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff8fab }));
        edges.add(line);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide })));
    this.scene.add(edges);

    // A sea of clouds at each lane's fall-off height, plus a few high ones.
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const clouds = new THREE.InstancedMesh(puff, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 1400);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    let n = 0;
    const rnd = mulberry(7);
    for (const t of level.triggers.filter(t => t.type === 'teleport')) {
      for (let i = 0; i < 200 && n < 1300; i++, n++) {
        p.set(t.min[0] + rnd() * (t.max[0] - t.min[0]), t.min[1] + rnd() * (t.max[1] - t.min[1]), t.max[2] - 200 + rnd() * 300);
        const r = 300 + rnd() * 700;
        sc.set(r, r, r * 0.55);
        clouds.setMatrixAt(n, m.compose(p, q, sc));
      }
    }
    for (; n < 1400; n++) {
      p.set(-8000 + rnd() * 50000, -8000 + rnd() * 40000, 5000 + rnd() * 6000);
      const r = 400 + rnd() * 900;
      clouds.setMatrixAt(n, m.compose(p, q, sc.set(r, r * 0.7, r * 0.4)));
    }
    this.scene.add(clouds);

    const colors = [0x9b5de5, 0xf15bb5, 0x00bbf9];
    for (const t of level.triggers.filter(t => t.type === 'pickup')) {
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(36), new THREE.MeshLambertMaterial({ color: colors[t.weapon ?? 0], emissive: colors[t.weapon ?? 0], emissiveIntensity: 0.4, flatShading: true }));
      gem.position.set((t.min[0] + t.max[0]) / 2, (t.min[1] + t.max[1]) / 2, (t.min[2] + t.max[2]) / 2);
      this.scene.add(gem);
      this.pickups.push({ mesh: gem, weapon: t.weapon ?? 0 });
    }

    // The winner's billboard: a giant sail next to the first spawn.
    const sp = level.spawns[0].pos;
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const tex = new THREE.CanvasTexture(canvas);
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(1400, 700), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
    sail.position.set(sp[0] - 1100, sp[1] + 1400, sp[2] + 500);
    sail.rotation.x = Math.PI / 2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 1700), new THREE.MeshLambertMaterial({ color: 0x8d6e63 }));
    mast.rotation.x = Math.PI / 2;
    mast.position.set(sp[0] - 1100, sp[1] + 1410, sp[2] + 200);
    this.scene.add(sail, mast);
    this.promoSail = { tex, canvas };
    this.setPromo(null);
  }

  setPromo(p: { text: string; url?: string; by: string } | null) {
    if (!this.promoSail) return;
    const { canvas, tex } = this.promoSail;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fffaf0';
    g.beginPath();
    g.moveTo(40, 20); g.quadraticCurveTo(560, 120, 990, 30); g.lineTo(980, 490); g.quadraticCurveTo(520, 400, 40, 490); g.closePath();
    g.fill();
    g.fillStyle = '#3d2c8d';
    g.textAlign = 'center';
    g.font = 'bold 40px "Comic Sans MS", "Chalkboard SE", sans-serif';
    g.fillText(p ? `🏆 ${p.by} says:` : 'WIN A ROUND TO', 512, 120);
    g.font = 'bold 54px "Comic Sans MS", "Chalkboard SE", sans-serif';
    wrap(g, p ? p.text : 'PAINT THIS SAIL', 512, 220, 880, 64);
    if (p?.url) { g.font = '32px monospace'; g.fillStyle = '#f15bb5'; g.fillText(p.url.slice(0, 48), 512, 440); }
    tex.needsUpdate = true;
  }

  showPickups(owned: boolean[], t: number) {
    for (const p of this.pickups) {
      p.mesh.visible = !owned[p.weapon];
      p.mesh.rotation.z = t * 2;
      p.mesh.position.z += Math.sin(t * 3) * 0.6;
    }
  }

  tracer(from: V3, to: V3, color: number, now: number) {
    const mat = new THREE.LineBasicMaterial({ color, transparent: true });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]), mat);
    this.scene.add(line);
    this.fx.push({ obj: line, until: now + 0.25, fade: mat });
  }

  puff(at: V3, size: number, now: number, color = 0xffffff, life = 0.8) {
    const mat = new THREE.MeshLambertMaterial({ color, transparent: true, flatShading: true });
    const m = new THREE.Mesh(PUFF, mat);
    m.position.set(...at);
    m.scale.setScalar(size);
    this.scene.add(m);
    this.fx.push({ obj: m, until: now + life, fade: mat });
  }

  tickFx(now: number) {
    this.fx = this.fx.filter(f => {
      const left = f.until - now;
      if (left <= 0) { this.scene.remove(f.obj); f.fade?.dispose(); return false; }
      if (f.fade) (f.fade as THREE.Material & { opacity: number }).opacity = Math.min(1, left * 3);
      f.obj.scale.multiplyScalar(1.01);
      return true;
    });
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

const PUFF = new THREE.IcosahedronGeometry(1, 0);

export class Boat {
  group = new THREE.Group();
  private sail: THREE.Mesh;
  private sailBase: Float32Array;
  private hull: THREE.Group;
  private label: THREE.Sprite;

  constructor(color: string, name: string) {
    this.hull = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color, flatShading: true });
    // A chunky little hull: a squashed, stretched half-sphere, pointing +x (yaw 0).
    const hullMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), wood);
    hullMesh.scale.set(30, 16, 22);
    hullMesh.position.z = 24;
    const deck = new THREE.Mesh(new THREE.CircleGeometry(1, 8), new THREE.MeshLambertMaterial({ color: 0xf4d6a0 }));
    deck.scale.set(30, 16, 1);
    deck.position.z = 24.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2, 70), new THREE.MeshLambertMaterial({ color: 0x6d4c41 }));
    mast.rotation.x = Math.PI / 2;
    mast.position.set(4, 0, 58);
    const sailGeo = new THREE.PlaneGeometry(40, 52, 6, 6);
    sailGeo.rotateX(Math.PI / 2);
    sailGeo.rotateZ(Math.PI / 2); // square-rigged: spans y/z, bulges forward along +x
    sailGeo.translate(6, 0, 64);
    this.sailBase = (sailGeo.attributes.position.array as Float32Array).slice();
    this.sail = new THREE.Mesh(sailGeo, new THREE.MeshLambertMaterial({ color: 0xfffaf0, side: THREE.DoubleSide, flatShading: true }));
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(12, 7), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    flag.rotation.x = Math.PI / 2;
    flag.position.set(-2, 0, 96);
    this.hull.add(hullMesh, deck, mast, this.sail, flag);
    this.label = nameSprite(name);
    this.label.position.z = 120;
    this.group.add(this.hull, this.label);
  }

  setName(name: string) {
    this.group.remove(this.label);
    this.label = nameSprite(name);
    this.label.position.z = 120;
    this.group.add(this.label);
  }

  // speed drives how hard the sail billows; roll leans the boat into the ramp.
  pose(pos: V3, yaw: number, speed: number, roll: number, t: number, sunk = false) {
    this.group.position.set(...pos);
    this.hull.rotation.set(sunk ? 2.5 : roll, 0, yaw);
    const a = this.sail.geometry.attributes.position;
    const arr = a.array as Float32Array;
    const billow = Math.min(18, 4 + speed / 120);
    for (let i = 0; i < arr.length; i += 3) {
      const y = this.sailBase[i + 1], z = this.sailBase[i + 2];
      const u = (y + 20) / 40, v = (z - 38) / 52;
      arr[i] = this.sailBase[i] + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * billow * (1 + 0.1 * Math.sin(t * 9 + v * 4));
    }
    a.needsUpdate = true;
  }
}

function nameSprite(name: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 30px "Comic Sans MS", "Chalkboard SE", sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(40,30,80,0.8)';
  g.strokeText(name, 128, 42);
  g.fillStyle = '#fff';
  g.fillText(name, 128, 42);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(120, 30, 1);
  return s;
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#7ec8ff');
  grad.addColorStop(0.55, '#cfe8ff');
  grad.addColorStop(1, '#ffd6e8');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  return new THREE.CanvasTexture(c);
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
