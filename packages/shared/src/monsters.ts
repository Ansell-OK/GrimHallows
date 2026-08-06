/**
 * Monster stat blocks and the encounter tables free dungeons draw from.
 *
 * `content.ts` holds what the *map* needs to describe a spawn before you enter
 * it (name, difficulty band). This holds what the *encounter* needs once you're
 * inside. The split is deliberate: the map screen has no business knowing a
 * monster's HP, and a stat change shouldn't touch the file the map imports.
 *
 * These numbers are content and are tuned by feel, but they are not arbitrary at
 * runtime: which monsters you face is drawn from the run's committed seed
 * (see `encounter.ts`), never from `Math.random()`. Composition decides whether
 * a run is winnable, so it is an outcome, and outcomes come from the seed.
 *
 * Monster ids are permanent for the same reason power ids are — a run's turn log
 * refers to them.
 */

import type { BaseStats } from './types.js';

export interface MonsterBlueprint {
  readonly id: string;
  readonly name: string;
  readonly stats: BaseStats;
  /** The power this monster attacks with. See powers.ts. */
  readonly powerId: string;
}

/**
 * Monster HP is far lower than a player character's, and that asymmetry is
 * intentional: a character's HP is `60 + VIT*2.5` scaled by rarity, so it starts
 * around three figures, and a fight against 2–4 monsters should be decided in
 * a handful of exchanges rather than a war of attrition.
 */
const MONSTER_LIST: readonly MonsterBlueprint[] = [
  // --- Forsaken Crypt (1–5) ----------------------------------------------
  {
    id: 'crypt-rat',
    name: 'Crypt Rat',
    stats: { hp: 12, str: 8, agi: 14, int: 4, vit: 8 },
    powerId: 'beast-claw',
  },
  {
    id: 'shambling-husk',
    name: 'Shambling Husk',
    stats: { hp: 22, str: 13, agi: 6, int: 4, vit: 12 },
    powerId: 'undead-grasp',
  },
  {
    id: 'bone-acolyte',
    name: 'Bone Acolyte',
    stats: { hp: 16, str: 8, agi: 10, int: 14, vit: 9 },
    powerId: 'arcane-lash',
  },

  // --- Ashwood Thicket (3–8) ---------------------------------------------
  {
    id: 'thornback-boar',
    name: 'Thornback Boar',
    stats: { hp: 30, str: 16, agi: 11, int: 3, vit: 14 },
    powerId: 'heavy-slam',
  },
  {
    id: 'ashwood-stalker',
    name: 'Ashwood Stalker',
    stats: { hp: 24, str: 12, agi: 17, int: 8, vit: 11 },
    powerId: 'venom-bite',
  },
  {
    id: 'ember-sprite',
    name: 'Ember Sprite',
    stats: { hp: 18, str: 6, agi: 15, int: 16, vit: 8 },
    powerId: 'arcane-lash',
  },

  // --- Echoing Cavern (5–10) ---------------------------------------------
  {
    id: 'cave-lurker',
    name: 'Cave Lurker',
    stats: { hp: 34, str: 17, agi: 12, int: 5, vit: 15 },
    powerId: 'heavy-slam',
  },
  {
    id: 'echo-wraith',
    name: 'Echo Wraith',
    stats: { hp: 28, str: 10, agi: 16, int: 18, vit: 12 },
    powerId: 'arcane-lash',
  },
  {
    id: 'stone-gnasher',
    name: 'Stone Gnasher',
    stats: { hp: 42, str: 19, agi: 7, int: 4, vit: 18 },
    powerId: 'heavy-slam',
  },

  // --- Hollowed Grounds (8–14) -------------------------------------------
  {
    id: 'plague-hound',
    name: 'Plague Hound',
    stats: { hp: 38, str: 15, agi: 18, int: 5, vit: 14 },
    powerId: 'venom-bite',
  },
  {
    id: 'hollow-knight',
    name: 'Hollow Knight',
    stats: { hp: 52, str: 20, agi: 11, int: 9, vit: 19 },
    powerId: 'rusted-blade',
  },
  {
    id: 'grave-tyrant',
    name: 'Grave Tyrant',
    stats: { hp: 60, str: 22, agi: 9, int: 13, vit: 21 },
    powerId: 'heavy-slam',
  },

  // --- Bloodfall Ruins (10–16) -------------------------------------------
  {
    id: 'ruin-warden',
    name: 'Ruin Warden',
    stats: { hp: 66, str: 23, agi: 12, int: 10, vit: 22 },
    powerId: 'rusted-blade',
  },
  {
    id: 'crimson-adept',
    name: 'Crimson Adept',
    stats: { hp: 48, str: 12, agi: 16, int: 23, vit: 16 },
    powerId: 'arcane-lash',
  },
  {
    id: 'bloodfall-revenant',
    name: 'Bloodfall Revenant',
    stats: { hp: 74, str: 25, agi: 14, int: 15, vit: 24 },
    powerId: 'heavy-slam',
  },
];

const MONSTERS_BY_ID = new Map(MONSTER_LIST.map((m) => [m.id, m]));

export const MONSTERS: readonly MonsterBlueprint[] = MONSTER_LIST;

/** Look up a stat block, or null for an id this build doesn't know about. */
export function getMonster(id: string): MonsterBlueprint | null {
  return MONSTERS_BY_ID.get(id) ?? null;
}

export interface EncounterTable {
  /** Matches a `MONSTER_TABLES` id in content.ts and `dungeon_spawns.monster_table_id`. */
  readonly monsterTableId: string;
  readonly minMonsters: number;
  readonly maxMonsters: number;
  /**
   * Ids drawn from with replacement, so the same monster can appear twice.
   * Repeating an id in this list weights it more heavily.
   */
  readonly pool: readonly string[];
}

export const ENCOUNTER_TABLES: readonly EncounterTable[] = [
  {
    monsterTableId: 'forsaken-crypt',
    minMonsters: 2,
    maxMonsters: 3,
    pool: ['crypt-rat', 'crypt-rat', 'shambling-husk', 'bone-acolyte'],
  },
  {
    monsterTableId: 'ashwood-thicket',
    minMonsters: 2,
    maxMonsters: 3,
    pool: ['thornback-boar', 'ashwood-stalker', 'ashwood-stalker', 'ember-sprite'],
  },
  {
    monsterTableId: 'echoing-cavern',
    minMonsters: 2,
    maxMonsters: 4,
    pool: ['cave-lurker', 'echo-wraith', 'stone-gnasher'],
  },
  {
    monsterTableId: 'hollowed-grounds',
    minMonsters: 3,
    maxMonsters: 4,
    pool: ['plague-hound', 'plague-hound', 'hollow-knight', 'grave-tyrant'],
  },
  {
    monsterTableId: 'bloodfall-ruins',
    minMonsters: 3,
    maxMonsters: 4,
    pool: ['ruin-warden', 'crimson-adept', 'bloodfall-revenant'],
  },
];

const ENCOUNTER_TABLES_BY_ID = new Map(ENCOUNTER_TABLES.map((t) => [t.monsterTableId, t]));

export function getEncounterTable(monsterTableId: string): EncounterTable | null {
  return ENCOUNTER_TABLES_BY_ID.get(monsterTableId) ?? null;
}
