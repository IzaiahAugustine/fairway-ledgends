// Converts a club + shot type + lie + swing result into ball launch conditions.
import { YARD, clamp } from '../core/rng';
import { CLUBS, TIERS, type ClubDef, type ShotTypeDef } from '../data/clubs';
import { FlatGround, ROLL, simulateShot, speedForRoll, type Launch } from '../physics/ballPhysics';
import { Surf } from '../world/holeGen';

export interface SwingResult {
  /** Achieved power, 0..1.1 (fraction of the intended full-shot distance). */
  power: number;
  /** Start-direction error in degrees, positive = right. */
  dirErr: number;
  /** Extra spin-axis tilt in degrees, positive = slice/fade. */
  curveErr: number;
  /** Labels for feedback. */
  tempo: 'Perfect' | 'Good' | 'Fast' | 'Slow' | 'Rushed' | 'Lazy';
  path: string;
  quality: number;
}

export const PERFECT_SWING = (power: number): SwingResult => ({ power, dirErr: 0, curveErr: 0, tempo: 'Perfect', path: 'Straight', quality: 1 });

export interface LieMods {
  dist: number;
  spin: number;
  launch: number;
  err: number;
  label: string;
}

export function lieMods(lie: Surf, club: ClubDef, teed: boolean): LieMods {
  switch (lie) {
    case Surf.Tee:
      return { dist: 1, spin: 1, launch: 1, err: 1, label: 'Tee — 100%' };
    case Surf.Fairway:
      if (club.kind === 'driver' && !teed) return { dist: 0.88, spin: 0.9, launch: 0.85, err: 1.5, label: 'Fairway — driver off the deck' };
      return { dist: 1, spin: 1, launch: 1, err: 1, label: 'Fairway — 100%' };
    case Surf.Fringe:
      return { dist: 0.97, spin: 0.9, launch: 1, err: 1.05, label: 'Fringe — 95-100%' };
    case Surf.Green:
      return { dist: 0.97, spin: 0.9, launch: 1, err: 1, label: 'Green' };
    case Surf.Rough:
      return { dist: club.kind === 'driver' ? 0.78 : 0.86, spin: 0.55, launch: 1.04, err: 1.3, label: 'Rough — 80-90%' };
    case Surf.Deep:
      return { dist: club.kind === 'wedge' ? 0.7 : 0.6, spin: 0.35, launch: 1.1, err: 1.7, label: 'Deep Rough — 55-70%' };
    case Surf.Bunker:
      return club.kind === 'wedge'
        ? { dist: 0.8, spin: 0.55, launch: 1.06, err: 1.3, label: 'Bunker — 75-85%' }
        : { dist: club.kind === 'driver' || club.kind === 'wood' ? 0.5 : 0.68, spin: 0.45, launch: 0.95, err: 1.7, label: 'Bunker — 50-70%' };
    default:
      return { dist: 0.85, spin: 0.6, launch: 1, err: 1.3, label: 'Rough' };
  }
}

// --- carry calibration: find the ball speed that produces a target carry on flat ground.
const flat = new FlatGround();
const speedCache = new Map<string, number>();

function carryFor(speed: number, launchDeg: number, spinRpm: number): number {
  const r = simulateShot(
    { x: 0, y: 0.03, z: 0, speed, launchDeg, dirX: 0, dirZ: -1, spinRpm, axisDeg: 0 },
    { ground: flat, wind: { x: 0, z: 0 }, firmness: 1, cup: null, flagIn: false, flightOnly: true },
  );
  return r.carry;
}

export function solveSpeed(targetCarry: number, launchDeg: number, spinRpm: number): number {
  const key = `${targetCarry.toFixed(1)}|${launchDeg.toFixed(1)}|${Math.round(spinRpm / 50)}`;
  const c = speedCache.get(key);
  if (c !== undefined) return c;
  let lo = 2, hi = 95;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (carryFor(mid, launchDeg, spinRpm) < targetCarry) lo = mid;
    else hi = mid;
  }
  const v = (lo + hi) / 2;
  if (speedCache.size > 4000) speedCache.clear();
  speedCache.set(key, v);
  return v;
}

export interface ShotSetup {
  club: ClubDef;
  tier: number;
  shot: ShotTypeDef;
  /** Intended power 0..1. */
  power: number;
  aimX: number;
  aimZ: number;
  x: number;
  y: number;
  z: number;
  lie: Surf;
  teed: boolean;
  /** Putts: full-power roll distance on a flat green in metres. */
  puttScale?: number;
}

/** Full-power carry in metres for a club/tier/shot/lie combination. */
export function fullCarry(club: ClubDef, tier: number, shot: ShotTypeDef, lie: Surf, teed: boolean): number {
  const lm = lieMods(lie, club, teed);
  return club.carry * YARD * TIERS[tier].power * shot.distMul * lm.dist;
}

export function launchFor(setup: ShotSetup, swing: SwingResult): Launch {
  const { club, shot } = setup;
  const tier = TIERS[setup.tier];
  if (club.kind === 'putter') {
    const scale = setup.puttScale ?? 10;
    const rr = ROLL[Surf.Green];
    const dist = Math.max(0.05, scale * swing.power) * (setup.lie === Surf.Green ? 1 : 1.12);
    const speed = speedForRoll(dist, rr.a, rr.k);
    const a = (swing.dirErr * Math.PI) / 180;
    const rX = -setup.aimZ, rZ = setup.aimX;
    const dx = setup.aimX * Math.cos(a) + rX * Math.sin(a);
    const dz = setup.aimZ * Math.cos(a) + rZ * Math.sin(a);
    return { x: setup.x, y: setup.y, z: setup.z, speed, launchDeg: 0, dirX: dx, dirZ: dz, spinRpm: 0, axisDeg: 0, putt: true };
  }
  const lm = lieMods(setup.lie, club, setup.teed);
  const p = clamp(swing.power, 0.03, 1.12);
  const carry = fullCarry(club, setup.tier, shot, setup.lie, setup.teed) * p;
  const launchDeg = club.launch * shot.launchMul * lm.launch * (1 + Math.max(0, 1 - p) * 0.4);
  const spin = club.spin * tier.spin * shot.spinMul * lm.spin * (0.8 + 0.2 * Math.min(1, p));
  const speed = solveSpeed(carry, launchDeg, spin);
  const a = ((shot.start + swing.dirErr) * Math.PI) / 180;
  const rX = -setup.aimZ, rZ = setup.aimX;
  const dx = setup.aimX * Math.cos(a) + rX * Math.sin(a);
  const dz = setup.aimZ * Math.cos(a) + rZ * Math.sin(a);
  return { x: setup.x, y: setup.y, z: setup.z, speed, launchDeg, dirX: dx, dirZ: dz, spinRpm: spin, axisDeg: shot.curve * (0.6 + 0.4 * tier.spin) + swing.curveErr };
}

/** Error multiplier applied to swing mistakes for a club tier, shot type and lie. */
export function errorScale(setup: ShotSetup): number {
  const tier = TIERS[setup.tier];
  const lm = lieMods(setup.lie, setup.club, setup.teed);
  const lengthFactor = setup.club.kind === 'driver' ? 1.25 : setup.club.kind === 'wood' || setup.club.kind === 'hybrid' ? 1.12 : setup.club.kind === 'wedge' ? 0.8 : 1;
  return Math.pow(1 / tier.accuracy, 0.9) * setup.shot.errMul * lm.err * lengthFactor;
}

/** Picks the club whose full carry best matches a distance (metres). */
export function suggestClub(dist: number, tiers: Record<string, number>, lie: Surf, teed: boolean, allowDriver: boolean, normal: ShotTypeDef): ClubDef {
  let best = CLUBS[CLUBS.length - 2];
  let bestErr = Infinity;
  for (const c of CLUBS) {
    if (c.kind === 'putter') continue;
    if (c.kind === 'driver' && !allowDriver) continue;
    const full = fullCarry(c, tiers[c.id] ?? 0, normal, lie, teed);
    // prefer a club that reaches with ~92% power
    const need = dist / full;
    const err = need > 1.02 ? (need - 1) * 6 : Math.abs(0.93 - need);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return best;
}
