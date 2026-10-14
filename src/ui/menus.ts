// Front-end screens: main menu, match setup (course + difficulty), golfer editor, club bag /
// upgrade shop, settings, pause and results.
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource-variable/inter';
import { sfx } from '../audio/sfx';
import { toYards } from '../core/rng';
import { persist, playerLevel, resetSave, save, type Appearance, type Difficulty, type FaceStyle, type TextSize } from '../core/save';
import { CLUBS, MAX_TIER, SHOT_TYPES, TIERS, upgradeCost } from '../data/clubs';
import { BALL_COLORS, CLUB_FINISHES, SHIRT_PATTERNS, type Unlock } from '../data/cosmetics';
import { COURSES, DRIVING_RANGE, HOLE_SETS, courseById, courseForSet, coursePar, courseYards, type CourseDef, type HoleSet } from '../data/courses';
import { CAREER, careerEvent } from '../data/career';
import { SWING_STYLES, swingStyleById, type SwingStyle, type SwingStyleId } from '../data/swingStyles';
import { FlatGround, simulateShot } from '../physics/ballPhysics';
import { PERFECT_SWING, fullCarry, launchFor } from '../game/shotModel';
import { FORMATS, computeXp, type Format, type MatchOptions, type MatchState } from '../game/match';
import { PERSONALITIES } from '../game/ai';
import { Surf } from '../world/holeGen';
import { clear, esc, h } from './dom';

export interface MenuHooks {
  startMatch(opts: MatchOptions): void;
  previewAppearance(a: Appearance): void;
  showroom(mode: 'menu' | 'editor' | 'shop' | 'swing' | 'none'): void;
  /** Swing-style screen: show this style's swing on the golfer (null to stop). */
  swingDemo(style: SwingStyle | null): void;
  settingsChanged(): void;
  resume(): void;
  quitMatch(): void;
}

const SKIN = ['#f6d3b8', '#f1c6a6', '#e0ac82', '#c68a62', '#a8714a', '#8a5636', '#6b4128', '#4a2c1c'];
const HAIR = ['#0f0c0a', '#2a1d14', '#3b2a1e', '#6b4a2a', '#9a6a38', '#c9a066', '#e3cf9e', '#8a8a8a', '#d9d9d9', '#7a2a16'];
const CLOTH = ['#f2f2f0', '#111111', '#1c2b4a', '#0b3d91', '#2a8fbd', '#1f6f43', '#6fae46', '#b5121b', '#e86a10', '#f2c14e', '#6a1b9a', '#e86fa0', '#8a8a8a', '#e8e2d0', '#5a3a22'];

const DIFF_INFO: Record<Difficulty, { name: string; desc: string; pips: number }> = {
  easy: { name: 'Easy', pips: 1, desc: 'Very forgiving swing timing, mistakes barely hurt. Full shot and putt previews, 4 ft gimmes. Opponent uses Rusty clubs and makes plenty of mistakes.' },
  medium: { name: 'Medium', pips: 2, desc: 'Forgiving swing timing. Shot preview with roll-out, most of the putt line, 3 ft gimmes. Opponent is a steady club golfer with Clubhouse clubs.' },
  hard: { name: 'Hard', pips: 3, desc: 'Tighter swing timing, carry-only shot preview, short putt line. Opponent is a strong amateur with Tour clubs.' },
};

// inline line icons (24px grid, stroked with currentColor)
const svg = (body: string) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  golfer: svg('<circle cx="12" cy="7.6" r="3.4"/><path d="M8.2 6.3h8.8"/><path d="M4.8 21c.7-4.3 3.6-7 7.2-7s6.5 2.7 7.2 7"/>'),
  bag: svg('<path d="M8 9.5h8l-.9 10.7a1.6 1.6 0 0 1-1.6 1.3h-3a1.6 1.6 0 0 1-1.6-1.3Z"/><path d="M9.6 9.5V4M12 9.5V2.8M14.3 9.5l1.6-5"/><path d="M8.5 14h7"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  pad: svg('<path d="M7.5 6.5h9a5.5 5.5 0 0 1 0 11h-9a5.5 5.5 0 0 1 0-11Z"/><path d="M7.5 10.2v3.6M5.7 12h3.6"/><circle cx="15.6" cy="10.8" r=".7" fill="currentColor"/><circle cx="17.6" cy="13" r=".7" fill="currentColor"/>'),
  back: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  chevron: svg('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  play: svg('<path d="M8 5.8v12.4L18 12Z" fill="currentColor"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 6H5.2a2.8 2.8 0 0 0 2.9 3.6M16 6h2.8a2.8 2.8 0 0 1-2.9 3.6M12 13v3.5M8.5 20h7M10 16.5h4"/>'),
  star: svg('<path d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.5l-5.1 2.7 1-5.6-4.1-4 5.7-.8Z" fill="currentColor" fill-opacity=".25"/>'),
  check: svg('<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>'),
  exit: svg('<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15"/>'),
  again: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>'),
  home: svg('<path d="m4 11 8-7 8 7"/><path d="M6.5 9.5V20h11V9.5"/>'),
  rotate: svg('<path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9"/><path d="M18.5 3.5v4h-4"/><path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M5.5 20.5v-4h4"/>'),
};

let crestN = 0;
/** Shield crest with a pin flag on a green; gradient ids are unique per instance. */
function crest(): string {
  const g = `crg${++crestN}`, f = `crf${crestN}`;
  return `<svg class="crest" viewBox="0 0 64 74" aria-hidden="true"><defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset=".5" stop-color="#f2c14e"/><stop offset="1" stop-color="#b8862b"/></linearGradient>
    <linearGradient id="${f}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#23854f"/><stop offset="1" stop-color="#092c1f"/></linearGradient></defs>
    <path d="M32 3 59 11v23c0 18.6-12.4 30.8-27 37C17.4 64.8 5 52.6 5 34V11Z" fill="url(#${f})" stroke="url(#${g})" stroke-width="3" stroke-linejoin="round"/>
    <path d="M32 9.6 53 15.9V34c0 14.6-9.3 24.7-21 30.3C20.3 58.7 11 48.6 11 34V15.9Z" fill="none" stroke="url(#${g})" stroke-opacity=".45"/>
    <ellipse cx="32" cy="52" rx="15.5" ry="4.2" fill="#3fae6e"/>
    <path d="M27 52V22" stroke="#f6f2e4" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M28 22.4 43 28l-15 5.6Z" fill="url(#${g})"/>
    <circle cx="37" cy="50.8" r="2.1" fill="#fff"/>
    <path d="M32 11.8l.85 2.43 2.57.06-2.04 1.56.74 2.46L32 16.85l-2.12 1.46.74-2.46-2.04-1.56 2.57-.06Z" fill="url(#${g})"/>
  </svg>`;
}

/** Circular level badge: level number inside a ring filled to the progress fraction. */
function ring(level: number, frac: number): string {
  const c = 2 * Math.PI * 27;
  return `<div class="lv-ring"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" class="trk"/><circle cx="32" cy="32" r="27" class="val" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"/></svg><span><small>Level</small><b>${level}</b></span></div>`;
}

const pips = (n: number, on: number) => `<span class="pips">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;

/** Average club tier across the bag (0 = Rusty .. MAX_TIER). */
const bagTier = () => CLUBS.reduce((a, c) => a + (save.clubs[c.id] ?? 0), 0) / CLUBS.length;

/** Re-renders a block, then puts keyboard focus back on the element with the same data-k. */
function keepFocus(render: () => void) {
  const k = (document.activeElement as HTMLElement | null)?.dataset?.k;
  render();
  if (k) document.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`)?.focus();
}

// elements reachable with the arrow keys
const NAV = 'button:not([disabled]), .nav, input[type=range]';
const DIRS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

function courseArt(c: CourseDef): HTMLCanvasElement {
  const cv = h('canvas', { width: '480', height: '300' });
  const ctx = cv.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, 300);
  const hexc = (n: number) => '#' + n.toString(16).padStart(6, '0');
  const st = c.style;
  if (st === 'desert') { sky.addColorStop(0, '#f2a86a'); sky.addColorStop(0.6, '#f6d8a8'); }
  else if (st === 'coastal') { sky.addColorStop(0, '#8a9aa8'); sky.addColorStop(0.6, '#d0d8de'); }
  else if (st === 'beach') { sky.addColorStop(0, '#3d9ae0'); sky.addColorStop(0.65, '#bfe6f6'); }
  else { sky.addColorStop(0, '#5d9fd8'); sky.addColorStop(0.65, '#cfe3f2'); }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 480, 300);
  let seed = c.id.length * 97;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  if (st === 'alpine') {
    // snow-capped peaks
    for (const [x0, w, ht, col] of [[-40, 260, 150, '#6c7a8c'], [150, 300, 175, '#5a687a'], [330, 220, 130, '#74828f']] as [number, number, number, string][]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x0, 190);
      ctx.lineTo(x0 + w / 2, 190 - ht);
      ctx.lineTo(x0 + w, 190);
      ctx.fill();
      ctx.fillStyle = '#eef2f6';
      ctx.beginPath();
      ctx.moveTo(x0 + w / 2 - w * 0.12, 190 - ht * 0.76);
      ctx.lineTo(x0 + w / 2, 190 - ht);
      ctx.lineTo(x0 + w / 2 + w * 0.12, 190 - ht * 0.76);
      ctx.lineTo(x0 + w / 2 + w * 0.04, 190 - ht * 0.8);
      ctx.lineTo(x0 + w / 2 - w * 0.03, 190 - ht * 0.72);
      ctx.fill();
    }
  }
  if (st === 'desert') {
    // red mesas on the horizon
    ctx.fillStyle = '#b5583a';
    for (const [x0, w, ht] of [[20, 120, 60], [190, 70, 85], [300, 160, 50]]) {
      ctx.beginPath();
      ctx.moveTo(x0, 175);
      ctx.lineTo(x0 + 14, 175 - ht);
      ctx.lineTo(x0 + w - 14, 175 - ht);
      ctx.lineTo(x0 + w, 175);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(80,20,10,0.25)';
    ctx.fillRect(0, 150, 480, 3);
  }
  const sea = st === 'coastal' || st === 'beach';
  if (sea) {
    ctx.fillStyle = st === 'beach' ? '#1fa6b0' : '#2a5d78';
    ctx.fillRect(0, 160, 480, 140);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (let i = 0; i < 30; i++) ctx.fillRect(rnd() * 480, 165 + rnd() * 120, 20 + rnd() * 30, 1.5);
  }
  if (st === 'beach') {
    // white sand shelving to the water
    ctx.fillStyle = hexc(c.colors.sand);
    ctx.beginPath();
    ctx.moveTo(100, 300);
    for (let x = 100; x <= 480; x += 10) ctx.lineTo(x, 175 + Math.sin(x * 0.02) * 6);
    ctx.lineTo(480, 300);
    ctx.fill();
  }
  // rolling land layers (clifftops on the coast)
  const layers = [hexc(c.colors.deep), hexc(c.colors.rough), hexc(c.colors.fairway)];
  layers.forEach((col, li) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    const base = 150 + li * 45 + (st === 'beach' ? 10 : 0);
    const x0 = sea ? 140 + li * 30 : 0;
    ctx.moveTo(x0, 300);
    for (let x = x0; x <= 480; x += 10) ctx.lineTo(x, base + Math.sin(x * 0.012 + li * 2) * (10 + c.dunes * 4) + Math.sin(x * 0.05 + li) * 3);
    ctx.lineTo(480, 300);
    ctx.fill();
  });
  if (st === 'coastal') {
    ctx.fillStyle = '#5d5850';
    for (let li = 0; li < 3; li++) ctx.fillRect(136 + li * 30, 150 + li * 45 + 8, 6, 300);
  }
  // trees: palms, cacti, pines or round crowns (autumn colours on the maple course)
  const n = st === 'parkland' || st === 'alpine' ? 26 : st === 'desert' ? 10 : st === 'beach' ? 8 : 4;
  for (let i = 0; i < n; i++) {
    const x = (sea ? 160 : 0) + rnd() * (sea ? 320 : 480), y = 150 + rnd() * 40, s = 14 + rnd() * 18;
    if (st === 'beach') {
      ctx.strokeStyle = '#7a5a3a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y + s);
      ctx.quadraticCurveTo(x + 6, y + s * 0.2, x + 3, y - s);
      ctx.stroke();
      ctx.strokeStyle = '#2f7a2c';
      ctx.lineWidth = 2.5;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(x + 3, y - s);
        ctx.quadraticCurveTo(x + 3 + Math.cos(a) * s * 0.6, y - s - 6, x + 3 + Math.cos(a) * s * 0.9, y - s + Math.abs(Math.sin(a)) * 6 + 6);
        ctx.stroke();
      }
      continue;
    }
    if (st === 'desert') {
      ctx.fillStyle = '#3f6a3a';
      ctx.fillRect(x - 3, y - s * 0.4, 6, s * 1.4);
      ctx.fillRect(x - 11, y, 4, -s * 0.5);
      ctx.fillRect(x - 11, y, 10, 4);
      ctx.fillRect(x + 7, y + 4, 4, -s * 0.4);
      ctx.fillRect(x + 1, y + 4, 10, 4);
      continue;
    }
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(x - 1.5, y, 3, s * 0.5);
    ctx.beginPath();
    if (st === 'alpine' || st === 'coastal') {
      ctx.fillStyle = '#244a2a';
      ctx.moveTo(x - s * 0.35, y + 2);
      ctx.lineTo(x, y - s);
      ctx.lineTo(x + s * 0.35, y + 2);
    } else {
      ctx.fillStyle = c.foliage ? hexc(c.foliage[i % c.foliage.length]) : '#2f5a28';
      ctx.arc(x, y - s * 0.3, s * 0.5, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // green + flag
  ctx.fillStyle = hexc(c.colors.green);
  ctx.beginPath();
  ctx.ellipse(330, 245, 70, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hexc(c.colors.sand);
  ctx.beginPath();
  ctx.ellipse(250, 255, 28, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(336, 195, 2, 50);
  ctx.fillStyle = '#ffd400';
  ctx.beginPath();
  ctx.moveTo(338, 196);
  ctx.lineTo(362, 203);
  ctx.lineTo(338, 210);
  ctx.fill();
  return cv;
}

// ---------------------------------------------------------------- swing-style ball flights

const flatGround = new FlatGround();
const flightCache = new Map<string, { side: [number, number][]; top: [number, number][]; carry: number; total: number }>();

/** A full shot with a style on flat ground, perfect strike, no wind (yards; side = height, top = lateral). */
function styleFlight(style: SwingStyleId, clubId: string) {
  const key = `${style}|${clubId}`;
  let f = flightCache.get(key);
  if (f) return f;
  const club = CLUBS.find((c) => c.id === clubId)!;
  const teed = club.kind === 'driver';
  const setup = { club, tier: 1, shot: SHOT_TYPES[0], power: 1, aimX: 0, aimZ: -1, x: 0, y: teed ? 0.045 : 0.0214, z: 0, lie: teed ? Surf.Tee : Surf.Fairway, teed, style };
  const r = simulateShot(launchFor(setup, PERFECT_SWING(1)), { ground: flatGround, wind: { x: 0, z: 0 }, firmness: 1, cup: null, flagIn: false });
  const side: [number, number][] = [], top: [number, number][] = [];
  for (let i = 0; i < r.samples.length; i += 4 * 3) {
    const x = r.samples[i + 1], y = r.samples[i + 2], z = r.samples[i + 3];
    side.push([toYards(-z), toYards(y)]);
    top.push([toYards(-z), toYards(x)]);
  }
  f = { side, top, carry: toYards(r.carry), total: toYards(r.total) };
  flightCache.set(key, f);
  return f;
}

/** Side and top views of a style's driver and 7-iron, with Classic Tour drawn faintly behind. */
function flightChart(style: SwingStyleId): string {
  const W = 360, sideH = 96, topH = 70, pad = 6, maxX = 320;
  const sx = (d: number) => pad + (d / maxX) * (W - pad * 2);
  const path = (pts: [number, number][], fy: (v: number) => number) => pts.map(([d, v], i) => `${i ? 'L' : 'M'}${sx(d).toFixed(1)},${fy(v).toFixed(1)}`).join('');
  const sideY = (h: number) => sideH - 8 - h * 2.0;
  const topY = (l: number) => sideH + 14 + topH / 2 + l * 1.6;
  const lines: string[] = [];
  for (const [club, col] of [['dr', 'var(--gold)'], ['7i', 'var(--accent2)']] as const) {
    const g = styleFlight('classic', club), f = styleFlight(style, club);
    lines.push(`<path d="${path(g.side, sideY)}" class="ghost"/>`, `<path d="${path(f.side, sideY)}" stroke="${col}"/>`);
    lines.push(`<path d="${path(g.top, topY)}" class="ghost"/>`, `<path d="${path(f.top, topY)}" stroke="${col}"/>`);
  }
  const grid = [100, 200, 300].map((d) => `<line x1="${sx(d)}" x2="${sx(d)}" y1="4" y2="${sideH + 14 + topH}" class="g"/><text x="${sx(d) + 3}" y="${sideH + 10}">${d}</text>`).join('');
  return `<svg class="flight-chart" viewBox="0 0 ${W} ${sideH + topH + 20}">
    ${grid}<line x1="${pad}" x2="${W - pad}" y1="${sideY(0)}" y2="${sideY(0)}" class="g"/>
    <line x1="${pad}" x2="${W - pad}" y1="${topY(0)}" y2="${topY(0)}" class="g dash"/>
    <text x="${pad}" y="12" class="lbl">SIDE VIEW</text><text x="${pad}" y="${sideH + 26}" class="lbl">FROM ABOVE</text>
    ${lines.join('')}</svg>`;
}

export class Menus {
  private root: HTMLElement;
  private screen: HTMLElement | null = null;
  private selCourse = save.settings.courseId;
  private selDiff: Difficulty = save.settings.difficulty;
  private selStyle: SwingStyleId = save.swingStyle;
  private selFormat: Format = save.settings.format;
  private selHoles: HoleSet = save.settings.holes;
  /** Last input came from the keyboard: new screens then focus their default item. */
  private kbd = false;
  /** Pause-menu context: Esc belongs to the round (toggles pause), not to our Back buttons. */
  private inMatch = false;
  /** Main-menu tile to re-highlight when coming back from a sub-screen. */
  private mainFocus = 'play';

  constructor(parent: HTMLElement, private hooks: MenuHooks) {
    this.root = h('div', { class: 'menus' });
    parent.append(this.root);
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', () => (this.kbd = false), true);
  }

  private set(el: HTMLElement) {
    clear(this.root);
    this.screen = el;
    el.classList.add('enter');
    setTimeout(() => el.classList.remove('enter'), 800);
    this.root.append(el);
    if (this.kbd) requestAnimationFrame(() => this.screen === el && this.focusDefault());
  }

  hide() {
    clear(this.root);
    this.screen = null;
  }

  get visible() {
    return this.screen !== null;
  }

  // ---------------------------------------------------------------- keyboard navigation

  private onKey(e: KeyboardEvent) {
    if (e.key in DIRS || e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') this.kbd = true;
    if (!this.screen || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      const back = this.inMatch ? null : this.root.querySelector<HTMLElement>('.btn-back');
      if (back) {
        e.preventDefault();
        back.click();
      }
      return;
    }
    const dir = DIRS[e.key];
    if (dir) {
      if (t instanceof HTMLInputElement && t.type === 'range' && dir[0] !== 0) return; // sliders keep left/right
      if (this.move(dir[0], dir[1])) e.preventDefault();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t.classList?.contains('nav')) {
      e.preventDefault();
      (t.querySelector<HTMLElement>('input[type=color]') ?? t).click();
    }
  }

  private navItems() {
    return [...this.root.querySelectorAll<HTMLElement>(NAV)].filter((el) => el.getClientRects().length > 0);
  }

  private focusDefault() {
    const items = this.navItems();
    const el = items.find((x) => x.hasAttribute('data-autofocus')) ?? items[0];
    el?.focus();
  }

  /** Spatial navigation: focus the nearest item in the pressed direction. */
  private move(dx: number, dy: number): boolean {
    const items = this.navItems();
    if (!items.length) return false;
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !items.includes(cur)) {
      this.focusDefault();
      return true;
    }
    const a = cur.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const centre = dx ? (b.left + b.right - a.left - a.right) * dx : (b.top + b.bottom - a.top - a.bottom) * dy;
      const along = dx > 0 ? b.left - a.right : dx < 0 ? a.left - b.right : dy > 0 ? b.top - a.bottom : a.top - b.bottom;
      if (centre <= 0 || along < -6) continue;
      const across = dx ? Math.max(0, b.top - a.bottom, a.top - b.bottom) : Math.max(0, b.left - a.right, a.left - b.right);
      if (dx && across > Math.max(a.height, b.height) * 0.5) continue; // left/right stays on the same row
      const off = dx ? Math.abs(b.top + b.bottom - a.top - a.bottom) : Math.abs(b.left + b.right - a.left - a.right);
      const score = along + across * 4 + off * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    return true;
  }

  // ---------------------------------------------------------------- shared pieces

  private pageHead(kicker: string, title: string, sub: string, back: () => void, right?: HTMLElement): HTMLElement {
    const head = h('div', { class: 'page-head' });
    const bk = h('button', { class: 'btn-back' });
    bk.innerHTML = `${ICON.back}<span>Back</span>${this.inMatch ? '' : '<i class="kc">Esc</i>'}`;
    bk.onclick = back;
    const t = h('div', { class: 'ph-text' });
    t.innerHTML = `<div class="kicker">${kicker}</div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}`;
    head.append(t, h('div', { class: 'ph-right' }, right, bk));
    return head;
  }

  private sectionTitle(n: number, text: string) {
    return h('div', { class: 'section-title' }, h('span', { class: 'n' }, String(n).padStart(2, '0')), text);
  }

  private playerCard(): HTMLElement {
    const lv = playerLevel(save.xpEarned);
    const st = save.stats;
    const avg = bagTier();
    const el = h('div', { class: 'mm-player rise-r' });
    el.innerHTML = `${ring(lv.level, lv.into / lv.next)}
      <div class="who"><div class="nm">${esc(save.name)}</div>
        <div class="rec"><b>${st.won}</b>W &nbsp;<b>${st.lost}</b>L &nbsp;<b>${st.halved}</b>H<span class="sep"></span>${st.played} played</div></div>
      <div class="xprow"><div class="xpbar"><i style="width:${Math.round((lv.into / lv.next) * 100)}%"></i></div>
        <span>${lv.into.toLocaleString()} / ${lv.next.toLocaleString()} XP to level ${lv.level + 1}</span></div>
      <div class="pstats">
        <div class="gold"><small>XP to spend</small><b>${save.xp.toLocaleString()}</b></div>
        <div><small>Bag</small><b class="tier-${Math.round(avg)}">${TIERS[Math.round(avg)].name}</b>${pips(TIERS.length, Math.floor(avg + 1e-6) + 1)}</div>
        <div><small>All-time XP</small><b>${save.xpEarned.toLocaleString()}</b></div>
      </div>`;
    return el;
  }

  // ---------------------------------------------------------------- main menu

  showMain() {
    this.hooks.showroom('menu');
    this.inMatch = false;
    const el = h('div', { class: 'screen menu-main' });
    const brand = h('div', { class: 'mm-brand rise' });
    brand.innerHTML = `${crest()}<div><div class="wordmark"><span>Fairway</span><span class="w2">Legends</span></div>
      <div class="mm-tagline">Match · Stroke · Skins<i></i>9 or 18 Holes<i></i>You vs The Tour</div></div>`;
    const col = h('div', { class: 'mm-col' });
    const go = (key: string, fn: () => void) => () => {
      this.mainFocus = key;
      fn();
    };
    const auto = (x: HTMLElement) => {
      if (x.dataset.k === this.mainFocus) x.dataset.autofocus = '';
      return x;
    };

    const play = auto(h('button', { class: 'mm-play rise', style: '--i:1', 'data-k': 'play' }));
    play.innerHTML = `<span class="k">1v1 Match Play</span><span class="t">Play Match</span>
      <span class="d">Pick a course, holes, format and swing, then take on the Tour.</span><span class="go">${ICON.chevron}</span>`;
    play.onclick = go('play', () => this.showPlay());

    // quick start on the last course with the saved difficulty
    const course = courseById(save.settings.courseId);
    const diff = save.settings.difficulty;
    const feat = auto(h('button', { class: 'mm-feature rise', style: '--i:2', 'data-k': 'quick' }));
    const art = h('span', { class: 'art' });
    art.append(courseArt(course));
    const info = h('span', { class: 'info' });
    const quick = courseForSet(course, save.settings.holes).course;
    const qFmt = FORMATS.find((f) => f.id === save.settings.format)?.name ?? '';
    info.innerHTML = `<span class="k">Quick Play · ${DIFF_INFO[diff].name} · ${qFmt}</span><span class="nm">${esc(course.name)}</span>
      <span class="meta"><span>Par <b>${coursePar(quick)}</b></span><span><b>${courseYards(quick).toLocaleString()}</b> yds</span><span>Wind <b>${course.windMin}-${course.windMax}</b></span></span>
      ${save.best[course.id] ? `<span class="best">${ICON.trophy}Best: ${esc(save.best[course.id])}</span>` : `<span class="loc">${esc(course.location)}</span>`}`;
    const tee = h('span', { class: 'tee' });
    tee.innerHTML = `<span>Tee Off</span>${ICON.play}`;
    feat.append(art, info, tee);
    feat.onclick = go('quick', () => this.hooks.startMatch({ courseId: course.id, difficulty: diff, format: save.settings.format, holes: save.settings.holes }));

    const tiles = h('div', { class: 'mm-tiles' });
    const tile = (i: number, key: string, icon: string, title: string, desc: string, fn: () => void, badge = '') => {
      const x = auto(h('button', { class: 'mm-tile rise', style: `--i:${i}`, 'data-k': key }));
      x.innerHTML = `<span class="ib">${icon}</span><span class="t">${title}${badge ? `<span class="badge">${badge}</span>` : ''}</span><span class="d">${desc}</span>`;
      x.onclick = go(key, fn);
      tiles.append(x);
    };
    const textSize = { normal: 'Normal', large: 'Large', xl: 'Extra large' }[save.settings.textSize];
    const nextEv = CAREER[Math.min(save.career.stage, CAREER.length - 1)];
    tile(3, 'career', ICON.trophy, 'Career', save.career.stage >= CAREER.length ? 'Champion! Replay any event' : `Next: ${nextEv.title}`, () => this.showCareer(), `${Math.min(save.career.stage, CAREER.length)}/${CAREER.length}`);
    tile(3, 'practice', ICON.play, 'Practice', 'No opponent, no pressure', () => this.showPlay(true));
    tile(3, 'golfer', ICON.golfer, 'My Golfer', 'Customize your look', () => this.showEditor());
    tile(3, 'swing', ICON.play, 'Swing Style', `${swingStyleById(save.swingStyle).name} · watch them all`, () => this.showSwing());
    tile(4, 'bag', ICON.bag, 'Golf Bag', `${TIERS[Math.round(bagTier())].name} clubs · upgrade`, () => this.showShop(), save.xp > 0 ? `${save.xp.toLocaleString()} XP` : '');
    tile(5, 'settings', ICON.sliders, 'Settings', `${save.settings.swingMode === 'stick' ? 'Swing Stick' : '3-Click'} · ${textSize} text`, () => this.showSettings());
    tile(6, 'help', ICON.pad, 'How to Play', 'Controls & match rules', () => this.showHelp());

    col.append(play, feat, tiles);
    const foot = h('div', { class: 'mm-foot rise', style: '--i:7' });
    foot.innerHTML = `<span><i class="kc">↑</i><i class="kc">↓</i><i class="kc">←</i><i class="kc">→</i>Navigate</span><span><i class="kc">Enter</i>Select</span>`;
    el.append(brand, col, foot, this.playerCard());
    this.set(el);
  }

  // ---------------------------------------------------------------- match setup

  showPlay(practice = false) {
    this.hooks.showroom('menu');
    // the range is only on the practice page
    if (!practice && this.selCourse === DRIVING_RANGE.id) this.selCourse = save.settings.courseId;
    const el = h('div', { class: 'screen page setup' });
    const head = practice
      ? this.pageHead('Practice', 'Practice', 'No opponent and no score to protect. Warm up on the driving range, or play any hole as often as you like: N skips to the next hole, B drops a ball on the green to practise putting.', () => this.showMain())
      : this.pageHead('Play', 'Match Setup', 'Pick a course, the holes, a format and difficulty. Good swings, holes won and birdies earn XP. Winning the match earns the most.', () => this.showMain());
    const sets = h('div', { class: 'chips seg wide' });
    const formats = h('div', { class: 'diffs formats' });
    const grid = h('div', { class: 'courses' });
    const diffs = h('div', { class: 'diffs' });
    const styles = h('div', { class: 'diffs styles' });
    const summary = h('div', { class: 'summary' });
    const refresh = () => {
      for (const k of grid.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === this.selCourse);
      for (const k of diffs.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === this.selDiff);
      for (const k of styles.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === this.selStyle);
      for (const k of sets.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === this.selHoles);
      for (const k of formats.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === this.selFormat);
      const c = courseById(this.selCourse);
      const sub = courseForSet(c, this.selHoles).course;
      const fmt = FORMATS.find((f) => f.id === this.selFormat)!;
      summary.innerHTML = practice
        ? `<span class="kicker">Practice</span><b>${esc(c.name)}</b><span>${c.id === DRIVING_RANGE.id ? 'Targets from 60 to 250 yards' : 'All 18 holes'} · ${esc(swingStyleById(this.selStyle).name)}</span>`
        : `<span class="kicker">Your match</span><b>${esc(c.name)}</b><span>${DIFF_INFO[this.selDiff].name} · ${HOLE_SETS.find((x) => x.id === this.selHoles)!.name} (par ${coursePar(sub)}) · ${fmt.name} · ${esc(swingStyleById(this.selStyle).name)}</span>`;
    };
    for (const hs of HOLE_SETS) {
      const x = h('div', { class: 'chip nav', tabindex: '0', role: 'button', 'data-id': hs.id }, `${hs.name}`);
      x.title = hs.desc;
      x.onclick = () => {
        this.selHoles = hs.id;
        refresh();
      };
      sets.append(x);
    }
    for (const f of FORMATS) {
      const x = h('div', { class: 'diff nav', tabindex: '0', role: 'button', 'data-id': f.id });
      x.innerHTML = `<div class="dh"><h4>${esc(f.name)}</h4></div><p>${esc(f.desc)}</p>`;
      x.onclick = () => {
        this.selFormat = f.id;
        refresh();
      };
      formats.append(x);
    }
    for (const c of practice ? [DRIVING_RANGE, ...COURSES] : COURSES) {
      const range = c.id === DRIVING_RANGE.id;
      const card = h('div', { class: 'card nav', tabindex: '0', role: 'button', 'data-id': c.id, 'data-k': `course:${c.id}` });
      if (c.id === this.selCourse) card.dataset.autofocus = '';
      const art = h('div', { class: 'art' });
      art.append(courseArt(c));
      art.insertAdjacentHTML('beforeend', `<span class="style-tag">${range ? 'range' : c.foliage ? 'autumn' : c.style}</span><span class="check">${ICON.check}</span>`);
      const body = h('div', { class: 'body' });
      body.innerHTML = range
        ? `<h3>${esc(c.name)}</h3><div class="loc">${esc(c.location)}</div><p>${esc(c.blurb)}</p>
        <div class="stats3"><div><small>Targets</small><b>5</b></div><div><small>Longest</small><b>250</b></div><div><small>Wind mph</small><b>${c.windMin}-${c.windMax}</b></div></div>`
        : `<h3>${esc(c.name)}</h3><div class="loc">${esc(c.location)}</div><p>${esc(c.blurb)}</p>
        <div class="stats3"><div><small>Par</small><b>${coursePar(c)}</b></div><div><small>Yards</small><b>${courseYards(c).toLocaleString()}</b></div><div><small>Wind mph</small><b>${c.windMin}-${c.windMax}</b></div></div>
        ${save.best[c.id] ? `<div class="best">${ICON.trophy}Best: ${esc(save.best[c.id])}</div>` : ''}`;
      card.append(art, body);
      card.onclick = () => {
        this.selCourse = c.id;
        refresh();
      };
      grid.append(card);
    }
    for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
      const x = h('div', { class: `diff d-${d} nav`, tabindex: '0', role: 'button', 'data-id': d });
      x.innerHTML = `<div class="dh"><h4>${DIFF_INFO[d].name}</h4>${pips(3, DIFF_INFO[d].pips)}</div><p>${DIFF_INFO[d].desc}</p>`;
      x.onclick = () => {
        this.selDiff = d;
        refresh();
      };
      diffs.append(x);
    }
    for (const st of SWING_STYLES) {
      const x = h('div', { class: 'diff style-card nav', tabindex: '0', role: 'button', 'data-id': st.id });
      const bar = (label: string, v: number) => `<div class="sbar"><span>${label}</span>${pips(5, v)}</div>`;
      x.innerHTML = `<div class="dh"><h4>${esc(st.name)}</h4></div><div class="tag-line">${esc(st.tagline)}</div><p>${esc(st.desc)}</p>
        <div class="sbars">${bar('Distance', st.bars.distance)}${bar('Accuracy', st.bars.accuracy)}${bar('Short game', st.bars.control)}${bar('Forgiveness', st.bars.forgiveness)}</div>
        <div class="pros">Swings like <b>${esc(st.pros)}</b></div>`;
      x.onclick = () => {
        this.selStyle = st.id;
        save.swingStyle = st.id;
        persist();
        refresh();
      };
      styles.append(x);
    }
    const bar = h('div', { class: 'action-bar' });
    const bag = h('button', { class: 'btn' });
    bag.innerHTML = `${ICON.bag}<span>Check my bag</span>`;
    bag.onclick = () => this.showShop(() => this.showPlay());
    const go = h('button', { class: 'btn primary big' });
    go.innerHTML = `<span>${practice ? 'Start Practice' : 'Tee Off'}</span>${ICON.play}`;
    if (practice) go.dataset.k = 'start-practice';
    go.onclick = () => {
      if (this.selCourse !== DRIVING_RANGE.id) save.settings.courseId = this.selCourse;
      if (!practice) {
        save.settings.difficulty = this.selDiff;
        save.settings.format = this.selFormat;
        save.settings.holes = this.selHoles;
      }
      persist();
      this.hooks.startMatch({ courseId: this.selCourse, difficulty: practice ? save.settings.difficulty : this.selDiff, format: this.selFormat, holes: this.selHoles, practice });
    };
    bar.append(summary, bag, go);
    refresh();
    const watch = h('button', { class: 'btn watch-swings' });
    watch.innerHTML = `${ICON.play}<span>Watch the swings</span>`;
    watch.onclick = () => this.showSwing(() => this.showPlay(practice));
    const styleHead = (n: number) => {
      const t = this.sectionTitle(n, 'Swing style');
      t.append(watch);
      return t;
    };
    if (practice) el.append(head, this.sectionTitle(1, 'Choose your course'), grid, styleHead(2), styles, bar);
    else el.append(head, this.sectionTitle(1, 'Choose your course'), grid, this.sectionTitle(2, 'Holes'), sets, this.sectionTitle(3, 'Format'), formats, this.sectionTitle(4, 'Difficulty'), diffs, styleHead(5), styles, bar);
    this.set(el);
  }

  // ---------------------------------------------------------------- swing styles

  /** Pick a swing style: the golfer demonstrates each one, with its ball flights charted. */
  showSwing(onBack?: () => void) {
    this.hooks.showroom('swing');
    const back = () => {
      this.hooks.swingDemo(null);
      if (onBack) onBack();
      else this.showMain();
    };
    const el = h('div', { class: 'screen editor swing-screen' });
    const side = h('div', { class: 'side' });
    const body = h('div', { class: 'ed-body' });
    const list = h('div', { class: 'swing-list' });
    const detail = h('div', { class: 'swing-detail' });
    const render = () => {
      const st = swingStyleById(this.selStyle);
      for (const k of list.children) k.classList.toggle('sel', (k as HTMLElement).dataset.id === st.id);
      const dr = styleFlight(st.id, 'dr'), i7 = styleFlight(st.id, '7i');
      const bar = (label: string, v: number) => `<div class="sbar"><span>${label}</span>${pips(5, v)}</div>`;
      detail.innerHTML = `<div class="sd-head"><h3>${esc(st.name)}</h3><div class="tag-line">${esc(st.tagline)}</div></div>
        <div class="pros">Swings like <b>${esc(st.pros)}</b></div>
        <div class="chart-title">Ball flight <span><i class="k dr"></i>Driver ${Math.round(dr.carry)} carry · ${Math.round(dr.total)} total <i class="k i7"></i>7-iron ${Math.round(i7.carry)}</span></div>
        ${flightChart(st.id)}
        <div class="chart-note">Dashed: Classic Tour, for comparison. Perfect strike, no wind.</div>
        <div class="sbars">${bar('Distance', st.bars.distance)}${bar('Accuracy', st.bars.accuracy)}${bar('Short game', st.bars.control)}${bar('Forgiveness', st.bars.forgiveness)}</div>
        <p>${esc(st.desc)}</p>`;
      this.hooks.swingDemo(st);
    };
    for (const st of SWING_STYLES) {
      const x = h('div', { class: 'swing-row nav', tabindex: '0', role: 'button', 'data-id': st.id });
      if (st.id === this.selStyle) x.dataset.autofocus = '';
      x.innerHTML = `<b>${esc(st.name)}</b><span>${esc(st.pros)}</span>`;
      x.onclick = () => {
        this.selStyle = st.id;
        save.swingStyle = st.id;
        persist();
        render();
      };
      list.append(x);
    }
    body.append(list, detail);
    const foot = h('div', { class: 'ed-foot' });
    const done = h('button', { class: 'btn primary' });
    done.innerHTML = `${ICON.check}<span>Use this swing</span>`;
    done.onclick = back;
    foot.append(done);
    side.append(this.pageHead('Your swing', 'Swing Style', 'Each style plays differently, like the tour pros known for it. Your golfer shows the swing.', back), body, foot);
    el.append(side);
    this.set(el);
    render();
  }

  // ---------------------------------------------------------------- career

  showCareer() {
    this.hooks.showroom('menu');
    const el = h('div', { class: 'screen page career' });
    const done = Math.min(save.career.stage, CAREER.length);
    el.append(this.pageHead('Career', 'The Road to Legend', `Win each event to unlock the next, from the club championship to the Legends Final. Every win pays an XP purse on top of your match XP. ${done} of ${CAREER.length} won.`, () => this.showMain()));
    const list = h('div', { class: 'career-list' });
    CAREER.forEach((ev, i) => {
      const state = i < save.career.stage ? 'won' : i === save.career.stage ? 'next' : 'locked';
      const c = courseById(ev.courseId);
      const pers = PERSONALITIES.find((p) => p.id === ev.personality)!;
      const fmt = FORMATS.find((f) => f.id === ev.format)!.name;
      const set = HOLE_SETS.find((x) => x.id === ev.holes)!.name;
      const x = h('div', { class: `career-ev ${state} ${state !== 'locked' ? 'nav' : ''}`, tabindex: state !== 'locked' ? '0' : '-1', role: 'button' });
      if (state === 'next') x.dataset.autofocus = '';
      x.innerHTML = `<div class="n">${String(i + 1).padStart(2, '0')}</div>
        <div class="body"><h3>${esc(ev.title)}</h3><div class="st">${esc(ev.stage)}</div>
          <div class="meta"><span>${esc(c.name)}</span><span>${set}</span><span>${fmt}</span><span>${DIFF_INFO[ev.difficulty].name}</span></div>
          <div class="opp">Opponent: <b>${esc(pers.label)}</b> — ${esc(pers.blurb)}</div></div>
        <div class="right"><div class="purse">${ev.purse.toLocaleString()} XP</div><div class="badge">${state === 'won' ? `${ICON.check} Won` : state === 'next' ? `Play ${ICON.play}` : 'Locked'}</div></div>`;
      if (state !== 'locked') x.onclick = () => this.hooks.startMatch({ courseId: ev.courseId, difficulty: ev.difficulty, format: ev.format, holes: ev.holes, careerEvent: ev.id });
      list.append(x);
    });
    el.append(list);
    this.set(el);
  }

  // ---------------------------------------------------------------- golfer editor

  showEditor() {
    this.hooks.showroom('editor');
    const a = save.appearance;
    const el = h('div', { class: 'screen editor' });
    const side = h('div', { class: 'side' });
    const body = h('div', { class: 'ed-body' });
    const update = () => {
      this.hooks.previewAppearance(save.appearance);
      persist();
    };
    const sec = (t: string) => body.append(h('div', { class: 'ed-sec' }, t));
    // name
    const nameF = h('div', { class: 'field' }, h('label', {}, 'Name'));
    const inp = h('input', { type: 'text', maxlength: '18', value: save.name, spellcheck: 'false' });
    inp.addEventListener('input', () => {
      save.name = inp.value.trim().slice(0, 18) || 'Player';
      persist();
    });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    nameF.append(inp);
    const swatchField = (label: string, key: keyof Appearance, palette: string[]) => {
      const f = h('div', { class: 'field' }, h('label', {}, label));
      const row = h('div', { class: 'swatches' });
      const render = () => {
        clear(row);
        for (const c of palette) {
          const s = h('div', { class: `swatch nav ${String(a[key]) === c ? 'sel' : ''}`, tabindex: '0', role: 'button', 'data-k': `${key}:${c}` });
          s.style.background = c;
          s.onclick = () => {
            (a as unknown as Record<string, unknown>)[key] = c;
            update();
            keepFocus(render);
          };
          row.append(s);
        }
        const isCustom = !palette.includes(String(a[key]));
        const custom = h('div', { class: `swatch custom nav ${isCustom ? 'sel' : ''}`, tabindex: '0', title: 'Custom colour', 'data-k': `${key}:custom` });
        const dot = h('i');
        if (isCustom) dot.style.background = String(a[key]);
        const ci = h('input', { type: 'color', value: String(a[key]), tabindex: '-1' });
        ci.addEventListener('input', () => {
          (a as unknown as Record<string, unknown>)[key] = ci.value;
          update();
          for (const s of row.children) s.classList.toggle('sel', s === custom);
          dot.style.background = ci.value;
        });
        custom.append(dot, ci);
        row.append(custom);
      };
      render();
      f.append(row);
      body.append(f);
    };
    const chipField = <T extends string>(label: string, options: T[], get: () => T, setv: (v: T) => void) => {
      const f = h('div', { class: 'field' }, h('label', {}, label));
      const row = h('div', { class: 'chips seg' });
      const render = () => {
        clear(row);
        for (const o of options) {
          const c = h('div', { class: `chip nav ${get() === o ? 'sel' : ''}`, tabindex: '0', role: 'button', 'data-k': `${label}:${o}` }, o);
          c.onclick = () => {
            setv(o);
            update();
            keepFocus(render);
          };
          row.append(c);
        }
      };
      render();
      f.append(row);
      body.append(f);
    };
    const slider = (label: string, min: number, max: number, step: number, get: () => number, setv: (v: number) => void, fmt: (v: number) => string) => {
      const f = h('div', { class: 'field' });
      const val = h('b', {}, fmt(get()));
      const lab = h('label', {}, label, val);
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
      const fill = () => r.style.setProperty('--p', `${((get() - min) / (max - min)) * 100}%`);
      r.addEventListener('input', () => {
        setv(parseFloat(r.value));
        val.textContent = fmt(get());
        fill();
        update();
      });
      fill();
      f.append(lab, r);
      body.append(f);
    };
    sec('Player');
    body.append(nameF);
    sec('Appearance');
    swatchField('Skin tone', 'skin', SKIN);
    chipField('Hair style', ['Short', 'Long', 'None'] as const as unknown as Appearance['hairStyle'][], () => a.hairStyle, (v) => (a.hairStyle = v));
    chipField('Face', ['Standard', 'Beard', 'Older', 'Freckles'] as FaceStyle[], () => a.face ?? 'Standard', (v) => (a.face = v));
    swatchField('Hair colour', 'hair', HAIR);
    sec('Apparel');
    chipField('Headwear', ['Cap', 'Visor', 'Bucket', 'None'] as Appearance['hat'][], () => a.hat, (v) => (a.hat = v));
    swatchField('Hat colour', 'hatColor', CLOTH);
    swatchField('Shirt', 'shirt', CLOTH);
    swatchField('Trousers', 'pants', CLOTH);
    swatchField('Shoes', 'shoes', ['#f4f4f4', '#111111', '#5a3a22', '#1c2b4a', '#b5121b', '#8a8a8a']);
    swatchField('Belt', 'belt', ['#111111', '#f2f2f2', '#5a3a22', '#1c2b4a', '#b5121b']);
    chipField('Sunglasses', ['Off', 'On'], () => (a.sunglasses ? 'On' : 'Off'), (v) => (a.sunglasses = v === 'On'));
    // level unlocks: everything shows, locked items say the level that unlocks them
    const lvl = playerLevel(save.xpEarned).level;
    const lockedTip = (u: Unlock) => `Unlocks at level ${u.level} (you are level ${lvl})`;
    const unlockChips = (label: string, items: Unlock[], get: () => string, setv: (id: string) => void) => {
      const f = h('div', { class: 'field' }, h('label', {}, label));
      const row = h('div', { class: 'chips seg wrap' });
      const render = () => {
        clear(row);
        for (const u of items) {
          const locked = u.level > lvl;
          const c = h('div', { class: `chip nav ${get() === u.id ? 'sel' : ''} ${locked ? 'locked' : ''}`, tabindex: '0', role: 'button', 'data-k': `${label}:${u.id}` });
          c.innerHTML = locked ? `${ICON.lock}<span>${esc(u.name)}</span><small>Lv ${u.level}</small>` : esc(u.name);
          c.title = locked ? lockedTip(u) : u.name;
          c.onclick = () => {
            if (locked) return;
            setv(u.id);
            update();
            keepFocus(render);
          };
          row.append(c);
        }
      };
      render();
      f.append(row);
      body.append(f);
    };
    sec('Level unlocks');
    unlockChips('Shirt pattern', SHIRT_PATTERNS, () => a.shirtPattern, (v) => (a.shirtPattern = v as Appearance['shirtPattern']));
    swatchField('Pattern colour', 'shirtAccent', CLOTH);
    {
      const f = h('div', { class: 'field' }, h('label', {}, 'Ball colour'));
      const row = h('div', { class: 'swatches' });
      const render = () => {
        clear(row);
        for (const b of BALL_COLORS) {
          const locked = b.level > lvl;
          const sw = h('div', { class: `swatch ball nav ${a.ball === b.id ? 'sel' : ''} ${locked ? 'locked' : ''}`, tabindex: '0', role: 'button', 'data-k': `ball:${b.id}` });
          sw.style.background = `radial-gradient(circle at 35% 30%, #fff8 0, #fff0 45%), #${b.hex.toString(16).padStart(6, '0')}`;
          sw.title = locked ? `${b.name} · ${lockedTip(b)}` : b.name;
          if (locked) sw.innerHTML = `<span class="lv">${b.level}</span>`;
          sw.onclick = () => {
            if (locked) return;
            a.ball = b.id;
            update();
            keepFocus(render);
          };
          row.append(sw);
        }
      };
      render();
      f.append(row);
      body.append(f);
    }
    unlockChips('Club finish', CLUB_FINISHES, () => a.clubFinish, (v) => (a.clubFinish = v));
    sec('Physique');
    slider('Build', 0, 1, 0.01, () => a.build, (v) => (a.build = v), (v) => (v < 0.25 ? 'Athletic' : v < 0.6 ? 'Solid' : 'Heavy'));
    slider('Height', 1.6, 2.0, 0.01, () => a.height, (v) => (a.height = v), (v) => `${Math.floor(v / 0.3048)}'${Math.round(((v / 0.3048) % 1) * 12)}" (${v.toFixed(2)} m)`);
    const foot = h('div', { class: 'ed-foot' });
    const done = h('button', { class: 'btn primary' });
    done.innerHTML = `${ICON.check}<span>Done</span>`;
    done.onclick = () => this.showMain();
    foot.append(done);
    side.append(this.pageHead('Create your player', 'My Golfer', 'Changes save automatically.', () => this.showMain()), body, foot);
    const hint = h('div', { class: 'drag-hint' });
    hint.innerHTML = `${ICON.rotate}<span>Drag to rotate</span>`;
    el.append(side, hint);
    this.set(el);
    this.hooks.previewAppearance(a);
  }

  // ---------------------------------------------------------------- golf bag

  showShop(onBack?: () => void) {
    this.hooks.showroom('shop');
    const el = h('div', { class: 'screen page shop' });
    const render = () => {
      clear(el);
      const pill = h('div', { class: 'xp-pill' });
      pill.innerHTML = `<span class="coin">${ICON.star}</span><span><small>XP to spend</small><b>${save.xp.toLocaleString()}</b></span>`;
      const head = this.pageHead('Equipment', 'Golf Bag', 'Every club starts as a rusty hand-me-down. Spend the XP you earn in matches to upgrade them: more distance, tighter dispersion, more spin.', () => (onBack ? onBack() : this.showMain()), pill);
      const ladder = h('div', { class: 'tier-ladder' });
      ladder.innerHTML = TIERS.map((t, i) => `<div class="tier-${i}"><b>${t.name}</b><span>Tier ${i + 1} · ${Math.round(t.power * 100)}% dist</span></div>`).join('');
      const grid = h('div', { class: 'shop-grid' });
      for (const c of CLUBS) {
        const tier = save.clubs[c.id] ?? 0;
        const t = TIERS[tier];
        const nt = TIERS[Math.min(MAX_TIER, tier + 1)];
        const card = h('div', { class: `club-card t${tier}` });
        const carry = c.kind === 'putter' ? '' : `<b>${Math.round(toYards(fullCarry(c, tier, SHOT_TYPES[0], Surf.Fairway, true)))}</b><small>yds</small>`;
        const nextCarry = c.kind === 'putter' || tier >= MAX_TIER ? '' : `<span class="nx">→ ${Math.round(toYards(fullCarry(c, tier + 1, SHOT_TYPES[0], Surf.Fairway, true)))}</span>`;
        const bar = (label: string, v: number, nv: number, max: number) =>
          `<span>${label}</span><div class="b"><i style="width:${(v / max) * 100}%"></i>${tier < MAX_TIER ? `<u style="left:${(v / max) * 100}%;width:${Math.max(0, (nv - v) / max) * 100}%"></u>` : ''}</div><span>${Math.round((v / max) * 100)}</span>`;
        card.innerHTML = `<div><span class="short">${esc(c.short)}</span><h3>${esc(c.name)}</h3><span class="tiername tier-${tier}">${t.name}</span></div>
          <div class="cc-right"><div class="carry">${carry}${nextCarry}</div>${pips(TIERS.length, tier + 1)}</div>
          <div class="bars">${c.kind === 'putter' ? '' : bar('Distance', t.power, nt.power, 1.04)}${bar('Accuracy', t.accuracy, nt.accuracy, 1)}${c.kind === 'putter' ? '' : bar('Spin', t.spin, nt.spin, 1.12)}</div>`;
        const cost = upgradeCost(c, tier);
        const btn = h('button', { class: 'btn buy', 'data-k': `buy:${c.id}` });
        if (cost === null) {
          btn.innerHTML = `${ICON.check}<span>Maxed out</span>`;
          btn.setAttribute('disabled', '');
        } else {
          btn.innerHTML = `<span>Upgrade to ${TIERS[tier + 1].name}</span><span class="cost">${cost} XP</span>`;
          if (save.xp < cost) btn.setAttribute('disabled', '');
          else btn.classList.add('can');
          btn.onclick = () => {
            if (save.xp < cost) return;
            save.xp -= cost;
            save.clubs[c.id] = tier + 1;
            persist();
            keepFocus(render);
          };
        }
        const wrap = h('div', { class: 'buy' });
        wrap.append(btn);
        card.append(wrap);
        grid.append(card);
      }
      el.append(head, ladder, grid);
    };
    render();
    this.set(el);
  }

  // ---------------------------------------------------------------- settings

  showSettings(onBack?: () => void) {
    const el = h('div', { class: 'screen page settings' });
    const render = () => {
      clear(el);
      el.append(this.pageHead('Options', 'Settings', 'Saved automatically.', () => (onBack ? onBack() : this.showMain())));
      const list = h('div', { class: 'settings-list' });
      el.append(list);
      const row = (title: string, desc: string, options: [string, string][], get: () => string, setv: (v: string) => void) => {
        const r = h('div', { class: 'toggle-row' });
        const l = h('div', {});
        l.innerHTML = `<div class="tt">${title}</div><div class="d">${desc}</div>`;
        const chips = h('div', { class: 'chips seg' });
        for (const [v, label] of options) {
          const c = h('div', { class: `chip nav ${get() === v ? 'sel' : ''}`, tabindex: '0', role: 'button', 'data-k': `${title}:${v}` }, label);
          if (list.childElementCount === 0 && get() === v) c.dataset.autofocus = '';
          c.onclick = () => {
            setv(v);
            persist();
            this.hooks.settingsChanged();
            keepFocus(render);
          };
          chips.append(c);
        }
        r.append(l, chips);
        list.append(r);
      };
      // one-click presets over the two graphics settings below
      const preset = () => {
        const { quality: q, gfxPriority: g } = save.settings;
        return q === 'low' && g === 'smooth' ? 'perf' : q === 'medium' && g === 'balanced' ? 'bal' : q === 'high' && g === 'quality' ? 'best' : 'custom';
      };
      row('Graphics preset', 'Performance runs smoothest on laptops; Best looking is for gaming PCs. Custom: you have set the two graphics options at the bottom yourself.', [['perf', 'Performance'], ['bal', 'Balanced'], ['best', 'Best looking'], ['custom', 'Custom']], preset, (v) => {
        if (v === 'perf') Object.assign(save.settings, { quality: 'low', gfxPriority: 'smooth' });
        else if (v === 'bal') Object.assign(save.settings, { quality: 'medium', gfxPriority: 'balanced' });
        else if (v === 'best') Object.assign(save.settings, { quality: 'high', gfxPriority: 'quality' });
      });
      row('Auto graphics', 'If the game keeps running slowly, lower the graphics quality a step at the start of the next hole (never below Low).', [['on', 'On'], ['off', 'Off']], () => (save.settings.autoGfx ? 'on' : 'off'), (v) => (save.settings.autoGfx = v === 'on'));
      row('Swing control', 'Swing Stick: hold, pull the mouse down, push up (tempo + straightness). 3-Click: classic power/accuracy meter.', [['stick', 'Swing Stick'], ['threeClick', '3-Click']], () => save.settings.swingMode, (v) => (save.settings.swingMode = v as 'stick' | 'threeClick'));
      row('Gimmes', 'Concede short putts for both players (4 ft on Easy, 3 ft on Medium, 2½ ft on Hard).', [['on', 'On'], ['off', 'Off']], () => (save.settings.gimmes ? 'on' : 'off'), (v) => (save.settings.gimmes = v === 'on'));
      row('Weather', 'Random: each round brings its own weather (wind, overcast skies or rain that softens the greens). Always fair: sunshine every round.', [['random', 'Random'], ['fair', 'Always fair']], () => save.settings.weather, (v) => (save.settings.weather = v as 'random' | 'fair'));
      row('Sound', 'Synthesized strike, crowd and ambience sounds, and music.', [['on', 'On'], ['off', 'Off']], () => (save.settings.sound ? 'on' : 'off'), (v) => (save.settings.sound = v === 'on'));
      const vol = (title: string, desc: string, key: 'volMaster' | 'volEffects' | 'volAmbience' | 'volMusic') => {
        const r = h('div', { class: 'toggle-row' });
        const l = h('div', {});
        l.innerHTML = `<div class="tt">${title}</div><div class="d">${desc}</div>`;
        const wrap = h('div', { class: 'vol' });
        const input = h('input', { type: 'range', min: '0', max: '100', step: '5', class: 'nav' });
        input.value = String(Math.round(save.settings[key] * 100));
        const out = h('b', {}, `${input.value}%`);
        const fill = () => input.style.setProperty('--p', `${input.value}%`);
        fill();
        input.oninput = () => {
          save.settings[key] = Number(input.value) / 100;
          out.textContent = `${input.value}%`;
          fill();
          persist();
          this.hooks.settingsChanged();
        };
        wrap.append(input, out);
        r.append(l, wrap);
        list.append(r);
      };
      vol('Master volume', 'Everything at once.', 'volMaster');
      vol('Effects', 'Club strikes, the ball, the crowd.', 'volEffects');
      vol('Ambience', 'Wind, surf, birds, rain and the course around you.', 'volAmbience');
      vol('Music', 'Background music in the menus (and on the course, if turned on below).', 'volMusic');
      row('Music during rounds', 'Most golf games keep the course quiet so you hear the strike and the crowd; turn this on for soft music while you play.', [['off', 'Off'], ['on', 'On']], () => (save.settings.musicInRound ? 'on' : 'off'), (v) => (save.settings.musicInRound = v === 'on'));
      row('Wind strength', 'How hard the wind blows in rounds. Light takes the edge off; Full is the real thing.', [['calm', 'Calm'], ['light', 'Light'], ['full', 'Full']], () => save.settings.wind, (v) => (save.settings.wind = v as 'calm' | 'light' | 'full'));
      row('Text size', 'Size of all on-screen text in the menus and HUD.', [['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra Large']], () => save.settings.textSize, (v) => (save.settings.textSize = v as TextSize));
      row('Graphics priority', 'The game adjusts resolution and effects on the fly. Smooth keeps the frame rate high (about 60 fps); Balanced aims for about 45; Best looking keeps full detail down to about 30 fps.', [['smooth', 'Smooth'], ['balanced', 'Balanced'], ['quality', 'Best looking']], () => save.settings.gfxPriority, (v) => (save.settings.gfxPriority = v as 'smooth' | 'balanced' | 'quality'));
      row('Graphics quality', 'Lower settings reduce shadow resolution, terrain detail and grass density.', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], () => save.settings.quality, (v) => (save.settings.quality = v as 'high' | 'medium' | 'low'));
      const reset = h('button', { class: 'btn small danger' }, 'Reset all progress');
      let armed = false;
      reset.onclick = () => {
        if (!armed) {
          armed = true;
          reset.textContent = 'Click again to confirm reset';
          reset.classList.add('armed');
          return;
        }
        resetSave();
        this.hooks.settingsChanged();
        render();
      };
      const danger = h('div', { class: 'danger-zone' });
      danger.innerHTML = `<div><div class="tt">Reset progress</div><div class="d">Clears your XP, club upgrades, stats and golfer. This cannot be undone.</div></div>`;
      danger.append(reset);
      list.append(danger);
    };
    render();
    this.set(el);
  }

  // ---------------------------------------------------------------- how to play

  showHelp(onBack?: () => void) {
    const el = h('div', { class: 'screen page guide' });
    const head = this.pageHead('Guide', 'How to Play', 'Play match play, stroke play or skins over 9 or 18 holes, work through the Career ladder, or warm up in Practice.', () => (onBack ? onBack() : this.showMain()));
    const grid = h('div', { class: 'guide-grid' });
    const controls = h('div', { class: 'm-card' });
    const k = (...ks: string[]) => ks.map((x) => `<span class="key">${x}</span>`).join('');
    const rows: [string, string][] = [
      [k('LMB'), '<b>Swing Stick:</b> hold the left mouse button, pull <b>down</b> to the blue power line (backswing), then push <b>up</b> past where you started. A smooth, straight push = a pure strike. Drifting right pushes/slices, left pulls/hooks. Too fast = hook, too slow = weak slice. Let go during the backswing to cancel.'],
      [k('Click ×3'), '<b>3-Click mode:</b> click to start, click at the blue line for power, click again inside the green impact zone.'],
      [k('←', '→'), "Pick a club from your bag (inventory bar shows each club's carry)."],
      [k('Q', 'E'), 'Shot type: Normal, Power, Draw, Fade, Punch, Pitch, Flop, Chip, Bump &amp; Run (depends on club).'],
      [k('A', 'D'), `Aim left / right (hold ${k('Shift')} for fine aim).`],
      [`${k('W', 'S')} / wheel`, 'Set how far you want to hit it — the landing ring, arc and carry/total numbers update live, and the blue line on the swing meter moves.'],
      [k('V'), 'Target camera: look at the landing area.'],
      [k('G'), 'Green read: elevated view with the slope grid. Dots flow downhill; colour shows steepness.'],
      [k('R'), 'Reset aim and club suggestion.'],
      [k('C'), 'Spin: Normal, Backspin (higher, stops fast) or Topspin (lower, runs out).'],
      [k('P'), 'Replay the last shot (yours or your opponent\'s).'],
      [k('Enter'), "Skip the opponent's shot."],
      [k('N', 'B'), 'Practice only: next hole · drop a ball on the green for putting practice.'],
      [k('Space'), 'Skip flyover · hold to fast-forward ball roll.'],
      [k('Tab'), 'Scorecard.'],
      [k('Esc'), 'Pause menu.'],
    ];
    controls.innerHTML = `<div class="card-title">Controls</div><div class="controls-table">${rows.map(([keys, d]) => `<span>${keys}</span><span>${d}</span>`).join('')}</div>`;
    const rules = h('div', { class: 'm-card' });
    rules.innerHTML = `<div class="card-title">Formats</div><ul class="rules">
        <li><b>Match play:</b> win holes, not strokes. The lowest score on a hole wins it, a tie halves it, and the match ends once a lead is out of reach, for example <b>3&amp;2</b>.</li>
        <li><b>Stroke play:</b> both players hole out on every hole; the lowest total wins.</li>
        <li><b>Skins:</b> each hole is worth a skin. Tie a hole and its skin carries over, so the next hole is worth more.</li>
        <li>Short putts inside the gimme range are conceded for both players (see Settings). On Easy, your first ball in water or out of bounds on each hole is a free <b>mulligan</b>.</li>
      </ul><div class="card-title">Swing styles &amp; opponents</div><ul class="rules">
        <li>Your <b>swing style</b> (Match Setup) changes distance, accuracy, ball flight and how forgiving the timing is.</li>
        <li>Opponents have personalities (Bomber, Grinder, Magician…) built on the same styles.</li>
        <li><b>Weather</b> varies by round: wind, overcast skies, or rain that softens greens and slows the ball.</li>
      </ul><div class="card-title">Earning XP</div><ul class="rules">
        <li>Good swings, holes won, birdies and better all earn XP. Winning the match earns the most, and harder difficulties pay more.</li>
        <li>Spend XP in the <b>Golf Bag</b> to upgrade clubs: more distance, tighter dispersion and more spin.</li>
        <li>Quitting a match from the pause menu earns no XP.</li>
      </ul>`;
    grid.append(controls, rules);
    el.append(head, grid);
    this.set(el);
  }

  // ---------------------------------------------------------------- loading / pause

  showLoading(title: string, sub: string) {
    const el = h('div', { class: 'screen loading' });
    el.innerHTML = `${crest()}<div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div><div class="lbar"><i></i></div>`;
    this.set(el);
  }

  showPause() {
    this.inMatch = true;
    const el = h('div', { class: 'screen pause' });
    const sheet = h('div', { class: 'sheet panel' });
    sheet.innerHTML = `${crest()}<h2>Paused</h2>`;
    const b = (label: string, icon: string, fn: () => void, primary = false) => {
      const x = h('button', { class: `btn ${primary ? 'primary' : ''}` });
      x.innerHTML = `${icon}<span>${label}</span>`;
      x.onclick = fn;
      sheet.append(x);
    };
    b('Resume', ICON.play, () => this.hooks.resume(), true);
    b('Controls', ICON.pad, () => this.showHelp(() => this.showPause()));
    b('Settings', ICON.sliders, () => this.showSettings(() => this.showPause()));
    b('Quit match (no XP)', ICON.exit, () => this.hooks.quitMatch());
    el.append(sheet);
    this.set(el);
  }

  // ---------------------------------------------------------------- results

  showResults(m: MatchState, course: CourseDef, diff: Difficulty, opponent: string, options: MatchOptions, onDone: () => void) {
    this.hooks.showroom('menu');
    this.inMatch = false;
    const xp = computeXp(m, diff);
    const res = m.result;
    const earnedBefore = save.xpEarned;
    save.xp += xp.total;
    save.xpEarned += xp.total;
    save.stats.played++;
    if (res === 'won') save.stats.won++;
    else if (res === 'lost') save.stats.lost++;
    else save.stats.halved++;
    for (const hr of m.holes) {
      if (hr.winner === 'player') save.stats.holesWon++;
      if (hr.player !== null && hr.winner && hr.playerHoled) {
        if (hr.player === 1) save.stats.aces++;
        else if (hr.player - hr.par <= -2) save.stats.eagles++;
        else if (hr.player - hr.par === -1) save.stats.birdies++;
      }
    }
    if (res === 'won') save.best[course.id] = `${diff}: ${m.statusText()}`;
    // career: winning the current event pays its purse and unlocks the next one
    const ev = careerEvent(options.careerEvent);
    let careerNote = '';
    if (ev) {
      const idx = CAREER.indexOf(ev);
      if (res === 'won' && idx === save.career.stage) {
        save.career.stage++;
        xp.lines.push({ label: `${ev.title} purse`, xp: ev.purse });
        xp.total += ev.purse;
        save.xp += ev.purse;
        save.xpEarned += ev.purse;
        const next = CAREER[save.career.stage];
        careerNote = next ? `Career: <b>${esc(ev.title)}</b> won! Next up: <b>${esc(next.title)}</b>` : `Career complete: you are a <b>Fairway Legend</b>!`;
      } else if (res === 'won') careerNote = `Career: ${esc(ev.title)} won again.`;
      else careerNote = `Career: ${esc(ev.title)} — win it to move on.`;
    }
    persist();
    const el = h('div', { class: 'screen results' });
    const sheet = h('div', { class: 'sheet panel' });
    const title = res === 'won' ? 'YOU WIN!' : res === 'lost' ? 'DEFEAT' : 'ALL SQUARE';
    const holes = m.holes;
    sheet.innerHTML = `<div class="res-hero ${res}">
        <div class="kicker">${esc(course.name)} · ${DIFF_INFO[diff].name} · vs ${esc(opponent)}</div>
        <h1 class="${res}">${title}</h1><div class="res-status">${esc(m.statusText())}</div>${careerNote ? `<div class="res-career">${careerNote}</div>` : ''}</div>
      <div class="res-body">
        <div><div class="card-title">XP earned</div>
          <div class="xp-lines">${xp.lines.map((l) => `<div><span>${esc(l.label)}</span><b>+${l.xp}</b></div>`).join('') || '<div><span>No XP this time — win holes to earn some.</span></div>'}
          <div class="total"><span>Total</span><b class="xp-count">+0</b></div></div></div>
        <div><div class="card-title">Player level</div>
          <div class="xp-progress"><div class="lvrow"><span>Level <b class="lv">1</b></span><span class="cnt"></span></div><div class="xpbar"><i></i></div><div class="lvup hidden">LEVEL UP!</div></div>
          <div class="res-bal">XP to spend <b>${save.xp.toLocaleString()}</b></div></div>
      </div>
      <div class="res-card"><table class="res-table">
        <tr>${['Hole', ...holes.map((_, i) => String(i + m.firstHole))].map((x) => `<th>${x}</th>`).join('')}</tr>
        <tr class="par"><td>Par</td>${holes.map((hr) => `<td>${hr.par}</td>`).join('')}</tr>
        <tr><td>${esc(save.name)}</td>${holes.map((hr) => `<td class="${hr.winner === 'player' ? 'w' : ''}">${hr.player ?? '-'}</td>`).join('')}</tr>
        <tr><td>${esc(opponent)}</td>${holes.map((hr) => `<td class="${hr.winner === 'ai' ? 'l' : ''}">${hr.ai ?? '-'}</td>`).join('')}</tr>
      </table></div>`;
    const row = h('div', { class: 'res-actions' });
    const up = h('button', { class: 'btn primary' });
    up.innerHTML = `${ICON.bag}<span>Upgrade clubs (${save.xp} XP)</span>`;
    up.onclick = () => this.showShop(() => onDone());
    const again = h('button', { class: 'btn' });
    again.innerHTML = `${ICON.again}<span>Play again</span>`;
    again.onclick = () => this.hooks.startMatch(options);
    const menu = h('button', { class: 'btn' });
    menu.innerHTML = `${ICON.home}<span>Main menu</span>`;
    menu.onclick = () => onDone();
    row.append(up, again, menu);
    sheet.append(row);
    el.append(sheet);
    this.set(el);
    this.animateXp(sheet, earnedBefore, xp.total);
  }

  /** Counts the earned XP up and fills the level bar, flagging any level-ups. */
  private animateXp(sheet: HTMLElement, before: number, gained: number) {
    const count = sheet.querySelector('.xp-count') as HTMLElement;
    const lvEl = sheet.querySelector('.xp-progress .lv') as HTMLElement;
    const cnt = sheet.querySelector('.xp-progress .cnt') as HTMLElement;
    const bar = sheet.querySelector('.xp-progress .xpbar i') as HTMLElement;
    const lvUp = sheet.querySelector('.xp-progress .lvup') as HTMLElement;
    const startLevel = playerLevel(before).level;
    const dur = gained > 0 ? 1.8 : 0;
    const t0 = performance.now();
    let chimed = false;
    const frame = () => {
      if (!sheet.isConnected) return;
      const u = dur ? Math.min(1, (performance.now() - t0) / 1000 / dur) : 1;
      const k = 1 - (1 - u) * (1 - u) * (1 - u);
      const g = Math.round(gained * k);
      const lv = playerLevel(before + g);
      count.textContent = `+${g}`;
      lvEl.textContent = String(lv.level);
      cnt.textContent = `${lv.into} / ${lv.next} XP to level ${lv.level + 1}`;
      bar.style.width = `${Math.round((lv.into / lv.next) * 100)}%`;
      if (lv.level > startLevel && !chimed) {
        chimed = true;
        lvUp.textContent = lv.level - startLevel > 1 ? `LEVEL UP! → ${lv.level}` : 'LEVEL UP!';
        lvUp.classList.remove('hidden');
        sfx.levelUp();
      }
      if (u < 1) requestAnimationFrame(frame);
      else if (gained > 0 && !chimed) sfx.xp();
    };
    frame();
  }
}
