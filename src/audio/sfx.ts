// Small synthesized sound kit (no audio files): club strikes, landings, cup rattle, splash,
// crowd reactions and an outdoor ambience bed.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: AudioBufferSourceNode | null = null;
  enabled = true;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.7;
        this.master.connect(this.ctx.destination);
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

  land(surface: 'green' | 'fairway' | 'rough' | 'sand', speed: number) {
    const g = Math.min(0.6, speed / 25);
    if (surface === 'sand') this.burst({ dur: 0.18, freq: 1800, q: 0.5, gain: g });
    else this.burst({ dur: 0.08, freq: surface === 'green' ? 380 : 260, q: 1, gain: g, type: 'lowpass' });
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
    g.gain.value = 0.045;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.ambience = src;
    // occasional bird chirps
    const chirp = () => {
      if (!this.ctx || !this.enabled) return;
      const base = 2800 + Math.random() * 1500;
      for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) this.tone(base + Math.random() * 400, 0.06, 0.02, i * 0.11);
      setTimeout(chirp, 4000 + Math.random() * 9000);
    };
    setTimeout(chirp, 3000);
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.7 : 0;
  }
}

export const sfx = new Sfx();
