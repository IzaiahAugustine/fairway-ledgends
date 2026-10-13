// Swing styles: archetypes modelled on the kinds of swings seen on tour (each lists pros known
// for that kind of swing, for reference; the game doesn't model any real player). A style changes how far
// and how straight the ball goes, its flight (launch, spin, natural curve), how forgiving the
// tempo window is, and how the golfer's swing looks (backswing length, downswing speed).
// AI opponents are built on the same styles, so a "bomber" opponent plays like one.

export type SwingStyleId = 'classic' | 'power' | 'smooth' | 'fader' | 'drawer' | 'wizard';

export interface SwingStyle {
  id: SwingStyleId;
  name: string;
  /** One line under the name. */
  tagline: string;
  desc: string;
  /** Multiplier on full-swing distance. */
  power: number;
  /** Multiplier on full-swing mistakes (lower = straighter). */
  error: number;
  /** Multiplier on mistakes for wedges, chips and putts. */
  shortError: number;
  launch: number;
  spin: number;
  /** Natural curve in degrees of spin-axis tilt (+ fade, - draw). */
  curve: number;
  /** Tempo window width multiplier (wider = more forgiving timing). */
  tempoWindow: number;
  /** Ideal push-up speed multiplier (lower = a quicker transition). */
  tempoSpeed: number;
  /** Backswing length for the animation (1 = full). */
  backswing: number;
  /** Downswing duration multiplier for the animation (lower = faster). */
  downswing: number;
  /** Tour pros known for this kind of swing (for reference only). */
  pros: string;
  /** Short bars for the menu, 1..5. */
  bars: { distance: number; accuracy: number; control: number; forgiveness: number };
}

export const SWING_STYLES: SwingStyle[] = [
  {
    id: 'classic', name: 'Classic Tour', tagline: 'Textbook and balanced',
    desc: 'A full, on-plane swing with no weak spot. Good at everything and the easiest to read.',
    pros: 'Adam Scott, Justin Rose',
    power: 1, error: 1, shortError: 1, launch: 1, spin: 1, curve: 0, tempoWindow: 1, tempoSpeed: 1, backswing: 1, downswing: 1,
    bars: { distance: 3, accuracy: 3, control: 3, forgiveness: 3 },
  },
  {
    id: 'power', name: 'Power Bomber', tagline: 'Big turn, big speed',
    desc: 'A long, violent swing built for distance. More carry and roll off the tee, but a quicker transition with less room for error.',
    pros: 'Rory McIlroy, Bryson DeChambeau',
    power: 1.07, error: 1.2, shortError: 1.05, launch: 1.03, spin: 0.9, curve: 0, tempoWindow: 0.85, tempoSpeed: 0.85, backswing: 1.08, downswing: 0.82,
    bars: { distance: 5, accuracy: 2, control: 2, forgiveness: 2 },
  },
  {
    id: 'smooth', name: 'Smooth Tempo', tagline: 'Effortless rhythm',
    desc: 'An unhurried, rhythmic swing. Slightly shorter, but the timing window is the most forgiving in the game.',
    pros: 'Ernie Els, Fred Couples',
    power: 0.98, error: 0.9, shortError: 0.95, launch: 1, spin: 1, curve: 0, tempoWindow: 1.3, tempoSpeed: 1.12, backswing: 1, downswing: 1.12,
    bars: { distance: 3, accuracy: 4, control: 3, forgiveness: 5 },
  },
  {
    id: 'fader', name: 'Precision Fader', tagline: 'Compact, high and soft',
    desc: 'A short, controlled swing that holds a gentle fade. Less distance, but straighter and it stops quickly on greens.',
    pros: 'Collin Morikawa, Jack Nicklaus',
    power: 0.96, error: 0.82, shortError: 0.9, launch: 1.04, spin: 1.12, curve: 3.5, tempoWindow: 1.05, tempoSpeed: 1, backswing: 0.86, downswing: 1,
    bars: { distance: 2, accuracy: 5, control: 4, forgiveness: 3 },
  },
  {
    id: 'drawer', name: 'Natural Draw', tagline: 'Inside-out, runs out',
    desc: 'Swings from the inside for a penetrating right-to-left flight with extra roll. A touch more distance than Classic.',
    pros: 'a young Ben Hogan',
    power: 1.03, error: 1.02, shortError: 1, launch: 0.96, spin: 0.92, curve: -3.5, tempoWindow: 1, tempoSpeed: 0.95, backswing: 1.02, downswing: 0.95,
    bars: { distance: 4, accuracy: 3, control: 3, forgiveness: 3 },
  },
  {
    id: 'wizard', name: 'Short-Game Wizard', tagline: 'Magic hands around the green',
    desc: 'Average off the tee, deadly inside 100 yards: wedges, chips and putts are far more accurate, with extra spin.',
    pros: 'Phil Mickelson, Seve Ballesteros',
    power: 0.97, error: 1.05, shortError: 0.62, launch: 1.02, spin: 1.08, curve: 0, tempoWindow: 1.1, tempoSpeed: 1.05, backswing: 0.95, downswing: 1.05,
    bars: { distance: 2, accuracy: 3, control: 5, forgiveness: 4 },
  },
];

export const swingStyleById = (id: string | undefined): SwingStyle => SWING_STYLES.find((s) => s.id === id) ?? SWING_STYLES[0];
