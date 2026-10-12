// Match-play bookkeeping: hole results, match status ("2 UP", "AS", "3&2"), score names and XP.
import type { Difficulty } from '../core/save';

export type Side = 'player' | 'ai';

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

  constructor(pars: number[]) {
    this.holes = pars.map((par) => ({ par, player: null, ai: null, winner: null }));
  }

  /** Positive: player is up. */
  get margin(): number {
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
    return Math.abs(this.margin) > this.remaining || this.remaining === 0;
  }

  get dormie(): boolean {
    return !this.decided && this.remaining > 0 && Math.abs(this.margin) === this.remaining;
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

  /** "2 UP", "1 DN", "AS", or final "3 & 2". */
  statusText(perspective: Side = 'player'): string {
    const m = perspective === 'player' ? this.margin : -this.margin;
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
    if (margin >= 3) lines.push({ label: `Dominant win (${margin} up)`, xp: margin * 25 });
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
