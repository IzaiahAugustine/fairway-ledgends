// Background music, generated live (no audio files, nothing to license): soft electric-piano chords
// over a warm pad and a gentle bass, in a relaxed clubhouse-jazz progression. The menu mood plays a
// little melody on top; the on-course mood is sparser and quieter so the strike and the crowd lead.
import { sfx } from './sfx';

type Mood = 'menu' | 'course' | 'off';

// Cmaj9 - Am9 - Dm9 - G13 (and a turnaround variant), as MIDI notes
const PROGRESSIONS: number[][][] = [
  [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [50, 57, 60, 64, 65], [43, 53, 57, 59, 64]],
  [[53, 57, 60, 64, 67], [52, 55, 59, 62, 64], [50, 57, 60, 64, 65], [43, 50, 53, 57, 59]],
];
const SCALE = [60, 62, 64, 67, 69, 72, 74, 76];
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private mood: Mood = 'off';
  private timer: number | null = null;
  private nextBar = 0;
  private bar = 0;
  private bus: GainNode | null = null;
  private readonly bpm = 76;

  /** Switch mood; music starts once the browser allows audio (after the first click). */
  play(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    const ctx = sfx.context();
    if (!ctx || !sfx.musicBus) return;
    if (!this.bus) {
      this.bus = ctx.createGain();
      this.bus.connect(sfx.musicBus);
    }
    // fade the old mood out / the new one in
    const t = ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(mood === 'off' ? 0 : mood === 'menu' ? 0.9 : 0.45, t, 0.8);
    if (mood === 'off') return;
    if (this.timer === null) {
      this.nextBar = ctx.currentTime + 0.3;
      this.timer = window.setInterval(() => this.schedule(), 250);
    }
  }

  private get barLen() {
    return (60 / this.bpm) * 4;
  }

  /** Keep about a bar of music scheduled ahead of the audio clock. */
  private schedule() {
    const ctx = sfx.context();
    if (!ctx || !this.bus) return;
    if (this.mood === 'off') {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      return;
    }
    while (this.nextBar < ctx.currentTime + this.barLen) {
      this.playBar(ctx, this.nextBar, this.bar);
      this.nextBar += this.barLen;
      this.bar++;
    }
  }

  private playBar(ctx: AudioContext, t0: number, bar: number) {
    const prog = PROGRESSIONS[Math.floor(bar / 8) % PROGRESSIONS.length];
    const chord = prog[Math.floor(bar / 2) % prog.length];
    const beat = 60 / this.bpm;
    const menu = this.mood === 'menu';
    // pad: the chord held across the bar
    if (bar % 2 === 0) for (const n of chord.slice(1)) this.pad(ctx, midiHz(n), t0, this.barLen * 2, menu ? 0.022 : 0.016);
    // bass on beats 1 and 3
    this.pluck(ctx, midiHz(chord[0] - 12), t0, beat * 1.8, 0.09, 'sine');
    if (menu || bar % 2 === 1) this.pluck(ctx, midiHz(chord[0] - 12 + (bar % 2 ? 7 : 0)), t0 + beat * 2, beat * 1.6, 0.07, 'sine');
    // electric-piano comping: a soft, slightly swung chord stab
    const stabs = menu ? [0.5, 2.5] : [1.5];
    for (const b of stabs) for (const n of chord.slice(1, 4)) this.pluck(ctx, midiHz(n + 12), t0 + beat * b + 0.06, beat * 0.9, 0.022, 'triangle');
    // menu melody: a few notes from the scale, chosen to sit on the chord
    if (menu) {
      const seed = (bar * 9301 + 49297) % 233280;
      const r = (k: number) => ((seed * (k + 1) * 7919) % 1000) / 1000;
      for (let k = 0; k < 3; k++) {
        if (r(k) < 0.45) continue;
        const note = SCALE[Math.floor(r(k + 5) * SCALE.length)] + 12;
        this.pluck(ctx, midiHz(note), t0 + beat * (k * 1.25 + 0.25), beat * 1.2, 0.03, 'triangle');
      }
    }
  }

  private pad(ctx: AudioContext, hz: number, t: number, dur: number, gain: number) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 1.2);
    g.gain.setValueAtTime(gain, t + dur - 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1200;
    f.connect(g).connect(this.bus!);
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.7);
    }
  }

  private pluck(ctx: AudioContext, hz: number, t: number, dur: number, gain: number, type: OscillatorType) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.bus!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

export const music = new Music();
