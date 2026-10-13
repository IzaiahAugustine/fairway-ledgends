// Career mode: a ladder of events against tougher opponents on bigger stages. Win an event to
// unlock the next one (and its XP purse). Each event has a fixed opponent, so a rematch is the
// same golfer with the same personality.
import type { Difficulty } from '../core/save';
import type { Format } from '../game/match';
import type { HoleSet } from './courses';

export interface CareerEvent {
  id: string;
  title: string;
  /** Short line under the title. */
  stage: string;
  courseId: string;
  holes: HoleSet;
  format: Format;
  difficulty: Difficulty;
  /** Opponent personality (see PERSONALITIES in game/ai). */
  personality: string;
  /** Bonus XP for winning the event (on top of the usual match XP). */
  purse: number;
}

export const CAREER: CareerEvent[] = [
  { id: 'club-champ', title: 'Club Championship', stage: 'Where it all starts, among the maples', courseId: 'maple-hollow', holes: 'front', format: 'match', difficulty: 'easy', personality: 'allrounder', purse: 250 },
  { id: 'island-am', title: 'Island Amateur', stage: 'Stroke play qualifier by the sea', courseId: 'coral-cove', holes: 'front', format: 'stroke', difficulty: 'easy', personality: 'metronome', purse: 350 },
  { id: 'desert-open', title: 'Desert Open', stage: 'Beat the local long-hitter', courseId: 'red-mesa', holes: 'front', format: 'match', difficulty: 'medium', personality: 'bomber', purse: 500 },
  { id: 'cove-skins', title: 'Coral Cove Skins', stage: 'Every hole pays', courseId: 'coral-cove', holes: 'back', format: 'skins', difficulty: 'medium', personality: 'shotmaker', purse: 650 },
  { id: 'q-school', title: 'Tour Qualifying', stage: 'Earn your card in the mountains', courseId: 'summit-peaks', holes: 'front', format: 'stroke', difficulty: 'medium', personality: 'grinder', purse: 800 },
  { id: 'bluffs-champ', title: 'Bluffs Championship', stage: 'Wind, gorse and ocean carries', courseId: 'thunder-bluffs', holes: 'front', format: 'match', difficulty: 'hard', personality: 'magician', purse: 1000 },
  { id: 'mesa-inv', title: 'Red Mesa Invitational', stage: 'Eighteen holes through the canyons', courseId: 'red-mesa', holes: 'all', format: 'stroke', difficulty: 'hard', personality: 'bomber', purse: 1400 },
  { id: 'the-final', title: 'The Legends Final', stage: 'Match play for the title on top of the world', courseId: 'summit-peaks', holes: 'all', format: 'match', difficulty: 'hard', personality: 'grinder', purse: 2500 },
];

export const careerEvent = (id: string | undefined) => CAREER.find((e) => e.id === id) ?? null;
