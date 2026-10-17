// Match-play bookkeeping: hole results, match status ("2 UP", "AS", "3&2"), score names and XP.
import type { Difficulty } from '../core/save';
import type { HoleSet } from '../data/courses';
import type { WeatherKind } from '../world/weather';

export type Side = 'player' | 'ai';

/**
 * Match play: win holes; ends early once a lead can't be caught ("3 & 2").
 * Stroke play: every hole is played out; fewest total strokes wins.
 * Skins: each hole is worth a skin; tied holes carry their skins over to the next.
 */
export type Format = 'match' | 'stroke' | 'skins';
/** Everything that defines a round before it starts (from the menus, quick play or career). */
export interface MatchOptions {
  courseId: string;
  difficulty: Difficulty;
  format: Format;
  holes: HoleSet;
  /** Practice: no opponent, no result, play the holes as long as you like. */
  practice?: boolean;
  /** Career event being played (see data/career). */
  careerEvent?: string;
  /** Force the weather instead of picking it. */
  weather?: WeatherKind;
  /** The daily challenge being played: its day, YYYY-MM-DD (see data/daily). */
  daily?: string;
}

export const FORMATS: { id: Format; name: string; desc: string }[] = [
  { id: 'match', name: 'Match Play', desc: 'Win holes, not strokes. The match can end early once a lead is out of reach.' },
  { id: 'stroke', name: 'Stroke Play', desc: 'Every shot counts. Both players hole out on every hole; lowest total wins.' },
  { id: 'skins', name: 'Skins', desc: 'Each hole is worth a skin. Halve a hole and its skin carries over to the next.' },
];

export interface HoleRecord {
  par: number;
  player: number | null;
  ai: number | null;
  winner: Side | 'halved' | null;
  conceded?: Side;
  /** The player finished the hole (holed out or had a putt conceded), so their score is complete. */
  playerHoled?: boolean;
}

export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'Hole in One';
  const d = strokes - par;
  switch (d) {
    case -3: return 'Albatross';
    case -2: return 'Eagle';
    case -1: return 'Birdie';
    case 0: return 'Par';
    case 1: return 'Bogey';
    case 2: return 'Double Bogey';
    case 3: return 'Triple Bogey';
    default: return d < -3 ? 'Condor' : `+${d}`;
  }
}

export class MatchState {
  holes: HoleRecord[];
  current = 0;
  finished = false;
  /** XP banked from individual player swings (tempo, fairways, greens, putts…). */
  swingXp = 0;
  swingCount = 0;

  constructor(pars: number[], readonly format: Format = 'match', readonly firstHole = 1) {
    this.holes = pars.map((par) => ({ par, player: null, ai: null, winner: null }));
  }

  /** Strokes so far for each side, and relative to par on the holes played. */
  totals() {
    let player = 0, ai = 0, par = 0;
    for (const h of this.holes) {
      if (h.winner === null) continue;
      player += h.player ?? 0;
      ai += h.ai ?? 0;
      par += h.par;
    }
    return { player, ai, par };
  }

  /** Skins won by each side and how many are riding on the next hole. */
  skins() {
    let player = 0, ai = 0, pot = 1;
    for (const h of this.holes) {
      if (h.winner === null) break;
      if (h.winner === 'halved') pot++;
      else {
        if (h.winner === 'player') player += pot;
        else ai += pot;
        pot = 1;
      }
    }
    return { player, ai, pot };
  }

  /** Positive: player is ahead (holes up, strokes ahead or skins ahead, by format). */
  get margin(): number {
    if (this.format === 'stroke') {
      const t = this.totals();
      return t.ai - t.player;
    }
    if (this.format === 'skins') {
      const k = this.skins();
      return k.player - k.ai;
    }
    let m = 0;
    for (const h of this.holes) {
      if (h.winner === 'player') m++;
      else if (h.winner === 'ai') m--;
    }
    return m;
  }

  get holesPlayed(): number {
    return this.holes.filter((h) => h.winner !== null).length;
  }

  get remaining(): number {
    return this.holes.length - this.holesPlayed;
  }

  get decided(): boolean {
    if (this.format !== 'match') return this.remaining === 0;
    return Math.abs(this.margin) > this.remaining || this.remaining === 0;
  }

  get dormie(): boolean {
    return this.format === 'match' && !this.decided && this.remaining > 0 && Math.abs(this.margin) === this.remaining;
  }

  record(i: number, player: number, ai: number, conceded?: Side, playerHoled = !conceded) {
    const h = this.holes[i];
    h.player = player;
    h.ai = ai;
    h.conceded = conceded;
    h.playerHoled = playerHoled;
    if (conceded === 'player') h.winner = 'ai';
    else if (conceded === 'ai') h.winner = 'player';
    else h.winner = player < ai ? 'player' : ai < player ? 'ai' : 'halved';
    if (this.decided) this.finished = true;
  }

  /** "2 UP", "1 DN", "AS", or final "3 & 2" (match); "+2 · LEAD BY 1" (stroke); "SKINS 3-1" (skins). */
  statusText(perspective: Side = 'player'): string {
    const m = perspective === 'player' ? this.margin : -this.margin;
    if (this.format === 'stroke') {
      const t = this.totals();
      const rel = t.player - t.par;
      const toPar = this.holesPlayed === 0 ? 'E' : rel === 0 ? 'E' : rel > 0 ? `+${rel}` : `${rel}`;
      if (this.finished) return m === 0 ? `TIED · ${t.player}-${t.ai}` : `${m > 0 ? 'WON' : 'LOST'} BY ${Math.abs(m)} · ${t.player}-${t.ai}`;
      return m === 0 ? `${toPar} · TIED` : `${toPar} · ${m > 0 ? 'LEAD' : 'TRAIL'} BY ${Math.abs(m)}`;
    }
    if (this.format === 'skins') {
      const k = this.skins();
      const tally = `SKINS ${k.player}-${k.ai}`;
      if (this.finished) return m === 0 ? `${tally} · TIED` : `${tally} · ${m > 0 ? 'WON' : 'LOST'}`;
      return k.pot > 1 ? `${tally} · ${k.pot} ON THE LINE` : tally;
    }
    if (this.finished) {
      if (m === 0) return 'MATCH HALVED';
      const lead = Math.abs(m);
      const rem = this.remaining;
      const res = rem === 0 ? `${lead} UP` : `${lead} & ${rem}`;
      return m > 0 ? `WON ${res}` : `LOST ${res}`;
    }
    if (m === 0) return 'ALL SQUARE';
    return `${Math.abs(m)} ${m > 0 ? 'UP' : 'DN'}${this.dormie ? ' · DORMIE' : ''}`;
  }

  get result(): 'won' | 'lost' | 'halved' {
    const m = this.margin;
    return m > 0 ? 'won' : m < 0 ? 'lost' : 'halved';
  }
}

export interface XpBreakdown {
  lines: { label: string; xp: number }[];
  total: number;
}

export const WIN_XP: Record<Difficulty, number> = { easy: 250, medium: 450, hard: 750 };

export function computeXp(m: MatchState, diff: Difficulty): XpBreakdown {
  const lines: XpBreakdown['lines'] = [];
  const res = m.result;
  if (res === 'won') {
    lines.push({ label: `Match win (${diff})`, xp: WIN_XP[diff] });
    const margin = m.margin;
    const unit = m.format === 'stroke' ? 'strokes' : m.format === 'skins' ? 'skins' : 'up';
    if (margin >= 3) lines.push({ label: `Dominant win (${margin} ${unit})`, xp: Math.min(margin, 8) * 25 });
  } else if (res === 'halved') {
    lines.push({ label: 'Match halved', xp: Math.round(WIN_XP[diff] * 0.3) });
  }
  lines.push(...bonusXp(m, diff).lines);
  const total = lines.reduce((a, l) => a + l.xp, 0);
  return { lines, total };
}

export const xpMul = (diff: Difficulty) => (diff === 'hard' ? 1.5 : diff === 'medium' ? 1.2 : 1);

/** XP banked so far (swings, holes won, birdies…), excluding the match result. */
export function bonusXp(m: MatchState, diff: Difficulty): XpBreakdown {
  const lines: XpBreakdown['lines'] = [];
  let holesWon = 0, birdies = 0, eagles = 0, aces = 0;
  for (const h of m.holes) {
    if (h.winner === 'player') holesWon++;
    if (h.player !== null && h.winner !== null && h.playerHoled) {
      const d = h.player - h.par;
      if (h.player === 1) aces++;
      else if (d <= -2) eagles++;
      else if (d === -1) birdies++;
    }
  }
  const mul = xpMul(diff);
  if (m.swingXp) lines.push({ label: `Swing XP (${m.swingCount} swings)`, xp: m.swingXp });
  if (holesWon) lines.push({ label: `Holes won ×${holesWon}`, xp: Math.round(holesWon * 20 * mul) });
  if (birdies) lines.push({ label: `Birdies ×${birdies}`, xp: Math.round(birdies * 40 * mul) });
  if (eagles) lines.push({ label: `Eagles ×${eagles}`, xp: Math.round(eagles * 120 * mul) });
  if (aces) lines.push({ label: `Hole in one ×${aces}`, xp: Math.round(aces * 400 * mul) });
  const total = lines.reduce((a, l) => a + l.xp, 0);
  return { lines, total };
}
