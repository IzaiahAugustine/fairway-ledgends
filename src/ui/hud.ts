// In-round HUD: hole card, match status, wind, minimap, shot panel, club inventory, swing
// meter, banners, shot feedback, ball tags and the scorecard.
import * as THREE from 'three';
import { toYards } from '../core/rng';
import { TIERS } from '../data/clubs';
import type { MeterState } from '../game/swingInput';
import { scoreName, type HoleRecord } from '../game/match';
import { HoleField, Surf } from '../world/holeGen';
import { esc, h } from './dom';

export interface ShotInfo {
  club: string;
  tier: number;
  shotName: string;
  shotDesc: string;
  /** Spin setting for full shots (null for putts). */
  spin?: string | null;
  lie: string;
  toPin: number; // metres
  elevation: number; // metres
  power: number;
  carry: number | null;
  total: number | null;
  putting: boolean;
  puttScale?: number;
  /** Putts: how the putt breaks (Easy/Medium only). */
  breakText?: string | null;
}

export interface ClubSlot {
  short: string;
  tier: number;
  carry: number; // metres
  enabled: boolean;
}

const SURF_COLORS: Record<number, string> = {
  [Surf.OB]: '#3d4a2e', [Surf.Fairway]: '#6fae46', [Surf.Rough]: '#4d7a32', [Surf.Deep]: '#5d6a38',
  [Surf.Green]: '#8fd168', [Surf.Fringe]: '#78c055', [Surf.Bunker]: '#e9dcb6', [Surf.Water]: '#2c6f9e', [Surf.Tee]: '#7fbe58',
};

export class Hud {
  readonly root: HTMLElement;
  private holeCard: HTMLElement;
  private match: HTMLElement;
  private wind: HTMLElement;
  private windArrow: HTMLElement;
  private windSpeed: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniBase: HTMLCanvasElement | null = null;
  private miniXf: { cx: number; cz: number; ang: number; scale: number } = { cx: 0, cz: 0, ang: 0, scale: 1 };
  private shot: HTMLElement;
  private clubBar: HTMLElement;
  private meter: HTMLElement;
  private meterHint: HTMLElement;
  private banner: HTMLElement;
  private feedbackEl: HTMLElement;
  private turnEl: HTMLElement;
  private help: HTMLElement;
  private resultEl: HTMLElement;
  private tags: HTMLElement;
  private card: HTMLElement;
  private intro: HTMLElement;
  private xpChip: HTMLElement;
  private xpPops: HTMLElement;
  private bannerTimer = 0;
  private feedbackTimer = 0;
  private resultTimer = 0;
  private tagEls = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'hud hidden' });
    parent.append(this.root);
    this.holeCard = h('div', { class: 'hole-card panel' });
    this.match = h('div', { class: 'match panel' });
    this.wind = h('div', { class: 'wind panel' });
    this.windArrow = h('div', { class: 'arrow' });
    this.windArrow.innerHTML = `<svg viewBox="0 0 64 64" width="64" height="64"><path d="M32 6 L44 30 L35 27 L35 52 L29 52 L29 27 L20 30 Z" fill="#f2c14e"/></svg>`;
    this.windSpeed = h('div', { class: 'speed' });
    this.wind.append(h('div', { class: 'label' }, 'WIND'), this.windArrow, this.windSpeed);
    const miniWrap = h('div', { class: 'minimap panel' });
    this.mini = h('canvas', { width: '284', height: '500' });
    miniWrap.append(this.mini);
    this.shot = h('div', { class: 'shot-panel panel' });
    this.clubBar = h('div', { class: 'club-bar panel' });
    const clubDock = h('div', { class: 'club-dock' });
    clubDock.append(this.clubBar);
    this.meter = h('div', { class: 'meter panel' });
    this.meterHint = h('div', { class: 'meter-hint' });
    this.banner = h('div', { class: 'banner off' });
    this.feedbackEl = h('div', { class: 'feedback' });
    this.turnEl = h('div', { class: 'turn panel' });
    this.help = h('div', { class: 'help panel' });
    this.resultEl = h('div', { class: 'shot-result panel hidden' });
    this.tags = h('div', { class: 'tags' });
    this.card = h('div', { class: 'scorecard hidden' });
    this.intro = h('div', { class: 'intro hidden' });
    this.xpChip = h('div', { class: 'xp-chip panel' });
    this.xpPops = h('div', { class: 'xp-pops' });
    this.root.append(this.tags, this.holeCard, this.match, this.wind, this.xpChip, this.xpPops, miniWrap, this.shot, clubDock, this.meter, this.meterHint, this.banner, this.feedbackEl, this.turnEl, this.help, this.resultEl, this.intro, this.card);
    this.buildMeter();
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  setAimUi(v: boolean) {
    for (const el of [this.shot, this.clubBar, this.meter, this.meterHint]) el.classList.toggle('hidden', !v);
  }

  setHole(course: string, hole: number, par: number, yards: number, name: string | undefined, pin = '') {
    this.holeCard.innerHTML = `
      <div class="course">${esc(course)}</div>
      <div class="hole"><b>HOLE ${hole}</b><span>PAR ${par} · ${yards} YDS</span></div>
      <div class="hole-name">${name ? `“${esc(name)}”` : ''}</div>
      ${pin ? `<div class="pin-sheet">Pin: <b>${esc(pin)}</b></div>` : ''}
      <div class="strokes"></div>`;
  }

  setStrokes(rows: { name: string; strokes: number; color: string; active: boolean; holed: boolean; lie: string }[]) {
    const el = this.holeCard.querySelector('.strokes');
    if (!el) return;
    el.innerHTML = rows
      .map(
        (r) => `<div class="who ${r.active ? 'active' : ''}"><span class="dot" style="background:${r.color}"></span>${esc(r.name)} <span style="color:var(--muted);font-size:calc(12px * var(--fs))">${r.holed ? 'IN' : esc(r.lie)}</span></div><div class="num">${r.strokes}</div>`,
      )
      .join('');
  }

  setMatch(status: string, holes: HoleRecord[], current: number, firstHole = 1) {
    const cls = status.includes('UP') || status.startsWith('WON') ? 'up' : status.includes('DN') || status.startsWith('LOST') ? 'dn' : '';
    this.match.innerHTML = `<div class="status ${cls}">${esc(status)}</div><div class="holes">${holes
      .map((hr, i) => {
        const c = hr.winner === 'player' ? 'p' : hr.winner === 'ai' ? 'a' : hr.winner === 'halved' ? 'h' : '';
        return `<i class="${c} ${i === current ? 'cur' : ''}">${i + firstHole}</i>`;
      })
      .join('')}</div>`;
  }

  private weatherLabel = '';

  private windKey = '';
  private windDeg = NaN;

  /** Called every frame: only writes to the page when the arrow or the text actually changes. */
  setWind(mph: number, relDeg: number) {
    const deg = Math.round(relDeg * 2) / 2;
    if (deg !== this.windDeg) {
      this.windArrow.style.transform = `rotate(${deg}deg)`;
      this.windDeg = deg;
    }
    const key = `${mph.toFixed(0)}|${this.weatherLabel}`;
    if (key !== this.windKey) {
      this.windSpeed.innerHTML = `${mph.toFixed(0)} MPH${this.weatherLabel ? `<small>${esc(this.weatherLabel)}</small>` : ''}`;
      this.windKey = key;
    }
  }

  /** Weather shown under the wind speed (empty for fair weather). */
  setWeather(label: string) {
    this.weatherLabel = label;
  }

  /** Level progress, spendable balance, XP banked this match and what a win is worth. */
  setXp(x: { level: number; into: number; next: number; balance: number; match: number; win: number; last: number | null }) {
    this.xpChip.innerHTML = `
      <div class="top"><span class="lv">LV ${x.level}</span><span class="bal"><b>${x.balance.toLocaleString()}</b> XP</span></div>
      <div class="xpbar"><i style="width:${Math.round((x.into / x.next) * 100)}%"></i></div>
      <div class="sub"><span>${x.into} / ${x.next} to LV ${x.level + 1}</span></div>
      <div class="sub"><span>Last swing</span><b>${x.last === null ? '—' : `+${x.last}`}</b></div>
      <div class="sub"><span>This match</span><b class="m">+${x.match}</b></div>
      <div class="sub"><span>Win bonus</span><b>+${x.win}</b></div>`;
  }

  /** Floating "+N XP" call-out next to the XP chip. */
  xpPop(amount: number, label: string) {
    const el = h('div', { class: 'xp-pop' });
    el.innerHTML = `<b>+${amount} XP</b><span>${esc(label)}</span>`;
    this.xpPops.append(el);
    this.xpChip.classList.remove('flash');
    void this.xpChip.offsetWidth;
    this.xpChip.classList.add('flash');
    setTimeout(() => el.remove(), 2600);
  }

  setTurn(text: string, color = 'var(--accent)') {
    this.turnEl.textContent = text;
    this.turnEl.style.color = color;
    this.turnEl.classList.toggle('hidden', !text);
  }

  setHelp(putting: boolean, mode: 'stick' | 'threeClick') {
    const swing = mode === 'stick' ? 'Hold <span class="key">LMB</span> drag ↓ then push ↑' : '<span class="key">Click</span> ×3 to swing';
    this.help.innerHTML = [
      swing,
      '<span class="key">←</span><span class="key">→</span> club',
      '<span class="key">A</span><span class="key">D</span> aim · <span class="key">W</span><span class="key">S</span> power',
      putting ? '<span class="key">G</span> read green' : '<span class="key">Q</span><span class="key">E</span> shot type · <span class="key">C</span> spin',
      '<span class="key">V</span> target view · <span class="key">G</span> green',
      '<span class="key">P</span> replay last shot · <span class="key">R</span> reset aim',
      '<span class="key">Tab</span> scorecard · <span class="key">Esc</span> menu',
      '<span class="key">Enter</span> skip opponent\'s shot',
    ].join('<br>');
  }

  setClubBar(slots: ClubSlot[], sel: number) {
    this.clubBar.innerHTML =
      `<div class="arrows"><span class="key">←</span></div>` +
      slots
        .map((s, i) => {
          const t = TIERS[s.tier];
          const col = '#' + t.head.color.toString(16).padStart(6, '0');
          return `<div class="slot ${i === sel ? 'sel' : ''} ${s.enabled ? '' : 'dis'}"><b>${s.short}</b><span>${s.carry > 0 ? Math.round(toYards(s.carry)) : '—'}</span><i class="pip" style="background:${col}"></i></div>`;
        })
        .join('') +
      `<div class="arrows"><span class="key">→</span></div>`;
  }

  setShotInfo(s: ShotInfo) {
    const t = TIERS[s.tier];
    const yd = (m: number) => `${Math.round(toYards(m))}`;
    const ft = (m: number) => `${(m / 0.3048).toFixed(m < 3 ? 1 : 0)}`;
    const elev = s.putting ? `${s.elevation >= 0 ? '+' : ''}${(s.elevation / 0.0254).toFixed(0)} in` : `${s.elevation >= 0 ? '+' : ''}${(s.elevation / 0.3048).toFixed(0)} ft`;
    const dist = s.putting ? `${ft(s.toPin)} ft` : `${yd(s.toPin)} yds`;
    this.shot.innerHTML = `
      <div class="club"><b>${esc(s.club)}</b><span class="tier tier-${s.tier}">${t.name}</span></div>
      <div class="shot-type">
        ${s.putting ? '' : '<span class="key">Q</span>'}
        <div style="text-align:center"><div class="name">${esc(s.shotName)}</div><div class="desc">${esc(s.shotDesc)}</div></div>
        ${s.putting ? '' : '<span class="key">E</span>'}
      </div>
      <div class="stats">
        <div>To pin <b>${dist}</b></div>
        <div>Elevation <b>${elev}</b></div>
        ${s.putting
          ? `<div>Putt power <b>${ft((s.puttScale ?? 0) * s.power)} / ${ft(s.puttScale ?? 0)} ft</b></div><div>Break <b>${s.breakText ? esc(s.breakText) : '—'}</b></div>`
          : `<div>Carry <b>${s.carry !== null ? yd(s.carry) + ' yds' : '—'}</b></div><div>Total <b>${s.total !== null ? yd(s.total) + ' yds' : '—'}</b></div>`}
      </div>
      <div class="power-row"><span>Power</span><div class="bar"><i style="width:${Math.round(Math.min(1, s.power) * 100)}%"></i></div><b style="color:var(--text)">${Math.round(s.power * 100)}%</b></div>
      <div class="lie">Lie: <b>${esc(s.lie)}</b>${s.spin ? `<span class="spin-set"><span class="key">C</span> Spin: <b>${esc(s.spin)}</b></span>` : ''}</div>`;
  }

  private buildMeter() {
    this.meter.innerHTML = `<div class="cap">0%</div><div class="track"><div class="zone"></div><div class="fill"></div><div class="zero"></div><div class="target"></div><div class="needle"></div></div><div class="drift"></div>`;
  }

  meterState(m: MeterState) {
    const track = this.meter.querySelector('.track') as HTMLElement;
    const fill = this.meter.querySelector('.fill') as HTMLElement;
    const target = this.meter.querySelector('.target') as HTMLElement;
    const needle = this.meter.querySelector('.needle') as HTMLElement;
    const zone = this.meter.querySelector('.zone') as HTMLElement;
    const cap = this.meter.querySelector('.cap') as HTMLElement;
    const drift = this.meter.querySelector('.drift') as HTMLElement;
    if (!track) return;
    // vertical scale: bottom 12% = 0 (impact line), top = 112%
    const y = (p: number) => 12 + (p / 1.12) * 85;
    target.style.bottom = `${y(m.target)}%`;
    const showFill = m.mode === 'stick' ? Math.max(0, m.power) : m.phase === 'power' ? m.needle : m.power;
    fill.style.height = `${Math.max(0, y(showFill) - 12)}%`;
    needle.style.bottom = `${y(m.needle)}%`;
    needle.style.display = m.mode === 'threeClick' && m.phase !== 'idle' ? 'block' : 'none';
    zone.style.display = m.mode === 'threeClick' ? 'block' : 'none';
    zone.style.bottom = `${y(-m.zone)}%`;
    zone.style.height = `${(m.zone * 2 / 1.12) * 85}%`;
    cap.textContent = `${Math.round(Math.max(0, showFill) * 100)}%`;
    drift.style.display = m.mode === 'stick' && m.phase !== 'idle' ? 'block' : 'none';
    drift.style.transform = `translateX(${m.drift * 60 - 2}px)`;
    if (m.mode === 'stick') {
      this.meterHint.innerHTML =
        m.phase === 'idle' ? 'Hold <b>left mouse</b> and pull <b>down</b> to the blue line…' : m.phase === 'back' ? '…then push <b>up</b> smoothly and straight' : '';
    } else {
      this.meterHint.innerHTML = m.phase === 'idle' ? '<b>Click</b> to start the swing' : m.phase === 'power' ? '<b>Click</b> at the blue line to set power' : m.phase === 'return' ? '<b>Click</b> in the green zone' : '';
    }
  }

  showBanner(big: string, sub = '', tone: 'good' | 'bad' | '' = '', ms = 2400) {
    this.banner.className = `banner ${tone}`;
    this.banner.innerHTML = `<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    this.bannerTimer = ms / 1000;
  }

  feedback(items: { text: string; tone: 'good' | 'bad' | 'ok' }[], ms = 2600) {
    this.feedbackEl.innerHTML = items.map((i) => `<span class="${i.tone}">${esc(i.text)}</span>`).join('');
    this.feedbackTimer = ms / 1000;
  }

  shotResult(html: string, ms = 3200) {
    this.resultEl.innerHTML = html;
    this.resultEl.classList.remove('hidden');
    this.resultTimer = ms / 1000;
  }

  showIntro(hole: number, par: number, yards: number, name: string | undefined, hcp: string, extra: string[] = []) {
    this.intro.innerHTML = `<div class="n">${esc(hcp)}</div><div class="h">HOLE ${hole}</div><div class="y">Par ${par} · ${yards} yards${name ? ` · “${esc(name)}”` : ''}</div>${extra.map((x) => `<div class="x">${esc(x)}</div>`).join('')}<div class="skip"><span class="key">Space</span> skip flyover</div>`;
    this.intro.classList.remove('hidden');
  }

  hideIntro() {
    this.intro.classList.add('hidden');
  }

  update(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.add('off');
    }
    if (this.feedbackTimer > 0) {
      this.feedbackTimer -= dt;
      if (this.feedbackTimer <= 0) this.feedbackEl.innerHTML = '';
    }
    if (this.resultTimer > 0) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0) this.resultEl.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- tags

  private tagV = new THREE.Vector3();
  private tagState = new Map<string, { shown: boolean; text: string; tx: number; ty: number }>();

  /**
   * Floating name tag over a ball. Runs every frame, so it only touches the DOM when something
   * changed, and moves with a transform (no page layout).
   */
  setTag(id: string, text: string, world: THREE.Vector3 | null, cam: THREE.Camera, ai: boolean) {
    let el = this.tagEls.get(id);
    let st = this.tagState.get(id);
    if (!el || !st) {
      el = h('div', { class: `tag ${ai ? 'ai' : ''}` });
      this.tags.append(el);
      this.tagEls.set(id, el);
      st = { shown: true, text: '', tx: NaN, ty: NaN };
      this.tagState.set(id, st);
    }
    const v = world ? this.tagV.copy(world).project(cam) : null;
    const show = !!v && v.z <= 1 && v.z >= -1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
    if (show !== st.shown) {
      el.style.display = show ? 'block' : 'none';
      st.shown = show;
    }
    if (!show || !v) return;
    if (text !== st.text) {
      el.textContent = text;
      st.text = text;
    }
    const W = window.innerWidth, H = window.innerHeight; // the HUD fills the window (reading its size would force a layout)
    const tx = Math.round((v.x * 0.5 + 0.5) * W), ty = Math.round((-v.y * 0.5 + 0.5) * H);
    if (tx !== st.tx || ty !== st.ty) {
      el.style.transform = `translate(${tx}px, ${ty}px) translate(-50%, -130%)`;
      st.tx = tx;
      st.ty = ty;
    }
  }

  // ---------------------------------------------------------------- minimap

  buildMinimap(field: HoleField) {
    const W = this.mini.width, H = this.mini.height;
    const tee = field.tee, cup = field.cup;
    // rotate so the tee->green line points up the map
    const ang = Math.atan2(cup.x - tee.x, -(cup.z - tee.z));
    const cx = (tee.x + cup.x) / 2, cz = (tee.z + cup.z) / 2;
    // fit
    let maxU = 1, maxV = 1;
    for (let i = 0; i < field.px.length; i += 5) {
      const dx = field.px[i] - cx, dz = field.pz[i] - cz;
      const u = dx * Math.cos(ang) + dz * Math.sin(ang);
      const v = -dx * Math.sin(ang) + dz * Math.cos(ang);
      maxU = Math.max(maxU, Math.abs(u) + 45);
      maxV = Math.max(maxV, Math.abs(v) + 40);
    }
    const scale = Math.min(W / (2 * maxU), H / (2 * maxV));
    this.miniXf = { cx, cz, ang, scale };
    const base = document.createElement('canvas');
    base.width = W;
    base.height = H;
    const ctx = base.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const u = (px - W / 2) / scale, v = (py - H / 2) / scale;
        const x = cx + u * Math.cos(ang) - v * Math.sin(ang);
        const z = cz + u * Math.sin(ang) + v * Math.cos(ang);
        const s = field.surfAt(x, z);
        const col = SURF_COLORS[s] ?? '#333';
        const o = (py * W + px) * 4;
        const n = parseInt(col.slice(1), 16);
        const hgt = field.heightAt(x, z);
        const shade = 0.85 + Math.max(-0.15, Math.min(0.15, (hgt - field.heightAt(x + 2, z + 2)) * 0.15));
        img.data[o] = ((n >> 16) & 255) * shade;
        img.data[o + 1] = ((n >> 8) & 255) * shade;
        img.data[o + 2] = (n & 255) * shade;
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // trees
    ctx.fillStyle = 'rgba(20,45,20,0.85)';
    for (const t of field.trees) {
      const p = this.toMini(t.x, t.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, 4 * scale * t.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    this.miniBase = base;
  }

  toMini(x: number, z: number) {
    const { cx, cz, ang, scale } = this.miniXf;
    const dx = x - cx, dz = z - cz;
    const u = dx * Math.cos(ang) + dz * Math.sin(ang);
    const v = -dx * Math.sin(ang) + dz * Math.cos(ang);
    return { x: this.mini.width / 2 + u * scale, y: this.mini.height / 2 + v * scale };
  }

  drawMinimap(field: HoleField, balls: { x: number; z: number; color: string }[], aim: { from: { x: number; z: number }; to: { x: number; z: number } } | null) {
    const ctx = this.mini.getContext('2d')!;
    if (this.miniBase) ctx.drawImage(this.miniBase, 0, 0);
    const cup = this.toMini(field.cup.x, field.cup.z);
    ctx.fillStyle = '#fff';
    ctx.fillRect(cup.x - 1, cup.y - 14, 2, 14);
    ctx.fillStyle = '#ffd400';
    ctx.fillRect(cup.x + 1, cup.y - 14, 8, 5);
    if (aim) {
      const a = this.toMini(aim.from.x, aim.from.z), b = this.toMini(aim.to.x, aim.to.z);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const b of balls) {
      const p = this.toMini(b.x, b.z);
      ctx.fillStyle = b.color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- scorecard

  showScorecard(v: boolean, data?: { course: string; holes: HoleRecord[]; yards: number[]; names: [string, string]; status: string; firstHole: number }) {
    this.card.classList.toggle('hidden', !v);
    if (!v || !data) return;
    const cell = (s: number | null, par: number, cls: string) => {
      if (s === null) return `<td class="${cls}"></td>`;
      const d = s - par;
      const inner = d <= -1 ? `<span class="birdie">${s}</span>` : d >= 1 ? `<span class="bogey">${s}</span>` : `${s}`;
      return `<td class="${cls}">${inner}</td>`;
    };
    const holes = data.holes;
    const tot = (k: 'player' | 'ai') => holes.reduce((a, h) => a + (h[k] ?? 0), 0);
    this.card.innerHTML = `<div class="sheet panel"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px"><h2 style="margin:0">${esc(data.course)}</h2><b style="color:var(--accent)">${esc(data.status)}</b></div>
      <table><tr><th>Hole</th>${holes.map((_, i) => `<th>${i + data.firstHole}</th>`).join('')}<th>Tot</th></tr>
      <tr><td>Yards</td>${data.yards.map((y) => `<td>${y}</td>`).join('')}<td>${data.yards.reduce((a, b) => a + b, 0)}</td></tr>
      <tr><td>Par</td>${holes.map((h) => `<td>${h.par}</td>`).join('')}<td>${holes.reduce((a, h) => a + h.par, 0)}</td></tr>
      <tr><td>${esc(data.names[0])}</td>${holes.map((h) => cell(h.player, h.par, h.winner === 'player' ? 'w' : '')).join('')}<td>${tot('player') || ''}</td></tr>
      <tr><td>${esc(data.names[1])}</td>${holes.map((h) => cell(h.ai, h.par, h.winner === 'ai' ? 'l' : '')).join('')}<td>${tot('ai') || ''}</td></tr>
      <tr><td>Result</td>${holes.map((h) => `<td style="font-size:calc(11px * var(--fs))">${h.winner === 'player' ? 'WON' : h.winner === 'ai' ? 'LOST' : h.winner === 'halved' ? 'HALVED' : ''}</td>`).join('')}<td></td></tr>
      </table></div>`;
  }
}

export { scoreName };
