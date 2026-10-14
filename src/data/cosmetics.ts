// Cosmetics unlocked by player level: shirt patterns, ball colours and club finishes. Purely
// looks: none of them change how the ball flies.

export interface Unlock {
  id: string;
  name: string;
  /** Player level that unlocks it. */
  level: number;
}

export type ShirtPattern = 'Solid' | 'Pinstripe' | 'Hoops' | 'Chest Band' | 'Sleeves';

export const SHIRT_PATTERNS: (Unlock & { id: ShirtPattern; code: number })[] = [
  { id: 'Solid', name: 'Solid', level: 1, code: 0 },
  { id: 'Pinstripe', name: 'Pinstripe', level: 2, code: 1 },
  { id: 'Chest Band', name: 'Chest Band', level: 3, code: 3 },
  { id: 'Sleeves', name: 'Two-Tone', level: 5, code: 4 },
  { id: 'Hoops', name: 'Hoops', level: 7, code: 2 },
];

export const BALL_COLORS: (Unlock & { hex: number; metal?: number })[] = [
  { id: 'white', name: 'Tour White', level: 1, hex: 0xffffff },
  { id: 'yellow', name: 'Optic Yellow', level: 2, hex: 0xf2f23a },
  { id: 'orange', name: 'Orange', level: 3, hex: 0xff8a2a },
  { id: 'pink', name: 'Pink', level: 4, hex: 0xff7ab8 },
  { id: 'lime', name: 'Lime', level: 5, hex: 0x8aff4a },
  { id: 'sky', name: 'Sky Blue', level: 6, hex: 0x5ab8ff },
  { id: 'red', name: 'Red', level: 8, hex: 0xe8302a },
  { id: 'black', name: 'Stealth Black', level: 10, hex: 0x1a1a1c },
  { id: 'gold', name: 'Gold', level: 12, hex: 0xe8b84a, metal: 0.8 },
];

/** Club head finishes; 'standard' keeps the look of the club's upgrade tier. */
export const CLUB_FINISHES: (Unlock & { head?: { color: number; metalness: number; roughness: number } })[] = [
  { id: 'standard', name: 'Standard', level: 1 },
  { id: 'black', name: 'Black PVD', level: 3, head: { color: 0x202124, metalness: 0.9, roughness: 0.32 } },
  { id: 'blue', name: 'Blue Ion', level: 5, head: { color: 0x2a5bd8, metalness: 0.95, roughness: 0.22 } },
  { id: 'copper', name: 'Copper', level: 7, head: { color: 0xc8744a, metalness: 1, roughness: 0.25 } },
  { id: 'gold', name: 'Gold', level: 10, head: { color: 0xe8b84a, metalness: 1, roughness: 0.18 } },
];

export const ballColor = (id: string) => BALL_COLORS.find((b) => b.id === id) ?? BALL_COLORS[0];
export const clubFinish = (id: string) => CLUB_FINISHES.find((f) => f.id === id) ?? CLUB_FINISHES[0];
export const shirtPatternCode = (id: string) => SHIRT_PATTERNS.find((p) => p.id === id)?.code ?? 0;
