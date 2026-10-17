// Daily challenge: three holes of stroke play, the same for every player on the same day (the
// course, the holes and the opponent all come from the date). Finishing it pays an XP purse once
// a day, more for a win, plus a bonus for coming back on days in a row.
import { hashString } from '../core/rng';
import { COURSES, courseById, type CourseDef } from './courses';

export const DAILY_HOLES = 3;
export const DAILY_WIN_XP = 400;
export const DAILY_PLAY_XP = 150;
/** Extra XP per day of a streak after the first, up to DAILY_STREAK_MAX. */
export const DAILY_STREAK_XP = 50;
export const DAILY_STREAK_MAX = 300;

export interface DailyChallenge {
  /** The day, YYYY-MM-DD in the player's own time zone. */
  key: string;
  courseId: string;
  /** Index of the first hole on the course. */
  start: number;
  personality: string;
  seed: number;
}

const PERSONALITIES = ['bomber', 'grinder', 'shotmaker', 'magician', 'metronome', 'allrounder'];

export function dailyKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The day before a YYYY-MM-DD key. */
export function previousDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return dailyKey(new Date(y, m - 1, d - 1));
}

export function dailyChallenge(key = dailyKey()): DailyChallenge {
  const seed = hashString(`daily:${key}`);
  const course = COURSES[seed % COURSES.length];
  return {
    key,
    courseId: course.id,
    start: (seed >>> 8) % (course.holes.length - DAILY_HOLES + 1),
    personality: PERSONALITIES[(seed >>> 16) % PERSONALITIES.length],
    seed,
  };
}

/** The challenge's course cut down to its three holes, and the number of the first one. */
export function dailyCourse(ch: DailyChallenge): { course: CourseDef; firstHole: number } {
  const c = courseById(ch.courseId);
  return { course: { ...c, holes: c.holes.slice(ch.start, ch.start + DAILY_HOLES) }, firstHole: ch.start + 1 };
}

export function dailyStreakBonus(streak: number): number {
  return Math.min(DAILY_STREAK_MAX, Math.max(0, streak - 1) * DAILY_STREAK_XP);
}
