// AI opponent: plans each shot by simulating candidate club / power / aim combinations with
// the real ball physics, scores the outcomes by expected strokes, then executes with
// difficulty-dependent human error.
import { Rng, clamp } from '../core/rng';
import type { Appearance, Difficulty } from '../core/save';
import { CLUBS, PUTT_SHOT, SHOT_TYPES, type ClubDef, type ShotTypeDef } from '../data/clubs';
import { simulateShot, type SimEnv, type SimResult } from '../physics/ballPhysics';
import { HoleField, Surf } from '../world/holeGen';
import type { SwingStyleId } from '../data/swingStyles';
import { PERFECT_SWING, errorScale, fullCarry, launchFor, type ShotSetup, type SwingResult } from './shotModel';

export interface AiSkill {
  tier: number;
  power: number;
  dir: number;
  curve: number;
  puttDist: number;
  puttAim: number;
  blunder: number;
  windRead: number;
}

export const AI_SKILL: Record<Difficulty, AiSkill> = {
  easy: { tier: 0, power: 0.11, dir: 4.6, curve: 10, puttDist: 0.25, puttAim: 3.4, blunder: 0.16, windRead: 0.3 },
  medium: { tier: 1, power: 0.075, dir: 3.1, curve: 7, puttDist: 0.18, puttAim: 2.5, blunder: 0.09, windRead: 0.55 },
  hard: { tier: 3, power: 0.05, dir: 2.0, curve: 4.8, puttDist: 0.12, puttAim: 1.5, blunder: 0.05, windRead: 0.85 },
};

/**
 * Opponent personalities. Each plays one of the swing styles, with its own putting touch and how
 * often it throws in a howler, so opponents feel different from match to match.
 */
export interface Personality {
  id: string;
  label: string;
  blurb: string;
  style: SwingStyleId;
  /** Multiplier on putting distance/line errors. */
  putt: number;
  /** Multiplier on the chance of a blunder. */
  blunder: number;
}

export const PERSONALITIES: Personality[] = [
  { id: 'bomber', label: 'Bomber', blurb: 'Hits it a mile, not always straight', style: 'power', putt: 1.12, blunder: 1.3 },
  { id: 'grinder', label: 'Grinder', blurb: 'Fairways, greens, no mistakes', style: 'fader', putt: 0.9, blunder: 0.6 },
  { id: 'shotmaker', label: 'Shotmaker', blurb: 'Works the ball right to left', style: 'drawer', putt: 1, blunder: 1 },
  { id: 'magician', label: 'Magician', blurb: 'Short off the tee, lethal with a wedge', style: 'wizard', putt: 0.72, blunder: 0.9 },
  { id: 'metronome', label: 'Metronome', blurb: 'Same smooth swing every time', style: 'smooth', putt: 0.95, blunder: 0.55 },
  { id: 'allrounder', label: 'All-Rounder', blurb: 'Solid in every department', style: 'classic', putt: 1, blunder: 1 },
];

export interface Opponent {
  name: string;
  appearance: Appearance;
  personality: Personality;
}

const NAMES = ['Marcus Hale', 'Viktor Lindqvist', 'Ryo Tanaka', 'Diego Alvarez', 'Callum Reid', 'Jonah Brooks', 'Anders Holm', 'Theo Marchetti', 'Sam Okafor', 'Liam Gallagher'];

export function makeOpponent(seed: number, personality?: string): Opponent {
  const rng = new Rng(seed);
  const pers = PERSONALITIES.find((p) => p.id === personality) ?? PERSONALITIES[Math.floor(new Rng(seed ^ 0x5bd1e995).next() * PERSONALITIES.length)];
  const skins = ['#f1c6a6', '#e0ac82', '#c68a62', '#9a6440', '#6b4128', '#4a2c1c'];
  const shirts = ['#b5121b', '#0b3d91', '#1f6f43', '#111111', '#f2f2f2', '#6a1b9a', '#e86a10', '#2a8fbd'];
  const pants = ['#1a1a1a', '#e8e2d0', '#3a3f4a', '#6b6b6b', '#14213d'];
  const hairs = ['#1b1410', '#3b2a1e', '#6b4a2a', '#b08850', '#8a8a8a'];
  return {
    name: rng.pick(NAMES),
    personality: pers,
    appearance: {
      skin: rng.pick(skins),
      hair: rng.pick(hairs),
      hairStyle: rng.pick(['Short', 'Short', 'Long', 'None'] as const),
      hat: rng.pick(['Cap', 'Visor', 'Bucket', 'None', 'Cap'] as const),
      hatColor: rng.pick(['#111111', '#f2f2f2', '#0b3d91', '#b5121b']),
      shirt: rng.pick(shirts),
      pants: rng.pick(pants),
      shoes: rng.pick(['#f4f4f4', '#111111', '#5a3a22']),
      belt: rng.pick(['#111111', '#f2f2f2', '#5a3a22']),
      sunglasses: rng.chance(0.35),
      build: rng.range(0, 0.6),
      height: rng.range(1.74, 1.9),
      shirtPattern: rng.pick(['Solid', 'Solid', 'Pinstripe', 'Chest Band', 'Sleeves'] as const),
      shirtAccent: rng.pick(['#111111', '#f2f2f2', '#0b3d91', '#b5121b', '#f2c14e']),
      ball: 'white',
      clubFinish: rng.pick(['standard', 'standard', 'black']),
      face: rng.pick(['Standard', 'Beard', 'Older', 'Freckles'] as const),
    },
  };
}

export interface AiContext {
  field: HoleField;
  ball: { x: number; y: number; z: number };
  lie: Surf;
  teed: boolean;
  env: SimEnv;
  difficulty: Difficulty;
  personality?: Personality;
}

export interface AiPlan {
  setup: ShotSetup;
  swing: SwingResult;
  expected: number;
}

const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function expectedFrom(field: HoleField, r: SimResult, start: { x: number; z: number }): number {
  const cup = field.cup;
  if (r.outcome === 'holed') return 0;
  if (r.outcome === 'ob') return 2 + expectedPos(field, start.x, start.z, Surf.Fairway) ;
  if (r.outcome === 'water') {
    const e = r.waterEntry ?? start;
    return 1 + expectedPos(field, e.x, e.z, Surf.Rough) + 0.1;
  }
  return expectedPos(field, r.rest.x, r.rest.z, r.restSurf, cup);
}

function expectedPos(field: HoleField, x: number, z: number, surf: Surf, cup = field.cup): number {
  const d = Math.hypot(x - cup.x, z - cup.z);
  if (surf === Surf.Green) return 1 + clamp(d / 9, 0, 1) * 0.95 + Math.max(0, d - 15) * 0.012;
  let e = d < 30 ? 2.15 + d * 0.009 : 2.3 + d * 0.0055;
  if (surf === Surf.Fringe) e = 1.6 + Math.min(1, d / 12) * 0.7;
  if (surf === Surf.Rough) e += 0.22;
  if (surf === Surf.Deep) e += 0.55;
  if (surf === Surf.Bunker) e += d < 40 ? 0.4 : 0.3;
  if (surf === Surf.OB || surf === Surf.Water) e += 1.5;
  return e;
}

export async function planAiShot(ctx: AiContext, rng: Rng): Promise<AiPlan> {
  const { field, ball, lie, difficulty } = ctx;
  const skill = AI_SKILL[difficulty];
  const pers = ctx.personality ?? PERSONALITIES[PERSONALITIES.length - 1];
  const style = pers.style;
  const cup = field.cup;
  const dist = Math.hypot(cup.x - ball.x, cup.z - ball.z);
  const tiers: Record<string, number> = {};
  for (const c of CLUBS) tiers[c.id] = skill.tier;
  const envRead: SimEnv = { ...ctx.env, wind: { x: ctx.env.wind.x * skill.windRead, z: ctx.env.wind.z * skill.windRead }, trees: ctx.env.trees };
  const toCup = { x: (cup.x - ball.x) / (dist || 1), z: (cup.z - ball.z) / (dist || 1) };
  const putter = CLUBS.find((c) => c.kind === 'putter')!;

  const base = (club: ClubDef, shot: ShotTypeDef, power: number, ax: number, az: number, puttScale?: number): ShotSetup => ({
    club, tier: skill.tier, shot, power, aimX: ax, aimZ: az, x: ball.x, y: ball.y, z: ball.z, lie, teed: ctx.teed, puttScale, style,
  });
  const rotate = (x: number, z: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: x * Math.cos(a) - z * Math.sin(a), z: x * Math.sin(a) + z * Math.cos(a) };
  };

  // ---- putting
  if (lie === Surf.Green || (lie === Surf.Fringe && dist < 14)) {
    let best: { setup: ShotSetup; score: number } | null = null;
    let t0 = performance.now();
    const scales = [0.92, 1.0, 1.08, 1.18, 1.3];
    const h0 = field.heightAt(ball.x, ball.z), h1 = field.heightAt(cup.x, cup.z);
    const L0 = Math.max(0.3, dist + 0.35 + (h1 - h0) * 6);
    for (let a = -18; a <= 18; a += 0.5) {
      for (const sc of scales) {
        const dir = rotate(toCup.x, toCup.z, a);
        const setup = base(putter, PUTT_SHOT, 1, dir.x, dir.z, L0 * sc);
        const r = simulateShot(launchFor(setup, PERFECT_SWING(1)), { ...ctx.env, flagIn: false });
        const restD = Math.hypot(r.rest.x - cup.x, r.rest.z - cup.z);
        const score = r.outcome === 'holed' ? Math.abs(sc - 1.08) * 0.2 : 1 + r.closest * 2 + restD * 0.4;
        if (!best || score < best.score) best = { setup, score };
      }
      if (performance.now() - t0 > 10) { await yieldFrame(); t0 = performance.now(); }
    }
    const setup = best!.setup;
    const blunder = rng.chance(skill.blunder * 0.6 * pers.blunder);
    const swing: SwingResult = {
      power: Math.max(0.05, 1 + rng.gauss() * skill.puttDist * pers.putt * (blunder ? 2.5 : 1) * Math.min(1.6, 0.6 + dist / 8)),
      dirErr: rng.gauss() * skill.puttAim * pers.putt * (blunder ? 2.5 : 1) * Math.min(1.4, 0.5 + dist / 10),
      curveErr: 0, tempo: 'Good', path: 'Straight', quality: 1,
    };
    return { setup, swing, expected: best!.score };
  }

  // ---- full and short game shots
  type Cand = { setup: ShotSetup; score: number };
  const cands: Cand[] = [];
  let t0 = performance.now();
  const evalSetup = (setup: ShotSetup): number => {
    const r = simulateShot(launchFor(setup, PERFECT_SWING(setup.power)), { ...envRead, flagIn: true });
    return expectedFrom(field, r, ball);
  };
  const shotTypes = dist < 75 ? SHOT_TYPES.filter((s) => ['normal', 'pitch', 'chip', 'bump', 'flop'].includes(s.id)) : [SHOT_TYPES[0]];
  const pars = field.def.par;
  for (const club of CLUBS) {
    if (club.kind === 'putter') continue;
    if (club.kind === 'driver' && !(ctx.teed && pars > 3)) continue;
    for (const shot of shotTypes) {
      if (!shot.allowed(club)) continue;
      const full = fullCarry(club, skill.tier, shot, lie, ctx.teed, style);
      if (full < dist * 0.25 && dist > 40) continue;
      if (full > dist * 3.2 && dist > 40) continue;
      const powers = [1.0, 0.94, 0.88, 0.8, 0.7, 0.6, 0.5, 0.4].filter((p) => full * p < dist * 1.25 + 15 && (full * p > dist * 0.35 || p === 1.0));
      for (const p of powers) {
        const carry = full * p;
        // aim lines: at the cup, and at the centre line where this shot would finish
        const aims: { x: number; z: number }[] = [toCup];
        if (carry < dist - 25) {
          const s0 = field.pathCoords(ball.x, ball.z).s;
          let s = Math.max(0, s0);
          let pt = field.pointAt(s);
          while (s < field.length && Math.hypot(pt.x - ball.x, pt.z - ball.z) < carry * 1.06) { s += 2; pt = field.pointAt(s); }
          const dx = pt.x - ball.x, dz = pt.z - ball.z;
          const l = Math.hypot(dx, dz) || 1;
          aims.push({ x: dx / l, z: dz / l });
        }
        for (const aim of aims) {
          for (const off of [-3, 0, 3]) {
            const d = rotate(aim.x, aim.z, off);
            const setup = base(club, shot, p, d.x, d.z);
            cands.push({ setup, score: evalSetup(setup) });
          }
        }
        if (performance.now() - t0 > 10) { await yieldFrame(); t0 = performance.now(); }
      }
    }
  }
  // putter from off the green when close
  if (dist < 20 && (lie === Surf.Fringe || lie === Surf.Fairway)) {
    for (const sc of [1.0, 1.15, 1.3]) {
      const setup = base(putter, PUTT_SHOT, 1, toCup.x, toCup.z, (dist + 0.4) * sc);
      const r = simulateShot(launchFor(setup, PERFECT_SWING(1)), { ...ctx.env, flagIn: false });
      cands.push({ setup, score: expectedFrom(field, r, ball) + 0.05 });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  // robustness check of the best few: average over likely errors
  const top = cands.slice(0, 10);
  let best = top[0];
  let bestRobust = Infinity;
  for (const c of top) {
    let tot = 0;
    const samples = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dp, da] of samples) {
      const sw: SwingResult = { power: c.setup.power * (1 + dp * skill.power), dirErr: da * skill.dir * 1.2, curveErr: da * skill.curve * 0.5, tempo: 'Good', path: '', quality: 1 };
      const r = simulateShot(launchFor(c.setup, sw), { ...envRead, flagIn: true });
      tot += expectedFrom(field, r, ball);
    }
    const robust = tot / samples.length;
    if (robust < bestRobust) { bestRobust = robust; best = c; }
    if (performance.now() - t0 > 10) { await yieldFrame(); t0 = performance.now(); }
  }
  const setup = best.setup;
  const es = setup.club.kind === 'putter' ? 0.6 : errorScale(setup) * 0.55;
  const blunder = rng.chance(skill.blunder * pers.blunder);
  const bm = blunder ? 3 : 1;
  const swing: SwingResult = {
    power: setup.club.kind === 'putter' ? 1 + rng.gauss() * skill.puttDist * pers.putt : setup.power * (1 + rng.gauss() * skill.power * bm),
    dirErr: rng.gauss() * skill.dir * es * bm,
    curveErr: rng.gauss() * skill.curve * es * bm,
    tempo: blunder ? 'Fast' : 'Good',
    path: blunder ? 'Mishit' : 'Straight',
    quality: blunder ? 0.3 : 0.9,
  };
  return { setup, swing, expected: bestRobust };
}
