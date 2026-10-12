// Course catalog. Yardages and pars follow the real front nines; terrain, hazards and green
// contours are generated procedurally from these hints, so holes are "inspired by" the real ones.

export type WaterKind =
  | 'pond-front' // pond short of the green
  | 'pond-left'
  | 'pond-right'
  | 'burn' // creek crossing in front of the green
  | 'ocean-right'
  | 'ocean-left'
  | 'chasm'; // ocean inlet crossing the hole

export interface HoleDef {
  par: 3 | 4 | 5;
  yards: number;
  name?: string;
  /** Dogleg angle in degrees: negative bends left, positive bends right. */
  bend?: number;
  /** Fraction of the hole length where the dogleg corner sits. */
  bendAt?: number;
  bend2?: number;
  bend2At?: number;
  /** Green elevation relative to the tee, metres. */
  elev?: number;
  water?: WaterKind[];
  greenBunkers?: number;
  fairwayBunkers?: number;
  pot?: boolean;
  greenSize?: number;
  /** Green tilt in percent (front-to-back rise). */
  greenSlope?: number;
  fwWidth?: number;
  oceanBehind?: boolean;
}

export type CourseStyle = 'links' | 'parkland' | 'coastal';

export interface CourseDef {
  id: string;
  name: string;
  location: string;
  blurb: string;
  style: CourseStyle;
  hdri: string;
  envIntensity: number;
  sunIntensity: number;
  exposure: number;
  trees: string[];
  treeDensity: number;
  bushes: string[];
  bushDensity: number;
  fescue: boolean;
  relief: number;
  dunes: number;
  firmness: number;
  windMin: number;
  windMax: number;
  colors: { fairway: number; rough: number; green: number; deep: number; sand: number; fescue: number };
  holes: HoleDef[];
}

export const COURSES: CourseDef[] = [
  {
    id: 'shinnecock',
    name: 'Shinnecock Hills',
    location: 'Southampton, New York',
    blurb: 'Windswept links-style test on the sandy hills of Long Island. Firm fairways, golden fescue and deep bunkers.',
    style: 'links',
    hdri: 'kloofendal_48d_partly_cloudy_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.2,
    exposure: 0.9,
    trees: ['Tree_Pine'],
    treeDensity: 0.08,
    bushes: ['Bush_Green', 'Bush_Gorse'],
    bushDensity: 0.35,
    fescue: true,
    relief: 5,
    dunes: 3.2,
    firmness: 1.15,
    windMin: 6,
    windMax: 16,
    colors: { fairway: 0x7ea044, rough: 0x66863a, green: 0x6a9e44, deep: 0x6f7a3e, sand: 0xd9c9a3, fescue: 0xa69a5c },
    holes: [
      { par: 4, yards: 399, name: 'Westward Ho', bend: 12, bendAt: 0.62, greenBunkers: 3, fairwayBunkers: 2, elev: 2 },
      { par: 3, yards: 252, name: 'Plateau', greenBunkers: 4, elev: 3, greenSlope: 2.2 },
      { par: 4, yards: 500, name: 'Peconic', bend: -6, bendAt: 0.55, greenBunkers: 3, fairwayBunkers: 3, elev: -2 },
      { par: 4, yards: 475, name: 'Pump House', bend: -14, bendAt: 0.58, greenBunkers: 3, fairwayBunkers: 2 },
      { par: 5, yards: 589, name: 'Montauk', bend: 8, bendAt: 0.45, bend2: -10, bend2At: 0.78, greenBunkers: 3, fairwayBunkers: 4, elev: 1 },
      { par: 4, yards: 491, name: 'Pond', bend: 14, bendAt: 0.6, water: ['pond-front'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 3, yards: 189, name: 'Redan', greenBunkers: 4, greenSlope: 3.2, elev: 1.5 },
      { par: 4, yards: 439, name: 'Lowlands', bend: -8, bendAt: 0.6, greenBunkers: 3, fairwayBunkers: 2, elev: -3 },
      { par: 4, yards: 485, name: 'Ben Nevis', bend: 6, bendAt: 0.55, greenBunkers: 4, fairwayBunkers: 2, elev: 9 },
    ],
  },
  {
    id: 'wykagyl',
    name: 'Wykagyl Country Club',
    location: 'New Rochelle, New York',
    blurb: 'Classic tree-lined Westchester parkland. Rolling terrain, lush fairways and tough elevated greens.',
    style: 'parkland',
    hdri: 'kloppenheim_05_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.0,
    exposure: 0.95,
    trees: ['Tree_Oak', 'Tree_Oak', 'Tree_Birch', 'Tree_Pine'],
    treeDensity: 1.0,
    bushes: ['Bush_Green'],
    bushDensity: 0.15,
    fescue: false,
    relief: 9,
    dunes: 0,
    firmness: 0.9,
    windMin: 0,
    windMax: 8,
    colors: { fairway: 0x5e9a35, rough: 0x4a7a2a, green: 0x4f9a3a, deep: 0x40682a, sand: 0xe0d5bc, fescue: 0x6a8a3a },
    holes: [
      { par: 5, yards: 537, bend: -8, bendAt: 0.5, greenBunkers: 2, fairwayBunkers: 2, elev: -4 },
      { par: 4, yards: 396, bend: 10, bendAt: 0.62, greenBunkers: 2, fairwayBunkers: 1, elev: 4 },
      { par: 4, yards: 456, bend: -6, bendAt: 0.6, greenBunkers: 3, fairwayBunkers: 1, elev: -2 },
      { par: 3, yards: 144, water: ['pond-front'], greenBunkers: 2, elev: -3 },
      { par: 4, yards: 397, bend: 14, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 1, elev: 5 },
      { par: 5, yards: 525, bend: 9, bendAt: 0.42, bend2: -9, bend2At: 0.75, water: ['pond-left'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 3, yards: 171, greenBunkers: 3, elev: 2, greenSlope: 2.6 },
      { par: 4, yards: 446, bend: -12, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 2, elev: -1 },
      { par: 5, yards: 494, bend: 10, bendAt: 0.55, greenBunkers: 3, fairwayBunkers: 1, elev: 6 },
    ],
  },
  {
    id: 'pebble',
    name: 'Pebble Beach Golf Links',
    location: 'Pebble Beach, California',
    blurb: 'Clifftop holes along Carmel Bay. Cypress trees, tiny greens and the Pacific waiting on the right.',
    style: 'coastal',
    hdri: 'qwantani_late_afternoon_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.2,
    exposure: 0.85,
    trees: ['Tree_Cypress', 'Tree_Cypress', 'Tree_Pine'],
    treeDensity: 0.45,
    bushes: ['Bush_Green'],
    bushDensity: 0.2,
    fescue: false,
    relief: 6,
    dunes: 0.5,
    firmness: 1.0,
    windMin: 4,
    windMax: 14,
    colors: { fairway: 0x6a9c3a, rough: 0x55803a, green: 0x5f9a40, deep: 0x5a7232, sand: 0xdccfb2, fescue: 0x9a9a5a },
    holes: [
      { par: 4, yards: 380, bend: 16, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 1, elev: 2, greenSize: 0.85 },
      { par: 5, yards: 511, bend: -5, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 2, water: ['burn'], greenSize: 0.85 },
      { par: 4, yards: 404, bend: -18, bendAt: 0.55, greenBunkers: 3, fairwayBunkers: 1, elev: -3, greenSize: 0.8 },
      { par: 4, yards: 331, water: ['ocean-right'], greenBunkers: 3, fairwayBunkers: 2, greenSize: 0.75, greenSlope: 2.4 },
      { par: 3, yards: 195, water: ['ocean-right'], greenBunkers: 2, greenSize: 0.8 },
      { par: 5, yards: 523, bend: 6, bendAt: 0.55, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 1, elev: 10, greenSize: 0.85 },
      { par: 3, yards: 109, water: ['ocean-right'], oceanBehind: true, greenBunkers: 4, elev: -7, greenSize: 0.65 },
      { par: 4, yards: 428, bend: 8, bendAt: 0.62, water: ['chasm', 'ocean-right'], greenBunkers: 2, greenSize: 0.8, elev: -2 },
      { par: 4, yards: 505, bend: -4, bendAt: 0.5, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 1, greenSize: 0.8, elev: -1 },
    ],
  },
  {
    id: 'standrews',
    name: 'St Andrews Old Course',
    location: 'St Andrews, Scotland',
    blurb: 'The Home of Golf. Vast shared fairways, hidden pot bunkers, gorse and huge double greens in the sea wind.',
    style: 'links',
    hdri: 'kloofendal_28d_misty_puresky',
    envIntensity: 0.9,
    sunIntensity: 3.2,
    exposure: 1.0,
    trees: [],
    treeDensity: 0,
    bushes: ['Bush_Gorse', 'Bush_Gorse', 'Bush_Green'],
    bushDensity: 1.0,
    fescue: true,
    relief: 3,
    dunes: 2.0,
    firmness: 1.25,
    windMin: 8,
    windMax: 20,
    colors: { fairway: 0x86a04a, rough: 0x718842, green: 0x74a048, deep: 0x6c7440, sand: 0xcfbd96, fescue: 0x9c9258 },
    holes: [
      { par: 4, yards: 376, name: 'Burn', water: ['burn'], greenBunkers: 0, fairwayBunkers: 1, pot: true, fwWidth: 1.8, greenSize: 1.2 },
      { par: 4, yards: 453, name: 'Dyke', bend: 6, bendAt: 0.55, greenBunkers: 2, fairwayBunkers: 3, pot: true, fwWidth: 1.4, greenSize: 1.4 },
      { par: 4, yards: 397, name: 'Cartgate', bend: 5, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 3, pot: true, fwWidth: 1.4, greenSize: 1.3 },
      { par: 4, yards: 480, name: 'Ginger Beer', bend: -6, bendAt: 0.5, greenBunkers: 2, fairwayBunkers: 4, pot: true, fwWidth: 1.3, greenSize: 1.3 },
      { par: 5, yards: 568, name: "Hole O'Cross", bend: 6, bendAt: 0.45, bend2: -5, bend2At: 0.75, greenBunkers: 2, fairwayBunkers: 5, pot: true, fwWidth: 1.4, greenSize: 1.6 },
      { par: 4, yards: 418, name: 'Heathery', bend: -5, bendAt: 0.55, greenBunkers: 1, fairwayBunkers: 3, pot: true, fwWidth: 1.3, greenSize: 1.3 },
      { par: 4, yards: 372, name: 'High', bend: 14, bendAt: 0.55, greenBunkers: 2, fairwayBunkers: 2, pot: true, fwWidth: 1.2, greenSize: 1.4 },
      { par: 3, yards: 175, name: 'Short', greenBunkers: 2, pot: true, greenSize: 1.2, greenSlope: 2 },
      { par: 4, yards: 352, name: 'End', greenBunkers: 1, fairwayBunkers: 3, pot: true, fwWidth: 1.6, greenSize: 1.2 },
    ],
  },
];

export function courseById(id: string): CourseDef {
  return COURSES.find((c) => c.id === id) ?? COURSES[0];
}

export const coursePar = (c: CourseDef) => c.holes.reduce((a, h) => a + h.par, 0);
export const courseYards = (c: CourseDef) => c.holes.reduce((a, h) => a + h.yards, 0);
