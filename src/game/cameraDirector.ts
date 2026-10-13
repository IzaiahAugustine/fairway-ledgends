// Broadcast-style camera work: behind-the-golfer address view, tee/landing cuts during ball
// flight, putting follow cam, hole flyover, target view and green-read view.
import * as THREE from 'three';
import { sampleAt, type SimResult } from '../physics/ballPhysics';
import type { HoleField } from '../world/holeGen';

export type CamMode = 'address' | 'flight' | 'putt' | 'flyover' | 'target' | 'green' | 'free';

export class CameraDirector {
  mode: CamMode = 'address';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private wantPos = new THREE.Vector3();
  private wantLook = new THREE.Vector3();
  private snap = true;
  // flight
  private shot: SimResult | null = null;
  private shotT = 0;
  private cut = false;
  private cutTime = 0;
  private landCam = new THREE.Vector3();
  /** Close-up at the hole for shots that go in: camera spot, what it looks at, and when to cut. */
  private cupCam: { pos: THREE.Vector3; over: THREE.Vector3; look: THREE.Vector3; time: number; dropT: number; cut: boolean } | null = null;
  private startCam = new THREE.Vector3();
  private startLook = new THREE.Vector3();
  private startBall = new THREE.Vector3();
  private following = false;
  private ballRef = new THREE.Vector3();
  // flyover
  private fly: THREE.CatmullRomCurve3 | null = null;
  private flyLook: THREE.CatmullRomCurve3 | null = null;
  private flyT = 0;
  private flyDur = 6;
  onFlyoverDone: (() => void) | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  private ground(field: HoleField, p: THREE.Vector3, clearance: number) {
    const h = field.heightAt(p.x, p.z) + clearance;
    if (p.y < h) p.y = h;
  }

  setAddress(field: HoleField, ball: THREE.Vector3, aimX: number, aimZ: number, putting: boolean, snap = false, targetY: number | null = null) {
    this.mode = putting ? 'putt' : 'address';
    const right = new THREE.Vector3(-aimZ, 0, aimX);
    const aim = new THREE.Vector3(aimX, 0, aimZ);
    if (putting) {
      this.wantPos.copy(ball).addScaledVector(aim, -2.9).addScaledVector(right, -0.35);
      this.wantPos.y = ball.y + 1.15;
      this.wantLook.copy(ball).addScaledVector(aim, 6);
      this.wantLook.y = ball.y - 0.1;
    } else {
      this.wantPos.copy(ball).addScaledVector(aim, -4.6).addScaledVector(right, -0.6);
      this.wantPos.y = ball.y + 1.75;
      this.wantLook.copy(ball).addScaledVector(aim, 14).addScaledVector(right, -0.2);
      this.wantLook.y = ball.y + 0.35 + (targetY !== null ? THREE.MathUtils.clamp((targetY - ball.y) * 0.3, -3, 2) : 0);
    }
    this.ground(field, this.wantPos, 0.6);
    if (snap) this.snap = true;
  }

  /** Replay a finished shot: cut straight to that shot's address view, then fly with it. */
  startReplay(field: HoleField, r: SimResult, start: THREE.Vector3, aimX: number, aimZ: number, putting: boolean) {
    this.setAddress(field, start, aimX, aimZ, putting);
    this.pos.copy(this.wantPos);
    this.look.copy(this.wantLook);
    this.startFlight(field, r, putting);
  }

  /** Fixed camera (cinematics and debug views). */
  setFree(pos: THREE.Vector3, look: THREE.Vector3, snap = true) {
    this.mode = 'free';
    this.wantPos.copy(pos);
    this.wantLook.copy(look);
    if (snap) this.snap = true;
  }

  setTargetView(field: HoleField, target: THREE.Vector3, from: THREE.Vector3) {
    this.mode = 'target';
    const dir = new THREE.Vector3().subVectors(target, from).setY(0).normalize();
    this.wantPos.copy(target).addScaledVector(dir, -32);
    this.wantPos.y = field.heightAt(target.x, target.z) + 26;
    this.wantLook.copy(target);
    this.ground(field, this.wantPos, 3);
  }

  setGreenView(field: HoleField, ball: THREE.Vector3, cup: { x: number; z: number }) {
    this.mode = 'green';
    const dir = new THREE.Vector3(cup.x - ball.x, 0, cup.z - ball.z);
    const d = dir.length();
    dir.normalize();
    const mid = new THREE.Vector3((ball.x + cup.x) / 2, 0, (ball.z + cup.z) / 2);
    mid.y = field.heightAt(mid.x, mid.z);
    this.wantPos.copy(ball).addScaledVector(dir, -Math.max(4, d * 0.35));
    this.wantPos.y = field.heightAt(this.wantPos.x, this.wantPos.z) + Math.max(5, d * 0.55);
    this.wantLook.copy(mid);
  }

  startFlight(field: HoleField, r: SimResult, putting: boolean) {
    this.mode = 'flight';
    this.shot = r;
    this.shotT = 0;
    this.cut = false;
    this.startCam.copy(this.pos);
    this.startLook.copy(this.look);
    this.following = false;
    const s = r.samples;
    const start = new THREE.Vector3(s[1], s[2], s[3]);
    this.startBall.copy(start);
    const land = r.landing ? new THREE.Vector3(r.landing.x, r.landing.y, r.landing.z) : new THREE.Vector3(r.rest.x, r.rest.y, r.rest.z);
    const flat = new THREE.Vector3().subVectors(land, start).setY(0);
    const dist = flat.length();
    flat.normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    // landing camera: ahead of and to the side of the landing spot, looking back
    const sideSign = (r.rest.x - start.x) * side.x + (r.rest.z - start.z) * side.z > 0 ? -1 : 1;
    const back = Math.min(26, 8 + dist * 0.08);
    this.landCam.copy(land).addScaledVector(flat, back).addScaledVector(side, sideSign * (6 + dist * 0.05));
    this.landCam.y = field.heightAt(this.landCam.x, this.landCam.z) + 2.5 + dist * 0.02;
    this.ground(field, this.landCam, 1.5);
    const flightTime = r.landingTime || r.duration;
    this.cutTime = putting || dist < 45 ? Infinity : Math.max(1.3, flightTime - 2.4);
    this.cupCam = this.planCupCam(field, r, putting);
  }

  /**
   * For a shot that's going in: a low TV-style camera just beyond the hole, looking back along the
   * line the ball comes in on, so you see it roll up, catch the edge and drop.
   */
  private planCupCam(field: HoleField, r: SimResult, putting: boolean) {
    if (r.outcome !== 'holed') return null;
    const ev = r.events.find((e) => e.type === 'cup');
    if (!ev) return null;
    const cup = field.cup;
    const h = field.heightAt(cup.x, cup.z);
    // where the ball was a moment before it reached the hole -> the line it comes in on
    const before = { x: 0, y: 0, z: 0 };
    sampleAt(r, Math.max(0, ev.t - 0.35), before);
    const inDir = new THREE.Vector3(cup.x - before.x, 0, cup.z - before.z);
    if (inDir.lengthSq() < 1e-4) inDir.set(cup.x - r.samples[1], 0, cup.z - r.samples[3]);
    inDir.normalize();
    const side = new THREE.Vector3(-inDir.z, 0, inDir.x);
    const pos = new THREE.Vector3(cup.x, 0, cup.z).addScaledVector(inDir, 0.95).addScaledVector(side, 0.3);
    pos.y = field.heightAt(pos.x, pos.z) + 0.42;
    const look = new THREE.Vector3(cup.x, h - 0.02, cup.z).addScaledVector(inDir, -0.25);
    // after the drop the camera eases up over the hole to look down at the ball on the bottom
    const over = new THREE.Vector3(cup.x, 0, cup.z).addScaledVector(inDir, -0.22).addScaledVector(side, 0.1);
    over.y = h + 0.7;
    const lead = putting ? 1.1 : 0.8;
    return { pos, over, look, time: Math.max(putting ? 0.5 : 0.3, ev.t - lead), dropT: ev.t, cut: false };
  }

  startFlyover(field: HoleField, onDone: () => void) {
    this.mode = 'flyover';
    const pts: THREE.Vector3[] = [];
    const looks: THREE.Vector3[] = [];
    const L = field.length;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * L * 0.92;
      const p = field.pointAt(Math.max(0, s - 25));
      const h = field.heightAt(p.x, p.z);
      pts.push(new THREE.Vector3(p.x, h + 34 - (i / n) * 20, p.z));
      const q = field.pointAt(Math.min(L, s + 60));
      looks.push(new THREE.Vector3(q.x, field.heightAt(q.x, q.z), q.z));
    }
    const cup = field.cup;
    looks[looks.length - 1].set(cup.x, field.heightAt(cup.x, cup.z), cup.z);
    this.fly = new THREE.CatmullRomCurve3(pts);
    this.flyLook = new THREE.CatmullRomCurve3(looks);
    this.flyT = 0;
    this.flyDur = 4.5 + L / 220;
    this.onFlyoverDone = onDone;
    this.snap = true;
  }

  skipFlyover() {
    if (this.mode === 'flyover') this.flyT = this.flyDur;
  }

  update(dt: number, field: HoleField | null, ballPos: THREE.Vector3) {
    if (this.mode === 'flyover' && this.fly && this.flyLook) {
      this.flyT += dt;
      const u = Math.min(1, this.flyT / this.flyDur);
      const e = u * u * (3 - 2 * u);
      this.fly.getPoint(e, this.wantPos);
      this.flyLook.getPoint(e, this.wantLook);
      this.pos.copy(this.wantPos);
      this.look.copy(this.wantLook);
      if (u >= 1) {
        const cb = this.onFlyoverDone;
        this.onFlyoverDone = null;
        this.mode = 'free';
        cb?.();
      }
    } else if (this.mode === 'flight' && this.shot && this.cupCam && this.shotT + dt >= this.cupCam.time) {
      // it's going in: hold the close-up at the hole until the next shot
      this.shotT += dt;
      const cc = this.cupCam;
      if (!cc.cut) {
        cc.cut = true;
        this.pos.copy(cc.pos);
        this.look.copy(cc.look);
        this.snap = true;
      }
      if (this.shotT < cc.dropT + 0.25) {
        this.wantPos.copy(cc.pos);
        // keep the hole in frame and lean toward the ball as it comes in
        this.wantLook.copy(cc.look).lerp(ballPos, ballPos.distanceTo(cc.look) < 3 ? 0.3 : 0.1);
      } else {
        this.wantPos.copy(cc.over);
        this.wantLook.copy(ballPos);
      }
    } else if (this.mode === 'flight' && this.shot) {
      this.shotT += dt;
      this.ballRef.copy(ballPos);
      const putting = this.cutTime === Infinity;
      if (!this.cut && this.shotT >= this.cutTime) {
        this.cut = true;
        this.pos.copy(this.landCam);
        this.look.copy(ballPos);
        this.snap = true;
      }
      if (this.cut) {
        this.wantPos.copy(this.landCam);
        this.wantLook.copy(ballPos);
        // drift toward the ball once it is rolling out
        if (this.shot.landing && this.shotT > this.shot.landingTime) {
          const toBall = new THREE.Vector3().subVectors(ballPos, this.landCam);
          const d = toBall.length();
          if (d > 22) this.wantPos.addScaledVector(toBall.normalize(), (d - 22) * 0.6);
        }
      } else if (putting) {
        // hold the address view until the ball is clear of the golfer, then follow it
        const s = this.shot.samples;
        const dir = new THREE.Vector3(s[s.length - 3] - s[1], 0, s[s.length - 1] - s[3]);
        if (dir.lengthSq() < 1e-6) dir.set(ballPos.x - this.startCam.x, 0, ballPos.z - this.startCam.z);
        dir.normalize();
        const travelled = Math.hypot(ballPos.x - this.startBall.x, ballPos.z - this.startBall.z);
        if (!this.following && travelled > 2.8) this.following = true;
        if (this.following) {
          this.wantPos.copy(ballPos).addScaledVector(dir, -3.0);
          this.wantPos.y = ballPos.y + 1.2;
          this.wantLook.copy(ballPos).addScaledVector(dir, 1.5);
          if (field) this.ground(field, this.wantPos, 0.6);
        } else {
          this.wantPos.copy(this.startCam);
          this.wantLook.copy(ballPos).addScaledVector(dir, 1.0);
        }
      } else {
        // stay at the tee: show the follow-through, then track the ball as it climbs
        this.wantPos.copy(this.startCam);
        this.wantPos.y += Math.min(1.5, this.shotT * 0.6);
        const u = THREE.MathUtils.smoothstep(this.shotT, 0.45, 1.3);
        this.wantLook.copy(this.startLook).lerp(ballPos, u);
      }
    }
    const k = this.snap ? 1 : 1 - Math.exp(-dt * (this.mode === 'flight' ? 6 : 3.2));
    const kl = this.snap ? 1 : 1 - Math.exp(-dt * (this.mode === 'flight' ? 10 : 4));
    this.pos.lerp(this.wantPos, k);
    this.look.lerp(this.wantLook, kl);
    this.snap = false;
    if (field && this.mode !== 'flyover') {
      const h = field.heightAt(this.pos.x, this.pos.z) + 0.4;
      if (this.pos.y < h) this.pos.y = h;
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  get lookTarget() {
    return this.look;
  }
}
