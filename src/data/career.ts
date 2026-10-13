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
  { id: 'club-champ', title: 'Club Championship', stage: 'Where it all starts', courseId: 'wykagyl', holes: 'front', format: 'match', difficulty: 'easy', personality: 'allrounder', purse: 250 },
  { id: 'county-am', title: 'County Amateur', stage: 'Stroke play qualifier', courseId: 'shinnecock', holes: 'front', format: 'stroke', difficulty: 'easy', personality: 'metronome', purse: 350 },
  { id: 'state-open', title: 'State Open', stage: 'Beat the local long-hitter', courseId: 'wykagyl', holes: 'back', format: 'match', difficulty: 'medium', personality: 'bomber', purse: 500 },
  { id: 'coastal-skins', title: 'Coastal Skins Game', stage: 'Every hole pays', courseId: 'pebble', holes: 'front', format: 'skins', difficulty: 'medium', personality: 'shotmaker', purse: 650 },
  { id: 'q-school', title: 'Tour Qualifying', stage: 'Earn your card', courseId: 'shinnecock', holes: 'back', format: 'stroke', difficulty: 'medium', personality: 'grinder', purse: 800 },
  { id: 'links-champ', title: 'Links Championship', stage: 'Wind, gorse and pot bunkers', courseId: 'standrews', holes: 'front', format: 'match', difficulty: 'hard', personality: 'magician', purse: 1000 },
  { id: 'pebble-inv', title: 'Pebble Beach Invitational', stage: 'Eighteen holes on the cliffs', courseId: 'pebble', holes: 'all', format: 'stroke', difficulty: 'hard', personality: 'bomber', purse: 1400 },
  { id: 'the-final', title: 'The Legends Final', stage: 'Match play for the title at the Home of Golf', courseId: 'standrews', holes: 'all', format: 'match', difficulty: 'hard', personality: 'grinder', purse: 2500 },
];

export const careerEvent = (id: string | undefined) => CAREER.find((e) => e.id === id) ?? null;
