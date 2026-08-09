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
 *
 * IT NEVER OVERLAPS ANOTHER INSTANCE EITHER. The flag that stops the first is a
 * boolean on one object, which was the whole world when a `setInterval` on a host
 * that owned its process was the only driver. Two HTTP schedulers against a
 * serverless fleet is not that world, so the same guard is asserted a second time
 * across two loop objects sharing a lease store.
 */

import { describe, expect, it, vi } from 'vitest';
import { FreeRunLootMinter, type LootMintReport } from '../src/oracle/freeRunLootMinter.js';
import { LootMinterLoop } from '../src/oracle/lootMinterLoop.js';
import { MemoryJobLeaseStore } from '../src/repos/jobLeases.js';

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

  describe('the cross-instance lease', () => {
    /**
     * Two loops sharing one lease store — the shape of two warm serverless
     * instances, which is what the `running` flag above cannot see. Both are
     * driven by the same two schedulers, so "another instance is mid-pass" is a
     * state the endpoint reaches in production and never reaches in a test that
     * only ever builds one loop.
     */
    function twoInstances(minterA: FreeRunLootMinter, minterB: FreeRunLootMinter) {
      const leases = new MemoryJobLeaseStore();
      return {
        leases,
        a: new LootMinterLoop(minterA, {}, () => {}, leases),
        b: new LootMinterLoop(minterB, {}, () => {}, leases),
      };
    }

    it('does not start a pass while another instance holds the lease', async () => {
      let release: (() => void) | null = null;
      let passesB = 0;
      const { a, b } = twoInstances(
        fakeMinter(
          () => new Promise<LootMintReport>((resolve) => {
            release = () => resolve(EMPTY);
          }),
        ),
        fakeMinter(async () => {
          passesB++;
          return EMPTY;
        }),
      );

      const first = a.tick();
      // The race this exists to stop: B would read the same run at the same
      // recorded step A is mid-broadcast on, and broadcast it again. At the
      // resolve step that is a second NFT for one drop; at any step it is an
      // aborted transaction that can be the one recorded, parking a run as failed
      // after the player was shown their reward.
      expect(await b.tick()).toBeNull();
      expect(passesB).toBe(0);

      release!();
      await first;
    });

    it('hands the lease back when the pass ends, rather than holding it out', async () => {
      // The TTL is two minutes and the tick interval is one. A lease held for its
      // full term would halve the cadence — and every skipped pass is a step a
      // player waits an extra interval for.
      let passesB = 0;
      const { a, b } = twoInstances(
        fakeMinter(async () => EMPTY),
        fakeMinter(async () => {
          passesB++;
          return EMPTY;
        }),
      );

      await a.tick();
      await b.tick();
      expect(passesB).toBe(1);
    });

    it('hands the lease back after a pass that threw', async () => {
      // Released in a `finally`, for the same reason the local flag is. A failure
      // that kept the lease would block every instance for a full TTL, and the
      // first pass after a transient Hiro blip is the one draining a backlog.
      let passesB = 0;
      const { a, b } = twoInstances(
        fakeMinter(async () => {
          throw new Error('hiro 503');
        }),
        fakeMinter(async () => {
          passesB++;
          return EMPTY;
        }),
      );

      await expect(a.tick()).rejects.toThrow('hiro 503');
      await b.tick();
      expect(passesB).toBe(1);
    });

    it('completes the pass even if the lease cannot be released', async () => {
      // A tidy-up failure is not a failed pass. Through `/jobs/loot-mint` a throw
      // here would be a non-2xx in a cron dashboard for work that succeeded, and
      // the lease expires on its own anyway.
      const logs: string[] = [];
      const leases = new MemoryJobLeaseStore();
      leases.release = async () => {
        throw new Error('pooler closed the connection');
      };
      const loop = new LootMinterLoop(
        fakeMinter(async () => ({ ...EMPTY, considered: 1, minted: 1 })),
        {},
        (message) => logs.push(message),
        leases,
      );

      expect((await loop.tick())?.minted).toBe(1);
      expect(logs).toContain('free-run loot mint lease release failed; it will expire');
    });

    it('runs normally with no lease store at all', async () => {
      // Null is the single-process case, and the default. A deployment that can
      // only ever have one instance needs no round trip to be told so.
      let passes = 0;
      const loop = new LootMinterLoop(
        fakeMinter(async () => {
          passes++;
          return EMPTY;
        }),
        {},
        () => {},
        null,
      );

      await loop.tick();
      await loop.tick();
      expect(passes).toBe(2);
    });
  });
});
