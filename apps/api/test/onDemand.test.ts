/**
 * The read-triggered ticker.
 *
 * The cases that matter are the ones that decide whether a deployed map keeps
 * spawning: a cold instance must tick on its very first read, a failed pass must
 * not become a 500, and a slow pass must not be able to stampede.
 */

import { describe, expect, it, vi } from 'vitest';
import { OnDemandTicker } from '../src/services/onDemand.js';

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('OnDemandTicker', () => {
  it('ticks on the first read of a cold instance', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'spawner', tick, minIntervalMs: 60_000, now: c.now });

    expect(ticker.isDue()).toBe(true);
    expect(await ticker.runIfDue()).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('throttles reads inside the interval and resumes after it', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'spawner', tick, minIntervalMs: 60_000, now: c.now });

    await ticker.runIfDue();
    c.advance(59_999);
    expect(await ticker.runIfDue()).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);

    c.advance(1);
    expect(await ticker.runIfDue()).toBe(true);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed pass rather than failing the request behind it', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('hiro is down'));
    const log = vi.fn();
    const c = clock();
    const ticker = new OnDemandTicker({
      name: 'indexer',
      tick,
      minIntervalMs: 1000,
      log,
      now: c.now,
    });

    await expect(ticker.runIfDue()).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      'indexer on-demand pass failed',
      expect.objectContaining({ error: 'hiro is down' }),
    );
  });

  it('is due again after a failure — one bad pass must not wedge the job', async () => {
    const tick = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'indexer', tick, minIntervalMs: 1000, now: c.now });

    await ticker.runIfDue();
    c.advance(1000);
    expect(await ticker.runIfDue()).toBe(true);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('will not start a second pass while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = vi.fn().mockReturnValue(gate);
    const c = clock();
    // Interval of zero: without the in-flight guard every call would be due.
    const ticker = new OnDemandTicker({ name: 'spawner', tick, minIntervalMs: 0, now: c.now });

    const first = ticker.runIfDue();
    expect(ticker.isDue()).toBe(false);
    expect(await ticker.runIfDue()).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(await ticker.runIfDue()).toBe(true);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('measures the interval from the pass finish, so a slow job does not run back-to-back', async () => {
    const c = clock();
    // A pass that takes twice the interval. Stamping on start would leave it
    // instantly due again the moment it lands; stamping on finish does not.
    const tick = vi.fn().mockImplementation(async () => {
      c.advance(120_000);
    });
    const ticker = new OnDemandTicker({ name: 'indexer', tick, minIntervalMs: 60_000, now: c.now });

    await ticker.runIfDue();
    expect(await ticker.runIfDue()).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);

    c.advance(60_000);
    expect(await ticker.runIfDue()).toBe(true);
  });

  it('startIfDue returns without waiting for the pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = vi.fn().mockReturnValue(gate);
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'indexer', tick, minIntervalMs: 1000, now: c.now });

    expect(ticker.startIfDue()).toBe(true);
    // Still running: the caller was handed control back mid-pass, which is the
    // whole point on the leaderboard path.
    expect(ticker.isDue()).toBe(false);
    release();
    await gate;
  });

  it('startIfDue does not reject when the pass fails', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('boom'));
    const log = vi.fn();
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'indexer', tick, minIntervalMs: 1000, log, now: c.now });

    expect(() => ticker.startIfDue()).not.toThrow();
    // Let the dropped promise settle; an unhandled rejection would surface here.
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalled();
  });

  it('respects the throttle across both entry points', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const c = clock();
    const ticker = new OnDemandTicker({ name: 'spawner', tick, minIntervalMs: 60_000, now: c.now });

    await ticker.runIfDue();
    expect(ticker.startIfDue()).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
