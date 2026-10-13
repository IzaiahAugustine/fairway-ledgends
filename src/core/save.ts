// Local save data: player profile, appearance, XP, club tiers, stats and settings.
import { CLUBS } from '../data/clubs';
import type { SwingStyleId } from '../data/swingStyles';
import type { HoleSet } from '../data/courses';
import type { Format } from '../game/match';

export type Difficulty = 'easy' | 'medium' | 'hard';
export type SwingMode = 'stick' | 'threeClick';
export type Quality = 'low' | 'medium' | 'high';
export type TextSize = 'normal' | 'large' | 'xl';

export const TEXT_SCALE: Record<TextSize, number> = { normal: 1, large: 1.25, xl: 1.5 };

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: 'Short' | 'Long' | 'None';
  hat: 'Cap' | 'Visor' | 'Bucket' | 'None';
  hatColor: string;
  shirt: string;
  pants: string;
  shoes: string;
  belt: string;
  sunglasses: boolean;
  build: number; // 0 slim .. 1 heavy
  height: number; // metres
}

export interface SaveData {
  version: 1;
  name: string;
  appearance: Appearance;
  xp: number;
  xpEarned: number;
  clubs: Record<string, number>;
  stats: { played: number; won: number; lost: number; halved: number; holesWon: number; birdies: number; eagles: number; aces: number };
  best: Record<string, string>;
  /** Swing archetype the player plays with. */
  swingStyle: SwingStyleId;
  settings: { swingMode: SwingMode; gimmes: boolean; sound: boolean; quality: Quality; difficulty: Difficulty; courseId: string; textSize: TextSize; format: Format; holes: HoleSet; weather: 'random' | 'fair';
    /** Volumes 0..1. */
    volMaster: number; volEffects: number; volAmbience: number; volMusic: number;
    /** Music during rounds (menus always have it unless the music volume is 0). */
    musicInRound: boolean;
    /** How strong the wind blows in rounds. */
    wind: 'calm' | 'light' | 'full';
    /** What the automatic quality protects first: frame rate, a balance, or how it looks. */
    gfxPriority: 'smooth' | 'balanced' | 'quality' };
  /** Career mode: index of the next event to win. */
  career: { stage: number };
}

const KEY = 'fairwayLegends.save.v1';

export const DEFAULT_APPEARANCE: Appearance = {
  skin: '#c68a62',
  hair: '#3b2a1e',
  hairStyle: 'Short',
  hat: 'Cap',
  hatColor: '#1c2b4a',
  shirt: '#f2f2f0',
  pants: '#2d3440',
  shoes: '#f4f4f4',
  belt: '#1a1a1a',
  sunglasses: false,
  build: 0.25,
  height: 1.8,
};

function defaults(): SaveData {
  const clubs: Record<string, number> = {};
  for (const c of CLUBS) clubs[c.id] = 0;
  return {
    version: 1,
    name: 'Player',
    appearance: { ...DEFAULT_APPEARANCE },
    xp: 0,
    xpEarned: 0,
    clubs,
    stats: { played: 0, won: 0, lost: 0, halved: 0, holesWon: 0, birdies: 0, eagles: 0, aces: 0 },
    best: {},
    swingStyle: 'classic',
    settings: { swingMode: 'stick', gimmes: true, sound: true, quality: 'high', difficulty: 'medium', courseId: 'coral-cove', textSize: 'large', format: 'match', holes: 'front', weather: 'random', volMaster: 0.7, volEffects: 0.8, volAmbience: 0.5, volMusic: 0.5, musicInRound: false, wind: 'light', gfxPriority: 'balanced' },
    career: { stage: 0 },
  };
}

function load(): SaveData {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      ...d,
      ...parsed,
      appearance: { ...d.appearance, ...(parsed.appearance ?? {}) },
      clubs: { ...d.clubs, ...(parsed.clubs ?? {}) },
      stats: { ...d.stats, ...(parsed.stats ?? {}) },
      best: { ...(parsed.best ?? {}) },
      settings: { ...d.settings, ...(parsed.settings ?? {}) },
      career: { ...d.career, ...(parsed.career ?? {}) },
    };
  } catch {
    return d;
  }
}

export const save: SaveData = load();

export function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}

export function resetSave(): void {
  const d = defaults();
  Object.assign(save, d);
  persist();
}

export function playerLevel(xpEarned: number): { level: number; into: number; next: number } {
  let level = 1;
  let need = 250;
  let rest = xpEarned;
  while (rest >= need) {
    rest -= need;
    level++;
    need = Math.round(need * 1.18);
  }
  return { level, into: rest, next: need };
}
