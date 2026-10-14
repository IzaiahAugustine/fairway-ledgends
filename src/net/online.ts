// Online matches against a friend, over Firebase Realtime Database.
//
// One record per match at matches/<code>. The host creates it with the match settings and its
// golfer; the guest adds theirs; both then run the same round from the shared seed and settings.
// Golf is turn-based, so the only traffic is one record per stroke: the shooter writes the shot
// setup and swing when the club meets the ball (the other side replays the identical, seeded
// simulation), then the settled ball state once it stops, which the other side adopts so the two
// rounds can never drift apart.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectDatabaseEmulator, getDatabase, onDisconnect, onValue, ref, runTransaction, serverTimestamp, set, update, get, type Database, type Unsubscribe } from 'firebase/database';
import type { Appearance, Difficulty } from '../core/save';
import type { HoleSet } from '../data/courses';
import type { SwingStyleId } from '../data/swingStyles';
import type { Format } from '../game/match';
import type { WeatherKind } from '../world/weather';
import { firebaseConfig, onlineConfigured } from './firebaseConfig';

export type Seat = 'host' | 'guest';

export interface OnlineSettings {
  courseId: string;
  holes: HoleSet;
  format: Format;
  difficulty: Difficulty;
  seed: number;
  weather: WeatherKind;
  wind: 'calm' | 'light' | 'full';
  gimmes: boolean;
}

export interface OnlinePlayer {
  name: string;
  appearance: Appearance;
  tiers: Record<string, number>;
  style: SwingStyleId;
}

/** A stroke as sent over the wire: ShotSetup with the club and shot type by id. */
export interface WireShot {
  by: Seat;
  hole: number;
  setup: {
    club: string;
    shot: string;
    tier: number;
    power: number;
    aimX: number;
    aimZ: number;
    x: number;
    y: number;
    z: number;
    lie: number;
    teed: boolean;
    puttScale?: number;
    style?: string;
    spin?: string;
  };
  swing: { power: number; dirErr: number; curveErr: number; tempo: string; path: string; quality: number };
  /** Ball state once it came to rest (written after the flight). */
  settle?: { x: number; y: number; z: number; lie: number; teed: boolean; strokes: number; holed: boolean; pickedUp: boolean };
}

interface MatchRecord {
  status: 'waiting' | 'playing' | 'done';
  settings: OnlineSettings;
  host: OnlinePlayer;
  guest?: OnlinePlayer;
  shots?: Record<string, WireShot>;
  left?: Seat;
}

let app: FirebaseApp | null = null;
let db: Database | null = null;
/** Dev server with ?emulator: talk to a local Firebase database emulator instead. */
const EMULATOR = import.meta.env.DEV && new URLSearchParams(location.search).has('emulator');
const useEmulator = () => EMULATOR;

function database(): Database {
  if (!db) {
    if (useEmulator()) {
      app = initializeApp({ projectId: 'demo-fairway', databaseURL: 'http://127.0.0.1:9000?ns=demo-fairway' });
      db = getDatabase(app);
      connectDatabaseEmulator(db, '127.0.0.1', 9000);
      return db;
    }
    if (!onlineConfigured()) throw new Error('Online play is not set up yet (missing Firebase config).');
    app = initializeApp(firebaseConfig);
    db = getDatabase(app);
  }
  return db;
}

export const onlineAvailable = () => onlineConfigured() || useEmulator();

// no 0/O/1/I/L: codes get read out over the phone
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

const key = (i: number) => String(i).padStart(4, '0');

/** Firebase rejects undefined values: drop them. */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** A live connection to one match, from one seat. */
export class OnlineMatch {
  private shots: WireShot[] = [];
  private waiters = new Map<number, ((s: WireShot) => void)[]>();
  private settleWaiters = new Map<number, ((s: WireShot) => void)[]>();
  private unsub: Unsubscribe | null = null;
  private record: MatchRecord | null = null;
  onChange: ((m: MatchRecord) => void) | null = null;
  onOpponentLeft: (() => void) | null = null;

  private constructor(
    readonly code: string,
    readonly seat: Seat,
  ) {}

  get other(): Seat {
    return this.seat === 'host' ? 'guest' : 'host';
  }
  get settings(): OnlineSettings | null {
    return this.record?.settings ?? null;
  }
  get opponent(): OnlinePlayer | null {
    return (this.seat === 'host' ? this.record?.guest : this.record?.host) ?? null;
  }
  get status() {
    return this.record?.status ?? 'waiting';
  }
  get link(): string {
    return `${location.origin}${location.pathname}?join=${this.code}`;
  }

  /** Create a match and wait in its lobby. */
  static async create(settings: OnlineSettings, me: OnlinePlayer): Promise<OnlineMatch> {
    const d = database();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeCode();
      const r = await runTransaction(ref(d, `matches/${code}`), (cur) =>
        cur ? undefined : clean({ status: 'waiting', settings, host: me, created: serverTimestamp() }),
      );
      if (r.committed) {
        const m = new OnlineMatch(code, 'host');
        m.record = { status: 'waiting', settings, host: me };
        m.listen();
        return m;
      }
    }
    throw new Error('Could not reserve a match code, try again.');
  }

  /** Join a friend's match by code. */
  static async join(codeIn: string, me: OnlinePlayer): Promise<OnlineMatch> {
    const d = database();
    const code = codeIn.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const snap = await get(ref(d, `matches/${code}`));
    if (!snap.exists()) throw new Error(`No match found with code ${code}.`);
    const rec = snap.val() as MatchRecord;
    if (rec.guest || rec.status !== 'waiting') throw new Error('That match has already started.');
    await update(ref(d, `matches/${code}`), clean({ guest: me, status: 'playing' }));
    const m = new OnlineMatch(code, 'guest');
    // settings and the host's golfer are needed right away, before the first live update
    m.record = { ...rec, guest: me, status: 'playing' };
    m.listen();
    return m;
  }

  private listen() {
    const d = database();
    // if this browser drops out mid-round, tell the other side
    void onDisconnect(ref(d, `matches/${this.code}/left`)).set(this.seat);
    this.unsub = onValue(ref(d, `matches/${this.code}`), (snap) => {
      const rec = snap.val() as MatchRecord | null;
      if (!rec) return;
      const wasLeft = this.record?.left;
      this.record = rec;
      const list = Object.keys(rec.shots ?? {})
        .sort()
        .map((k) => rec.shots![k]);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!this.shots[i]) {
          this.shots[i] = s;
          this.waiters.get(i)?.forEach((f) => f(s));
          this.waiters.delete(i);
        }
        if (s.settle && !this.shots[i].settle) this.shots[i] = s;
        if (s.settle) {
          this.settleWaiters.get(i)?.forEach((f) => f(s));
          this.settleWaiters.delete(i);
        }
      }
      if (rec.left && rec.left !== this.seat && !wasLeft) this.onOpponentLeft?.();
      this.onChange?.(rec);
    });
  }

  /** Record my stroke number i of the match (both rounds count strokes in the same order). */
  sendShot(i: number, s: Omit<WireShot, 'by'>) {
    const shot: WireShot = { ...s, by: this.seat };
    this.shots[i] = shot;
    void set(ref(database(), `matches/${this.code}/shots/${key(i)}`), clean(shot));
  }

  sendSettle(i: number, settle: NonNullable<WireShot['settle']>) {
    if (this.shots[i]) this.shots[i].settle = settle;
    void set(ref(database(), `matches/${this.code}/shots/${key(i)}/settle`), clean(settle));
  }

  /** The stroke with this index, once the other player has played it. */
  shot(i: number): Promise<WireShot> {
    const s = this.shots[i];
    if (s) return Promise.resolve(s);
    return new Promise((res) => this.waiters.set(i, [...(this.waiters.get(i) ?? []), res]));
  }

  /** The stroke's settled ball state, once the shooter's ball has stopped. */
  settled(i: number): Promise<WireShot> {
    const s = this.shots[i];
    if (s?.settle) return Promise.resolve(s);
    return new Promise((res) => this.settleWaiters.set(i, [...(this.settleWaiters.get(i) ?? []), res]));
  }

  /** Leave the match (the other side is told). */
  leave() {
    this.unsub?.();
    this.unsub = null;
    if (!db) return;
    const d = db;
    if (this.record?.status === 'waiting' && this.seat === 'host') void set(ref(d, `matches/${this.code}`), null);
    else void update(ref(d, `matches/${this.code}`), { left: this.seat, status: 'done' });
    void onDisconnect(ref(d, `matches/${this.code}/left`)).cancel();
  }

  finish() {
    if (db) void update(ref(db, `matches/${this.code}`), { status: 'done' });
    void (db && onDisconnect(ref(db, `matches/${this.code}/left`)).cancel());
    this.unsub?.();
    this.unsub = null;
  }
}
