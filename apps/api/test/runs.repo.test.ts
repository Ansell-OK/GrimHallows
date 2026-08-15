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
      powerUpItems: [],
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

    /**
     * The setup is stored once and read two ways, and both readings are load-bearing.
     *
     * `setup` is what `runEncounter` takes. `storedSetup` is what the column
     * holds, which for a run committed before archetypes is a different shape —
     * and it is the one the oracle's transcript hash was taken over, so it has to
     * survive the round trip rather than being normalized away on the way in.
     *
     * Pinned on the memory store because it is the only one these unit tests can
     * reach, and because the store is where the two could silently become one
     * value under two names. `PostgresRunStore.fromRow` splits the same way; this
     * is the half of that agreement a test can hold.
     */
    describe('the stored setup and the runnable one', () => {
      it('keeps both readings of a modern setup, which are the same value', async () => {
        const run = await newRun();
        const committed = (await runs.commit(run.id, commitDetails()))!;

        expect(committed.setup).toEqual(SETUP);
        expect(committed.storedSetup).toEqual(SETUP);
      });

      it('keeps a pre-archetype loadout as stored while exposing a runnable reading', async () => {
        const run = await newRun();
        // Cast because `CommitDetails.setup` is deliberately the CURRENT shape:
        // no production write path may persist a legacy one, so the only way to
        // reproduce a row from before archetypes is to inject it here. This is
        // the row shape that actually exists on mainnet today.
        const legacy = {
          monsterTableId: 'forsaken-crypt',
          party: [{ ...SETUP.party[0], powerUpItems: undefined, powerUpTiers: [2] }],
        } as unknown as EncounterSetup;

        const committed = (await runs.commit(run.id, commitDetails({ setup: legacy })))!;

        // The row, unchanged. This is what gets hashed and published.
        expect(committed.storedSetup).toEqual(legacy);
        // And the reading the engine can run, with the tier read as `relic` —
        // whose per-tier bonuses are byte-identical to the table that run was
        // played under, which is why this is a faithful reading and not a guess.
        expect(committed.setup?.party[0]?.powerUpItems).toEqual([
          { archetype: 'relic', tier: 2 },
        ]);
        // Stripped, not carried alongside: a member holding both would let a
        // later reader pick the stale half and replay a different fight.
        expect(committed.setup?.party[0]).not.toHaveProperty('powerUpTiers');
      });

      it('leaves both null before a commit, so neither can be read as an empty setup', async () => {
        const run = await newRun();
        expect(run.setup).toBeNull();
        expect(run.storedSetup).toBeNull();
      });
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

  describe('the free-run loot mint ceremony (docs/09 B7)', () => {
    /** A resolved free run that drew loot — the state the worker picks up. */
    async function runOwedLoot(resolvedAt: Date) {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      await runs.resolve(run.id, {
        ...resolveDetails(),
        resolvedAt,
        reward: { kind: 'loot', amountUstx: null, lootTokenId: null, degraded: false },
      });
      return run;
    }

    it('offers up a resolved free run that drew loot', async () => {
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      expect((await runs.listFreeRunsAwaitingLootMint(10)).map((r) => r.id)).toEqual([run.id]);
    });

    it('leaves a run alone until it has actually resolved', async () => {
      // The ceremony commits the run's own revealed seed, so a run still being
      // fought has nothing to escort on chain yet — and its outcome could still
      // turn out to be a loss.
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      expect(await runs.listFreeRunsAwaitingLootMint(10)).toEqual([]);
      expect(run.state).toBe('pending');
    });

    it('ignores a resolved run whose draw came up empty', async () => {
      const run = await newRun();
      await runs.commit(run.id, commitDetails());
      await runs.resolve(run.id, {
        ...resolveDetails(),
        reward: { kind: 'none', amountUstx: null, lootTokenId: null, degraded: false },
      });
      // 70% of wins land here. Minting for them would hand out an NFT the reward
      // table never drew.
      expect(await runs.listFreeRunsAwaitingLootMint(10)).toEqual([]);
    });

    it('keeps offering a run mid-ceremony, so a restart resumes it', async () => {
      // The worker advances one step per pass and is the only thing that knows
      // which step a run is on. A list that dropped a run after its first txid
      // would strand every ceremony that was interrupted between steps.
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      await runs.updateLootMint(run.id, { enterTxId: '0xenter', chainRunId: '42' });
      expect((await runs.listFreeRunsAwaitingLootMint(10)).map((r) => r.id)).toEqual([run.id]);

      await runs.updateLootMint(run.id, { commitTxId: '0xcommit' });
      expect((await runs.listFreeRunsAwaitingLootMint(10)).map((r) => r.id)).toEqual([run.id]);
    });

    it('stops offering a run once the mint has been broadcast', async () => {
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      await runs.updateLootMint(run.id, { resolveTxId: '0xresolve' });
      // The double-mint guard: a second pass that still saw this run would run
      // the whole ceremony again and mint a second NFT for one drop.
      expect(await runs.listFreeRunsAwaitingLootMint(10)).toEqual([]);
    });

    it('stops offering a run that has been marked failed', async () => {
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      await runs.updateLootMint(run.id, { failedReason: 'abort_by_response' });
      // Retried forever, a permanently failing ceremony would spend oracle STX on
      // fees every pass. A failure is parked for an operator instead.
      expect(await runs.listFreeRunsAwaitingLootMint(10)).toEqual([]);
    });

    it('serves the longest-owed run first', async () => {
      const later = await runOwedLoot(new Date('2026-01-02T00:00:00.000Z'));
      const earlier = await runOwedLoot(new Date('2026-01-01T00:00:00.000Z'));
      // Oldest-first, matching the SQL's `order by resolved_at asc`. Written out
      // of order on purpose: insertion order would pass a test that sorts nothing.
      expect((await runs.listFreeRunsAwaitingLootMint(10)).map((r) => r.id)).toEqual([
        earlier.id,
        later.id,
      ]);
    });

    it('honours the limit', async () => {
      await runOwedLoot(new Date('2026-01-01T00:00:00.000Z'));
      await runOwedLoot(new Date('2026-01-02T00:00:00.000Z'));
      expect(await runs.listFreeRunsAwaitingLootMint(1)).toHaveLength(1);
    });

    it('records each step without erasing the ones before it', async () => {
      // Each step is written as it is broadcast, so a patch carries only what
      // that step learnt. Merging rather than replacing is what lets the worker
      // read back where it got to.
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));

      await runs.updateLootMint(run.id, { enterTxId: '0xenter', chainRunId: '42' });
      await runs.updateLootMint(run.id, { commitTxId: '0xcommit' });
      await runs.updateLootMint(run.id, { resolveTxId: '0xresolve' });

      expect((await runs.findById(run.id))?.lootMint).toEqual({
        chainRunId: '42',
        enterTxId: '0xenter',
        commitTxId: '0xcommit',
        resolveTxId: '0xresolve',
        failedReason: null,
      });
    });

    it('starts from all-nulls, so the first step need not write the rest', async () => {
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      expect(run.lootMint).toBeNull();

      await runs.updateLootMint(run.id, { failedReason: 'ERR-NOT-ORACLE' });

      // A first recorded fact that is a failure, with every txid still null. The
      // reason this is worth pinning: a presence check written as truthiness
      // rather than `!== null` would read this row back as no ceremony at all.
      expect((await runs.findById(run.id))?.lootMint).toEqual({
        chainRunId: null,
        enterTxId: null,
        commitTxId: null,
        resolveTxId: null,
        failedReason: 'ERR-NOT-ORACLE',
      });
    });

    it('can clear a failure to hand a run back to the worker', async () => {
      // Null is a real value here, not an absent key — an operator who has fixed
      // whatever broke needs a way to requeue, and the patch has to distinguish
      // "clear this" from "this step learnt nothing about that field".
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      await runs.updateLootMint(run.id, { failedReason: 'abort_by_response' });

      expect(await runs.updateLootMint(run.id, { failedReason: null })).toBe(true);
      expect((await runs.listFreeRunsAwaitingLootMint(10)).map((r) => r.id)).toEqual([run.id]);
    });

    it('refuses to record a ceremony against a paid run', async () => {
      // Paid runs mint their loot inside their own `reveal-and-resolve`. A
      // ceremony recorded against one would describe a second mint for a drop
      // that already exists.
      const paid = await runs.ingestPaidRun({
        id: '5000',
        dungeonId: 1,
        createdBy: PLAYER,
        character: CHARACTER,
        feePaidUstx: '1000000',
        enterTxId: '0xpaidenter',
      });

      expect(await runs.updateLootMint(paid.id, { enterTxId: '0xenter' })).toBe(false);
      expect((await runs.findById(paid.id))?.lootMint).toBeNull();
    });

    it('reports a miss rather than creating anything for an unknown run', async () => {
      expect(await runs.updateLootMint('999999', { enterTxId: '0xenter' })).toBe(false);
      expect(runs.all()).toHaveLength(0);
    });

    it('treats an empty patch as a miss rather than a silent no-op write', async () => {
      const run = await runOwedLoot(new Date('2026-01-01T00:05:00.000Z'));
      expect(await runs.updateLootMint(run.id, {})).toBe(false);
      expect((await runs.findById(run.id))?.lootMint).toBeNull();
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
