// Procedural hole layout: centre path, fairway, rough, greens, bunkers, water and terrain heights.
// Everything is baked into a 0.5 m grid that both the renderer and the ball physics read.
import { Noise2D, Rng, clamp, lerp, smoothstep, YARD } from '../core/rng';
import { traits, type CourseDef, type HoleDef } from '../data/courses';

export enum Surf {
  OB = 0,
  Fairway = 1,
  Rough = 2,
  Deep = 3,
  Green = 4,
  Fringe = 5,
  Bunker = 6,
  Water = 7,
  Tee = 8,
}

export const SURF_NAME: Record<Surf, string> = {
  [Surf.OB]: 'Out of Bounds',
  [Surf.Fairway]: 'Fairway',
  [Surf.Rough]: 'Rough',
  [Surf.Deep]: 'Deep Rough',
  [Surf.Green]: 'Green',
  [Surf.Fringe]: 'Fringe',
  [Surf.Bunker]: 'Bunker',
  [Surf.Water]: 'Water',
  [Surf.Tee]: 'Tee Box',
};

interface Blob {
  x: number;
  z: number;
  rx: number;
  rz: number;
  rot: number;
  seed: number;
}
export interface Bunker extends Blob {
  depth: number;
  pot: boolean;
  /** Direction the steep face points (towards the green / tee). */
  faceX: number;
  faceZ: number;
}
export interface Pond extends Blob {
  level: number;
}
export interface Crossing {
  s: number;
  half: number;
  level: number;
  ocean: boolean;
  /** Deep rock ravine (desert) rather than a burn. */
  canyon?: boolean;
}

export interface TreeSpot {
  x: number;
  z: number;
  kind: string;
  scale: number;
  rot: number;
}

const CELL = 0.5;
const COARSE = 2.0;

export class HoleField {
  readonly def: HoleDef;
  readonly course: CourseDef;
  readonly index: number;
  readonly rng: Rng;
  readonly noise: Noise2D;

  // Centre line sampled every metre.
  px: number[] = [];
  pz: number[] = [];
  ps: number[] = [];
  length = 0;
  /** Dogleg corners: arc length of the apex, turn (radians, + right) and half-length of the turn. */
  bends: { s: number; ang: number; w: number }[] = [];
  /** Tightest centre-line radius through a dogleg (m), well outside the rough. */
  static TURN_RADIUS = 38;

  tee = { x: 0, z: 0 };
  teeDir = { x: 0, z: -1 };
  green = { x: 0, z: 0, rx: 15, rz: 12, rot: 0, h: 0 };
  greenTilt = { x: 0, z: 0 };
  greenAmp = 0.06;
  greenTier = 0;
  cup = { x: 0, z: 0 };

  fwStart = 0;
  fwEnd = 0;
  fwBase = 16;
  bunkers: Bunker[] = [];
  ponds: Pond[] = [];
  crossings: Crossing[] = [];
  oceanSide = 0; // +1 right, -1 left, 0 none
  oceanBehind = false;
  seaLevel = -20;
  /** True when an open-sea water plane is drawn for this hole. */
  get hasOcean(): boolean {
    return this.oceanSide !== 0 || this.oceanBehind || this.crossings.some((c) => c.ocean);
  }
  teeH = 0;

  // Grid.
  minX = 0;
  minZ = 0;
  nx = 0;
  nz = 0;
  heights!: Float32Array;
  surf!: Uint8Array;
  /**
   * Render-only anti-aliased surface coverage, 2 x RGBA8 per cell. Each channel stores a signed
   * distance (metres, +inside) to that surface's edge as 0.5 + d / 4, so bilinear filtering gives
   * smooth curved edges at any zoom. cover: fairway, fringe, green, bunker. cover2: deep/natural,
   * tee box, wet (below pond or burn level), slope (|grad h| / 2.55).
   */
  cover!: Uint8Array;
  cover2!: Uint8Array;
  pathS!: Float32Array; // along-path coordinate per mesh vertex (1 m grid) for mowing stripes
  pathD!: Float32Array;

  trees: TreeSpot[] = [];
  bushes: TreeSpot[] = [];
  obStakes: { x: number; z: number }[] = [];

  // Coarse grid of (s, d) for fast lookup.
  private cnx = 0;
  private cnz = 0;
  private cs!: Float32Array;
  private cd!: Float32Array;

  constructor(course: CourseDef, index: number, seed: number) {
    this.course = course;
    this.def = course.holes[index];
    this.index = index;
    this.rng = new Rng(seed);
    this.noise = new Noise2D(seed ^ 0x5bd1e995);
    this.buildPath();
    // bounds and path lookup first: placing water checks it against the fairway
    this.computeBounds();
    this.buildCoarse();
    this.placeFeatures();
    this.bake();
    this.placeVegetation();
  }

  // ---------------------------------------------------------------- layout

  private buildPath() {
    const d = this.def;
    const L = d.yards * YARD;
    let heading = this.rng.range(-0.06, 0.06); // radians, 0 = -Z
    // A dogleg runs straight out to the corner, swings round it and runs straight on, as real
    // holes are routed. Each turn is a smooth bump of curvature centred on the corner, wide
    // enough that the tightest radius stays outside the rough (so the corridor never folds).
    this.bends = [];
    if (d.bend) this.bends.push({ s: (d.bendAt ?? 0.6) * L, ang: (d.bend * Math.PI) / 180, w: 0 });
    if (d.bend2) this.bends.push({ s: (d.bend2At ?? 0.8) * L, ang: (d.bend2 * Math.PI) / 180, w: 0 });
    for (const b of this.bends) {
      b.w = Math.max(18, Math.abs(b.ang) * HoleField.TURN_RADIUS);
      b.s = clamp(b.s, b.w + 25, Math.max(b.w + 25, L - b.w - 30));
    }
    const curv = (s: number) => {
      let k = 0;
      for (const b of this.bends) {
        const u = (s - b.s) / b.w;
        if (Math.abs(u) < 1) k += ((b.ang / b.w) * (1 + Math.cos(Math.PI * u))) / 2;
      }
      return k;
    };
    // integrate the heading in quarter-metre steps, keeping a point every metre
    this.px = [0];
    this.pz = [0];
    this.ps = [0];
    let x = 0, z = 0, s = 0;
    const whole = Math.floor(L);
    for (let m = 1; m <= whole + 1; m++) {
      const end = Math.min(m, L);
      if (end <= s) break;
      const h = (end - s) / 4;
      for (let q = 0; q < 4; q++) {
        const k = curv(s + h / 2);
        const mid = heading + (k * h) / 2;
        x += Math.sin(mid) * h;
        z -= Math.cos(mid) * h;
        heading += k * h;
        s += h;
      }
      this.px.push(x);
      this.pz.push(z);
      this.ps.push(end);
    }
    this.length = L;
    this.tee = { x: this.px[0], z: this.pz[0] };
    const t0 = this.tangentAt(3);
    this.teeDir = t0;
  }

  /** Unit tangent of the centre line at arc length s. */
  tangentAt(s: number): { x: number; z: number } {
    const n = this.px.length;
    const i = clamp(Math.round(s), 1, n - 2);
    const dx = this.px[i + 1] - this.px[i - 1];
    const dz = this.pz[i + 1] - this.pz[i - 1];
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  pointAt(s: number): { x: number; z: number } {
    const n = this.px.length;
    const i = clamp(Math.floor(s), 0, n - 2);
    const t = clamp(s - i, 0, 1);
    return { x: lerp(this.px[i], this.px[i + 1], t), z: lerp(this.pz[i], this.pz[i + 1], t) };
  }

  private placeFeatures() {
    const d = this.def;
    const c = this.course;
    const rng = this.rng;
    const L = this.length;
    const end = this.pointAt(L);
    const endT = this.tangentAt(L - 2);
    const gs = d.greenSize ?? 1;
    const par3 = d.par === 3;
    this.green.rx = rng.range(14, 18) * gs * (par3 ? 0.9 : 1);
    this.green.rz = rng.range(11, 14) * gs * (par3 ? 0.95 : 1);
    // Green centre sits a little past the nominal yardage so the cup lands near the listed length.
    this.green.x = end.x;
    this.green.z = end.z;
    // greens sit at an angle to the approach rather than square to it; some (Redans) sharply
    const angle = d.greenAngle ?? rng.range(-14, 14);
    this.green.rot = Math.atan2(endT.x, -endT.z) + (angle * Math.PI) / 180;
    const slope = ((d.greenSlope ?? rng.range(1.1, 1.9)) * 0.75) / 100;
    // Rise from front to back, with a random sideways component.
    const side = rng.range(-0.6, 0.6);
    const fx = endT.x, fz = endT.z; // forward
    const rx = -fz, rz = fx; // right
    this.greenTilt = { x: (fx + rx * side) * slope, z: (fz + rz * side) * slope };
    this.greenAmp = rng.range(0.025, 0.045) * traits(c).greenAmp;
    this.greenTier = rng.chance(0.3) ? rng.range(0.15, 0.28) : 0;

    // Cup position: within the green, away from the edge.
    const ca = rng.range(0, Math.PI * 2);
    const cr = rng.range(0.1, 0.55);
    const lu = Math.cos(ca) * cr * this.green.rx * 0.9;
    const lv = Math.sin(ca) * cr * this.green.rz * 0.9;
    // local u = along the green's own axis, v = to its right
    const gfx = Math.sin(this.green.rot), gfz = -Math.cos(this.green.rot);
    this.cup = { x: this.green.x + gfx * lu - gfz * lv, z: this.green.z + gfz * lu + gfx * lv };

    // Fairway extents.
    this.fwBase = traits(c).fwWidth * (d.fwWidth ?? 1);
    if (par3) {
      this.fwStart = Math.max(0, L - this.green.rx - 28);
      this.fwEnd = L - this.green.rx * 0.6;
    } else {
      this.fwStart = Math.min(d.par === 5 ? 150 : 130, L * 0.3) * traits(c).fwStartMul;
      this.fwEnd = L - this.green.rx * 0.5;
    }
    // the dogleg the tee shot plays to, if any
    const corner = this.bends.find((b) => Math.abs(b.ang) > 0.3 && b.s > 140 && b.s < L - 90);

    // Water.
    const water = d.water ?? [];
    for (const w of water) {
      if (w === 'ocean-right') this.oceanSide = 1;
      if (w === 'ocean-left') this.oceanSide = -1;
      if (w === 'pond-front') {
        const prx = rng.range(12, 17);
        const s = L - this.green.rx - prx - rng.range(5, 8);
        const p = this.pointAt(s);
        const t = this.tangentAt(s);
        const off = rng.range(-6, 6);
        this.ponds.push({ x: p.x - t.z * off, z: p.z + t.x * off, rx: prx, rz: rng.range(26, 36), rot: Math.atan2(t.x, -t.z), seed: rng.next() * 100, level: 0 });
      }
      if (w === 'pond-left' || w === 'pond-right') {
        const sgn = w === 'pond-right' ? 1 : -1;
        const s = L * rng.range(0.55, 0.7);
        const p = this.pointAt(s);
        const t = this.tangentAt(s);
        const off = (this.fwBase + rng.range(8, 14)) * sgn;
        // long axis along the hole
        const pond = { x: p.x - t.z * off, z: p.z + t.x * off, rx: rng.range(40, 60), rz: rng.range(14, 20), rot: Math.atan2(t.x, -t.z), seed: rng.next() * 100, level: 0 };
        if (this.fitPond(pond)) this.ponds.push(pond);
      }
      if (w === 'pond-corner' && corner) {
        // water filling the inside of the dogleg: carry it to cut the corner, or play round
        const inside = Math.sign(corner.ang);
        const p = this.pointAt(corner.s);
        const t = this.tangentAt(corner.s);
        const nx = -t.z * inside, nz = t.x * inside;
        // a horseshoe wraps round a bigger lake
        const big = Math.max(1, Math.abs(corner.ang));
        const prx = rng.range(26, 34) * big;
        const off = this.fwBase * 1.2 + 12 + prx;
        const pond = { x: p.x + nx * off, z: p.z + nz * off, rx: prx, rz: rng.range(18, 24) * Math.sqrt(big), rot: Math.atan2(nx, -nz), seed: rng.next() * 100, level: 0 };
        if (this.fitPond(pond)) this.ponds.push(pond);
      }
      if (w === 'burn') {
        this.crossings.push({ s: L - this.green.rx - rng.range(6, 10), half: 2.6, level: 0, ocean: false });
      }
      if (w === 'chasm') {
        this.crossings.push({ s: L * rng.range(0.55, 0.62), half: 26, level: 0, ocean: true });
      }
      if (w === 'canyon') {
        // par 3s carry it from the tee; longer holes cross it in the second-shot zone
        const at = d.par === 3 ? rng.range(0.45, 0.55) : rng.range(0.56, 0.64);
        this.crossings.push({ s: L * at, half: d.par === 3 ? 13 : 16, level: 0, ocean: false, canyon: true });
      }
    }
    this.oceanBehind = !!d.oceanBehind;

    // Bunkers around the green.
    const gb = d.greenBunkers ?? 2;
    const pot = !!d.pot;
    const angles = [Math.PI * 0.78, -Math.PI * 0.78, Math.PI * 0.5, -Math.PI * 0.5, Math.PI * 0.95, 0.15];
    const used = angles.slice(0, gb).map((a) => a + rng.range(-0.25, 0.25));
    rng.next();
    for (const a of used) {
      // a measured from the approach direction; pi = front (towards tee)
      const ux = fx * Math.cos(a) + rx * Math.sin(a), uz = fz * Math.cos(a) + rz * Math.sin(a);
      // the green's edge that way (it may be angled and is never quite an ellipse)
      let er = 0;
      while (er < 40 && this.greenDist(this.green.x + ux * er, this.green.z + uz * er) < 1) er += 0.25;
      const dist = er + (pot ? rng.range(2.5, 4) : rng.range(4.5, 7));
      const bx = this.green.x + ux * dist;
      const bz = this.green.z + uz * dist;
      const bunker: Bunker = pot
        ? { x: bx, z: bz, rx: rng.range(2.9, 3.8), rz: rng.range(2.8, 3.6), rot: rng.range(0, 6.28), seed: rng.next() * 100, depth: rng.range(1.0, 1.3), pot: true, faceX: 0, faceZ: 0 }
        : { x: bx, z: bz, rx: rng.range(6, 10), rz: rng.range(3.2, 5), rot: Math.atan2(this.green.x - bx, -(this.green.z - bz)) + Math.PI / 2, seed: rng.next() * 100, depth: rng.range(0.7, 1.1), pot: false, faceX: 0, faceZ: 0 };
      const fl = Math.hypot(this.green.x - bx, this.green.z - bz) || 1;
      bunker.faceX = (this.green.x - bx) / fl;
      bunker.faceZ = (this.green.z - bz) / fl;
      this.bunkers.push(bunker);
    }
    // Fairway bunkers in the driving zone.
    const fb = d.fairwayBunkers ?? 0;
    for (let i = 0; i < fb; i++) {
      let s: number, sgn: number;
      if (corner && i < 2) {
        // at a dogleg one guards the inside of the corner against the cut, the other catches
        // a drive that runs through the fairway on the outside
        const inside = Math.sign(corner.ang);
        s = corner.s + (i === 0 ? rng.range(-30, -12) : rng.range(8, 28));
        sgn = i === 0 ? inside : -inside;
      } else {
        s = clamp(rng.range(205, 265) + (pot ? rng.range(-60, 40) : 0), 120, L - 80);
        sgn = i % 2 === 0 ? 1 : -1;
      }
      if (s > L - 60) continue;
      const p = this.pointAt(s);
      const t = this.tangentAt(s);
      const off = pot ? rng.range(-this.fwBase * 0.7, this.fwBase * 0.7) : sgn * (this.fwBase - rng.range(1, 4));
      const bx = p.x - t.z * off, bz = p.z + t.x * off;
      const bunker: Bunker = pot
        ? { x: bx, z: bz, rx: rng.range(2.8, 3.6), rz: rng.range(2.7, 3.4), rot: rng.range(0, 6.28), seed: rng.next() * 100, depth: rng.range(0.95, 1.25), pot: true, faceX: -t.x, faceZ: -t.z }
        : { x: bx, z: bz, rx: rng.range(4.5, 7), rz: rng.range(9, 14), rot: Math.atan2(t.x, -t.z), seed: rng.next() * 100, depth: rng.range(0.6, 0.9), pot: false, faceX: -t.x, faceZ: -t.z };
      this.bunkers.push(bunker);
    }
    if (d.crossBunker) {
      // a long bunker slanted across the fairway in the lay-up zone of a three-shotter
      const s = L - rng.range(95, 130);
      const p = this.pointAt(s);
      const t = this.tangentAt(s);
      const off = rng.range(-0.35, 0.35) * this.fwBase;
      this.bunkers.push({
        x: p.x - t.z * off, z: p.z + t.x * off, rx: rng.range(9, 12), rz: rng.range(3.5, 4.5),
        rot: Math.atan2(t.x, -t.z) + Math.PI / 2 + rng.range(-0.3, 0.3), seed: rng.next() * 100,
        depth: rng.range(0.8, 1.0), pot: false, faceX: -t.x, faceZ: -t.z,
      });
    }
  }

  /**
   * Keep a pond's banks off the fairway: one laid straight beside a bending hole can cut across
   * it, so ease it outward and shorten it until it sits clear. False if it never does.
   */
  private fitPond(p: Pond): boolean {
    for (let tries = 0; tries < 10; tries++) {
      const fx = Math.sin(p.rot), fz = -Math.cos(p.rot);
      let clear = true;
      for (let a = 0; a < 32 && clear; a++) {
        const ang = (a / 32) * Math.PI * 2;
        const u = Math.cos(ang) * p.rx * 1.4, v = Math.sin(ang) * p.rz * 1.4;
        const { s, d } = this.pathCoords(p.x + fx * u - fz * v, p.z + fz * u + fx * v);
        if (s > this.fwStart - 10 && s < this.fwEnd + 30 && Math.abs(d) < this.fwHalf(clamp(s, 0, this.length)) + 2) clear = false;
      }
      if (clear) return true;
      const pc = this.pathCoords(p.x, p.z);
      const t = this.tangentAt(clamp(pc.s, 0, this.length));
      const out = Math.sign(pc.d || 1) * 4;
      p.x += -t.z * out;
      p.z += t.x * out;
      p.rx *= 0.9;
    }
    return false;
  }

  private computeBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.px.length; i += 4) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
    }
    const m = 135;
    minX -= m;
    maxX += m;
    minZ -= m;
    maxZ += m;
    this.minX = Math.floor(minX / 2) * 2;
    this.minZ = Math.floor(minZ / 2) * 2;
    this.nx = Math.ceil((maxX - this.minX) / CELL) + 1;
    this.nz = Math.ceil((maxZ - this.minZ) / CELL) + 1;
    // keep mesh-friendly (even) counts
    if (this.nx % 2 === 0) this.nx++;
    if (this.nz % 2 === 0) this.nz++;
  }

  /** Brute-force nearest centre-line point on a coarse grid, refined by segment projection. */
  private buildCoarse() {
    const cnx = Math.ceil(((this.nx - 1) * CELL) / COARSE) + 1;
    const cnz = Math.ceil(((this.nz - 1) * CELL) / COARSE) + 1;
    this.cnx = cnx;
    this.cnz = cnz;
    this.cs = new Float32Array(cnx * cnz);
    this.cd = new Float32Array(cnx * cnz);
    const px = this.px, pz = this.pz, ps = this.ps;
    const n = px.length;
    const step = 2;
    for (let j = 0; j < cnz; j++) {
      const z = this.minZ + j * COARSE;
      for (let i = 0; i < cnx; i++) {
        const x = this.minX + i * COARSE;
        let best = Infinity, bi = 0;
        for (let k = 0; k < n; k += step) {
          const dx = x - px[k], dz = z - pz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bi = k; }
        }
        // refine around bi
        const lo = Math.max(0, bi - step), hi = Math.min(n - 1, bi + step);
        for (let k = lo; k <= hi; k++) {
          const dx = x - px[k], dz = z - pz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bi = k; }
        }
        // project on adjacent segment for continuous s
        let s = ps[bi];
        let sd = 0;
        const k0 = Math.min(bi, n - 2);
        const ax = px[k0], az = pz[k0];
        const bx = px[k0 + 1], bz = pz[k0 + 1];
        const vx = bx - ax, vz = bz - az;
        const vl2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / vl2;
        if (bi === 0 && t < 0) {
          s = t * Math.sqrt(vl2);
        } else if (bi >= n - 2 && t > 1) {
          s = ps[n - 2] + t * Math.sqrt(vl2);
        } else {
          t = clamp(t, 0, 1);
          s = ps[k0] + t * Math.sqrt(vl2);
        }
        const cx = ax + vx * clamp(t, bi === 0 ? -1e9 : 0, bi >= n - 2 ? 1e9 : 1);
        const cz = az + vz * clamp(t, bi === 0 ? -1e9 : 0, bi >= n - 2 ? 1e9 : 1);
        // signed lateral: positive to the right of travel direction
        const rx = -vz, rz = vx;
        const rl = Math.sqrt(vl2);
        sd = ((x - cx) * rx + (z - cz) * rz) / rl;
        const dd = Math.hypot(x - cx, z - cz);
        this.cs[j * cnx + i] = s;
        this.cd[j * cnx + i] = Math.sign(sd || 1) * dd;
      }
    }
  }

  /** Along-path s and signed lateral distance d at world (x, z). */
  pathCoords(x: number, z: number): { s: number; d: number } {
    const fx = (x - this.minX) / COARSE;
    const fz = (z - this.minZ) / COARSE;
    const i = clamp(Math.floor(fx), 0, this.cnx - 2);
    const j = clamp(Math.floor(fz), 0, this.cnz - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const a = j * this.cnx + i;
    const s = lerp(lerp(this.cs[a], this.cs[a + 1], tx), lerp(this.cs[a + this.cnx], this.cs[a + this.cnx + 1], tx), tz);
    const d = lerp(lerp(this.cd[a], this.cd[a + 1], tx), lerp(this.cd[a + this.cnx], this.cd[a + this.cnx + 1], tx), tz);
    return { s, d };
  }

  // ---------------------------------------------------------------- shapes

  /** Normalised elliptical distance with a wobbly boundary (1 = edge). */
  private blobDist(b: Blob, x: number, z: number, wobble: number): number {
    const dx = x - b.x, dz = z - b.z;
    // rot: angle from -Z; local u along rot direction, v to the right
    const fx = Math.sin(b.rot), fz = -Math.cos(b.rot);
    const u = dx * fx + dz * fz;
    const v = dx * -fz + dz * fx;
    const r = Math.hypot(u / b.rx, v / b.rz);
    if (wobble <= 0 || r > 3) return r;
    const ang = Math.atan2(v / b.rz, u / b.rx);
    const w = this.noise.noise(Math.cos(ang) * 1.3 + b.seed, Math.sin(ang) * 1.3 + b.seed * 0.7);
    const w2 = this.noise.noise(Math.cos(ang) * 2.2 + b.seed * 1.3, Math.sin(ang) * 2.2 - b.seed);
    return r / (1 + wobble * (0.82 * w + 0.18 * w2));
  }

  greenDist(x: number, z: number): number {
    const g = this.green;
    return this.blobDist({ x: g.x, z: g.z, rx: g.rx, rz: g.rz, rot: g.rot, seed: 17.3 + this.index }, x, z, 0.14);
  }

  private fwHalf(s: number): number {
    const n = this.noise.noise(s * 0.012, 3.7 + this.index);
    let w = this.fwBase * (1 + 0.22 * n);
    // narrow into the green approach
    const L = this.length;
    const toGreen = L - s;
    if (toGreen < 60) w = lerp(Math.min(w, this.green.rz * 1.05), w, smoothstep(10, 60, toGreen));
    return w;
  }

  private roughHalf(s: number): number {
    return this.fwHalf(s) + traits(this.course).roughBand + 5 * this.noise.noise(s * 0.02, 9.1 + this.index);
  }

  private obHalf(s: number): number {
    return this.fwHalf(s) + traits(this.course).obBand + 8 * this.noise.noise(s * 0.01, 2.3);
  }

  // ---------------------------------------------------------------- baking

  private bake() {
    const { nx, nz, minX, minZ } = this;
    this.heights = new Float32Array(nx * nz);
    this.surf = new Uint8Array(nx * nz);
    this.cover = new Uint8Array(nx * nz * 4);
    this.cover2 = new Uint8Array(nx * nz * 4);
    const enc = (d: number) => clamp(Math.round((0.5 + d / 4) * 255), 0, 255);
    const noise = this.noise;
    const c = this.course;
    const d = this.def;
    const L = this.length;
    const elev = d.elev ?? 0;
    const relief = c.relief;
    const teeH = 0;
    this.teeH = teeH;
    const pEnd = this.pointAt(L);
    const chordX = pEnd.x - this.tee.x, chordZ = pEnd.z - this.tee.z;
    const chordL2 = chordX * chordX + chordZ * chordZ || 1;

    // Base terrain before features.
    const baseH = (x: number, z: number, s: number, ad: number) => {
      const low = relief * noise.fbm(x * 0.0045 + 11, z * 0.0045 - 7, 3);
      const mid = relief * 0.22 * noise.fbm(x * 0.018 - 3, z * 0.018 + 5, 3);
      const corridor = smoothstep(this.roughHalf(clamp(s, 0, L)) + 4, this.fwHalf(clamp(s, 0, L)) * 0.6, ad);
      let h = low * (1 - 0.55 * corridor) + mid * (1 - 0.7 * corridor);
      // gentle fairway rolls
      h += 0.45 * noise.noise(x * 0.03 + 40, z * 0.03 - 40) * corridor;
      if (c.dunes > 0) {
        const outside = smoothstep(this.roughHalf(clamp(s, 0, L)) - 2, this.roughHalf(clamp(s, 0, L)) + 22, ad);
        // rounded links hummocks with flat swales between them
        const dn = noise.fbm(x * 0.017 + 5, z * 0.017 + 9, 2);
        const hummock = smoothstep(-0.15, 0.75, dn);
        h += c.dunes * outside * (hummock * hummock * 2.6 - 0.45 + 0.25 * noise.noise(x * 0.06 - 7, z * 0.06 + 3));
        h += c.dunes * 0.22 * corridor * noise.fbm(x * 0.032 - 2, z * 0.032 + 1, 2);
      }
      // elevation trend toward the green: along the path near it, but by progress along the
      // tee-to-green line farther out, where the path coordinate jumps across a dogleg's inside
      const chord = clamp(((x - this.tee.x) * chordX + (z - this.tee.z) * chordZ) / chordL2, 0, 1);
      const far = smoothstep(HoleField.TURN_RADIUS * 0.6, HoleField.TURN_RADIUS * 0.95, ad);
      h += elev * smoothstep(0, 1, lerp(clamp(s / L, 0, 1), chord, far));
      return h;
    };

    // Reference heights.
    const ref = (x: number, z: number) => {
      const pc = this.pathCoords(x, z);
      return baseH(x, z, pc.s, Math.abs(pc.d));
    };
    const g = this.green;
    const T = traits(c);
    const gBase = ref(g.x, g.z) + T.greenRaise;
    g.h = gBase;
    const teeBase = ref(this.tee.x, this.tee.z) + T.teeRaise;
    this.teeH = teeBase;
    for (const p of this.ponds) p.level = Math.min(ref(p.x, p.z), ref(p.x + p.rx, p.z), ref(p.x - p.rx, p.z), ref(p.x, p.z + p.rz), ref(p.x, p.z - p.rz)) - 0.5;
    for (const cr of this.crossings) {
      const p = this.pointAt(cr.s);
      cr.level = cr.ocean ? 0 : ref(p.x, p.z) - (cr.canyon ? 9 : 0.9);
    }
    // Sea level well below the cliff tops.
    let minRef = Infinity;
    for (let s = 0; s < L; s += 20) {
      const p = this.pointAt(s);
      minRef = Math.min(minRef, ref(p.x, p.z));
    }
    this.seaLevel = minRef - T.seaDrop;
    for (const cr of this.crossings) if (cr.ocean) cr.level = this.seaLevel;

    const fwd = this.tangentAt(L - 2);
    const right = { x: -fwd.z, z: fwd.x };
    const teeFwd = this.teeDir;
    const teeRight = { x: -teeFwd.z, z: teeFwd.x };
    const native = T.carryNative;

    for (let j = 0; j < nz; j++) {
      const z = minZ + j * CELL;
      for (let i = 0; i < nx; i++) {
        const x = minX + i * CELL;
        const { s, d: sd } = this.pathCoords(x, z);
        const ad = Math.abs(sd);
        const sc = clamp(s, 0, L);
        let h = baseH(x, z, s, ad);
        const edgeLow = noise.noise(x * 0.045 + 3, z * 0.045 - 2);
        const edgeN = edgeLow * 0.6 + noise.noise(x * 0.25, z * 0.25) * 0.25;

        // surface classification by corridor
        const fwH = this.fwHalf(sc) + edgeLow * 1.4;
        const rH = this.roughHalf(sc) + edgeN * 2.5;
        const oH = this.obHalf(sc);
        let surf: Surf;
        const inFwRange = s >= this.fwStart + edgeLow * 5 && s <= this.fwEnd + 30;
        // signed edge distances for the render coverage (see `cover`)
        let dFw = Math.min(fwH - ad, s - (this.fwStart + edgeLow * 5), this.fwEnd + 30 - s);
        let dDeep = ad - rH;
        let dGreen = -9, dFringe = -9, dTee = -9, dBunk = -9, dWet = -9;
        if (native) dDeep = Math.max(dDeep, Math.min(this.fwStart - 5 - s, rH - ad, s - 22));
        dDeep = Math.max(dDeep, s - (L + 22), -55 - s);
        if (inFwRange && ad < fwH) surf = Surf.Fairway;
        else if (ad < rH) surf = Surf.Rough;
        else if (ad < oH) surf = Surf.Deep;
        else surf = Surf.OB;
        // short of the fairway (carry zone) is rough on parkland, fescue on links
        if (s < this.fwStart && surf === Surf.Fairway) surf = Surf.Rough;
        if (s < this.fwStart - 5 && ad < rH && native && s > 22) surf = Surf.Deep;
        // behind the tee and past the green
        if (s < -55 || s > L + 60) surf = ad < rH && s > -55 ? Surf.Rough : Surf.OB;
        if (s > L + 22 && surf === Surf.Rough) surf = Surf.Deep;

        // Green complex.
        const gd = this.greenDist(x, z);
        const grX = x - g.x, grZ = z - g.z;
        if (gd < 3.2) {
          const gR = Math.min(g.rx, g.rz);
          dGreen = (1 - gd) * gR;
          dFringe = (1 + 1.4 / gR - gd) * gR;
          dDeep = Math.min(dDeep, (gd - 1.9) * gR);
          const u = grX * fwd.x + grZ * fwd.z;
          const v = grX * right.x + grZ * right.z;
          let gh = gBase + grX * this.greenTilt.x + grZ * this.greenTilt.z;
          gh += this.greenAmp * (noise.noise(u * 0.06 + 31, v * 0.06 - 12) + 0.35 * noise.noise(u * 0.11 - 4, v * 0.11 + 8));
          if (this.greenTier > 0) gh += this.greenTier * smoothstep(-4, 4, u - g.rx * 0.15 + v * 0.3);
          const w = 1 - smoothstep(1.0, 2.2, gd);
          h = lerp(h, gh, w);
          // collar mound
          h += 0.25 * Math.exp(-((gd - 1.25) * (gd - 1.25)) / 0.05) * T.collar;
          if (gd < 1) surf = Surf.Green;
          else if (gd < 1 + 1.4 / Math.min(g.rx, g.rz)) surf = Surf.Fringe;
          else if (gd < 1.9 && surf !== Surf.Fairway) surf = Surf.Rough;
        }

        // Tee box (10 x 7 m rectangle starting 4 m behind the tee point).
        {
          const tx = x - this.tee.x, tz = z - this.tee.z;
          const tu = tx * teeFwd.x + tz * teeFwd.z;
          const tv = tx * teeRight.x + tz * teeRight.z;
          const box = Math.max(Math.abs(tu + 3) / 7, Math.abs(tv) / 4.5);
          if (box < 2.2) {
            dTee = (1 - box) * 4.5;
            dDeep = Math.min(dDeep, (box - 2.2) * 4.5);
            const w = 1 - smoothstep(1.0, 2.2, box);
            h = lerp(h, teeBase, w);
            if (box < 1) surf = Surf.Tee;
            else if (surf !== Surf.Fairway) surf = Surf.Rough;
          }
        }

        // Bunkers.
        for (const b of this.bunkers) {
          if (Math.abs(x - b.x) > b.rx * 2 + 6 && Math.abs(z - b.z) > b.rz * 2 + 6) continue;
          const bd = this.blobDist(b, x, z, b.pot ? 0.05 : 0.22);
          if (bd > 1.8) continue;
          if (b.pot) {
            // revetted pot bunker: flat sand floor, near-vertical turf walls, a small lip
            const bowl = b.depth * (1 - smoothstep(0.68, 1.0, bd));
            h -= bowl;
            h += 0.22 * Math.exp(-((bd - 1.06) ** 2) / 0.03);
          } else {
            const bowl = b.depth * (1 - smoothstep(0.15, 1.02, bd));
            h -= bowl;
            // raised lip on the face side
            const dx = (x - b.x) / Math.max(b.rx, b.rz), dz = (z - b.z) / Math.max(b.rx, b.rz);
            const faceDot = dx * b.faceX + dz * b.faceZ;
            h += (0.25 + 0.45 * smoothstep(-0.2, 0.8, faceDot)) * Math.exp(-((bd - 1.1) ** 2) / 0.06);
          }
          const bR = Math.min(b.rx, b.rz);
          if (!b.pot) dBunk = Math.max(dBunk, (1 - bd) * bR);
          dFw = Math.min(dFw, (bd - 1.3) * bR);
          if (bd < 1) surf = Surf.Bunker;
          else if (bd < 1.3 && surf === Surf.Fairway) surf = Surf.Rough;
          if (b.pot) dBunk = Math.max(dBunk, (0.74 - bd) * bR);
        }

        // Ponds.
        for (const p of this.ponds) {
          const pd = this.blobDist(p, x, z, 0.18);
          if (pd > 1.6) continue;
          const bed = p.level - 1.4 * (1 - smoothstep(0, 1, pd));
          const bank = p.level + 0.35;
          if (pd < 1) h = Math.min(h, lerp(bed, bank, smoothstep(0.75, 1.0, pd)));
          else h = lerp(bank, h, smoothstep(1.0, 1.6, pd));
          const pR = Math.min(p.rx, p.rz);
          dFw = Math.min(dFw, (pd - 1.3) * pR);
          dDeep = Math.min(dDeep, (pd - 1.3) * pR);
          dWet = Math.max(dWet, p.level + 0.05 - h);
          if (h < p.level) surf = Surf.Water;
          else if (pd < 1.3 && surf !== Surf.Green && surf !== Surf.Fringe) surf = Surf.Rough;
        }

        // Crossing burn / chasm.
        for (const cr of this.crossings) {
          const ds = Math.abs(s - cr.s) + edgeN * (cr.ocean ? 3 : 0.4);
          if (ds > cr.half + 14) continue;
          if (cr.ocean) {
            const t = 1 - smoothstep(cr.half - 2, cr.half + 6, ds);
            h = lerp(h, cr.level - 3, t);
            if (ds < cr.half + 1) surf = Surf.Water;
          } else if (cr.canyon) {
            // sheer rock walls down to a river; ragged rims
            const rim = cr.half + 2.5 * noise.noise(x * 0.05 + 7, z * 0.05 - 3);
            const t = 1 - smoothstep(rim - 5, rim + 0.5, ds);
            const ledge = 1.6 * noise.ridged(x * 0.08, z * 0.08, 2) * (1 - t);
            h = Math.min(h, lerp(h, cr.level - 0.8 + ledge, t));
            dWet = Math.max(dWet, cr.level + 0.05 - h);
            dDeep = Math.max(dDeep, rim + 3 - ds);
            dFw = Math.min(dFw, ds - rim - 4);
            if (h < cr.level) surf = Surf.Water;
            else if (ds < rim + 3 && surf !== Surf.Green && surf !== Surf.Fringe && surf !== Surf.Tee) surf = Surf.Deep;
          } else {
            const t = 1 - smoothstep(cr.half * 0.6, cr.half + 1.6, ds);
            h = Math.min(h, lerp(h, cr.level - 0.6, t));
            dWet = Math.max(dWet, cr.level + 0.05 - h);
            if (h < cr.level) surf = Surf.Water;
          }
        }

        // Ocean side.
        if (this.oceanSide !== 0 || this.oceanBehind) {
          let o = -1e9;
          if (this.oceanSide !== 0) {
            const lat = sd * this.oceanSide;
            const edge = (s > L - 30 ? Math.max(this.fwHalf(sc), g.rz) + 10 : rH + 6) + 6 * noise.noise(s * 0.03, 1.7);
            o = lat - edge;
          }
          if (this.oceanBehind) {
            const past = s - (L + g.rx + 10 + 5 * noise.noise(sd * 0.05, 4.4));
            o = Math.max(o, past);
          }
          if (T.shore === 'beach') {
            // a sand beach: rough gives way to sand that shelves gently into the sea
            if (o > -6) {
              const beachTop = this.seaLevel + 0.9;
              h = lerp(h, beachTop, smoothstep(-6, 6, o));
              h = lerp(h, this.seaLevel - 2.5, smoothstep(8, 40, o));
              h += 0.25 * noise.noise(x * 0.04, z * 0.04) * (1 - smoothstep(8, 20, o));
              const sandEdge = o + 2 + 1.5 * noise.noise(x * 0.06 + 2, z * 0.06);
              if (surf !== Surf.Green && surf !== Surf.Fringe && surf !== Surf.Tee) {
                dBunk = Math.max(dBunk, sandEdge);
                dFw = Math.min(dFw, -sandEdge - 2);
                dDeep = Math.min(dDeep, -sandEdge);
                if (sandEdge > 0) surf = Surf.Bunker;
              }
              if (h < this.seaLevel) surf = Surf.Water;
            }
          } else if (o > -1) {
            const t = smoothstep(-1, 9, o);
            const rock = 2.5 * noise.ridged(x * 0.07, z * 0.07, 2);
            h = lerp(h, this.seaLevel - 4 + rock * (1 - t), t);
            if (o > 2) surf = Surf.Water;
          }
        }
        if (this.hasOcean && h < this.seaLevel + 0.05) surf = Surf.Water;

        const k = j * nx + i;
        this.heights[k] = h;
        this.surf[k] = surf;
        const o4 = k * 4;
        const cv = this.cover, cv2 = this.cover2;
        cv[o4] = enc(dFw);
        cv[o4 + 1] = enc(dFringe);
        cv[o4 + 2] = enc(dGreen);
        cv[o4 + 3] = enc(dBunk);
        cv2[o4] = enc(dDeep);
        cv2[o4 + 1] = enc(dTee);
        cv2[o4 + 2] = enc(dWet);
      }
    }

    // Slope magnitude for the renderers (no grass on cliffs, rock shading).
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const H = this.heights;
        const hx = (H[j * nx + Math.min(nx - 1, i + 1)] - H[j * nx + Math.max(0, i - 1)]) / ((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * CELL);
        const hz = (H[Math.min(nz - 1, j + 1) * nx + i] - H[Math.max(0, j - 1) * nx + i]) / ((Math.min(nz - 1, j + 1) - Math.max(0, j - 1)) * CELL);
        this.cover2[k * 4 + 3] = clamp(Math.round((Math.hypot(hx, hz) / 2.55) * 255), 0, 255);
      }

    // Path coordinates on the 1 m mesh grid for stripe shading.
    const mnx = (nx - 1) / 2 + 1, mnz = (nz - 1) / 2 + 1;
    this.pathS = new Float32Array(mnx * mnz);
    this.pathD = new Float32Array(mnx * mnz);
    for (let j = 0; j < mnz; j++) {
      for (let i = 0; i < mnx; i++) {
        const pc = this.pathCoords(minX + i, minZ + j);
        this.pathS[j * mnx + i] = pc.s;
        this.pathD[j * mnx + i] = pc.d;
      }
    }

    // White OB stakes along the boundary.
    for (let s = 0; s < L + 40; s += 28) {
      const p = this.pointAt(clamp(s, 0, L));
      const t = this.tangentAt(clamp(s, 2, L - 2));
      for (const sg of [-1, 1]) {
        if (this.oceanSide === sg) continue;
        const off = this.obHalf(clamp(s, 0, L)) * sg;
        const sx = p.x - t.z * off, sz = p.z + t.x * off;
        // inside a dogleg this point is nearer the other leg, well in bounds
        if (Math.abs(this.pathCoords(sx, sz).d) < Math.abs(off) - 3) continue;
        if (this.surfAt(sx + t.z * sg * 1.5, sz - t.x * sg * 1.5) !== Surf.Water) this.obStakes.push({ x: sx, z: sz });
      }
    }
  }

  private placeVegetation() {
    const c = this.course;
    const rng = new Rng(this.index * 7919 + 13);
    const L = this.length;
    const grid = new Map<string, { x: number; z: number }[]>();
    const cellKey = (x: number, z: number) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    const tooClose = (x: number, z: number, r: number) => {
      const ci = Math.floor(x / 8), cj = Math.floor(z / 8);
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++) {
          const list = grid.get(`${ci + a},${cj + b}`);
          if (!list) continue;
          for (const p of list) if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) return true;
        }
      return false;
    };
    const add = (x: number, z: number) => {
      const k = cellKey(x, z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push({ x, z });
    };
    const area = (this.nx * this.nz * CELL * CELL) / 1000;
    // dogleg corners are planted up on the inside so the corner can't simply be flown
    const corners = this.bends.filter((b) => Math.abs(b.ang) > 0.3);
    const cornerAttempts = 70 * corners.length;
    const spot = (n: number) => {
      if (n >= cornerAttempts) return { x: this.minX + rng.next() * (this.nx - 1) * CELL, z: this.minZ + rng.next() * (this.nz - 1) * CELL };
      const b = corners[n % corners.length];
      const s = clamp(b.s + rng.range(-1.3, 0.7) * b.w - 15, 0, L);
      const p = this.pointAt(s), t = this.tangentAt(s);
      const off = Math.sign(b.ang) * (this.fwHalf(s) + rng.range(10, 55));
      return { x: p.x - t.z * off, z: p.z + t.x * off };
    };
    if (c.trees.length > 0 && c.treeDensity > 0) {
      const attempts = Math.floor(area * 9 * c.treeDensity) + cornerAttempts;
      for (let n = 0; n < attempts; n++) {
        const { x, z } = spot(n);
        const sf = this.surfAt(x, z);
        if (sf !== Surf.Deep && sf !== Surf.Rough && sf !== Surf.OB) continue;
        const { s, d } = this.pathCoords(x, z);
        const ad = Math.abs(d);
        const sc = clamp(s, 0, L);
        const fw = this.fwHalf(sc);
        if (ad < fw + 9) continue;
        if (s > -8 && s < 40 && ad < fw + 16) continue; // keep tee chute open
        if (this.greenDist(x, z) < 2.6) continue;
        if (this.nearWater(x, z, 6)) continue;
        // denser further from the corridor
        const p = sf === Surf.Rough ? 0.18 : sf === Surf.Deep ? 0.75 : 0.5;
        if (!rng.chance(n < cornerAttempts ? Math.max(p, 0.6) : p)) continue;
        const kind = rng.pick(c.trees);
        const minDist = kind === 'Tree_Cypress' ? 9 : kind === 'Tree_Birch' ? 5 : 7;
        if (tooClose(x, z, minDist)) continue;
        add(x, z);
        this.trees.push({ x, z, kind, scale: rng.range(0.8, 1.2), rot: rng.range(0, Math.PI * 2) });
      }
    }
    if (c.bushes.length > 0 && c.bushDensity > 0) {
      const attempts = Math.floor(area * 14 * c.bushDensity) + cornerAttempts;
      for (let n = 0; n < attempts; n++) {
        const { x, z } = spot(n);
        const sf = this.surfAt(x, z);
        if (sf !== Surf.Deep && sf !== Surf.OB) continue;
        if (this.greenDist(x, z) < 2.4 || this.nearWater(x, z, 3)) continue;
        // gorse grows in clumps
        const clump = this.noise.noise(x * 0.03 + 50, z * 0.03 - 50);
        if (clump < 0.1 && n >= cornerAttempts && !rng.chance(0.15)) continue;
        if (tooClose(x, z, 2.2)) continue;
        add(x, z);
        this.bushes.push({ x, z, kind: rng.pick(c.bushes), scale: rng.range(0.7, 1.35), rot: rng.range(0, Math.PI * 2) });
      }
    }
  }

  nearWater(x: number, z: number, r: number): boolean {
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2;
      if (this.surfAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r) === Surf.Water) return true;
    }
    return this.surfAt(x, z) === Surf.Water;
  }

  // ---------------------------------------------------------------- queries

  inBounds(x: number, z: number): boolean {
    const fx = (x - this.minX) / CELL, fz = (z - this.minZ) / CELL;
    return fx >= 0 && fz >= 0 && fx < this.nx - 1 && fz < this.nz - 1;
  }

  heightAt(x: number, z: number): number {
    const fx = clamp((x - this.minX) / CELL, 0, this.nx - 1.001);
    const fz = clamp((z - this.minZ) / CELL, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const k = j * this.nx + i;
    const H = this.heights;
    return lerp(lerp(H[k], H[k + 1], tx), lerp(H[k + this.nx], H[k + this.nx + 1], tx), tz);
  }

  /** Height gradient (dh/dx, dh/dz) using a 0.5 m central difference. */
  gradAt(x: number, z: number): { x: number; z: number } {
    const e = 0.35;
    return {
      x: (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e),
      z: (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e),
    };
  }

  surfAt(x: number, z: number): Surf {
    if (!this.inBounds(x, z)) return Surf.OB;
    const i = Math.round((x - this.minX) / CELL), j = Math.round((z - this.minZ) / CELL);
    return this.surf[j * this.nx + i] as Surf;
  }

  /** Water surface level at a point if it is water. */
  waterLevelAt(x: number, z: number): number {
    for (const p of this.ponds) if (this.blobDist(p, x, z, 0) < 1.6) return p.level;
    const { s } = this.pathCoords(x, z);
    for (const cr of this.crossings) if (Math.abs(s - cr.s) < cr.half + 8) return cr.level;
    return this.seaLevel;
  }

  /** Distance from tee to cup along the play line, in metres. */
  get playLength(): number {
    return Math.hypot(this.cup.x - this.tee.x, this.cup.z - this.tee.z);
  }

  /**
   * Where to aim a shot that can't reach the green: the farthest point down the centre line
   * within `reach` (straight-line) of (x, z) that can be seen along the fairway. On a dogleg
   * that is the corner, not a line across the trees on the inside.
   */
  layupPoint(x: number, z: number, reach: number): { x: number; z: number } {
    const start = this.pathCoords(x, z);
    let best: { x: number; z: number } | null = null;
    let s = Math.max(0, start.s) + 2;
    for (; s < this.length; s += 2) {
      const p = this.pointAt(s);
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist >= reach) break;
      // the line may start out in the rough, where the ball is, but must close onto the fairway
      let open = true;
      for (let k = 1; k < 8 && open; k++) {
        const pc = this.pathCoords(x + ((p.x - x) * k) / 8, z + ((p.z - z) * k) / 8);
        if (Math.abs(pc.d) > this.fwHalf(clamp(pc.s, 0, this.length)) + 4 + Math.abs(start.d) * (1 - k / 8)) open = false;
      }
      if (open) best = p;
      else if (dist > 60) break;
    }
    return best ?? this.pointAt(Math.min(s, this.length));
  }
}
