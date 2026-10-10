// Three.js world, built Z-up to match the Source-style physics.
import * as THREE from 'three';
import type { Level, V3 } from './physics.ts';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const HAZARD = 0xf2b705;
const FONT = 'Impact, "Arial Narrow Bold", "Arial Black", sans-serif';

export class World {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 2, 80000);
  private fx: { obj: THREE.Object3D; until: number; fade?: THREE.Material }[] = [];
  private pickups: { mesh: THREE.Object3D; weapon: number }[] = [];
  private decals = new Map<string, THREE.Object3D>();
  private hemi = new THREE.HemisphereLight(0xb4bccc, 0x4a3a30, 2.0);
  private flash = 0;
  promoSail?: { tex: THREE.CanvasTexture; canvas: HTMLCanvasElement };

  constructor(mount: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    mount.appendChild(this.renderer.domElement);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0x2a2220, 5000, 26000);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffa060, 2.6); // low, burnt-orange dusk sun
    sun.position.set(-0.7, 0.9, 0.35);
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
    const edgePts: number[] = [];
    for (const b of level.brushes) {
      for (const f of b.faces) {
        // Faint per-face shade variation keeps flat-shaded steel readable at speed.
        c.set(b.color).offsetHSL(0, 0, (f.length * 0.013) % 0.04 - 0.02);
        for (let i = 1; i + 1 < f.length; i++) for (const v of [f[0], f[i], f[i + 1]]) { pos.push(...v); col.push(c.r, c.g, c.b); }
        for (let i = 0; i < f.length; i++) edgePts.push(...f[i], ...f[(i + 1) % f.length]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide })));
    // Hazard-yellow paint on every edge.
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePts, 3));
    this.scene.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: HAZARD })));

    // Storm clouds at each lane's fall-off height, plus a dark ceiling.
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const below = new THREE.InstancedMesh(puff, new THREE.MeshLambertMaterial({ color: 0x4a4650, flatShading: true }), 1200);
    const above = new THREE.InstancedMesh(puff, new THREE.MeshLambertMaterial({ color: 0x23242b, flatShading: true }), 200);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const rnd = mulberry(7);
    let n = 0;
    for (const t of level.triggers.filter(t => t.type === 'teleport')) {
      for (let i = 0; i < 200 && n < 1200; i++, n++) {
        p.set(t.min[0] + rnd() * (t.max[0] - t.min[0]), t.min[1] + rnd() * (t.max[1] - t.min[1]), t.max[2] - 200 + rnd() * 300);
        const r = 300 + rnd() * 700;
        below.setMatrixAt(n, m.compose(p, q, sc.set(r, r, r * 0.55)));
      }
    }
    below.count = n;
    for (let i = 0; i < 200; i++) {
      p.set(-8000 + rnd() * 50000, -8000 + rnd() * 40000, 6000 + rnd() * 5000);
      const r = 900 + rnd() * 1600;
      above.setMatrixAt(i, m.compose(p, q, sc.set(r, r * 0.8, r * 0.3)));
    }
    this.scene.add(below, above);

    const colors = [0xffb000, 0xff5a1f, 0xd7261e];
    for (const t of level.triggers.filter(t => t.type === 'pickup')) {
      const k = colors[t.weapon ?? 0];
      const crate = new THREE.Mesh(new THREE.OctahedronGeometry(36), new THREE.MeshLambertMaterial({ color: k, emissive: k, emissiveIntensity: 0.6, flatShading: true }));
      crate.position.set((t.min[0] + t.max[0]) / 2, (t.min[1] + t.max[1]) / 2, (t.min[2] + t.max[2]) / 2);
      this.scene.add(crate);
      this.pickups.push({ mesh: crate, weapon: t.weapon ?? 0 });
    }

    // The winner's billboard: a giant black sail next to the first spawn.
    const sp = level.spawns[0].pos;
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const tex = new THREE.CanvasTexture(canvas);
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(1400, 700), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
    sail.position.set(sp[0] - 1100, sp[1] + 1400, sp[2] + 500);
    sail.rotation.x = Math.PI / 2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 1700), new THREE.MeshLambertMaterial({ color: 0x1c1d21 }));
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
    g.fillStyle = '#16161a';
    g.beginPath();
    g.moveTo(40, 20); g.quadraticCurveTo(560, 120, 990, 30); g.lineTo(980, 490); g.quadraticCurveTo(520, 400, 40, 490); g.closePath();
    g.fill();
    g.fillStyle = '#e8e2d0';
    g.textAlign = 'center';
    g.font = `40px ${FONT}`;
    g.fillText(p ? `${p.by.toUpperCase()} OWNS THIS SAIL` : 'WIN A ROUND', 512, 120);
    g.font = `60px ${FONT}`;
    wrap(g, p ? p.text : 'THIS SAIL IS YOURS', 512, 230, 860, 70);
    if (p?.url) { g.font = `32px ${FONT}`; g.fillStyle = '#f2b705'; g.fillText(p.url.slice(0, 48), 512, 440); }
    tex.needsUpdate = true;
  }

  showPickups(owned: boolean[], t: number) {
    for (const p of this.pickups) {
      p.mesh.visible = !owned[p.weapon];
      p.mesh.rotation.z = t * 2;
      p.mesh.position.z += Math.sin(t * 3) * 0.6;
    }
  }

  // A spray or a winner's tag, stuck flat to the surface it was aimed at.
  setDecal(key: string, tex: THREE.Texture, pos: V3, normal: V3, size: number, plate?: string[]) {
    this.removeDecal(key);
    const g = new THREE.Group();
    const at = new THREE.Vector3(...pos).addScaledVector(new THREE.Vector3(...normal), 0.6);
    g.position.copy(at);
    if (Math.abs(normal[2]) > 0.9) g.up.set(0, 1, 0);
    g.lookAt(at.clone().add(new THREE.Vector3(...normal)));
    const mat = (map: THREE.Texture | null, color = 0xffffff) => new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    // Explicit draw order: transparent layers at the same spot would otherwise sort arbitrarily.
    if (plate) {
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(size + 10, size + 10), mat(null, 0xc9971c));
      frame.renderOrder = 1;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.28), mat(plateTexture(plate)));
      label.position.y = -size * 0.68;
      label.renderOrder = 2;
      g.add(frame, label);
    }
    const img = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat(tex));
    img.renderOrder = 2;
    g.add(img);
    this.scene.add(g);
    this.decals.set(key, g);
  }

  removeDecal(key: string) {
    const d = this.decals.get(key);
    if (d) { this.scene.remove(d); this.decals.delete(key); }
  }

  decalKeys() { return [...this.decals.keys()]; }

  tracer(from: V3, to: V3, color: number, now: number) {
    const mat = new THREE.LineBasicMaterial({ color, transparent: true });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]), mat);
    this.scene.add(line);
    this.fx.push({ obj: line, until: now + 0.25, fade: mat });
  }

  puff(at: V3, size: number, now: number, color = 0x8a8a8a, life = 0.8) {
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
    // Distant lightning: rare double-flickers of the whole sky light.
    if (Math.random() < 0.0015) this.flash = 1;
    this.flash *= 0.9;
    this.hemi.intensity = 2.0 + this.flash * (Math.sin(now * 60) > 0 ? 3 : 1);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

const PUFF = new THREE.IcosahedronGeometry(1, 0);

// Image textures by content hash, fetched once and shared by every boat/decal using them.
const textures = new Map<string, Promise<THREE.Texture>>();
export function imageTexture(hash: string) {
  let t = textures.get(hash);
  if (!t) {
    t = fetch(`/img/${hash}`)
      .then(r => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then(b => createImageBitmap(b))
      .then(bmp => canvasTexture(bmp.width, bmp.height, g => g.drawImage(bmp, 0, 0)));
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

// The default banner: a crude skull and crossbones.
export const SKULL = canvasTexture(128, 80, g => {
  g.fillStyle = '#111';
  g.fillRect(0, 0, 128, 80);
  g.strokeStyle = g.fillStyle = '#e8e2d0';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(40, 22); g.lineTo(88, 66); g.moveTo(88, 22); g.lineTo(40, 66); g.stroke();
  g.beginPath(); g.arc(64, 34, 18, 0, Math.PI * 2); g.fill();
  g.fillRect(55, 44, 18, 12);
  g.fillStyle = '#111';
  g.beginPath(); g.arc(57, 33, 5, 0, Math.PI * 2); g.arc(71, 33, 5, 0, Math.PI * 2); g.fill();
});

function plateTexture(lines: string[]) {
  return canvasTexture(256, 72, g => {
    g.fillStyle = '#c9971c';
    g.fillRect(0, 0, 256, 72);
    g.fillStyle = '#16161a';
    g.textAlign = 'center';
    g.font = `26px ${FONT}`;
    g.fillText(lines[0].toUpperCase().slice(0, 22), 128, 30);
    g.font = `18px ${FONT}`;
    g.fillText(lines.slice(1).join('  ·  ').slice(0, 34), 128, 58);
  });
}

export class Boat {
  group = new THREE.Group();
  private sail: THREE.Mesh;
  private sailBase: Float32Array;
  private hull: THREE.Group;
  private flag: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private label: THREE.Sprite;

  constructor(accent: string, name: string, sponsor = '') {
    this.hull = new THREE.Group();
    // A chunky gunboat hull: a squashed, stretched half-sphere pointing +x (yaw 0), charcoal with an accent stripe.
    const hullMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x24252a, flatShading: true }));
    hullMesh.scale.set(30, 16, 22);
    hullMesh.position.z = 24;
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 4, 16), new THREE.MeshBasicMaterial({ color: accent }));
    stripe.scale.set(29, 15.5, 8);
    stripe.position.z = 20;
    const deck = new THREE.Mesh(new THREE.CircleGeometry(1, 8), new THREE.MeshLambertMaterial({ color: 0x4a3b2e }));
    deck.scale.set(30, 16, 1);
    deck.position.z = 24.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2, 78), new THREE.MeshLambertMaterial({ color: 0x1c1d21 }));
    mast.rotation.x = Math.PI / 2;
    mast.position.set(4, 0, 62);
    const sailGeo = new THREE.PlaneGeometry(40, 52, 6, 6);
    sailGeo.rotateX(Math.PI / 2);
    sailGeo.rotateZ(Math.PI / 2); // square-rigged: spans y/z, bulges forward along +x
    sailGeo.translate(6, 0, 64);
    this.sailBase = (sailGeo.attributes.position.array as Float32Array).slice();
    this.sail = new THREE.Mesh(sailGeo, new THREE.MeshLambertMaterial({ color: 0x2a2724, side: THREE.DoubleSide, flatShading: true }));
    // The banner hangs square across the masthead, facing aft so whoever is chasing you reads it right way round.
    const flagGeo = new THREE.PlaneGeometry(44, 27);
    flagGeo.rotateX(Math.PI / 2);
    flagGeo.rotateZ(-Math.PI / 2);
    this.flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ map: SKULL, side: THREE.DoubleSide }));
    this.flag.position.set(5, 0, 106);
    this.hull.add(hullMesh, stripe, deck, mast, this.sail, this.flag);
    this.label = nameSprite(name, sponsor);
    this.label.position.z = 134;
    this.group.add(this.hull, this.label);
  }

  setName(name: string, sponsor = '') {
    this.group.remove(this.label);
    this.label = nameSprite(name, sponsor);
    this.label.position.z = 134;
    this.group.add(this.label);
  }

  setFlag(tex: THREE.Texture | null) {
    this.flag.material.map = tex ?? SKULL;
    this.flag.material.needsUpdate = true;
  }

  // speed drives how hard the sail billows and the banner flaps; roll leans the boat into the ramp.
  pose(pos: V3, yaw: number, speed: number, roll: number, t: number, sunk = false) {
    this.group.position.set(...pos);
    this.hull.rotation.set(sunk ? 2.5 : roll, 0, yaw);
    this.flag.rotation.x = Math.sin(t * (3 + speed / 400)) * 0.12;
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

function nameSprite(name: string, sponsor: string) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.lineWidth = 8;
  g.strokeStyle = '#000';
  g.font = `52px ${FONT}`;
  g.strokeText(name, 256, 58);
  g.fillStyle = '#f4f1e8';
  g.fillText(name, 256, 58);
  if (sponsor) {
    g.font = `34px ${FONT}`;
    g.lineWidth = 6;
    g.strokeText(`[${sponsor}]`, 256, 106);
    g.fillStyle = '#ffb000';
    g.fillText(`[${sponsor}]`, 256, 106);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: textureFromCanvas(c), depthTest: false }));
  s.scale.set(160, 40, 1);
  return s;
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0d1016');
  grad.addColorStop(0.45, '#1f1d24');
  grad.addColorStop(0.62, '#3a2a2a');
  grad.addColorStop(0.75, '#b8532a');
  grad.addColorStop(1, '#2a2220');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  return textureFromCanvas(c);
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
