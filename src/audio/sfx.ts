// Small synthesized sound kit (no audio files): club strikes, landings, cup rattle, splash,
// crowd reactions, an outdoor ambience bed and background music. Three buses (effects, ambience,
// music) feed one output, each with its own volume from Settings.
export interface Volumes {
  master: number;
  effects: number;
  ambience: number;
  music: number;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  /** Effects bus (strikes, landings, crowd…). */
  private master: GainNode | null = null;
  private out: GainNode | null = null;
  private amb: GainNode | null = null;
  musicBus: GainNode | null = null;
  private vol: Volumes = { master: 0.7, effects: 0.8, ambience: 0.5, music: 0.5 };
  private ambience: AudioBufferSourceNode | null = null;
  /** Per-course ambience layers (surf, wind) and the rain bed. */
  private layers: { src: AudioBufferSourceNode; gain: GainNode; lfo?: OscillatorNode }[] = [];
  private rainLayer: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private birdRate = 1;
  enabled = true;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.out = this.ctx.createGain();
        this.out.connect(this.ctx.destination);
        this.master = this.ctx.createGain();
        this.amb = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        for (const b of [this.master, this.amb, this.musicBus]) b.connect(this.out);
        this.applyVolumes();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private noiseBuffer(dur: number): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  private burst(opts: { dur: number; freq: number; q: number; gain: number; type?: BiquadFilterType; delay?: number }) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(opts.dur);
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q;
    const g = ctx.createGain();
    const t = ctx.currentTime + (opts.delay ?? 0);
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  private tone(freq: number, dur: number, gain: number, delay = 0, type: OscillatorType = 'sine') {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  strike(kind: 'driver' | 'wood' | 'iron' | 'wedge' | 'putter' | 'hybrid', quality: number) {
    if (kind === 'putter') {
      this.tone(1250, 0.06, 0.25);
      this.burst({ dur: 0.04, freq: 2500, q: 2, gain: 0.25 });
      return;
    }
    if (kind === 'driver' || kind === 'wood') {
      this.tone(kind === 'driver' ? 1900 : 2300, 0.11, 0.22 * quality + 0.05);
      this.burst({ dur: 0.08, freq: 3200, q: 1.2, gain: 0.7 });
      this.burst({ dur: 0.18, freq: 900, q: 0.8, gain: 0.2 });
    } else {
      this.burst({ dur: 0.05, freq: 4200, q: 1.5, gain: 0.8 });
      this.burst({ dur: 0.14, freq: 600, q: 0.7, gain: 0.35, type: 'lowpass' }); // turf
      this.tone(3100, 0.04, 0.12);
    }
  }

  /**
   * The ball landing: a soft thump of the ball into the turf plus the brush of the grass, shaped by
   * the surface: firm and short on a green, a duller thud on the fairway, muffled and grassy in
   * the rough, a gritty spray in a bunker. Harder landings are louder.
   */
  land(surface: 'green' | 'fairway' | 'rough' | 'sand', speed: number) {
    const k = Math.min(1, speed / 22);
    const loud = 0.25 + 0.75 * k;
    if (surface === 'sand') {
      this.burst({ dur: 0.22, freq: 2200, q: 0.5, gain: 0.32 * loud });
      this.burst({ dur: 0.1, freq: 420, q: 0.8, gain: 0.18 * loud, type: 'lowpass' });
      return;
    }
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    // thump: a short low sine that drops in pitch as the ball buries into the turf
    const f0 = surface === 'green' ? 165 : surface === 'fairway' ? 120 : 95;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((surface === 'rough' ? 0.18 : 0.3) * loud, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (surface === 'green' ? 0.09 : 0.14));
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.2);
    // the impact click and the grass brushing round the ball
    this.burst({ dur: 0.05, freq: surface === 'green' ? 900 : 600, q: 0.9, gain: 0.16 * loud, type: 'lowpass' });
    if (surface !== 'green') this.burst({ dur: surface === 'rough' ? 0.2 : 0.12, freq: surface === 'rough' ? 2600 : 3400, q: 0.7, gain: (surface === 'rough' ? 0.1 : 0.06) * loud, delay: 0.01 });
  }

  cup() {
    for (let i = 0; i < 4; i++) {
      this.tone(2400 + Math.random() * 600, 0.05, 0.2 / (i + 1), i * 0.07);
      this.burst({ dur: 0.04, freq: 3000, q: 3, gain: 0.25 / (i + 1), delay: i * 0.07 });
    }
  }

  splash() {
    this.burst({ dur: 0.6, freq: 900, q: 0.4, gain: 0.5 });
    this.burst({ dur: 0.3, freq: 2500, q: 0.6, gain: 0.3, delay: 0.05 });
  }

  tree() {
    this.burst({ dur: 0.25, freq: 2400, q: 0.4, gain: 0.35 });
    this.burst({ dur: 0.06, freq: 700, q: 2, gain: 0.3, delay: 0.02 });
  }

  crowd(intensity: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    // applause = many short filtered clicks
    const n = Math.floor(80 * intensity);
    for (let i = 0; i < n; i++) {
      this.burst({ dur: 0.03, freq: 1500 + Math.random() * 2500, q: 1.5, gain: 0.08 * intensity * Math.random(), delay: Math.random() * 2.2 * intensity });
    }
    this.burst({ dur: 1.5 * intensity, freq: 600, q: 0.3, gain: 0.08 * intensity });
  }

  xp() {
    this.tone(1320, 0.09, 0.07, 0, 'triangle');
    this.tone(1760, 0.14, 0.06, 0.08, 'triangle');
  }

  levelUp() {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i === 3 ? 0.4 : 0.12, 0.08, i * 0.1, 'triangle'));
  }

  /** Crowd "ooooh": the ball lipped out or just slid by. */
  ooh(intensity = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    // a crowd of voices: detuned sawtooths through a vowel ("oo") formant, gliding down
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 520;
    f.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 * intensity, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    f.connect(g).connect(this.master);
    for (let i = 0; i < 9; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 150 + Math.random() * 120;
      o.frequency.setValueAtTime(f0 * 1.12, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.88, t + 1.4);
      o.connect(f);
      o.start(t + Math.random() * 0.08);
      o.stop(t + 1.6);
    }
    this.burst({ dur: 1.2, freq: 500, q: 0.8, gain: 0.05 * intensity });
  }

  /** Big roar for a birdie or better, chip-ins and long putts. */
  cheer(intensity = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * intensity, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    f.connect(g).connect(this.master);
    for (let i = 0; i < 12; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 180 + Math.random() * 220;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f0 * 1.25, t + 0.35);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + 2.2);
      o.connect(f);
      o.start(t + Math.random() * 0.15);
      o.stop(t + 2.5);
    }
    this.burst({ dur: 2.2, freq: 1200, q: 0.4, gain: 0.12 * intensity });
    this.crowd(Math.min(1.4, intensity));
  }

  groan() {
    this.tone(220, 0.7, 0.05, 0, 'sawtooth');
    this.burst({ dur: 0.8, freq: 400, q: 0.6, gain: 0.08 });
  }

  startAmbience() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.ambience) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(4);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.03;
    src.connect(f).connect(g).connect(this.amb!);
    src.start();
    this.ambience = src;
    // occasional bird chirps
    const chirp = () => {
      if (!this.ctx || !this.enabled) return;
      const base = 2800 + Math.random() * 1500;
      for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) this.tone(base + Math.random() * 400, 0.06, 0.02, i * 0.11);
      setTimeout(chirp, (4000 + Math.random() * 9000) / this.birdRate);
    };
    setTimeout(chirp, 3000);
  }

  // ---------------------------------------------------------------- golf-course sounds

  /** The club whooshing through the air on the downswing (faster swings are brighter). */
  swoosh(speed = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.6;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800 + 1400 * speed, t + 0.2);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.34);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * speed, t + 0.17);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  /** The tee popping out of the ground on a driver. */
  teePop() {
    this.tone(1650, 0.03, 0.05, 0.01, 'triangle');
    this.burst({ dur: 0.05, freq: 3600, q: 3, gain: 0.08, delay: 0.01 });
  }

  /** Clubs rattling in the bag when you swap clubs. */
  bagRattle() {
    for (let i = 0; i < 3; i++) {
      this.tone(2900 + Math.random() * 1600, 0.05, 0.025, i * 0.035 + Math.random() * 0.02, 'triangle');
      this.burst({ dur: 0.04, freq: 4200, q: 4, gain: 0.03, delay: i * 0.035 });
    }
  }

  /** Polite golf clap: a handful of spectators for a good shot. */
  golfClap(intensity = 1) {
    const n = Math.floor(14 + 26 * intensity);
    for (let i = 0; i < n; i++) {
      this.burst({ dur: 0.025, freq: 1300 + Math.random() * 1800, q: 1.8, gain: 0.05 * intensity * (0.5 + Math.random() * 0.5), delay: 0.15 + Math.random() * 1.4 });
    }
  }

  /** A distant "Fore!" when a shot is heading for trouble. */
  fore() {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(520, t + 0.6);
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.06);
    g.gain.setValueAtTime(0.05, t + 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    f.connect(g).connect(this.master);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(230, t);
    o.frequency.linearRampToValueAtTime(260, t + 0.15);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.7);
    o.connect(f);
    o.start(t);
    o.stop(t + 0.8);
    this.burst({ dur: 0.07, freq: 1800, q: 1, gain: 0.03 }); // the "f"
  }

  private roll: { src: AudioBufferSourceNode; gain: GainNode; f: BiquadFilterNode } | null = null;

  /** Ball rolling on the green: 0 silent .. 1 a quick putt. Call every frame while it rolls. */
  setRoll(level: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (!this.roll) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(3);
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 300;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(f).connect(gain).connect(this.master);
      src.start();
      this.roll = { src, gain, f };
    }
    const l = Math.max(0, Math.min(1, level));
    this.roll.gain.gain.setTargetAtTime(l * 0.09, ctx.currentTime, 0.04);
    this.roll.f.frequency.setTargetAtTime(220 + 500 * l, ctx.currentTime, 0.05);
  }

  private mowerStarted = false;

  /** A greenkeeper's mower somewhere on the course every minute or two. */
  private startMower() {
    if (this.mowerStarted || !this.ctx || !this.master) return;
    this.mowerStarted = true;
    const ctx = this.ctx;
    const mower = () => {
      if (!this.ctx || !this.enabled || !this.master) return;
      const t = ctx.currentTime, dur = 14 + Math.random() * 10;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 52 + Math.random() * 10;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.3;
      const ld = ctx.createGain();
      ld.gain.value = 3;
      lfo.connect(ld).connect(o.frequency);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 260;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.006, t + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f).connect(g).connect(this.amb!);
      o.start(t);
      lfo.start(t);
      o.stop(t + dur + 0.1);
      lfo.stop(t + dur + 0.1);
      setTimeout(mower, (60 + Math.random() * 90) * 1000);
    };
    setTimeout(mower, 20000 + Math.random() * 30000);
  }

  /** Looping filtered noise whose level slowly swells (surf, wind gusts, rain). */
  private noiseLayer(opts: { type: BiquadFilterType; freq: number; q: number; gain: number; lfoRate?: number; lfoDepth?: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(5);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q;
    const gain = ctx.createGain();
    gain.gain.value = opts.gain;
    src.connect(f).connect(gain).connect(this.amb!);
    let lfo: OscillatorNode | undefined;
    if (opts.lfoRate) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = opts.lfoRate;
      const depth = ctx.createGain();
      depth.gain.value = opts.lfoDepth ?? opts.gain * 0.8;
      lfo.connect(depth).connect(gain.gain);
      lfo.start();
    }
    src.start();
    return { src, gain, lfo };
  }

  /** Course ambience: surf on coastal courses, wind on links, extra birdsong in parkland. */
  setCourseAmbience(style: { surf: boolean; birdRate: number; windNoise: number }, windMph: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    for (const l of this.layers) {
      l.src.stop();
      l.lfo?.stop();
    }
    this.layers = [];
    const w = Math.min(1, windMph / 20);
    // surf rolling in on the sea courses
    if (style.surf) this.layers.push(this.noiseLayer({ type: 'lowpass', freq: 520, q: 0.4, gain: 0.05, lfoRate: 0.11, lfoDepth: 0.04 }));
    this.layers.push(this.noiseLayer({ type: 'bandpass', freq: 360 + 220 * w, q: 0.5, gain: 0.006 + 0.012 * w * style.windNoise, lfoRate: 0.15 + 0.08 * w, lfoDepth: 0.004 + 0.009 * w }));
    this.birdRate = style.birdRate;
    // a quiet murmur from the gallery
    this.layers.push(this.noiseLayer({ type: 'bandpass', freq: 480, q: 1.2, gain: 0.011, lfoRate: 0.05, lfoDepth: 0.006 }));
    this.startMower();
  }

  /** Rain on the umbrellas and the turf. */
  setRain(on: boolean, heavy = 0.6) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (this.rainLayer) {
      this.rainLayer.src.stop();
      this.rainLayer = null;
    }
    if (on) this.rainLayer = this.noiseLayer({ type: 'bandpass', freq: 2200, q: 0.35, gain: 0.006 + 0.008 * heavy, lfoRate: 0.07, lfoDepth: 0.003 });
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    this.applyVolumes();
  }

  /** Volumes 0..1 from Settings. */
  setVolumes(v: Volumes) {
    this.vol = { ...v };
    this.applyVolumes();
  }

  private applyVolumes() {
    if (!this.out || !this.master || !this.amb || !this.musicBus) return;
    // perceptual curve: the slider's halfway point sounds about half as loud
    const c = (x: number) => x * x;
    this.out.gain.value = this.enabled ? c(this.vol.master) : 0;
    this.master.gain.value = c(this.vol.effects) * 1.1;
    this.amb.gain.value = c(this.vol.ambience) * 1.4;
    this.musicBus.gain.value = c(this.vol.music);
  }

  /** The shared audio clock for the music player (null until audio is allowed to start). */
  context(): AudioContext | null {
    return this.ensure();
  }
}

export const sfx = new Sfx();
