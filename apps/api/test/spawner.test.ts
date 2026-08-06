/**
 * Free-dungeon spawner tests.
 *
 * The spawner is content generation, not game logic, so what matters is that it
 * behaves like a well-mannered background job: it converges on the target, it
 * doesn't stampede, it treats expiry as the only thing that removes a spawn,
 * and it never leaves a timer running behind it.
 *
 * It also must not invent map positions a marker can't be drawn at, since the
 * map screen positions markers by percentage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAP_MAX_COORD, MAP_MIN_COORD, MONSTER_TABLES } from '@grimhallow/shared';
import { MemorySpawnStore } from '../src/repos/spawns.js';
import { DEFAULT_SPAWNER_CONFIG, DungeonSpawner } from '../src/services/spawner.js';

const TABLE_IDS = new Set(MONSTER_TABLES.map((t) => t.id));

afterEach(() => {
  vi.useRealTimers();
});

describe('tick', () => {
  it('fills up to the target over successive ticks', async () => {
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({
      spawns,
      config: { targetLiveSpawns: 5, maxPerTick: 2 },
    });

    expect(await spawner.tick()).toHaveLength(2);
    expect(await spawner.tick()).toHaveLength(2);
    expect(await spawner.tick()).toHaveLength(1);
    expect(await spawns.listActive()).toHaveLength(5);
  });

  it('creates nothing once the target is met', async () => {
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({ spawns, config: { targetLiveSpawns: 2 } });

    await spawner.tick();
    expect(await spawns.listActive()).toHaveLength(2);

    expect(await spawner.tick()).toEqual([]);
    expect(await spawns.listActive()).toHaveLength(2);
  });

  it('replaces spawns as they expire, without deleting the old rows', async () => {
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({
      spawns,
      config: { targetLiveSpawns: 2, minTtlMs: 1000, maxTtlMs: 1000 },
    });

    const start = new Date('2026-01-01T00:00:00Z');
    const first = await spawner.tick(start);
    expect(first).toHaveLength(2);

    const later = new Date(start.getTime() + 60_000);
    expect(await spawns.listActive(later)).toHaveLength(0);

    await spawner.tick(later);
    expect(await spawns.listActive(later)).toHaveLength(2);

    // The expired ones are still retrievable — a run that happened inside one
    // still references it (05-data-model.md).
    expect(await spawns.findById(first[0].id)).not.toBeNull();
  });

  it('places spawns inside the drawable map area', async () => {
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({ spawns, config: { targetLiveSpawns: 40, maxPerTick: 40 } });

    for (const spawn of await spawner.tick()) {
      expect(spawn.x).toBeGreaterThan(MAP_MIN_COORD);
      expect(spawn.x).toBeLessThan(MAP_MAX_COORD);
      expect(spawn.y).toBeGreaterThan(MAP_MIN_COORD);
      expect(spawn.y).toBeLessThan(MAP_MAX_COORD);
      expect(Number.isInteger(spawn.x)).toBe(true);
    }
  });

  it('only ever uses monster tables the client also knows about', async () => {
    // An id the web app can't resolve would render as a raw slug on the map.
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({ spawns, config: { targetLiveSpawns: 30, maxPerTick: 30 } });

    for (const spawn of await spawner.tick()) {
      expect(TABLE_IDS.has(spawn.monsterTableId)).toBe(true);
    }
  });

  it('gives every spawn a TTL inside the configured band', async () => {
    const spawns = new MemorySpawnStore();
    const now = new Date('2026-01-01T00:00:00Z');
    const spawner = new DungeonSpawner({
      spawns,
      config: { targetLiveSpawns: 20, maxPerTick: 20, minTtlMs: 60_000, maxTtlMs: 120_000 },
    });

    for (const spawn of await spawner.tick(now)) {
      const ttl = spawn.expiresAt.getTime() - now.getTime();
      expect(ttl).toBeGreaterThanOrEqual(60_000);
      expect(ttl).toBeLessThanOrEqual(120_000);
    }
  });
});

describe('start / stop', () => {
  it('spawns immediately rather than waiting a full interval', async () => {
    vi.useFakeTimers();
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({ spawns, config: { targetLiveSpawns: 1 } });

    spawner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await spawns.listActive()).toHaveLength(1);
    spawner.stop();
  });

  it('keeps topping up on each interval', async () => {
    vi.useFakeTimers();
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({
      spawns,
      config: { targetLiveSpawns: 4, maxPerTick: 1, tickIntervalMs: 1000 },
    });

    spawner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await spawns.listActive()).toHaveLength(4);
    spawner.stop();
  });

  it('stops cleanly and is safe to start or stop twice', async () => {
    vi.useFakeTimers();
    const spawns = new MemorySpawnStore();
    const spawner = new DungeonSpawner({
      spawns,
      config: { targetLiveSpawns: 10, maxPerTick: 1, tickIntervalMs: 1000 },
    });

    spawner.start();
    spawner.start(); // must not install a second interval
    await vi.advanceTimersByTimeAsync(2000);
    const afterStart = (await spawns.listActive()).length;

    spawner.stop();
    spawner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await spawns.listActive()).toHaveLength(afterStart);
  });

  it('survives a failing tick instead of crashing the process', async () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const failing = new MemorySpawnStore();
    vi.spyOn(failing, 'listActive').mockRejectedValue(new Error('database is down'));

    const spawner = new DungeonSpawner({
      spawns: failing,
      log: (message) => void messages.push(message),
    });

    spawner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toContain('spawner tick failed');
    spawner.stop();
  });
});

describe('defaults', () => {
  it('matches the five markers the map screen was designed around', () => {
    expect(DEFAULT_SPAWNER_CONFIG.targetLiveSpawns).toBe(5);
    expect(DEFAULT_SPAWNER_CONFIG.minTtlMs).toBeLessThan(DEFAULT_SPAWNER_CONFIG.maxTtlMs);
  });
});
