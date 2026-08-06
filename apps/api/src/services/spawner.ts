/**
 * Free-dungeon spawner.
 *
 * Keeps the world map populated: on each tick, tops the live spawn count back
 * up toward a target, giving each new spawn a random location, a random monster
 * table, and a TTL. Expired spawns simply stop being returned by `/map` — they
 * are never deleted (see repos/spawns.ts).
 *
 * "Simple timer-based spawner is fine for MVP; no need for anything fancy"
 * (06-mvp-roadmap.md Phase 3), so that is exactly what this is.
 *
 * ON RANDOMNESS — the one thing worth being careful about here:
 * `randomInt` from node:crypto picks locations, tables, and TTLs. These are
 * *content* decisions: which map pin appears where, and for how long. They do
 * not touch a dice roll, a combat outcome, or a payout, all of which must be
 * derived from the committed/revealed seed and nothing else
 * (03-smart-contracts-spec.md#5). A CSPRNG is used regardless — there is no
 * reason to reach for Math.random() even where it would technically be harmless,
 * because "harmless here" is a judgement that rots as code moves.
 */

import { randomInt } from 'node:crypto';
import {
  MAP_MAX_COORD,
  MAP_MIN_COORD,
  MONSTER_TABLES,
} from '@grimhallow/shared';
import type { SpawnRecord, SpawnStore } from '../repos/spawns.js';

export interface SpawnerConfig {
  /** How many spawns the map aims to have live at once. */
  readonly targetLiveSpawns: number;
  readonly minTtlMs: number;
  readonly maxTtlMs: number;
  /** How often to top up. */
  readonly tickIntervalMs: number;
  /** Cap on spawns created per tick, so a cold start ramps up. */
  readonly maxPerTick: number;
}

/**
 * Defaults chosen so the map looks alive without churning: five simultaneous
 * spawns matches the five markers the map screen was designed around, and TTLs
 * of 8–35 minutes match the countdowns it was mocked with (and are long enough
 * that a party can actually form and finish a run before one expires).
 */
export const DEFAULT_SPAWNER_CONFIG: SpawnerConfig = {
  targetLiveSpawns: 5,
  minTtlMs: 8 * 60 * 1000,
  maxTtlMs: 35 * 60 * 1000,
  tickIntervalMs: 60 * 1000,
  maxPerTick: 2,
};

/**
 * Keep new spawns off the extreme edges of the map, where a marker would render
 * half off-screen, and away from the paid dungeon's landmark so its label
 * doesn't get covered.
 */
const EDGE_MARGIN = 8;

export interface SpawnerDeps {
  readonly spawns: SpawnStore;
  readonly config?: Partial<SpawnerConfig>;
  /** Injected so tests can assert on log output without a live server. */
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export class DungeonSpawner {
  private readonly config: SpawnerConfig;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SpawnerDeps) {
    this.config = { ...DEFAULT_SPAWNER_CONFIG, ...deps.config };
  }

  /**
   * Top up to the target, returning what was created.
   *
   * Idempotent in effect: called twice in a row with nothing expiring, the
   * second call creates nothing.
   */
  async tick(now: Date = new Date()): Promise<SpawnRecord[]> {
    const live = await this.deps.spawns.listActive(now);
    const deficit = Math.min(
      Math.max(this.config.targetLiveSpawns - live.length, 0),
      this.config.maxPerTick,
    );
    if (deficit === 0) return [];

    const created: SpawnRecord[] = [];
    for (let i = 0; i < deficit; i += 1) {
      created.push(await this.spawnOne(now));
    }

    this.deps.log?.('free dungeon spawns created', {
      created: created.length,
      liveBefore: live.length,
      target: this.config.targetLiveSpawns,
    });
    return created;
  }

  private async spawnOne(now: Date): Promise<SpawnRecord> {
    const table = MONSTER_TABLES[randomInt(MONSTER_TABLES.length)];
    const ttlMs = randomInt(this.config.minTtlMs, this.config.maxTtlMs + 1);

    return this.deps.spawns.create({
      x: randomInt(MAP_MIN_COORD + EDGE_MARGIN, MAP_MAX_COORD - EDGE_MARGIN + 1),
      y: randomInt(MAP_MIN_COORD + EDGE_MARGIN, MAP_MAX_COORD - EDGE_MARGIN + 1),
      monsterTableId: table.id,
      expiresAt: new Date(now.getTime() + ttlMs),
    });
  }

  /**
   * Begin ticking. Runs one tick immediately so a freshly-started server has a
   * populated map rather than an empty one for the first interval.
   *
   * A failing tick is logged and swallowed: the map degrades to fewer spawns,
   * which is survivable, whereas an unhandled rejection in a timer would take
   * the process down over cosmetic content.
   */
  start(): void {
    if (this.timer) return;

    const run = () => {
      this.tick().catch((err: unknown) => {
        this.deps.log?.('spawner tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    run();
    this.timer = setInterval(run, this.config.tickIntervalMs);
    // Don't hold the event loop open on shutdown for a content timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
