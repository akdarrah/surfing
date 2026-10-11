// The giant: a kit-bashed robot colossus standing waist-deep in the cloud sea. Rounded cream body with blue
// panel lines, one big blue eye and a pulsing chest core. The head yaws slowly toward the leading player.
import * as THREE from 'three/webgpu';
import { time, sin, color } from 'three/tsl';
import { bake, mergeAll, upright, tmat, CREAM, BLUE, GLOW } from './gfx.ts';

type Parts = { cream: THREE.BufferGeometry; blue: THREE.BufferGeometry; core: THREE.BufferGeometry; head: THREE.BufferGeometry; headBlue: THREE.BufferGeometry; eye: THREE.BufferGeometry };
let parts: Parts | null = null;

// Everything is built for H = 1 (feet at z = 0, facing +y) and scaled per instance.
function build(): Parts {
  const cream: THREE.BufferGeometry[] = [], blue: THREE.BufferGeometry[] = [];
  const sphere = (r: number, w = 24, h = 16) => new THREE.SphereGeometry(r, w, h);
  const capsule = (r: number, l: number) => upright(new THREE.CapsuleGeometry(r, l, 6, 20));
  const ring = (r: number, t: number) => new THREE.TorusGeometry(r, t, 8, 48);

  // Pelvis and torso.
  cream.push(bake(sphere(0.09), tmat(0, 0, 0.46, 0, 0, 0, 1.3, 0.95, 0.8), CREAM));
  cream.push(bake(sphere(0.13), tmat(0, 0, 0.62, 0, 0, 0, 1.25, 0.9, 1.1), CREAM));
  blue.push(bake(ring(0.117, 0.007), tmat(0, 0, 0.46, 0, 0, 0, 1.3, 0.95, 1), BLUE));       // belt
  blue.push(bake(ring(0.16, 0.006), tmat(0, 0, 0.56, 0, 0, 0, 1.25, 0.9, 1), BLUE));        // torso seam
  blue.push(bake(ring(0.155, 0.006), tmat(0, 0, 0.69, 0, 0, 0, 1.2, 0.86, 1), BLUE));       // chest seam
  // Neck.
  cream.push(bake(upright(new THREE.CylinderGeometry(0.035, 0.04, 0.06, 16)), tmat(0, 0, 0.76), CREAM));
  blue.push(bake(ring(0.037, 0.005), tmat(0, 0, 0.775), BLUE));
  // Shoulders, arms, two-finger hands.
  for (const s of [-1, 1]) {
    cream.push(bake(sphere(0.07, 20, 14), tmat(s * 0.21, 0, 0.71), CREAM));
    blue.push(bake(ring(0.071, 0.005), tmat(s * 0.21, 0, 0.71, 0, Math.PI / 2, 0), BLUE));
    cream.push(bake(capsule(0.042, 0.15), tmat(s * 0.255, 0, 0.6, 0, s * 0.22, 0), CREAM));
    blue.push(bake(sphere(0.045, 16, 12), tmat(s * 0.275, 0.01, 0.51), BLUE));              // elbow
    cream.push(bake(capsule(0.038, 0.16), tmat(s * 0.29, 0.03, 0.42, 0.1, s * 0.08, 0), CREAM));
    blue.push(bake(ring(0.04, 0.005), tmat(s * 0.3, 0.04, 0.34), BLUE));                     // wrist
    blue.push(bake(sphere(0.046, 16, 12), tmat(s * 0.3, 0.045, 0.31, 0, 0, 0, 1, 1, 0.85), BLUE)); // palm
    for (const f of [-1, 1]) blue.push(bake(capsule(0.017, 0.05), tmat(s * 0.3 + f * 0.024, 0.055, 0.255, 0.15, 0, 0), BLUE));
  }
  // Legs and feet.
  for (const s of [-1, 1]) {
    cream.push(bake(capsule(0.052, 0.3), tmat(s * 0.09, 0, 0.26), CREAM));
    blue.push(bake(ring(0.054, 0.005), tmat(s * 0.09, 0, 0.27), BLUE));                      // knee
    blue.push(bake(sphere(0.07, 16, 12), tmat(s * 0.095, 0.02, 0.05, 0, 0, 0, 1, 1.3, 0.6), BLUE)); // foot
  }
  // Chest core.
  const core = bake(sphere(0.038, 20, 14), tmat(0, 0.115, 0.645), GLOW);
  // Head: a dome with a flattened face plate and one big eye, built around the neck pivot at z = 0.79.
  const headCream: THREE.BufferGeometry[] = [], headBlue: THREE.BufferGeometry[] = [];
  headCream.push(bake(sphere(0.088, 28, 20), tmat(0, 0, 0.07, 0, 0, 0, 1.05, 1, 0.9), CREAM));
  headBlue.push(bake(ring(0.085, 0.005), tmat(0, 0, 0.055, 0, 0, 0, 1.05, 1, 1), BLUE));     // visor seam
  headBlue.push(bake(sphere(0.012, 10, 8), tmat(0, 0, 0.16), BLUE));                        // antenna tip
  headCream.push(bake(upright(new THREE.CylinderGeometry(0.005, 0.006, 0.03, 8)), tmat(0, 0, 0.145), CREAM));
  headBlue.push(bake(sphere(0.052, 20, 14), tmat(0, 0.062, 0.075, 0, 0, 0, 1, 0.55, 1), BLUE)); // eye socket
  const eye = bake(sphere(0.04, 20, 14), tmat(0, 0.085, 0.077, 0, 0, 0, 1, 0.6, 1), GLOW);
  return { cream: mergeAll(cream)!, blue: mergeAll(blue)!, core, head: mergeAll(headCream)!, headBlue: mergeAll(headBlue)!, eye };
}

const glowMat = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  m.colorNode = color(GLOW).mul(sin(time.mul(2.2)).mul(0.25).add(0.9));
  return m;
})();

export class Giant {
  group = new THREE.Group();
  private head = new THREE.Group();
  private yaw = 0;
  private targetYaw = 0;

  constructor(H: number, far = false) {
    parts ??= build();
    const cream = far
      ? new THREE.MeshBasicNodeMaterial({ color: 0xd4c6d2, fog: false })
      : new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02 });
    const blue = far
      ? new THREE.MeshBasicNodeMaterial({ color: 0xc3b5c6, fog: false })
      : new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
    const glow = far ? new THREE.MeshBasicNodeMaterial({ color: GLOW, fog: false }) : glowMat;
    this.group.add(new THREE.Mesh(parts.cream, cream), new THREE.Mesh(parts.blue, blue), new THREE.Mesh(parts.core, glow));
    this.head.add(new THREE.Mesh(parts.head, cream), new THREE.Mesh(parts.headBlue, blue), new THREE.Mesh(parts.eye, glow));
    this.head.position.z = 0.79;
    this.group.add(this.head);
    this.group.scale.setScalar(H);
  }

  // Turn the head toward a world position (slowly, clamped so it never looks backward).
  lookAt(x: number, y: number) {
    const dx = x - this.group.position.x, dy = y - this.group.position.y;
    let a = Math.atan2(dy, dx) - Math.PI / 2 - this.group.rotation.z;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    this.targetYaw = Math.max(-1.1, Math.min(1.1, a));
  }

  tick(dt: number) {
    let d = this.targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 0.6);
    this.head.rotation.z = this.yaw;
  }
}
