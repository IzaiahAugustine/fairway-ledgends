// Golf ball simulation: aerodynamic flight (drag + Magnus lift + wind), bounces, rolling on
// sloped turf, cup capture, flagstick and tree collisions. Shots are simulated up front and
// played back, so the camera and the AI know the outcome in advance.
import { Rng, clamp } from '../core/rng';
import { Surf } from '../world/holeGen';

export const BALL_R = 0.02135;
export const CUP_R = 0.054;
const G = 9.81;
const K_AERO = (0.5 * 1.2 * Math.PI * BALL_R * BALL_R) / 0.04593;

export interface Ground {
  heightAt(x: number, z: number): number;
  gradAt(x: number, z: number): { x: number; z: number };
  surfAt(x: number, z: number): Surf;
  waterLevelAt(x: number, z: number): number;
}

export interface TreeCollider {
  x: number;
  z: number;
  base: number;
  trunkR: number;
  crownY: number;
  crownR: number;
  crownH: number;
}

export interface SimEnv {
  ground: Ground;
  wind: { x: number; z: number };
  firmness: number;
  cup: { x: number; z: number } | null;
  flagIn: boolean;
  trees?: TreeIndex;
  seed?: number;
  /** Stop at the first ground contact (used for carry calibration and previews). */
  flightOnly?: boolean;
}

export interface Launch {
  x: number;
  y: number;
  z: number;
  speed: number;
  launchDeg: number;
  dirX: number;
  dirZ: number;
  spinRpm: number;
  /** Spin axis tilt in degrees, positive curves right. */
  axisDeg: number;
  putt?: boolean;
}

export type Outcome = 'rest' | 'holed' | 'water' | 'ob';

export interface SimEvent {
  t: number;
  type: 'bounce' | 'tree' | 'pin' | 'cup' | 'splash' | 'lip' | 'roll';
  x: number;
  y: number;
  z: number;
  surf?: Surf;
  speed?: number;
}

export interface SimResult {
  /** Flat array [t, x, y, z, ...] sampled at 60 Hz. */
  samples: number[];
  duration: number;
  outcome: Outcome;
  rest: { x: number; y: number; z: number };
  restSurf: Surf;
  landing: { x: number; y: number; z: number } | null;
  landingTime: number;
  carry: number;
  total: number;
  apex: number;
  waterEntry: { x: number; z: number } | null;
  events: SimEvent[];
  /** Closest approach to the cup (m). */
  closest: number;
}

const RESTITUTION: Record<number, number> = {
  [Surf.Fairway]: 0.32, [Surf.Tee]: 0.32, [Surf.Fringe]: 0.28, [Surf.Green]: 0.24,
  [Surf.Rough]: 0.18, [Surf.Deep]: 0.1, [Surf.Bunker]: 0.04, [Surf.OB]: 0.18, [Surf.Water]: 0,
};
const FRICTION: Record<number, number> = {
  [Surf.Fairway]: 0.42, [Surf.Tee]: 0.42, [Surf.Fringe]: 0.45, [Surf.Green]: 0.42,
  [Surf.Rough]: 0.6, [Surf.Deep]: 0.8, [Surf.Bunker]: 0.95, [Surf.OB]: 0.6, [Surf.Water]: 1,
};
const SPIN_BITE: Record<number, number> = {
  [Surf.Fairway]: 0.5, [Surf.Tee]: 0.5, [Surf.Fringe]: 0.75, [Surf.Green]: 1.0,
  [Surf.Rough]: 0.12, [Surf.Deep]: 0.05, [Surf.Bunker]: 0.1, [Surf.OB]: 0.1, [Surf.Water]: 0,
};
/** Rolling resistance: deceleration = a + k * speed (m/s^2). Green a/k give ~stimp 11. */
export const ROLL: Record<number, { a: number; k: number }> = {
  [Surf.Fairway]: { a: 1.35, k: 0.4 }, [Surf.Tee]: { a: 1.35, k: 0.4 }, [Surf.Fringe]: { a: 1.1, k: 0.32 },
  [Surf.Green]: { a: 0.47, k: 0.035 }, [Surf.Rough]: { a: 3.2, k: 0.9 }, [Surf.Deep]: { a: 6.5, k: 1.6 },
  [Surf.Bunker]: { a: 11, k: 2.5 }, [Surf.OB]: { a: 3.2, k: 0.9 }, [Surf.Water]: { a: 20, k: 2 },
};

/** Flat-ground roll distance for an initial speed. */
export function rollDistance(v0: number, a: number, k: number): number {
  if (k < 1e-6) return (v0 * v0) / (2 * a);
  return v0 / k - (a / (k * k)) * Math.log(1 + (k * v0) / a);
}

/** Initial speed needed to roll a given distance on flat ground. */
export function speedForRoll(dist: number, a: number, k: number): number {
  let lo = 0, hi = 40;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (rollDistance(m, a, k) < dist) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

export class TreeIndex {
  private cells = new Map<number, TreeCollider[]>();
  constructor(trees: TreeCollider[]) {
    for (const t of trees) {
      const r = t.crownR + 1;
      for (let i = Math.floor((t.x - r) / 12); i <= Math.floor((t.x + r) / 12); i++)
        for (let j = Math.floor((t.z - r) / 12); j <= Math.floor((t.z + r) / 12); j++) {
          const k = i * 73856093 ^ j * 19349663;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(t);
        }
    }
  }
  near(x: number, z: number): TreeCollider[] | undefined {
    return this.cells.get(Math.floor(x / 12) * 73856093 ^ Math.floor(z / 12) * 19349663);
  }
}

export function simulateShot(l: Launch, env: SimEnv): SimResult {
  const rng = new Rng(env.seed ?? 12345);
  const ground = env.ground;
  const samples: number[] = [];
  const events: SimEvent[] = [];
  const firm = env.firmness;
  let x = l.x, y = l.y, z = l.z;
  const la = (l.launchDeg * Math.PI) / 180;
  let vx = l.speed * Math.cos(la) * l.dirX;
  let vy = l.speed * Math.sin(la);
  let vz = l.speed * Math.cos(la) * l.dirZ;
  // spin axis: right = dir x up, tilted toward -up for positive (slice) tilt
  const ax = (l.axisDeg * Math.PI) / 180;
  const rX = -l.dirZ, rZ = l.dirX;
  let wx = rX * Math.cos(ax);
  let wy = -Math.sin(ax);
  let wz = rZ * Math.cos(ax);
  let spin = (l.spinRpm * 2 * Math.PI) / 60; // rad/s
  let mode: 'flight' | 'roll' = l.putt ? 'roll' : 'flight';
  if (mode === 'roll') vy = 0;
  let t = 0;
  let nextSample = 0;
  let landing: SimResult['landing'] = null;
  let landingTime = 0;
  let apex = y;
  let outcome: Outcome = 'rest';
  let waterEntry: SimResult['waterEntry'] = null;
  let rollVy = 0;
  let lipCooldown = 0;
  let pinHit = false;
  const cup = env.cup;
  let closest = cup ? Math.hypot(x - cup.x, z - cup.z) : Infinity;
  const startX = x, startZ = z;
  const dtF = 1 / 240;
  const push = () => {
    samples.push(t, x, y, z);
  };
  push();

  let steps = 0;
  while (t < 45 && steps < 200000) {
    steps++;
    const dt = dtF;
    if (mode === 'flight') {
      const rvx = vx - env.wind.x, rvy = vy, rvz = vz - env.wind.z;
      const sp = Math.hypot(rvx, rvy, rvz) || 1e-6;
      const S = (BALL_R * spin) / sp;
      const cd = 0.215 + 0.2 * S;
      const cl = clamp(1.25 * S, 0, 0.34);
      // lift direction = w x v
      let lx = wy * rvz - wz * rvy;
      let ly = wz * rvx - wx * rvz;
      let lz = wx * rvy - wy * rvx;
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx /= ll; ly /= ll; lz /= ll;
      const kd = K_AERO * cd * sp;
      const kl = K_AERO * cl * sp * sp;
      const accx = -kd * rvx + kl * lx;
      const accy = -kd * rvy + kl * ly - G;
      const accz = -kd * rvz + kl * lz;
      vx += accx * dt; vy += accy * dt; vz += accz * dt;
      const ox = x, oz = z;
      x += vx * dt; y += vy * dt; z += vz * dt;
      spin *= 1 - dt / 22;
      t += dt;
      if (y > apex) apex = y;

      // trees
      if (env.trees) {
        const list = env.trees.near(x, z);
        if (list) {
          for (const tr of list) {
            const dx = x - tr.x, dz = z - tr.z;
            const hd = Math.hypot(dx, dz);
            // trunk
            if (hd < tr.trunkR + BALL_R && y < tr.crownY && y > tr.base) {
              const nx = dx / (hd || 1), nz = dz / (hd || 1);
              const vn = vx * nx + vz * nz;
              if (vn < 0) {
                vx -= 1.6 * vn * nx;
                vz -= 1.6 * vn * nz;
                vx *= 0.5; vz *= 0.5; vy *= 0.6;
                events.push({ t, type: 'tree', x, y, z });
              }
            }
            // crown (ellipsoid)
            const cy = (y - tr.crownY) / tr.crownH;
            const inside = (hd / tr.crownR) ** 2 + cy * cy;
            if (inside < 1) {
              const sp2 = Math.hypot(vx, vy, vz);
              const density = 0.28 * (1 - inside * 0.6);
              if (rng.next() < 1 - Math.exp(-density * sp2 * dt)) {
                const keep = rng.range(0.12, 0.4);
                let nx = rng.range(-1, 1), ny = rng.range(-1, 0.2), nz = rng.range(-1, 1);
                const nl = Math.hypot(nx, ny, nz) || 1;
                nx /= nl; ny /= nl; nz /= nl;
                const ux = vx / (sp2 || 1), uy = vy / (sp2 || 1), uz = vz / (sp2 || 1);
                const s2 = sp2 * keep;
                vx = (ux * 0.35 + nx * 0.65) * s2;
                vy = (uy * 0.35 + ny * 0.65) * s2;
                vz = (uz * 0.35 + nz * 0.65) * s2;
                spin *= 0.3;
                if (events.length < 200) events.push({ t, type: 'tree', x, y, z });
              }
            }
          }
        }
      }

      // flagstick
      if (cup && env.flagIn && !pinHit) {
        const hd = Math.hypot(x - cup.x, z - cup.z);
        const gh = ground.heightAt(cup.x, cup.z);
        if (hd < 0.0065 + BALL_R && y - gh < 2.13 && y - gh > 0) {
          pinHit = true;
          const nx = (x - cup.x) / (hd || 1), nz = (z - cup.z) / (hd || 1);
          const vn = vx * nx + vz * nz;
          vx = (vx - 1.5 * vn * nx) * 0.35;
          vz = (vz - 1.5 * vn * nz) * 0.35;
          events.push({ t, type: 'pin', x, y, z });
        }
      }

      // out of the world
      const s = ground.surfAt(x, z);
      const h = ground.heightAt(x, z);
      if (s === Surf.Water) {
        const wl = ground.waterLevelAt(x, z);
        if (y - BALL_R <= wl) {
          outcome = 'water';
          waterEntry = { x: ox, z: oz };
          y = wl;
          events.push({ t, type: 'splash', x, y, z });
          if (!landing) { landing = { x, y, z }; landingTime = t; }
          break;
        }
      }
      if (y - BALL_R <= h) {
        // contact
        y = h + BALL_R;
        if (!landing) { landing = { x, y, z }; landingTime = t; }
        if (env.flightOnly) break;
        // dunk into the cup
        if (cup && Math.hypot(x - cup.x, z - cup.z) < CUP_R - BALL_R * 0.2 && Math.hypot(vx, vz) < 4.5) {
          outcome = 'holed';
          x = cup.x; z = cup.z; y = h - 0.06;
          events.push({ t, type: 'cup', x, y, z });
          push();
          break;
        }
        const g = ground.gradAt(x, z);
        let nx = -g.x, ny = 1, nz = -g.z;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        const vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) {
          let tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
          const vt = Math.hypot(tx, ty, tz) || 1e-6;
          tx /= vt; ty /= vt; tz /= vt;
          const e = clamp((RESTITUTION[s] ?? 0.2) * (0.8 + 0.2 * firm) * (1 - 0.25 * clamp(-vn / 30, 0, 1)), 0, 0.6);
          const mu = (FRICTION[s] ?? 0.4) / (0.85 + 0.15 * firm);
          const rpm = (spin * 60) / (2 * Math.PI);
          const bite = (SPIN_BITE[s] ?? 0.1) * clamp(rpm / 9000, 0, 1.4) ** 2 * 0.55;
          let newVt = vt - (mu + bite) * (1 + e) * -vn;
          // high-spin wedges can check up and spin back on greens
          const maxBack = s === Surf.Green || s === Surf.Fringe ? clamp((rpm - 7500) / 2500, 0, 1) * 2.4 : 0;
          if (newVt < -maxBack) newVt = -maxBack;
          if (newVt < 0 && maxBack === 0) newVt = 0;
          const nvn = -e * vn;
          vx = tx * newVt + nx * nvn;
          vy = ty * newVt + ny * nvn;
          vz = tz * newVt + nz * nvn;
          spin *= 0.4;
          events.push({ t, type: 'bounce', x, y, z, surf: s, speed: -vn });
          if (nvn < 0.9 || s === Surf.Bunker) {
            mode = 'roll';
            rollVy = 0;
            if (s === Surf.Bunker) { vx *= 0.25; vz *= 0.25; }
            events.push({ t, type: 'roll', x, y, z, surf: s });
          }
        }
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    } else {
      // rolling
      const s = ground.surfAt(x, z);
      if (s === Surf.Water) {
        outcome = 'water';
        waterEntry = { x, z };
        events.push({ t, type: 'splash', x, y, z });
        break;
      }
      const g = ground.gradAt(x, z);
      const gl2 = g.x * g.x + g.z * g.z;
      const slopeK = ((5 / 7) * G) / Math.sqrt(1 + gl2);
      let accx = -slopeK * g.x;
      let accz = -slopeK * g.z;
      const sp = Math.hypot(vx, vz);
      const rr = ROLL[s] ?? ROLL[Surf.Rough];
      const decel = (rr.a + rr.k * sp) / (s === Surf.Green ? 1 : firm);
      const slopeA = Math.hypot(accx, accz);
      if (sp < 0.02) {
        if (slopeA < decel * 1.05) {
          vx = 0; vz = 0;
          break;
        }
      }
      if (sp > 1e-5) {
        accx -= (decel * vx) / sp;
        accz -= (decel * vz) / sp;
      }
      const pvx = vx, pvz = vz;
      vx += accx * dt;
      vz += accz * dt;
      // friction must not reverse the motion on its own
      if (vx * pvx + vz * pvz < 0 && slopeA < decel) { vx = 0; vz = 0; }
      const ox = x, oz = z;
      x += vx * dt;
      z += vz * dt;
      t += dt;
      const oy = y;
      const nh = ground.heightAt(x, z) + BALL_R;
      // leave the ground if the terrain falls away faster than gravity can follow
      const needVy = (nh - oy) / dt;
      if (needVy < rollVy - G * dt * 2.5 && Math.hypot(vx, vz) > 1.2) {
        mode = 'flight';
        vy = rollVy - G * dt;
        y = oy + vy * dt;
        spin = 0;
      } else {
        rollVy = needVy;
        y = nh;
      }
      if (lipCooldown > 0) lipCooldown -= dt;
      if (cup) {
        // closest approach on this step
        const sx = x - ox, sz = z - oz;
        const sl2 = sx * sx + sz * sz || 1e-12;
        const tt = clamp(((cup.x - ox) * sx + (cup.z - oz) * sz) / sl2, 0, 1);
        const qx = ox + sx * tt, qz = oz + sz * tt;
        const cd = Math.hypot(qx - cup.x, qz - cup.z);
        if (cd < closest) closest = cd;
        if (cd < CUP_R && lipCooldown <= 0) {
          const spd = Math.hypot(vx, vz);
          const vmax = 1.45 * Math.sqrt(Math.max(0, 1 - (cd / CUP_R) ** 2));
          if (spd < vmax || cd < CUP_R * 0.35 && spd < 1.75) {
            outcome = 'holed';
            x = cup.x; z = cup.z; y = ground.heightAt(cup.x, cup.z) - 0.06;
            events.push({ t, type: 'cup', x, y, z });
            push();
            break;
          } else {
            // lip out: deflect and slow
            const side = (qx - cup.x) * -vz + (qz - cup.z) * vx >= 0 ? 1 : -1;
            const ang = side * (0.35 + 0.6 * (cd / CUP_R)) * (1.2 - clamp(spd / 3, 0, 1));
            const c = Math.cos(ang), sn = Math.sin(ang);
            const nvx = vx * c - vz * sn, nvz = vx * sn + vz * c;
            vx = nvx * 0.7; vz = nvz * 0.7;
            lipCooldown = 0.25;
            events.push({ t, type: 'lip', x, y, z });
          }
        }
      }
    }
    if (t >= nextSample) {
      push();
      nextSample += 1 / 60;
    }
    if (mode === 'flight' && y < -200) break;
  }
  if (outcome === 'rest') {
    const s = ground.surfAt(x, z);
    if (s === Surf.OB) outcome = 'ob';
    if (s === Surf.Water) outcome = 'water';
  }
  if (samples[samples.length - 4] !== t) push();
  const restSurf = ground.surfAt(x, z);
  if (cup) closest = Math.min(closest, Math.hypot(x - cup.x, z - cup.z));
  return {
    samples,
    duration: t,
    outcome,
    rest: { x, y, z },
    restSurf,
    landing,
    landingTime,
    carry: landing ? Math.hypot(landing.x - startX, landing.z - startZ) : Math.hypot(x - startX, z - startZ),
    total: Math.hypot(x - startX, z - startZ),
    apex: apex - l.y,
    waterEntry,
    events,
    closest: outcome === 'holed' ? 0 : closest,
  };
}

/** Interpolated position along a simulated shot at time t. */
export function sampleAt(r: SimResult, t: number, out: { x: number; y: number; z: number }) {
  const s = r.samples;
  const n = s.length / 4;
  if (t <= s[0]) { out.x = s[1]; out.y = s[2]; out.z = s[3]; return; }
  if (t >= s[(n - 1) * 4]) { out.x = s[(n - 1) * 4 + 1]; out.y = s[(n - 1) * 4 + 2]; out.z = s[(n - 1) * 4 + 3]; return; }
  // binary search
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid * 4] <= t) lo = mid; else hi = mid;
  }
  const t0 = s[lo * 4], t1 = s[hi * 4];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  out.x = s[lo * 4 + 1] + (s[hi * 4 + 1] - s[lo * 4 + 1]) * f;
  out.y = s[lo * 4 + 2] + (s[hi * 4 + 2] - s[lo * 4 + 2]) * f;
  out.z = s[lo * 4 + 3] + (s[hi * 4 + 3] - s[lo * 4 + 3]) * f;
}

/** Flat practice ground used to calibrate club distances. */
export class FlatGround implements Ground {
  heightAt() { return 0; }
  gradAt() { return { x: 0, z: 0 }; }
  surfAt() { return Surf.Fairway; }
  waterLevelAt() { return -100; }
}
