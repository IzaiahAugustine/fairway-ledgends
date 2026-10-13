// Club catalog, upgrade tiers and shot types.

export type ClubKind = 'driver' | 'wood' | 'hybrid' | 'iron' | 'wedge' | 'putter';
export type SwingAnim = 'Driver' | 'Wood' | 'Iron' | 'Wedge' | 'Chip' | 'Putt';

export interface ClubDef {
  id: string;
  short: string;
  name: string;
  kind: ClubKind;
  loft: number;
  /** Full-swing carry in yards with Tour-tier equipment. */
  carry: number;
  launch: number;
  spin: number;
  anim: SwingAnim;
  model: string;
}

export const CLUBS: ClubDef[] = [
  { id: 'dr', short: 'DR', name: 'Driver', kind: 'driver', loft: 10.5, carry: 265, launch: 10.8, spin: 2600, anim: 'Driver', model: 'Club_Driver' },
  { id: '3w', short: '3W', name: '3 Wood', kind: 'wood', loft: 15, carry: 240, launch: 10.4, spin: 3700, anim: 'Wood', model: 'Club_Wood' },
  { id: '3h', short: '3H', name: '3 Hybrid', kind: 'hybrid', loft: 19, carry: 220, launch: 12.2, spin: 4500, anim: 'Wood', model: 'Club_Hybrid' },
  { id: '4i', short: '4i', name: '4 Iron', kind: 'iron', loft: 22, carry: 205, launch: 12.8, spin: 5100, anim: 'Iron', model: 'Club_Iron' },
  { id: '5i', short: '5i', name: '5 Iron', kind: 'iron', loft: 25, carry: 193, launch: 13.6, spin: 5600, anim: 'Iron', model: 'Club_Iron' },
  { id: '6i', short: '6i', name: '6 Iron', kind: 'iron', loft: 28, carry: 181, launch: 15, spin: 6350, anim: 'Iron', model: 'Club_Iron' },
  { id: '7i', short: '7i', name: '7 Iron', kind: 'iron', loft: 32, carry: 169, launch: 16.3, spin: 7050, anim: 'Iron', model: 'Club_Iron' },
  { id: '8i', short: '8i', name: '8 Iron', kind: 'iron', loft: 36, carry: 157, launch: 18.2, spin: 7900, anim: 'Iron', model: 'Club_Iron' },
  { id: '9i', short: '9i', name: '9 Iron', kind: 'iron', loft: 41, carry: 144, launch: 20.4, spin: 8600, anim: 'Iron', model: 'Club_Iron' },
  { id: 'pw', short: 'PW', name: 'Pitching Wedge', kind: 'wedge', loft: 46, carry: 132, launch: 24, spin: 9250, anim: 'Wedge', model: 'Club_Wedge' },
  { id: 'gw', short: 'GW', name: 'Gap Wedge', kind: 'wedge', loft: 50, carry: 118, launch: 27, spin: 9700, anim: 'Wedge', model: 'Club_Wedge' },
  { id: 'sw', short: 'SW', name: 'Sand Wedge', kind: 'wedge', loft: 56, carry: 102, launch: 30, spin: 10100, anim: 'Wedge', model: 'Club_Wedge' },
  { id: 'lw', short: 'LW', name: 'Lob Wedge', kind: 'wedge', loft: 60, carry: 86, launch: 33, spin: 10400, anim: 'Wedge', model: 'Club_Wedge' },
  { id: 'pt', short: 'PT', name: 'Putter', kind: 'putter', loft: 3, carry: 0, launch: 0, spin: 0, anim: 'Putt', model: 'Club_Putter' },
];

export const clubById = (id: string) => CLUBS.find((c) => c.id === id) ?? CLUBS[0];

export interface TierDef {
  name: string;
  power: number;
  accuracy: number;
  spin: number;
  /** XP cost to reach this tier from the one below. */
  cost: number;
  head: { color: number; metalness: number; roughness: number };
}

export const TIERS: TierDef[] = [
  { name: 'Rusty', power: 0.85, accuracy: 0.7, spin: 0.75, cost: 0, head: { color: 0x7a4a2c, metalness: 0.55, roughness: 0.78 } },
  { name: 'Clubhouse', power: 0.9, accuracy: 0.78, spin: 0.86, cost: 150, head: { color: 0x9a9fa6, metalness: 0.85, roughness: 0.45 } },
  { name: 'Pro', power: 0.95, accuracy: 0.86, spin: 0.95, cost: 350, head: { color: 0xd8dde3, metalness: 1.0, roughness: 0.18 } },
  { name: 'Tour', power: 1.0, accuracy: 0.93, spin: 1.05, cost: 600, head: { color: 0x22252a, metalness: 0.9, roughness: 0.3 } },
  { name: 'Elite', power: 1.04, accuracy: 1.0, spin: 1.12, cost: 1000, head: { color: 0xd4a640, metalness: 1.0, roughness: 0.22 } },
];

export const MAX_TIER = TIERS.length - 1;

export function upgradeCost(club: ClubDef, currentTier: number): number | null {
  if (currentTier >= MAX_TIER) return null;
  const base = TIERS[currentTier + 1].cost;
  const mul = club.kind === 'driver' || club.kind === 'putter' ? 1.25 : 1;
  return Math.round((base * mul) / 10) * 10;
}

export interface ShotTypeDef {
  id: string;
  name: string;
  desc: string;
  distMul: number;
  launchMul: number;
  spinMul: number;
  /** Spin-axis tilt in degrees, positive curves right. */
  curve: number;
  /** Start direction offset in degrees, positive starts right. */
  start: number;
  errMul: number;
  anim?: SwingAnim;
  allowed: (c: ClubDef) => boolean;
}

const isIronish = (c: ClubDef) => c.kind === 'iron' || c.kind === 'wedge';
const shortIron = (c: ClubDef) => ['7i', '8i', '9i', 'pw', 'gw', 'sw', 'lw'].includes(c.id);

export const SHOT_TYPES: ShotTypeDef[] = [
  { id: 'normal', name: 'Normal', desc: 'Standard full swing', distMul: 1, launchMul: 1, spinMul: 1, curve: 0, start: 0, errMul: 1, allowed: (c) => c.kind !== 'putter' },
  { id: 'power', name: 'Power', desc: '+7% distance, harder to control', distMul: 1.07, launchMul: 1.0, spinMul: 0.95, curve: 0, start: 0, errMul: 1.6, allowed: (c) => c.kind !== 'putter' && c.kind !== 'wedge' },
  { id: 'draw', name: 'Draw', desc: 'Starts right, curves left, extra roll', distMul: 1.02, launchMul: 0.95, spinMul: 0.92, curve: -11, start: 2.6, errMul: 1.1, allowed: (c) => c.kind !== 'putter' },
  { id: 'fade', name: 'Fade', desc: 'Starts left, curves right, lands soft', distMul: 0.97, launchMul: 1.05, spinMul: 1.08, curve: 11, start: -2.6, errMul: 1.1, allowed: (c) => c.kind !== 'putter' },
  { id: 'punch', name: 'Punch', desc: 'Low knockdown under the wind', distMul: 0.86, launchMul: 0.58, spinMul: 0.7, curve: 0, start: 0, errMul: 0.9, allowed: (c) => c.kind === 'iron' || c.kind === 'hybrid' || c.id === 'pw' },
  { id: 'pitch', name: 'Pitch', desc: 'Three-quarter soft wedge', distMul: 0.72, launchMul: 1.12, spinMul: 1.05, curve: 0, start: 0, errMul: 0.85, anim: 'Wedge', allowed: (c) => c.kind === 'wedge' },
  { id: 'flop', name: 'Flop', desc: 'Sky-high, stops fast', distMul: 0.55, launchMul: 1.6, spinMul: 1.15, curve: 0, start: 0, errMul: 1.3, anim: 'Wedge', allowed: (c) => ['gw', 'sw', 'lw'].includes(c.id) },
  { id: 'chip', name: 'Chip', desc: 'Short, controlled, some release', distMul: 0.24, launchMul: 0.75, spinMul: 0.75, curve: 0, start: 0, errMul: 0.6, anim: 'Chip', allowed: (c) => shortIron(c) },
  { id: 'bump', name: 'Bump & Run', desc: 'Low runner along the ground', distMul: 0.14, launchMul: 0.42, spinMul: 0.35, curve: 0, start: 0, errMul: 0.6, anim: 'Chip', allowed: (c) => isIronish(c) && !['sw', 'lw'].includes(c.id) },
];

export const PUTT_SHOT: ShotTypeDef = {
  id: 'putt', name: 'Putt', desc: 'Roll it in', distMul: 1, launchMul: 0, spinMul: 0, curve: 0, start: 0, errMul: 1, anim: 'Putt', allowed: (c) => c.kind === 'putter',
};

export const shotTypeById = (id: string) => SHOT_TYPES.find((s) => s.id === id) ?? (id === 'putt' ? PUTT_SHOT : SHOT_TYPES[0]);

export function animFor(club: ClubDef, shot: ShotTypeDef): SwingAnim {
  if (club.kind === 'putter') return 'Putt';
  return shot.anim ?? club.anim;
}
