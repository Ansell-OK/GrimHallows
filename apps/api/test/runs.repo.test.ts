/**
 * Run store tests.
 *
 * The store is where two invariants are actually enforced, and both of them are
 * about things that must not be possible rather than things that must work.
 *
 * A SEED NEVER RIDES ALONG ON A RUN. `RunRecord` has no seed field, and
 * `readSeedSecret` is a separate, deliberate call. Every route that returns a run
 * returns the record, so a seed on that object would be one `return run` away
 * from being published mid-run — at which point a player derives every remaining
 * roll before choosing their next action. `repos/runs.ts` says this file asserts
 * it; this file asserts it.
 *
 * A STATE MOVES ONCE. `commit` matches only a pending run and `resolve` only a
 * committed one, so a second commit cannot replace a hash the player has already
 * been shown and acted under, and a second resolve cannot restate an outcome.
 * The same predicate is the lock in Postgres — `where id = $1 and state = ...` —
 * and the memory store mirrors it so the two agree.
 *
 * Only `MemoryRunStore` is exercised here: `PostgresRunStore` needs a database,
 * and these are unit tests. What they pin is the contract both implement.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CombatTurn, EncounterSetup } from '@grimhallow/shared';
import { MemoryRunStore } from '../src/repos/runs.js';
import { characterRef } from './helpers/collections.js';

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const CHARACTER = characterRef('7');
const SPAWN = '0f1e2d3c-4b5a-4967-8899-aabbccddeeff';

/** A 32-byte seed and a hash, shaped like the real ones without being random. */
const SEED = 'a'.repeat(64);
const SEED_HASH = 'b'.repeat(64);

const SETUP: EncounterSetup = {
  monsterTableId: 'forsaken-crypt',
  party: [
    {
      id: 'p0',
      address: PLAYER,
      name: 'Character #7',
      charClass: 'warrior',
      stats: { hp: 30, str: 14, agi: 11, int: 8, vit: 12 },
      powerUpTiers: [],
    },
  ],
};

const commitDetails = (over: Partial<Parameters<MemoryRunStore['commit']>[1]> = {}) => ({
  seedHash: SEED_HASH,
  seed: SEED,
  setup: SETUP,
  commitSignature: 'sig-commit',
  oracleAddress: 'ST2ORACLE',
  committedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

const resolveDetails = () => ({
  seedReveal: SEED,
  combatOutcome: 'win' as const,
  resolveSignature: 'sig-resolve',
  resolvedAt: new Date('2026-01-01T00:05:00.000Z'),
});

describe('MemoryRunStore', () => {
  let runs: MemoryRunStore;

  beforeEach(() => {
    runs = new MemoryRunStore();
  });

  const newRun = () =>
    runs.createFreeRun({
      spawnId: SPAWN,
      partyId: null,
      createdBy: PLAYER,
      character: CHARACTER,
    });

  describe('creating a free run', () => {
    it('starts pending, with nothing committed to yet', async () => {
      const run = await newRun();

      expect(run.dungeonType).toBe('free');
      expect(run.state).toBe('pending');
      expect(run.spawnId).toBe(SPAWN);
      expect(run.createdBy).toBe(PLAYER);
      expect(run.character).toEqual(CHARACTER);
      expect(run.seedHash).toBeNull();
      expect(run.setup).toBeNull();
      // Both null rather than stamped at creation: they are lines inside signed
      // statements that have not been made yet, and a timestamp for a commit
      // that never happened would be a claim about nothing.
      expect(run.committedAt).toBeNull();
      expect(run.resolvedAt).toBeNull();
    });

    it('has no seed to read before one is committed', async () => {
      const run = await newRun();
      expect(await runs.readSeedSecret(run.id)).toBeNull();
    });

    it('issues a distinct id per run', async () => {
      const ids = new Set([(await newRun()).id, (await newRun()).id, (await newRun()).id]);
      expect(ids.size).toBe(3);
    });

    it('keeps ids as strings', async () => {
      // Run ids share a space with on-chain ones, which exceed
      // Number.MAX_SAFE_INTEGER. A number here would round somebody's run into
      // somebody else's.
      expect(typeof (await newRun()).id).toBe('string');
    });
  });

  describe('committing', () => {
    it('records the commitment and freezes the setup', async () => {
      const run = await newRun();
      const committed = (await runs.commit(run.id, commitDetails()))!;

      expect(committed.state).toBe('committed');
      expect(committed.seedHash).toBe(SEED_HASH);
      expect(committed.setup).toEqual(SETUP);
      expect(committed.commitSignature).toBe('sig-commit');
      expect(committed.oracleAddress).toBe('ST2ORACLE');
      // The instant that was signed, stored verbatim. A store that stamped its
      // own would leave the signature quoting a time the row does not have.
      expect(committed.committedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('makes the seed readable only through readSeedSecret', async () => {
      const run = await newRun();
      const committed = (await runs.commit(run.id, commitDetails()))!;

      expect(await runs.readSeedSecret(run.id)).toBe(SEED);
      // The record is what every read path serializes. Asserted over the whole
      // serialization rather than over a field name, because the failure being
      // caught is a seed appearing somewhere nobody thought to name.
      expect(JSON.stringify(committed)).not.toContain(SEED);
      expect(JSON.stringify(await runs.findById(run.id))).not.toContain(SEED);
    });

    it('refuses a second commit and keeps the first hash', async () => {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());

      const second = await runs.commit(
        run.id,
        commitDetails({ seedHash: 'c'.repeat(64), seed: 'd'.repeat(64) }),
      );

      // Null, not a fresh commitment: re-committing would replace a hash the
      // player has already been shown and possibly already acted under, making
      // every roll since unverifiable.
      expect(second).toBeNull();
      expect((await runs.findById(run.id))?.seedHash).toBe(SEED_HASH);
      expect(await runs.readSeedSecret(run.id)).toBe(SEED);
    });

    it('refuses to commit a run that has already resolved', async () => {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      await runs.resolve(run.id, resolveDetails());

      expect(await runs.commit(run.id, commitDetails())).toBeNull();
    });

    it('returns null for a run that does not exist', async () => {
      expect(await runs.commit('999999', commitDetails())).toBeNull();
    });
  });

  describe('resolving', () => {
    it('reveals the seed and records the outcome', async () => {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      const resolved = (await runs.resolve(run.id, resolveDetails()))!;

      expect(resolved.state).toBe('resolved');
      expect(resolved.seedReveal).toBe(SEED);
      expect(resolved.combatOutcome).toBe('win');
      expect(resolved.resolveSignature).toBe('sig-resolve');
      expect(resolved.resolvedAt).toEqual(new Date('2026-01-01T00:05:00.000Z'));
      // Still there afterwards: the commitment is half of what a verifier
      // checks, and a reveal with nothing to check it against proves nothing.
      expect(resolved.seedHash).toBe(SEED_HASH);
      expect(resolved.committedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('refuses to resolve a run that never committed', async () => {
      const run = await newRun();
      // There is no seed to reveal and no hash to have revealed it against.
      // Resolving here would be recording an outcome with no commitment behind
      // it at all.
      expect(await runs.resolve(run.id, resolveDetails())).toBeNull();
      expect((await runs.findById(run.id))?.state).toBe('pending');
    });

    it('refuses a second resolve', async () => {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      await runs.resolve(run.id, resolveDetails());

      expect(await runs.resolve(run.id, resolveDetails())).toBeNull();
    });
  });

  describe('actions', () => {
    it('appends in order and reads back in order', async () => {
      const run = await newRun();
      expect(await runs.appendAction(run.id, 0, {
        address: PLAYER,
        powerId: 'warrior-strike',
        targetId: 'm0',
      })).toBe(true);
      expect(await runs.appendAction(run.id, 1, {
        address: PLAYER,
        powerId: 'guard',
        targetId: null,
      })).toBe(true);

      const stored = await runs.listActions(run.id);
      // Order is not a display preference here: the action list is replayed
      // positionally, so two actions swapped is a different fight.
      expect(stored.map((a) => a.powerId)).toEqual(['warrior-strike', 'guard']);
      expect(stored.map((a) => a.actionIndex)).toEqual([0, 1]);
    });

    it('lets exactly one of two submissions claim a slot', async () => {
      const run = await newRun();
      const action = { address: PLAYER, powerId: 'warrior-strike', targetId: 'm0' };

      expect(await runs.appendAction(run.id, 0, action)).toBe(true);
      // The loser of the race, told so. Applying it anyway would append an
      // action to a turn that has already been resolved and rewrite every roll
      // after it.
      expect(await runs.appendAction(run.id, 0, { ...action, powerId: 'guard' })).toBe(false);
      expect(await runs.listActions(run.id)).toHaveLength(1);
    });

    it('refuses an index that would leave a hole', async () => {
      const run = await newRun();
      expect(await runs.appendAction(run.id, 3, {
        address: PLAYER,
        powerId: 'warrior-strike',
        targetId: 'm0',
      })).toBe(false);
      expect(await runs.listActions(run.id)).toHaveLength(0);
    });

    it('returns an empty list for a run with no actions', async () => {
      expect(await runs.listActions((await newRun()).id)).toEqual([]);
    });

    it('hands back a copy, so a caller cannot edit history in place', async () => {
      const run = await newRun();
      await runs.appendAction(run.id, 0, {
        address: PLAYER,
        powerId: 'warrior-strike',
        targetId: 'm0',
      });

      (await runs.listActions(run.id)).pop();
      expect(await runs.listActions(run.id)).toHaveLength(1);
    });
  });

  describe('the written-down replay', () => {
    const turn = (n: number): CombatTurn => ({
      turnNumber: n,
      actorId: 'p0',
      actorName: 'Character #7',
      actorAddress: PLAYER,
      action: 'attack',
      powerId: 'warrior-strike',
      powerName: 'Strike',
      targetId: 'm0',
      targetName: 'Crypt Rat',
      rolls: { initiative: 14, attackRoll: 17, attackDice: [15], targetDc: 12, hit: true },
      damageDealt: 5,
      targetHpAfter: 3,
      defeated: false,
      derivationIndex: n * 8,
    });

    it('stores and returns the turns', async () => {
      const run = await newRun();
      await runs.putTurns(run.id, [turn(1), turn(2)]);
      expect(await runs.listTurns(run.id)).toEqual([turn(1), turn(2)]);
    });

    it('replaces rather than appends, so a replay can be rewritten', async () => {
      // The turn log is derived from the actions, so writing it twice must
      // produce the log, not two copies of it.
      const run = await newRun();
      await runs.putTurns(run.id, [turn(1)]);
      await runs.putTurns(run.id, [turn(1), turn(2)]);
      expect(await runs.listTurns(run.id)).toHaveLength(2);
    });

    it('returns an empty log for a run that has not been replayed', async () => {
      expect(await runs.listTurns((await newRun()).id)).toEqual([]);
    });
  });

  describe('unknown runs', () => {
    it('reads as null rather than throwing', async () => {
      expect(await runs.findById('999999')).toBeNull();
      expect(await runs.readSeedSecret('999999')).toBeNull();
    });

    it('creates nothing on a write to one', async () => {
      await runs.appendAction('999999', 0, {
        address: PLAYER,
        powerId: 'warrior-strike',
        targetId: 'm0',
      });
      expect(runs.all()).toHaveLength(0);
    });
  });
});
