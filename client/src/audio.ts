// All sound is synthesized with Web Audio: no assets, no licensing. Starts on the first user gesture.
export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private wind!: { gain: GainNode; filter: BiquadFilterNode };
  private slide!: { gain: GainNode; filter: BiquadFilterNode };
  private musicOn = false;
  private musicIntensity = 0;
  private nextBeat = 0;
  private beat = 0;
  private timer = 0;
  volumes = { sfx: Number(localStorage.getItem('vol.sfx') ?? 0.8), music: Number(localStorage.getItem('vol.music') ?? 0.5) };

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicBus.connect(this.master);
    this.setVolumes();

    const noise = this.noiseSource();
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 300; wf.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = 0;
    noise.connect(wf).connect(wg).connect(this.sfx);
    this.wind = { gain: wg, filter: wf };

    const noise2 = this.noiseSource();
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass'; sf.frequency.value = 1800; sf.Q.value = 1.2;
    const sg = ctx.createGain(); sg.gain.value = 0;
    noise2.connect(sf).connect(sg).connect(this.sfx);
    this.slide = { gain: sg, filter: sf };

    this.musicOn = true;
    this.nextBeat = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.scheduleMusic(), 100);
  }

  setVolumes() {
    if (!this.ctx) return;
    this.sfx.gain.value = this.volumes.sfx;
    this.musicBus.gain.value = this.volumes.music * 0.5;
    localStorage.setItem('vol.sfx', String(this.volumes.sfx));
    localStorage.setItem('vol.music', String(this.volumes.music));
  }

  private noiseSource() {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.start();
    return src;
  }

  // Called every frame with the player's state. speed in u/s.
  update(speed: number, sliding: boolean, racing: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, speed / 2500);
    this.wind.gain.gain.setTargetAtTime(k * k * 0.9, t, 0.08);
    this.wind.filter.frequency.setTargetAtTime(250 + k * 1400, t, 0.1);
    this.slide.gain.gain.setTargetAtTime(sliding ? 0.08 + k * 0.25 : 0, t, 0.05);
    this.slide.filter.frequency.setTargetAtTime(900 + k * 2200, t, 0.1);
    this.musicIntensity += ((racing ? 0.35 + k * 0.65 : 0.15) - this.musicIntensity) * 0.02;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'square', gain = 0.2, slideTo?: number, bus: GainNode = this.sfx) {
    const ctx = this.ctx; if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g).connect(bus);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  touchdown() { this.tone(180, 0.12, 'sawtooth', 0.15, 90); }
  liftoff() { this.tone(400, 0.25, 'sine', 0.12, 900); }
  boost() { this.tone(220, 0.6, 'sawtooth', 0.25, 1400); }
  gate() { this.tone(880, 0.18, 'triangle', 0.25); setTimeout(() => this.tone(1320, 0.25, 'triangle', 0.2), 90); }
  fail() { this.tone(160, 0.5, 'sawtooth', 0.25, 50); }
  countdown(final = false) { this.tone(final ? 880 : 440, final ? 0.5 : 0.15, 'square', 0.25); }
  finish() { for (const [f, d] of [[523, 0], [659, 120], [784, 240], [1046, 360]] as const) setTimeout(() => this.tone(f, 0.6, 'triangle', 0.25), d); }
  fanfare() { for (const [f, d] of [[392, 0], [523, 150], [659, 300], [784, 450], [1046, 600]] as const) setTimeout(() => this.tone(f, 0.8, 'square', 0.18), d); }
  claim() { this.tone(660, 0.4, 'triangle', 0.25, 1320); }
  whoosh() { this.tone(300, 0.3, 'sine', 0.1, 120); }

  // A generative synthwave bed: 110 BPM, saw bass arpeggio on a i–VI–III–VII loop, a pad, and a kick when racing.
  private scheduleMusic() {
    const ctx = this.ctx; if (!ctx || !this.musicOn) return;
    const bpm = 110, step = 60 / bpm / 2;
    while (this.nextBeat < ctx.currentTime + 0.3) {
      const t = this.nextBeat, b = this.beat;
      const chords = [[55, 65.4, 82.4], [43.7, 55, 65.4], [49, 61.7, 73.4], [41.2, 49, 61.7]];
      const chord = chords[Math.floor(b / 16) % 4];
      const bass = chord[b % 3] * (b % 4 === 2 ? 2 : 1);
      const inten = this.musicIntensity;
      this.noteAt(t, bass, step * 0.9, 'sawtooth', 0.07 + inten * 0.1, 400 + inten * 2200);
      if (b % 16 === 0) for (const f of chord) this.noteAt(t, f * 4, step * 16, 'triangle', 0.025 + inten * 0.02, 1200);
      if (inten > 0.3 && b % 4 === 0) this.kickAt(t, 0.25 * inten);
      if (inten > 0.5 && b % 4 === 2) this.noteAt(t, 6000, 0.05, 'square', 0.02 * inten, 8000);
      this.nextBeat += step;
      this.beat++;
    }
  }

  private noteAt(t: number, freq: number, dur: number, type: OscillatorType, gain: number, cutoff: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = type; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.musicBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private kickAt(t: number, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(this.musicBus);
    o.start(t); o.stop(t + 0.3);
  }
}
