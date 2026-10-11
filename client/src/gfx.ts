// Palette, canvas helpers and geometry baking shared by the renderer, boats, sky and giant.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mrt, cameraNormalMatrix, vec2, vec3 } from 'three/tsl';

// Astro-Bot direction: cream plastic, cobalt trim, warm sunset light.
export const CREAM = 0xf3efe6, BLUE = 0x2f6fe4, GLOW = 0x8ec5ff, GOLD = 0xffb84a, TEAL = 0x5fb8a8, WAKE = 0xbfe3ff, INK = 0x1d2b4a, SKY = 0xbfe0ff;
export const FONT = '"Rajdhani", "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif';

export function mulberry(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function textureFromCanvas(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  return textureFromCanvas(c);
}

export function puffTexture() {
  return canvasTexture(256, 256, g => {
    const r = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    r.addColorStop(0, 'rgba(255,255,255,0.95)'); r.addColorStop(0.45, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  });
}

// Position/rotation/scale → matrix. Rotations are Euler XYZ in radians.
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
export function tmat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}

// Y-up primitives (cylinder, capsule, cone, lathe) stood up along +Z.
export function upright<T extends THREE.BufferGeometry>(g: T): T { g.rotateX(Math.PI / 2); return g; }

// Transform a geometry, give every vertex one flat colour (and optional phase), and drop everything but
// position / normal / color (+ phase) so pieces from any primitive can be merged into one draw.
export function bake(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, phase?: number) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (geo === g) g = geo.clone();
  if (m) g.applyMatrix4(m);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.attributes.position);
  out.setAttribute('normal', g.attributes.normal);
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (phase !== undefined) {
    const ph = new Float32Array(n).fill(phase);
    out.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
  }
  return out;
}

export function mergeAll(geos: THREE.BufferGeometry[]) {
  if (!geos.length) return null;
  const g = mergeGeometries(geos, false);
  if (!g) return null;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  for (const x of geos) x.dispose();
  return g;
}

export function fit(g: CanvasRenderingContext2D, s: string, maxW: number) {
  while (s.length > 3 && g.measureText(s).width > maxW) s = s.slice(0, -2) + '…';
  return s;
}

// Transparent layers (clouds, wakes, glows) must not smear the normal/velocity MRT the AO and motion-blur passes read:
// write a flat "up" normal and zero velocity so the surface behind them keeps its shading.
// Only valid when the scene pass actually has those attachments (High quality); a material MRT with no
// `output` on a single-attachment pass renders nothing, so Low quality must leave mrtNode null.
let mrtOn = false;
export function enableMRT(on: boolean) { mrtOn = on; }
export function flatMRT() { return mrtOn ? mrt({ normal: cameraNormalMatrix.mul(vec3(0, 0, 1)), velocity: vec2(0) }) : null; }
