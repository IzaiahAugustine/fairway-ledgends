// Mouse swing controls.
//  - Swing Stick (default, like 2K): hold the left button, pull the mouse DOWN for the
//    backswing (how far = power), then push it UP through the start point. Tempo (speed of
//    the push) and straightness (left/right drift) decide the strike.
//  - 3-Click: click to start the power bar, click to set power, click again in the impact zone.
import { clamp } from '../core/rng';
import type { Difficulty, SwingMode } from '../core/save';
import { SWING_STYLES, type SwingStyle } from '../data/swingStyles';
import type { SwingResult } from './shotModel';

export interface SwingHooks {
  /** Visual backswing fraction 0..1.1 (and meter display). */
  onBackswing(frac: number): void;
  /** The downswing has begun; duration is how long until impact in seconds. */
  onDownswing(duration: number): void;
  /** Swing resolved (fires when the golfer reaches impact). */
  onResult(r: SwingResult): void;
  onCancel(): void;
  onMeter(state: MeterState): void;
}

export interface MeterState {
  mode: SwingMode;
  phase: 'idle' | 'back' | 'down' | 'power' | 'return' | 'done';
  power: number;
  /** 3-click: current needle position (power units); stick: horizontal drift 0-centred. */
  needle: number;
  drift: number;
  target: number;
  zone: number;
}

const TEMPO_WINDOW: Record<Difficulty, [number, number]> = { easy: [0.04, 1.3], medium: [0.06, 0.9], hard: [0.08, 0.62] };
/** Push-up speeds (seconds) that count as a perfect tempo; always inside TEMPO_WINDOW. */
const PERFECT_TEMPO: Record<Difficulty, [number, number]> = { easy: [0.1, 0.75], medium: [0.14, 0.55], hard: [0.17, 0.45] };
const PATH_TOL: Record<Difficulty, number> = { easy: 18, medium: 12, hard: 7.5 };
const CLICK_SPEED: Record<Difficulty, number> = { easy: 0.6, medium: 0.75, hard: 0.95 };
const CLICK_ZONE: Record<Difficulty, number> = { easy: 0.11, medium: 0.075, hard: 0.05 };
/** Overall multiplier on how much a mistimed or off-line swing costs. */
const MISTAKE: Record<Difficulty, number> = { easy: 0.5, medium: 0.7, hard: 0.9 };

export class SwingInput {
  enabled = false;
  mode: SwingMode = 'stick';
  difficulty: Difficulty = 'medium';
  /** Multiplier on swing mistakes from club/lie/shot type. */
  errScale = 1;
  /** Target power marker shown on the meter. */
  target = 1;
  putting = false;
  /** Swing style: shifts and widens/narrows the tempo windows. */
  style: SwingStyle = SWING_STYLES[0];
  private hooks: SwingHooks;
  private el: HTMLElement;
  // stick state
  private phase: MeterState['phase'] = 'idle';
  private y0 = 0;
  private x0 = 0;
  private range = 220;
  private pull = 0;
  private maxPull = 0;
  private topX = 0;
  private topY = 0;
  private topT = 0;
  private lastX = 0;
  private backDrift = 0;
  // 3-click state
  private needle = 0;
  private power = 0;

  private onDown = (e: PointerEvent) => this.down(e);
  private onMove = (e: PointerEvent) => this.move(e);
  private onUp = (e: PointerEvent) => this.up(e);

  constructor(el: HTMLElement, hooks: SwingHooks) {
    this.el = el;
    this.hooks = hooks;
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  }

  get active(): boolean {
    return this.phase !== 'idle' && this.phase !== 'done';
  }

  reset() {
    this.phase = 'idle';
    this.pull = 0;
    this.maxPull = 0;
    this.needle = 0;
    this.power = 0;
    this.emit();
  }

  private emit() {
    this.hooks.onMeter({
      mode: this.mode,
      phase: this.phase,
      power: this.mode === 'stick' ? this.pull : this.power,
      needle: this.mode === 'stick' ? this.pull : this.needle,
      drift: this.mode === 'stick' ? clamp((this.lastX - this.x0) / this.range, -1, 1) : 0,
      target: this.target,
      zone: CLICK_ZONE[this.difficulty],
    });
  }

  private down(e: PointerEvent) {
    if (!this.enabled || e.button !== 0) return;
    if (this.mode === 'stick') {
      if (this.phase !== 'idle') return;
      this.phase = 'back';
      this.x0 = this.lastX = e.clientX;
      this.y0 = e.clientY;
      this.range = Math.max(150, window.innerHeight * 0.26);
      this.pull = 0;
      this.maxPull = 0;
      this.el.setPointerCapture?.(e.pointerId);
      this.emit();
    } else {
      this.click();
    }
  }

  private move(e: PointerEvent) {
    if (this.mode !== 'stick' || !this.enabled) return;
    this.lastX = e.clientX;
    if (this.phase === 'back') {
      this.pull = clamp((e.clientY - this.y0) / this.range, 0, 1.12);
      if (this.pull >= this.maxPull) {
        this.maxPull = this.pull;
        this.topX = e.clientX;
        this.topY = e.clientY;
        this.topT = performance.now();
        this.backDrift = (e.clientX - this.x0) / this.range;
      }
      this.hooks.onBackswing(this.pull);
      // downswing begins once the mouse comes back up noticeably from the top
      if (this.maxPull > 0.06 && this.maxPull - this.pull > 0.05) {
        this.phase = 'down';
        // expected time to impact: extrapolate current speed
        this.hooks.onDownswing(0.22);
      }
      this.emit();
    } else if (this.phase === 'down') {
      this.pull = clamp((e.clientY - this.y0) / this.range, -0.3, 1.12);
      this.emit();
      if (e.clientY <= this.y0) this.finishStick(e.clientX, e.clientY, false);
    }
  }

  private up(e: PointerEvent) {
    if (this.mode !== 'stick' || !this.enabled) return;
    if (this.phase === 'back') {
      if (this.maxPull > 0.06 && this.maxPull - this.pull > 0.02) {
        // released on the way down: weak, mishit strike
        this.phase = 'down';
        this.hooks.onDownswing(0.22);
        this.finishStick(e.clientX, e.clientY, true);
        return;
      }
      this.phase = 'idle';
      this.pull = 0;
      this.hooks.onCancel();
      this.emit();
    } else if (this.phase === 'down') {
      this.finishStick(e.clientX, e.clientY, true);
    }
  }

  private finishStick(x: number, y: number, released: boolean) {
    this.phase = 'done';
    const tempo = (performance.now() - this.topT) / 1000;
    const travelY = this.topY - y;
    const travelX = x - this.topX;
    const progress = clamp(travelY / Math.max(1, this.topY - this.y0), 0, 1);
    const pathDeg = (Math.atan2(travelX, Math.max(8, travelY)) * 180) / Math.PI;
    let power = Math.min(this.maxPull, 1.12);
    const r = this.evaluate(power, tempo, pathDeg, this.backDrift);
    if (released && progress < 0.95) {
      power *= 0.45 + 0.5 * progress;
      r.power = power;
      r.dirErr += (pathDeg >= 0 ? 1 : -1) * 3 * (1 - progress) * this.errScale;
      r.tempo = 'Lazy';
      r.path = 'Quit on it';
      r.quality = Math.min(r.quality, 0.3);
    }
    this.emit();
    this.hooks.onResult(r);
  }

  /** Turns raw stick measurements into a strike. */
  evaluate(power: number, tempoSec: number, pathDeg: number, backDrift: number): SwingResult {
    // a style moves the ideal push speed (tempoSpeed) and scales how wide the windows are
    const st = this.style;
    const win = ([a, b]: [number, number]): [number, number] => {
      const mid = ((a + b) / 2) * st.tempoSpeed;
      const half = ((b - a) / 2) * st.tempoWindow;
      return [Math.max(0.02, mid - half), mid + half];
    };
    const [lo, hi] = win(TEMPO_WINDOW[this.difficulty]);
    const tol = PATH_TOL[this.difficulty];
    let tempoErr = 0; // + fast, - slow
    if (tempoSec < lo) tempoErr = (lo - tempoSec) / lo;
    else if (tempoSec > hi) tempoErr = -(tempoSec - hi) / hi;
    tempoErr = clamp(tempoErr, -1.5, 1.5);
    const [pLo, pHi] = win(PERFECT_TEMPO[this.difficulty]);
    let tempo: SwingResult['tempo'] = 'Good';
    if (tempoErr === 0 && tempoSec >= pLo && tempoSec <= pHi) tempo = 'Perfect';
    else if (tempoErr > 0.5) tempo = 'Rushed';
    else if (tempoErr > 0) tempo = 'Fast';
    else if (tempoErr < -0.5) tempo = 'Lazy';
    else if (tempoErr < 0) tempo = 'Slow';
    const over = Math.max(0, power - 1) / 0.12; // 0..1 overswing
    const p = this.putting ? pathDeg * 0.6 : pathDeg;
    const eff = Math.sign(p) * Math.max(0, Math.abs(p) - tol * 0.45);
    const drift = backDrift * 10;
    const es = this.errScale * (1 + over * 0.8) * MISTAKE[this.difficulty];
    const noise = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.5;
    let dirErr: number, curveErr: number;
    if (this.putting) {
      dirErr = (eff * 0.1 + tempoErr * -0.4 + noise() * 0.1) * es;
      curveErr = 0;
    } else {
      dirErr = (eff * 0.22 - tempoErr * 1.1 + drift * 0.06 + noise() * 0.35) * es;
      curveErr = (eff * 0.6 - tempoErr * 4.5 + noise() * 0.8) * es;
    }
    let pw = power;
    if (tempoErr < 0) pw *= 1 - Math.min(0.1, -tempoErr * 0.08);
    if (tempoErr > 0) pw *= 1 + Math.min(0.03, tempoErr * 0.02);
    const pathLabel = Math.abs(p) < tol * 0.45 ? 'Straight' : `${p > 0 ? 'Push' : 'Pull'} ${Math.abs(p).toFixed(0)}°`;
    const quality = clamp(1 - Math.abs(eff) / 25 - Math.abs(tempoErr) * 0.4 - over * 0.3, 0, 1);
    return { power: pw, dirErr, curveErr, tempo, path: pathLabel, quality };
  }

  // ---------------------------------------------------------------- 3-click

  private click() {
    if (this.phase === 'idle') {
      this.phase = 'power';
      this.needle = 0;
      this.power = 0;
    } else if (this.phase === 'power') {
      this.power = Math.max(0.03, this.needle);
      this.phase = 'return';
    } else if (this.phase === 'return') {
      this.resolveClick(this.needle);
    }
    this.emit();
  }

  private resolveClick(at: number) {
    this.phase = 'done';
    const zone = CLICK_ZONE[this.difficulty];
    // needle > 0: early (hook / pull), < 0: late (slice / push)
    const off = at / zone;
    const inZone = Math.abs(off) <= 1;
    const es = this.errScale * (1 + Math.max(0, this.power - 1) * 6) * MISTAKE[this.difficulty];
    const k = inZone ? off * 0.35 : Math.sign(off) * (0.35 + (Math.abs(off) - 1) * 1.1);
    const dirErr = this.putting ? -k * 0.8 * es : -k * 1.4 * es;
    const curveErr = this.putting ? 0 : -k * 7.5 * es;
    const tempo: SwingResult['tempo'] = Math.abs(off) < 0.25 ? 'Perfect' : inZone ? 'Good' : off > 0 ? 'Fast' : 'Slow';
    const path = Math.abs(off) < 0.25 ? 'Straight' : off > 0 ? 'Early (hook)' : 'Late (slice)';
    this.hooks.onDownswing(0.14);
    this.hooks.onResult({ power: this.power, dirErr, curveErr, tempo, path, quality: clamp(1 - Math.abs(off) * 0.4, 0, 1) });
  }

  /** Advance the 3-click meter. */
  update(dt: number) {
    if (this.mode !== 'threeClick' || !this.enabled) return;
    const speed = CLICK_SPEED[this.difficulty] * (this.putting ? 0.75 : 1);
    if (this.phase === 'power') {
      this.needle += dt * speed;
      if (this.needle >= 1.12) {
        this.needle = 1.12;
        this.power = 1.12;
        this.phase = 'return';
      }
      this.hooks.onBackswing(this.needle);
      this.emit();
    } else if (this.phase === 'return') {
      this.needle -= dt * speed * 1.25;
      if (this.needle <= -0.16) this.resolveClick(-0.16);
      this.emit();
    }
  }
}
