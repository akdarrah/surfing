// F3 overlay (frame ms, draw calls, physics ms, heap) and adaptive render scale.
import type * as THREE from 'three/webgpu';

const WINDOW = 120;

export class Perf {
  el: HTMLElement;
  visible = false;
  physicsMs = 0;
  private frames = new Float32Array(WINDOW);
  private physics = new Float32Array(WINDOW);
  private head = 0;
  private filled = 0;
  private lastText = '';
  private lastDom = 0;
  private drawCalls = 0;
  private triangles = 0;
  // Adaptive render scale: step down while frames are slow, back up when they're comfortably fast.
  scale = 1;
  private slowSince = -1;
  private fastSince = -1;
  private lastStep = 0;
  private refresh = 0;      // estimated display interval in ms
  private refreshSamples = 0;
  private refreshMin = 1e9;
  private refreshT0 = 0;

  constructor(el: HTMLElement) { this.el = el; }

  // Record one frame; returns the new render scale if it changed, else 0.
  sample(now: number, frameMs: number, physicsMs: number) {
    this.frames[this.head] = frameMs;
    this.physics[this.head] = physicsMs;
    this.head = (this.head + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
    // Estimate the refresh interval from the fastest deltas in the first second; defaults to 60 Hz-ish if nothing fits.
    if (this.refresh === 0) {
      if (!this.refreshT0) this.refreshT0 = now;
      if (frameMs > 2) { this.refreshMin = Math.min(this.refreshMin, frameMs); this.refreshSamples++; }
      if (now - this.refreshT0 > 1000 && this.refreshSamples > 20) this.refresh = Math.max(4, Math.min(16.8, this.refreshMin));
      return 0;
    }
    const avg = this.avg(this.frames);
    const slow = avg > this.refresh * 1.6 && avg > 11;
    const fast = avg < Math.max(this.refresh * 1.1, 10);
    if (slow) { if (this.slowSince < 0) this.slowSince = now; } else this.slowSince = -1;
    if (fast) { if (this.fastSince < 0) this.fastSince = now; } else this.fastSince = -1;
    const steps = [1, 0.85, 0.7];
    const i = steps.indexOf(this.scale);
    if (now - this.lastStep > 1500) {
      if (this.slowSince >= 0 && now - this.slowSince > 1000 && i < steps.length - 1) { this.scale = steps[i + 1]; this.lastStep = now; this.slowSince = -1; return this.scale; }
      if (this.fastSince >= 0 && now - this.fastSince > 2000 && i > 0) { this.scale = steps[i - 1]; this.lastStep = now; this.fastSince = -1; return this.scale; }
    }
    return 0;
  }

  private avg(a: Float32Array) {
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += a[i];
    return this.filled ? s / this.filled : 0;
  }
  private max(a: Float32Array) {
    let m = 0;
    for (let i = 0; i < this.filled; i++) if (a[i] > m) m = a[i];
    return m;
  }

  // Snapshot the renderer counters right after the frame renders (the backend resets them between frames).
  rendered(renderer: THREE.WebGPURenderer) {
    this.drawCalls = renderer.info.render.drawCalls;
    this.triangles = renderer.info.render.triangles;
  }

  stats() {
    const mem = (performance as any).memory;
    return {
      avgMs: +this.avg(this.frames).toFixed(2),
      maxMs: +this.max(this.frames).toFixed(2),
      physicsMs: +this.avg(this.physics).toFixed(2),
      calls: this.drawCalls,
      tris: this.triangles,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      scale: this.scale,
      refresh: +this.refresh.toFixed(2),
    };
  }

  toggle() { this.visible = !this.visible; this.el.hidden = !this.visible; }

  // Update the overlay text at ~5 Hz and only when it changed.
  draw(now: number) {
    if (!this.visible || now - this.lastDom < 200) return;
    this.lastDom = now;
    const s = this.stats();
    const text = `frame ${s.avgMs.toFixed(1)} ms avg · ${s.maxMs.toFixed(1)} max\n`
      + `draws ${s.calls} · tris ${s.tris.toLocaleString()}\n`
      + `physics ${s.physicsMs.toFixed(2)} ms\n`
      + `heap ${s.heapMB === null ? 'n/a' : s.heapMB + ' MB'}\n`
      + `scale ${s.scale} · refresh ${s.refresh} ms`;
    if (text !== this.lastText) { this.el.textContent = text; this.lastText = text; }
  }
}
