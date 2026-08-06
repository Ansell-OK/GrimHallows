/**
 * Free-dungeon spawns (`dungeon_spawns`).
 *
 * A spawn is off-chain generated content — a location, a monster table, and a
 * TTL (02-architecture.md#4). No money is involved in one existing or expiring,
 * which is exactly why it can be a Postgres row rather than a contract call.
 *
 * Two rules the storage layer owns:
 *
 *   - Expired spawns are excluded from `/map` reads but never hard-deleted
 *     (05-data-model.md indexing notes). A run that happened inside a spawn
 *     still references it via `runs.spawn_id`, so deleting the row would
 *     orphan history to save a few bytes.
 *   - "Live" is decided by comparing `expires_at` to a caller-supplied `now`,
 *     not by a background sweep. Nothing can be stale between sweeps if there
 *     is no sweep.
 */

import { query } from '../db.js';

export interface SpawnRecord {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly monsterTableId: string;
  readonly spawnedAt: Date;
  readonly expiresAt: Date;
}

export interface NewSpawn {
  readonly x: number;
  readonly y: number;
  readonly monsterTableId: string;
  readonly expiresAt: Date;
}

export interface SpawnStore {
  /** Spawns that have not yet expired, soonest-to-expire first. */
  listActive(now?: Date): Promise<SpawnRecord[]>;
  /** One spawn by id, expired or not — entry checks expiry itself. */
  findById(id: string): Promise<SpawnRecord | null>;
  create(spawn: NewSpawn): Promise<SpawnRecord>;
}

interface SpawnRow {
  id: string;
  map_x: number;
  map_y: number;
  monster_table_id: string;
  spawned_at: Date;
  expires_at: Date;
}

function fromRow(row: SpawnRow): SpawnRecord {
  return {
    id: row.id,
    x: row.map_x,
    y: row.map_y,
    monsterTableId: row.monster_table_id,
    spawnedAt: row.spawned_at,
    expiresAt: row.expires_at,
  };
}

export class PostgresSpawnStore implements SpawnStore {
  async listActive(now: Date = new Date()): Promise<SpawnRecord[]> {
    const { rows } = await query<SpawnRow>(
      `select id, map_x, map_y, monster_table_id, spawned_at, expires_at
         from dungeon_spawns
        where expires_at > $1
        order by expires_at asc`,
      [now],
    );
    return rows.map(fromRow);
  }

  async findById(id: string): Promise<SpawnRecord | null> {
    // A malformed uuid makes Postgres raise rather than return no rows, and a
    // player pasting garbage into a URL is a 404, not a 500.
    if (!UUID_RE.test(id)) return null;

    const { rows } = await query<SpawnRow>(
      `select id, map_x, map_y, monster_table_id, spawned_at, expires_at
         from dungeon_spawns
        where id = $1`,
      [id],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async create(spawn: NewSpawn): Promise<SpawnRecord> {
    const { rows } = await query<SpawnRow>(
      `insert into dungeon_spawns (map_x, map_y, monster_table_id, expires_at)
       values ($1, $2, $3, $4)
       returning id, map_x, map_y, monster_table_id, spawned_at, expires_at`,
      [spawn.x, spawn.y, spawn.monsterTableId, spawn.expiresAt],
    );
    return fromRow(rows[0]);
  }
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * In-memory equivalent: same rules, no database. Used by route tests and by
 * `npm run dev` before docker compose is up.
 */
export class MemorySpawnStore implements SpawnStore {
  private readonly spawns = new Map<string, SpawnRecord>();
  private counter = 0;

  async listActive(now: Date = new Date()): Promise<SpawnRecord[]> {
    return [...this.spawns.values()]
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  }

  async findById(id: string): Promise<SpawnRecord | null> {
    return this.spawns.get(id) ?? null;
  }

  async create(spawn: NewSpawn): Promise<SpawnRecord> {
    // Shaped like a uuid so nothing downstream can start depending on the id
    // format differing between the memory and Postgres stores.
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    const record: SpawnRecord = {
      id: `00000000-0000-4000-8000-${suffix}`,
      x: spawn.x,
      y: spawn.y,
      monsterTableId: spawn.monsterTableId,
      spawnedAt: new Date(),
      expiresAt: spawn.expiresAt,
    };
    this.spawns.set(record.id, record);
    return record;
  }
}
