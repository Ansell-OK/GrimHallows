/**
 * Loot minter loop tests (docs/09 B7).
 *
 * The loop is a timer around a pass, so what is worth pinning is the two things
 * a timer can do that the pass cannot defend against on its own.
 *
 * IT NEVER OVERLAPS ITSELF. `FreeRunLootMinter` derives each run's next step from
 * txids it reads at the top of a pass and writes back mid-pass. Two passes in
 * flight would both read the same run before either wrote, and both broadcast the
 * same step — for the resolve step, that is two NFTs for one drop. The indexer's
 * equivalent guard is about Hiro quota; this one is about not minting twice.
 *
 * IT NEVER TAKES THE PROCESS DOWN. An unhandled rejection inside a `setInterval`
 * callback is fatal in Node, and a loot ceremony is not worth the server.
 */

import { describe, expect, it, vi } from 'vitest';
import { FreeRunLootMinter, type LootMintReport } from '../src/oracle/freeRunLootMinter.js';
import { LootMinterLoop } from '../src/oracle/lootMinterLoop.js';

const EMPTY: LootMintReport = {
  considered: 0,
  advanced: 0,
  minted: 0,
  waiting: 0,
  failed: 0,
  errors: [],
};

/** A minter whose pass is whatever the test needs it to be. */
function fakeMinter(runOnce: () => Promise<LootMintReport>): FreeRunLootMinter {
  return { runOnce } as unknown as FreeRunLootMinter;
}

describe('LootMinterLoop', () => {
  it('skips a tick while the previous pass is still running', async () => {
    let release: (() => void) | null = null;
    let passes = 0;
    const minter = fakeMinter(async () => {
      passes++;
      // Only the first pass hangs. What is under test is what the loop does
      // while a pass is in flight, so later passes return straight away rather
      // than needing a gate of their own.
      if (passes === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return EMPTY;
    });
    const loop = new LootMinterLoop(minter, {}, () => {});

    const first = loop.tick();
    // The overlapping tick a slow pass would collide with. It must not start a
    // second pass: both would read the same runs at the same step and broadcast
    // it twice, which at the resolve step means two NFTs for one drop.
    expect(await loop.tick()).toBeNull();
    expect(passes).toBe(1);

    release!();
    await first;

    // And the guard lifts once the pass finishes, rather than latching.
    await loop.tick();
    expect(passes).toBe(2);
  });

  it('swallows a failed pass rather than taking the process down', async () => {
    const logs: string[] = [];
    const loop = new LootMinterLoop(
      fakeMinter(async () => {
        throw new Error('database unreachable');
      }),
      {},
      (message) => logs.push(message),
    );

    // `tick` itself rejects — the caller may want to know — but `start`'s timer
    // callback is where an unhandled rejection would be fatal, so the failure has
    // to be caught there and reported instead.
    await expect(loop.tick()).rejects.toThrow('database unreachable');

    loop.start();
    await vi.waitFor(() => expect(logs).toContain('free-run loot mint pass failed'));
    loop.stop();
  });

  it('unblocks after a failed pass instead of latching the guard', async () => {
    // The `running` flag is cleared in a `finally`. Set on the way in and cleared
    // only on success, one transient failure would stop every later pass forever
    // and the backlog would never drain.
    let passes = 0;
    const loop = new LootMinterLoop(
      fakeMinter(async () => {
        passes++;
        throw new Error('hiro 503');
      }),
      {},
      () => {},
    );

    await expect(loop.tick()).rejects.toThrow();
    await expect(loop.tick()).rejects.toThrow();
    expect(passes).toBe(2);
  });

  it('runs a pass immediately on start, without waiting out the interval', async () => {
    // A restart is exactly when a backlog exists: any ceremony interrupted
    // mid-flight is sitting at its recorded step. Waiting a full interval to
    // discover that would add the interval to every one of those players' waits.
    let passes = 0;
    const loop = new LootMinterLoop(
      fakeMinter(async () => {
        passes++;
        return EMPTY;
      }),
      { tickIntervalMs: 60_000 },
      () => {},
    );

    loop.start();
    await vi.waitFor(() => expect(passes).toBe(1));
    loop.stop();
  });

  it('stops cleanly, and a second stop is not an error', async () => {
    // `onClose` fires on every server teardown, including ones where the loop was
    // never started. A timer surviving teardown would keep an oracle-signing job
    // alive in a process that is supposed to be gone.
    const loop = new LootMinterLoop(fakeMinter(async () => EMPTY), {}, () => {});
    loop.start();
    loop.stop();
    expect(() => loop.stop()).not.toThrow();
  });

  it('logs a pass that did something and stays quiet about one that did not', async () => {
    // This runs every minute forever. A line per pass would bury the ones that
    // say a drop was minted or a ceremony was parked under thousands saying
    // nothing was owed.
    const logs: string[] = [];
    const reports = [EMPTY, { ...EMPTY, considered: 1, minted: 1 }];
    const loop = new LootMinterLoop(
      fakeMinter(async () => reports.shift() ?? EMPTY),
      {},
      (message) => logs.push(message),
    );

    await loop.tick();
    expect(logs).toEqual([]);

    await loop.tick();
    expect(logs).toEqual(['free-run loot mint pass complete']);
  });
});
