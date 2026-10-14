// Course catalog: five original courses, each in a different kind of landscape. Terrain, hazards
// and green contours are generated from these hints; the style picks the landscape around them.

export type WaterKind =
  | 'pond-front' // pond short of the green
  | 'pond-left'
  | 'pond-right'
  | 'burn' // creek crossing in front of the green
  | 'ocean-right'
  | 'ocean-left'
  | 'chasm' // ocean inlet crossing the hole
  | 'canyon' // deep rock ravine with a river at the bottom, crossing the hole
  | 'pond-corner'; // lake filling the inside of the dogleg (carry it to cut the corner)

export interface HoleDef {
  par: 3 | 4 | 5;
  yards: number;
  name?: string;
  /**
   * Dogleg angle in degrees: negative bends left, positive bends right. Real doglegs turn
   * 30-75 degrees at the corner (a horseshoe round a lake, 100+); under 12 reads as straight.
   */
  bend?: number;
  /** Fraction of the hole length where the dogleg corner sits (par 4s: the drive's landing zone). */
  bendAt?: number;
  bend2?: number;
  bend2At?: number;
  /** Degrees the green's long axis is turned from the line of approach (Redan-style when large). */
  greenAngle?: number;
  /** A long bunker slanted across the fairway in the lay-up zone. */
  crossBunker?: boolean;
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

export type CourseStyle = 'links' | 'parkland' | 'coastal' | 'beach' | 'alpine' | 'desert';

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
  /** Metres above sea level. Thinner air: the ball flies farther. */
  altitude?: number;
  /** Autumn colours: leaf tints for the tree variants (pines stay green). */
  foliage?: number[];
  /** Rock colour for cliffs and canyon walls. */
  rock?: number;
  /** Sea colours, shallow and deep. */
  sea?: { shallow: number; deep: number };
  colors: { fairway: number; rough: number; green: number; deep: number; sand: number; fescue: number };
  holes: HoleDef[];
}

/** How each style shapes the land: corridor widths, the coast, the far landscape, weather and sound. */
export interface StyleTraits {
  /** Fairway half-width (m) and the first cut of rough beyond it. */
  fwWidth: number;
  roughBand: number;
  /** Out-of-bounds distance beyond the fairway edge. */
  obBand: number;
  /** Native grass (fescue / scrub) in the carry zone short of the fairway. */
  carryNative: boolean;
  fwStartMul: number;
  greenRaise: number;
  teeRaise: number;
  /** Collar mound around greens (1 = parkland push-up greens). */
  collar: number;
  greenAmp: number;
  /** How the hole meets the sea: cliffs, or a sand beach shelving into the water. */
  shore: 'cliff' | 'beach';
  /** Sea level below the lowest point of the centre line. */
  seaDrop: number;
  /** Sea along one side of every hole in the backdrop, and how far beyond the hole edge. */
  seaAlways: boolean;
  seaDist: number;
  cliffs: boolean;
  rolling: number;
  ridge: number;
  /** Distance where the far ridges start to rise. */
  ridgeNear: number;
  forest: number;
  /** How much of the far land is dry grass / bare ground. */
  dry: number;
  cliffRock: number;
  /** Height above the hole where snow covers the far mountains (alpine); the treeline sits below it. */
  snowLine?: number;
  weather: { fair: number; breezy: number; overcast: number; rain: number };
  haze: number;
  cloudCover: number;
  /** Warm late-afternoon sun. */
  golden: boolean;
  surf: boolean;
  birdRate: number;
  windNoise: number;
}

export const STYLE: Record<CourseStyle, StyleTraits> = {
  links: {
    fwWidth: 19, roughBand: 9, obBand: 78, carryNative: true, fwStartMul: 0.75, greenRaise: 0.15, teeRaise: 0.4, collar: 0.4, greenAmp: 1.25,
    shore: 'beach', seaDrop: 11, seaAlways: true, seaDist: 1500, cliffs: false, rolling: 5, ridge: 30, ridgeNear: 700, forest: 0.08, dry: 0.6, cliffRock: 0.2,
    weather: { fair: 4, breezy: 3, overcast: 2, rain: 1 }, haze: 0.00022, cloudCover: 0.35, golden: false, surf: false, birdRate: 0.8, windNoise: 1.3,
  },
  parkland: {
    fwWidth: 15.5, roughBand: 12, obBand: 62, carryNative: false, fwStartMul: 1, greenRaise: 0.7, teeRaise: 0.8, collar: 1, greenAmp: 1,
    shore: 'cliff', seaDrop: 11, seaAlways: false, seaDist: 1500, cliffs: false, rolling: 16, ridge: 75, ridgeNear: 700, forest: 0.8, dry: 0.15, cliffRock: 0.75,
    weather: { fair: 6, breezy: 2, overcast: 1, rain: 1 }, haze: 0.00022, cloudCover: 0.3, golden: false, surf: false, birdRate: 1.8, windNoise: 1,
  },
  coastal: {
    fwWidth: 15, roughBand: 12, obBand: 78, carryNative: false, fwStartMul: 1, greenRaise: 0.4, teeRaise: 0.8, collar: 0.4, greenAmp: 1,
    shore: 'cliff', seaDrop: 11, seaAlways: true, seaDist: 650, cliffs: true, rolling: 14, ridge: 230, ridgeNear: 700, forest: 0.4, dry: 0.5, cliffRock: 1,
    weather: { fair: 4, breezy: 4, overcast: 2, rain: 1 }, haze: 0.0003, cloudCover: 0.4, golden: false, surf: true, birdRate: 0.6, windNoise: 1.3,
  },
  beach: {
    fwWidth: 17, roughBand: 10, obBand: 70, carryNative: false, fwStartMul: 0.85, greenRaise: 0.35, teeRaise: 0.6, collar: 0.4, greenAmp: 1,
    shore: 'beach', seaDrop: 2.6, seaAlways: true, seaDist: 260, cliffs: false, rolling: 4, ridge: 140, ridgeNear: 900, forest: 0.45, dry: 0.25, cliffRock: 0.3,
    weather: { fair: 7, breezy: 3, overcast: 1, rain: 1 }, haze: 0.00018, cloudCover: 0.2, golden: false, surf: true, birdRate: 0.9, windNoise: 1,
  },
  alpine: {
    fwWidth: 16, roughBand: 11, obBand: 60, carryNative: false, fwStartMul: 1, greenRaise: 0.6, teeRaise: 0.9, collar: 0.7, greenAmp: 1.1,
    shore: 'cliff', seaDrop: 11, seaAlways: false, seaDist: 1500, cliffs: false, rolling: 40, ridge: 1050, ridgeNear: 650, forest: 0.85, dry: 0.2, cliffRock: 1,
    snowLine: 430,
    weather: { fair: 6, breezy: 2, overcast: 2, rain: 1 }, haze: 0.00012, cloudCover: 0.3, golden: false, surf: false, birdRate: 1.2, windNoise: 1.1,
  },
  desert: {
    fwWidth: 15.5, roughBand: 6, obBand: 55, carryNative: true, fwStartMul: 0.9, greenRaise: 0.5, teeRaise: 0.8, collar: 0.5, greenAmp: 1.1,
    shore: 'cliff', seaDrop: 11, seaAlways: false, seaDist: 1500, cliffs: false, rolling: 18, ridge: 420, ridgeNear: 600, forest: 0, dry: 0.95, cliffRock: 1,
    weather: { fair: 10, breezy: 3, overcast: 1, rain: 0 }, haze: 0.00016, cloudCover: 0.12, golden: true, surf: false, birdRate: 0.35, windNoise: 1.2,
  },
};

export const traits = (c: CourseDef) => STYLE[c.style];

export const COURSES: CourseDef[] = [
  {
    id: 'coral-cove',
    name: 'Coral Cove',
    location: 'Isla Coralina, Caribbean',
    blurb: 'White-sand beaches, swaying palms and turquoise water on almost every hole. Miss right and you are on the beach.',
    style: 'beach',
    hdri: 'kloppenheim_05_puresky',
    envIntensity: 0.8,
    sunIntensity: 4.4,
    exposure: 0.92,
    trees: ['Tree_Palm', 'Tree_Palm', 'Tree_Palm', 'Tree_Cypress'],
    treeDensity: 0.4,
    bushes: ['Bush_Green'],
    bushDensity: 0.35,
    fescue: false,
    relief: 3,
    dunes: 1.2,
    firmness: 1.1,
    windMin: 6,
    windMax: 15,
    sea: { shallow: 0x2fc2b8, deep: 0x05507a },
    colors: { fairway: 0x74b23c, rough: 0x5e9a34, green: 0x66b044, deep: 0x8c9c56, sand: 0xf2ead2, fescue: 0xc8b680 },
    holes: [
      { par: 4, yards: 390, name: 'Sea Grape', bend: -22, bendAt: 0.64, greenBunkers: 2, fairwayBunkers: 1 },
      { par: 4, yards: 425, name: 'Conch', bend: -50, bendAt: 0.6, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 3, yards: 165, name: 'Lagoon', water: ['pond-front'], greenBunkers: 2, greenSlope: 2, greenAngle: 20 },
      { par: 5, yards: 545, name: 'Trade Winds', bend: 38, bendAt: 0.44, bend2: -36, bend2At: 0.77, water: ['ocean-right'], greenBunkers: 3, fairwayBunkers: 2 },
      { par: 4, yards: 380, name: 'Coconut Grove', bend: 58, bendAt: 0.64, greenBunkers: 2, fairwayBunkers: 2, elev: 2 },
      { par: 3, yards: 205, name: 'Shipwreck', water: ['ocean-right'], oceanBehind: true, greenBunkers: 2, greenSize: 0.85, greenAngle: -18 },
      { par: 4, yards: 440, name: 'Pelican', bend: -12, bendAt: 0.6, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 4, yards: 355, name: 'The Reef', water: ['chasm', 'ocean-right'], greenBunkers: 3, greenSize: 0.85, greenAngle: 16 },
      { par: 5, yards: 560, name: 'Sunset', bend: -32, bendAt: 0.44, bend2: 42, bend2At: 0.78, water: ['ocean-left'], greenBunkers: 3, fairwayBunkers: 2, crossBunker: true },
      { par: 4, yards: 410, name: 'Mangrove', bend: 44, bendAt: 0.6, water: ['pond-left'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 3, yards: 150, name: 'Flamingo', water: ['pond-front'], greenBunkers: 2, greenSize: 0.8, greenSlope: 2.4, greenAngle: -26 },
      { par: 4, yards: 460, name: 'Barefoot', bend: 10, bendAt: 0.55, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 4, yards: 330, name: 'Hammock', bend: -65, bendAt: 0.66, water: ['pond-corner'], greenBunkers: 3, fairwayBunkers: 1, greenSize: 0.85 },
      { par: 5, yards: 530, name: 'Tidepool', bend: 60, bendAt: 0.6, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 4, yards: 430, name: 'Driftwood', bend: -36, bendAt: 0.58, greenBunkers: 2, fairwayBunkers: 2, elev: -2 },
      { par: 3, yards: 190, name: 'Lighthouse', water: ['ocean-left'], oceanBehind: true, greenBunkers: 3, greenSize: 0.8, greenAngle: 22 },
      { par: 4, yards: 450, name: 'Riptide', water: ['chasm', 'ocean-right'], greenBunkers: 2, fairwayBunkers: 1, greenAngle: -10 },
      { par: 5, yards: 570, name: 'Paradise', bend: -34, bendAt: 0.42, bend2: 26, bend2At: 0.8, water: ['ocean-left', 'pond-front'], greenBunkers: 2, fairwayBunkers: 2 },
    ],
  },
  {
    id: 'summit-peaks',
    name: 'Summit Peaks',
    location: 'Rocky Mountains, 8,000 ft',
    blurb: 'Tee shots that hang in the thin mountain air over snowy peaks, pine forest and glacier lakes. The ball flies about 12% farther up here.',
    style: 'alpine',
    hdri: 'kloofendal_48d_partly_cloudy_puresky',
    envIntensity: 0.8,
    sunIntensity: 4.4,
    exposure: 0.9,
    trees: ['Tree_Pine', 'Tree_Pine', 'Tree_Pine', 'Tree_Birch'],
    treeDensity: 1.0,
    bushes: ['Bush_Green'],
    bushDensity: 0.2,
    fescue: false,
    relief: 10,
    dunes: 0,
    firmness: 1.0,
    windMin: 3,
    windMax: 12,
    altitude: 2440,
    rock: 0x7a7570,
    sea: { shallow: 0x3a8a8a, deep: 0x0a3446 },
    colors: { fairway: 0x5f9e36, rough: 0x4c822e, green: 0x55a03c, deep: 0x557a36, sand: 0xe6dcc6, fescue: 0x8a9a52 },
    holes: [
      { par: 4, yards: 450, name: 'Base Camp', bend: 30, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 1, elev: -8 },
      { par: 5, yards: 560, name: 'Switchback', bend: -44, bendAt: 0.4, bend2: 50, bend2At: 0.74, greenBunkers: 2, fairwayBunkers: 2, elev: 10 },
      { par: 3, yards: 215, name: "Eagle's Nest", greenBunkers: 3, elev: -24, greenSlope: 2, greenAngle: -15 },
      { par: 4, yards: 430, name: 'Glacier Lake', bend: 40, bendAt: 0.58, water: ['pond-left'], greenBunkers: 2, fairwayBunkers: 1, elev: -4 },
      { par: 4, yards: 470, name: 'Avalanche', bend: -52, bendAt: 0.56, greenBunkers: 2, fairwayBunkers: 2, elev: -14 },
      { par: 4, yards: 395, name: 'Timberline', bend: 64, bendAt: 0.64, greenBunkers: 2, fairwayBunkers: 1, elev: 9, fwWidth: 0.9 },
      { par: 3, yards: 175, name: 'Snowmelt', water: ['burn'], greenBunkers: 2, elev: -10, greenSlope: 2.4, greenAngle: 26 },
      { par: 4, yards: 485, name: 'The Ridge', bend: 6, bendAt: 0.55, greenBunkers: 3, fairwayBunkers: 2, elev: 6, fwWidth: 0.85 },
      { par: 5, yards: 600, name: 'Summit', bend: -40, bendAt: 0.62, greenBunkers: 3, fairwayBunkers: 2, elev: -18, crossBunker: true },
      { par: 4, yards: 410, name: 'Pinecone', bend: -56, bendAt: 0.62, greenBunkers: 2, fairwayBunkers: 1, elev: -6 },
      { par: 3, yards: 240, name: 'Echo Canyon', water: ['pond-front'], greenBunkers: 2, elev: -28, greenAngle: 12 },
      { par: 5, yards: 545, name: 'Elk Meadow', bend: -26, bendAt: 0.45, bend2: 44, bend2At: 0.8, water: ['pond-right'], greenBunkers: 2, fairwayBunkers: 2, elev: 4 },
      { par: 4, yards: 455, name: 'Rockslide', bend: 42, bendAt: 0.57, greenBunkers: 2, fairwayBunkers: 2, elev: 12 },
      { par: 3, yards: 165, name: 'Alpine Lake', water: ['pond-front'], greenBunkers: 2, elev: -6, greenSize: 0.85, greenAngle: -22 },
      { par: 4, yards: 500, name: 'Black Diamond', bend: 4, bendAt: 0.55, greenBunkers: 2, fairwayBunkers: 2, elev: -20, fwWidth: 0.85 },
      { par: 4, yards: 380, name: 'Ptarmigan', bend: -55, bendAt: 0.62, water: ['pond-corner', 'burn'], greenBunkers: 2, fairwayBunkers: 1, elev: 7 },
      { par: 3, yards: 205, name: 'Chairlift', greenBunkers: 3, elev: -16, greenSlope: 2.2, greenAngle: 18 },
      { par: 5, yards: 620, name: 'Long Way Down', bend: 38, bendAt: 0.4, bend2: -32, bend2At: 0.72, water: ['pond-front'], greenBunkers: 2, fairwayBunkers: 2, elev: -26 },
    ],
  },
  {
    id: 'red-mesa',
    name: 'Red Mesa',
    location: 'Sonoran Desert, Arizona',
    blurb: 'Emerald fairways cut through red rock and saguaro cactus. Carry the canyons, stay out of the desert, and enjoy firm, fast greens.',
    style: 'desert',
    hdri: 'qwantani_late_afternoon_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.6,
    exposure: 0.84,
    trees: ['Tree_Saguaro', 'Tree_Saguaro', 'Tree_Saguaro', 'Tree_Saguaro', 'Tree_Saguaro', 'Tree_Cypress'],
    treeDensity: 0.55,
    bushes: ['Bush_Barrel', 'Bush_Barrel', 'Bush_Gorse'],
    bushDensity: 0.6,
    fescue: true,
    relief: 7,
    dunes: 0.8,
    firmness: 1.3,
    windMin: 4,
    windMax: 14,
    altitude: 760,
    rock: 0x8c5642,
    sea: { shallow: 0x3a8a6a, deep: 0x123a30 },
    colors: { fairway: 0x74a83e, rough: 0x7c9640, green: 0x63a442, deep: 0xb89a6c, sand: 0xe8c9a0, fescue: 0xc49a66 },
    holes: [
      { par: 4, yards: 410, name: 'Coyote', bend: 34, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 2 },
      { par: 5, yards: 555, name: 'Saguaro', bend: -38, bendAt: 0.42, bend2: 32, bend2At: 0.76, greenBunkers: 2, fairwayBunkers: 3, elev: 3, crossBunker: true },
      { par: 4, yards: 440, name: 'Arroyo', bend: 22, bendAt: 0.84, water: ['canyon'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 3, yards: 195, name: 'Mesa Top', greenBunkers: 3, elev: 6, greenSlope: 2.2, greenAngle: -20 },
      { par: 4, yards: 455, name: 'Rattlesnake', bend: -48, bendAt: 0.57, greenBunkers: 2, fairwayBunkers: 2 },
      { par: 4, yards: 385, name: 'Dry Wash', bend: -20, bendAt: 0.84, water: ['canyon'], greenBunkers: 2, elev: -4, greenAngle: 14 },
      { par: 3, yards: 160, name: 'Oasis', water: ['pond-front'], greenBunkers: 2, greenSize: 0.85, greenAngle: 26 },
      { par: 5, yards: 590, name: 'Sidewinder', bend: 44, bendAt: 0.4, bend2: -46, bend2At: 0.74, greenBunkers: 3, fairwayBunkers: 3 },
      { par: 4, yards: 465, name: 'Red Rock', water: ['canyon'], greenBunkers: 2, fairwayBunkers: 1, elev: 5 },
      { par: 4, yards: 425, name: 'Roadrunner', bend: -58, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 2 },
      { par: 3, yards: 225, name: 'Hoodoo', water: ['canyon'], greenBunkers: 2, elev: -8, greenAngle: -12 },
      { par: 4, yards: 470, name: 'Tumbleweed', bend: 26, bendAt: 0.58, greenBunkers: 2, fairwayBunkers: 2, fwWidth: 0.9 },
      { par: 5, yards: 540, name: 'Mirage', bend: 105, bendAt: 0.5, water: ['pond-corner'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 4, yards: 360, name: 'Javelina', bend: -70, bendAt: 0.68, greenBunkers: 3, fairwayBunkers: 2, greenSize: 0.85 },
      { par: 4, yards: 445, name: 'Slot Canyon', bend: 16, bendAt: 0.84, water: ['canyon'], greenBunkers: 2, fairwayBunkers: 1, elev: -6 },
      { par: 3, yards: 175, name: 'Sundial', greenBunkers: 3, elev: -10, greenSlope: 2.4, greenAngle: 20 },
      { par: 4, yards: 480, name: 'Scorpion', bend: -24, bendAt: 0.84, water: ['canyon'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 5, yards: 575, name: 'Sundown', bend: -32, bendAt: 0.45, bend2: 38, bend2At: 0.74, water: ['pond-front'], greenBunkers: 2, fairwayBunkers: 2 },
    ],
  },
  {
    id: 'thunder-bluffs',
    name: 'Thunder Bluffs',
    location: 'Wild Atlantic coast',
    blurb: 'Clifftop golf high above crashing surf. Gusty sea wind, gorse on the headlands and heroic carries over ocean inlets.',
    style: 'coastal',
    hdri: 'kloofendal_48d_partly_cloudy_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.2,
    exposure: 0.9,
    trees: ['Tree_Pine'],
    treeDensity: 0.12,
    bushes: ['Bush_Gorse', 'Bush_Gorse', 'Bush_Green'],
    bushDensity: 0.9,
    fescue: true,
    relief: 6,
    dunes: 1.2,
    firmness: 1.15,
    windMin: 8,
    windMax: 19,
    rock: 0x605850,
    colors: { fairway: 0x7aa244, rough: 0x678a3c, green: 0x6ea446, deep: 0x6c7a40, sand: 0xd2c29e, fescue: 0xa09458 },
    holes: [
      { par: 4, yards: 405, name: 'Gannet', bend: -34, bendAt: 0.6, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 4, yards: 440, name: 'Storm Point', bend: -46, bendAt: 0.58, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 3, yards: 210, name: 'The Leap', water: ['chasm', 'ocean-right'], greenBunkers: 2, greenSize: 0.85, greenAngle: 16 },
      { par: 5, yards: 565, name: 'Kelp Bed', bend: 32, bendAt: 0.44, bend2: -36, bend2At: 0.78, water: ['ocean-right'], greenBunkers: 3, fairwayBunkers: 2 },
      { par: 4, yards: 425, name: 'Gorse Hill', bend: 54, bendAt: 0.6, greenBunkers: 3, fairwayBunkers: 2, elev: 6 },
      { par: 4, yards: 375, name: 'Blowhole', bend: 24, bendAt: 0.84, water: ['chasm', 'ocean-left'], greenBunkers: 2, greenSize: 0.85 },
      { par: 3, yards: 160, name: 'Puffin', water: ['ocean-right'], oceanBehind: true, greenBunkers: 3, greenSize: 0.75, elev: -4, greenAngle: -24 },
      { par: 4, yards: 470, name: 'Breakwater', bend: -12, bendAt: 0.55, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 5, yards: 545, name: 'Lookout', bend: 50, bendAt: 0.64, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 2, elev: 8 },
      { par: 4, yards: 420, name: 'Sea Stack', bend: -22, bendAt: 0.84, water: ['chasm', 'ocean-left'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 3, yards: 225, name: 'Spray', water: ['ocean-right'], oceanBehind: true, greenBunkers: 2, greenSize: 0.85, greenAngle: 14 },
      { par: 4, yards: 455, name: 'Driftnet', bend: -60, bendAt: 0.58, greenBunkers: 3, fairwayBunkers: 2, elev: -3 },
      { par: 4, yards: 395, name: 'Tidal Race', bend: 40, bendAt: 0.62, water: ['ocean-left'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 5, yards: 590, name: 'Thunderhead', bend: -36, bendAt: 0.42, bend2: 42, bend2At: 0.76, water: ['ocean-right'], greenBunkers: 3, fairwayBunkers: 3, crossBunker: true },
      { par: 4, yards: 435, name: 'Cormorant', water: ['chasm', 'ocean-right'], greenBunkers: 2, elev: -6, greenAngle: -12 },
      { par: 3, yards: 185, name: "Widow's Walk", water: ['ocean-left'], oceanBehind: true, greenBunkers: 2, greenSize: 0.7, greenSlope: 2.2, greenAngle: -20 },
      { par: 4, yards: 490, name: 'Gale', bend: 6, bendAt: 0.55, water: ['ocean-right'], greenBunkers: 2, fairwayBunkers: 2 },
      { par: 5, yards: 560, name: 'Lighthouse', bend: -55, bendAt: 0.66, water: ['ocean-left'], greenBunkers: 3, fairwayBunkers: 2, elev: 4 },
    ],
  },
  {
    id: 'maple-hollow',
    name: 'Maple Hollow',
    location: 'Green Mountains, Vermont',
    blurb: 'Autumn in New England: fairways framed by blazing red, orange and gold maples, a winding creek and a covered-bridge millpond.',
    style: 'parkland',
    hdri: 'kloppenheim_05_puresky',
    envIntensity: 0.75,
    sunIntensity: 4.0,
    exposure: 0.95,
    trees: ['Tree_Oak', 'Tree_Oak', 'Tree_Oak', 'Tree_Birch', 'Tree_Pine'],
    treeDensity: 1.0,
    bushes: ['Bush_Green'],
    bushDensity: 0.15,
    fescue: false,
    relief: 9,
    dunes: 0,
    firmness: 0.95,
    windMin: 0,
    windMax: 9,
    foliage: [0xff8a3a, 0xff4a2a, 0xffc24a],
    colors: { fairway: 0x6a9a38, rough: 0x58802e, green: 0x52983a, deep: 0x5a6e2e, sand: 0xe0d5bc, fescue: 0x8a8a44 },
    holes: [
      { par: 4, yards: 400, name: 'Sugar Maple', bend: -36, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 1, elev: 2 },
      { par: 4, yards: 430, name: 'Covered Bridge', bend: 26, bendAt: 0.58, water: ['burn'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 3, yards: 170, name: 'Cider Mill', water: ['pond-front'], greenBunkers: 2, elev: -3, greenAngle: 22 },
      { par: 5, yards: 535, name: 'Harvest', bend: 40, bendAt: 0.42, bend2: -44, bend2At: 0.75, greenBunkers: 2, fairwayBunkers: 2, elev: 4 },
      { par: 4, yards: 455, name: 'Red Oak', bend: -56, bendAt: 0.58, greenBunkers: 2, fairwayBunkers: 2, elev: 5 },
      { par: 4, yards: 385, name: 'Millpond', bend: 50, bendAt: 0.62, water: ['pond-corner'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 3, yards: 195, name: 'Hayride', greenBunkers: 3, elev: -6, greenSlope: 2.6, greenAngle: -18 },
      { par: 4, yards: 420, name: 'Pumpkin Patch', bend: 42, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 2, elev: -2 },
      { par: 5, yards: 560, name: 'Golden Mile', bend: -8, bendAt: 0.5, greenBunkers: 3, fairwayBunkers: 2, elev: 6, crossBunker: true },
      { par: 4, yards: 410, name: 'Stone Wall', bend: 6, bendAt: 0.6, greenBunkers: 2, fairwayBunkers: 1, elev: -3 },
      { par: 4, yards: 445, name: 'Birch Run', bend: -44, bendAt: 0.58, water: ['burn'], greenBunkers: 2, fairwayBunkers: 1, elev: -5 },
      { par: 3, yards: 150, name: 'Acorn', water: ['pond-front'], greenBunkers: 2, greenSize: 0.8, greenAngle: -26 },
      { par: 5, yards: 525, name: 'Woodsmoke', bend: -75, bendAt: 0.5, water: ['pond-corner'], greenBunkers: 2, fairwayBunkers: 1 },
      { par: 4, yards: 395, name: 'The Hollow', bend: 58, bendAt: 0.62, greenBunkers: 2, fairwayBunkers: 1, elev: -8 },
      { par: 4, yards: 465, name: 'Lantern', bend: 18, bendAt: 0.58, greenBunkers: 2, fairwayBunkers: 2, elev: 3 },
      { par: 3, yards: 210, name: 'Foliage', greenBunkers: 3, elev: -10, greenSlope: 2.4, greenAngle: 16 },
      { par: 4, yards: 440, name: 'Bramble', bend: 36, bendAt: 0.6, water: ['pond-left'], greenBunkers: 2, fairwayBunkers: 1, elev: 2 },
      { par: 5, yards: 545, name: 'Homestead', bend: -34, bendAt: 0.44, bend2: 30, bend2At: 0.76, water: ['pond-front'], greenBunkers: 2, fairwayBunkers: 2, elev: 6 },
    ],
  },
];

export function courseById(id: string): CourseDef {
  return COURSES.find((c) => c.id === id) ?? COURSES[0];
}

export const coursePar = (c: CourseDef) => c.holes.reduce((a, h) => a + h.par, 0);
export const courseYards = (c: CourseDef) => c.holes.reduce((a, h) => a + h.yards, 0);

/** Which holes a round uses: the front nine (1-9), the back nine (10-18) or all eighteen. */
export type HoleSet = 'front' | 'back' | 'all';
export const HOLE_SETS: { id: HoleSet; name: string; desc: string }[] = [
  { id: 'front', name: 'Front 9', desc: 'Holes 1-9' },
  { id: 'back', name: 'Back 9', desc: 'Holes 10-18' },
  { id: 'all', name: '18 Holes', desc: 'The full course' },
];

/** The course cut down to the chosen holes, and the number of the first one. */
export function courseForSet(c: CourseDef, set: HoleSet): { course: CourseDef; firstHole: number } {
  if (set === 'all' || c.holes.length <= 9) return { course: c, firstHole: 1 };
  if (set === 'back') return { course: { ...c, holes: c.holes.slice(9, 18) }, firstHole: 10 };
  return { course: { ...c, holes: c.holes.slice(0, 9) }, firstHole: 1 };
}
