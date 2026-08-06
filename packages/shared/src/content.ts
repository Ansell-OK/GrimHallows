/**
 * World content: the map coordinate space, the monster tables free dungeons
 * draw from, and the standing paid dungeon's identity.
 *
 * This is *content*, not rules and not money. It lives in `shared` for one
 * reason: `GET /map` returns a spawn's `monsterTableId` and nothing else
 * (04-backend-api-spec.md#3), so the API and the web app have to agree on what
 * that id means. Two copies of this table would let the map label a spawn
 * "Forsaken Crypt" while the server ran an entirely different encounter.
 *
 * Monster *stat blocks* are deliberately absent — those belong to the combat
 * loop (Phase 4). What is here is only what the map screen needs to describe a
 * spawn before you enter it.
 */

/**
 * Map coordinates are percentages of the world map image, `0..100`, with the
 * origin at the top-left — the same units the map screen already positions
 * markers in (`top: 40%`, `left: 50%`). Storing percentages rather than pixels
 * means a future higher-resolution map background doesn't relocate every spawn.
 */
export const MAP_MIN_COORD = 0;
export const MAP_MAX_COORD = 100;

export interface MapLocation {
  readonly x: number;
  readonly y: number;
}

export interface MonsterTable {
  readonly id: string;
  /** Display name of a dungeon rolled from this table. */
  readonly name: string;
  /** Advisory difficulty band shown before entry. Not enforced anywhere. */
  readonly recommendedLevel: { readonly min: number; readonly max: number };
}

/**
 * Free-dungeon monster tables. Ids are stable strings and are what lands in
 * `dungeon_spawns.monster_table_id`, so renaming an id orphans every historical
 * spawn row that referenced it — add a new table instead.
 */
export const MONSTER_TABLES: readonly MonsterTable[] = [
  { id: 'forsaken-crypt', name: 'Forsaken Crypt', recommendedLevel: { min: 1, max: 5 } },
  { id: 'ashwood-thicket', name: 'Ashwood Thicket', recommendedLevel: { min: 3, max: 8 } },
  { id: 'echoing-cavern', name: 'Echoing Cavern', recommendedLevel: { min: 5, max: 10 } },
  { id: 'hollowed-grounds', name: 'Hollowed Grounds', recommendedLevel: { min: 8, max: 14 } },
  { id: 'bloodfall-ruins', name: 'Bloodfall Ruins', recommendedLevel: { min: 10, max: 16 } },
] as const;

const TABLES_BY_ID = new Map(MONSTER_TABLES.map((t) => [t.id, t]));

/** Look up a table, or null for an id this build doesn't know about. */
export function getMonsterTable(id: string): MonsterTable | null {
  return TABLES_BY_ID.get(id) ?? null;
}

/**
 * Display name for a spawn's monster table.
 *
 * Falls back to the raw id rather than inventing a name: an unrecognised id
 * means the server is running content this client doesn't have, and showing the
 * id makes that visible instead of hiding it behind a plausible-looking label.
 */
export function monsterTableName(id: string): string {
  return getMonsterTable(id)?.name ?? id;
}

/**
 * The standing paid dungeon (on-chain dungeon id `PAID_DUNGEON_ID`).
 *
 * Its name and location are content; its gate fee and prize pool are money and
 * are read live from the chain — never from this file.
 */
export const PAID_DUNGEON_NAME = 'The Obsidian Spire';
export const PAID_DUNGEON_LOCATION: MapLocation = { x: 50, y: 40 };

/**
 * The monster table the paid dungeon fights with.
 *
 * The hardest table in `MONSTER_TABLES`, which is the point: the paid dungeon is
 * the one with a prize pool behind it, and a fight easier than the free ones
 * would make the reward table the only reason to enter.
 *
 * Content, not money — the fee and pool are still read live from chain. It lives
 * here rather than in the API because stat derivation and the encounter build are
 * shared code, and a table id the verifier doesn't have is a run it can't replay.
 *
 * A single constant because MVP has exactly one paid dungeon (`PAID_DUNGEON_ID`).
 * When a second one exists this becomes a lookup keyed by dungeon id; the
 * encounter setup already stores the resolved id per run, so past runs stay
 * replayable through that change.
 */
export const PAID_DUNGEON_MONSTER_TABLE_ID = 'bloodfall-ruins';
