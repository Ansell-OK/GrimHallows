/**
 * Free-run loot minter tests (docs/09 B7).
 *
 * The worker escorts a drop that has already been decided through the only route
 * `character-loot-nft.mint` has on the deployed contracts: `enter-dungeon` →
 * `commit-seed` → `reveal-and-resolve`. What makes that safe is not that each
 * call succeeds — it is that a pass never takes a step whose predecessor it has
 * not read back as confirmed. So most of what follows is about what the worker
 * declines to broadcast.
 *
 * THE SAME DROP IS NEVER MINTED TWICE. This is the one that costs real money to
 * get wrong: two `reveal-and-resolve` calls for one drop hand out two NFTs the
 * reward table drew once. It is pinned from three directions — a pass whose last
 * step is unconfirmed broadcasts nothing, a run with a recorded `resolveTxId` is
 * no longer offered at all, and a restart mid-ceremony resumes at the recorded
 * step instead of starting over.
 *
 * A FAILURE PARKS RATHER THAN RETRIES. An `abort_by_response` is the contract
 * refusing on its own terms, so the next pass would be refused identically,
 * having spent another fee to find that out.
 *
 * The store is the real `MemoryRunStore`. The worker's state machine *is* the
 * txid columns, and a hand-written fake store would let the two drift apart
 * while both kept passing.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveFreeRunReward,
  type EncounterSetup,
  type RewardResult,
} from '@grimhallow/shared';
import { MemoryRunStore } from '../src/repos/runs.js';
import { FreeRunLootMinter } from '../src/oracle/freeRunLootMinter.js';
import { PaidOracleError, type PaidRunOracle } from '../src/oracle/paidRunOracle.js';
import type { ChainClient, ChainTransaction } from '../src/lib/hiro.js';
import { characterRef } from './helpers/collections.js';

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const CHARACTER = characterRef('7');
const SPAWN = '0f1e2d3c-4b5a-4967-8899-aabbccddeeff';
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

/**
 * The three chain calls, recorded rather than broadcast.
 *
 * `broadcasts` is the assertion surface for the double-mint guard: what matters
 * is not what a pass returned but how many transactions it put on the wire.
 */
class FakeOracle {
  readonly broadcasts: string[] = [];
  readonly commits: { runId: string; seedHash: string }[] = [];
  readonly resolves: { chainRunId: string; seed: string }[] = [];
  /** Null leaves the entry pending; a `PaidOracleError` makes it read as aborted. */
  enteredRunId: string | null | PaidOracleError = '77';
  /** Thrown by the next `commitSeed`, to model a Hiro blip mid-ceremony. */
  commitError: Error | null = null;

  async enterFreeDungeon(params: { readonly player: string }): Promise<string> {
    this.broadcasts.push('enter-dungeon');
    return `0xenter-${params.player.slice(-4)}`;
  }

  async readEnteredRunId(_txId: string): Promise<string | null> {
    if (this.enteredRunId instanceof PaidOracleError) throw this.enteredRunId;
    return this.enteredRunId;
  }

  async commitSeed(params: { readonly runId: string; readonly seedHash: string }): Promise<string> {
    if (this.commitError) throw this.commitError;
    this.broadcasts.push('commit-seed');
    this.commits.push({ ...params });
    return '0xcommit';
  }

  async resolveFreeLootRun(params: {
    readonly chainRunId: string;
    readonly seed: string;
  }): Promise<{ readonly resolveTxId: string; readonly reward: RewardResult }> {
    this.broadcasts.push('reveal-and-resolve');
    this.resolves.push({ ...params });
    return {
      resolveTxId: '0xresolve',
      reward: resolveFreeRunReward({ seed: params.seed, combatOutcome: 'win' }),
    };
  }
}

/** A chain where a txid absent from the map 404s, exactly as a fresh one does. */
class FakeChain {
  readonly statuses = new Map<string, string>();
  readonly reads: string[] = [];

  async getTransaction(txId: string): Promise<ChainTransaction | null> {
    this.reads.push(txId);
    const txStatus = this.statuses.get(txId);
    if (!txStatus) return null;
    return {
      txId,
      txStatus,
      txType: 'contract_call',
      senderAddress: 'ST2ORACLE',
      contractId: 'ST2ORACLE.game-core',
      functionName: 'commit-seed',
      functionArgsRepr: [],
      resultRepr: '(ok true)',
      events: [],
      blockHeight: 4242,
    };
  }
}

function harness() {
  const runs = new MemoryRunStore();
  const oracle = new FakeOracle();
  const chain = new FakeChain();
  const logs: string[] = [];

  /**
   * A factory, not an instance. Every test that models a restart builds a second
   * worker over the same store, which only proves anything because the worker
   * itself holds no ceremony state.
   */
  const minter = (config: { batchSize?: number } = {}) =>
    new FreeRunLootMinter(
      {
        runs,
        oracle: oracle as unknown as PaidRunOracle,
        chain: chain as unknown as ChainClient,
        log: (message) => logs.push(message),
      },
      config,
    );

  /** A resolved free run that drew loot — the state the worker picks up. */
  async function runOwedLoot(over: { resolvedAt?: Date; seedReveal?: string } = {}) {
    const run = await runs.createFreeRun({
      spawnId: SPAWN,
      partyId: null,
      createdBy: PLAYER,
      character: CHARACTER,
    });
    await runs.commit(run.id, {
      seedHash: SEED_HASH,
      seed: SEED,
      setup: SETUP,
      commitSignature: 'sig-commit',
      oracleAddress: 'ST2ORACLE',
      committedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await runs.resolve(run.id, {
      seedReveal: over.seedReveal ?? SEED,
      combatOutcome: 'win',
      resolveSignature: 'sig-resolve',
      resolvedAt: over.resolvedAt ?? new Date('2026-01-01T00:05:00.000Z'),
      reward: { kind: 'loot', amountUstx: null, lootTokenId: null, degraded: false },
    });
    return run;
  }

  return { runs, oracle, chain, logs, minter, runOwedLoot };
}

describe('FreeRunLootMinter', () => {
  describe('the ceremony', () => {
    it('takes one step per pass, in the order the contract will accept', async () => {
      // One step per pass is not pacing, it is the double-mint guard: each step
      // is only taken after the previous one has been read back as confirmed, so
      // there is no pass at which two of these can be in flight for one drop.
      const h = harness();
      const run = await h.runOwedLoot();
      h.chain.statuses.set('0xcommit', 'success');
      const worker = h.minter();

      expect((await worker.runOnce()).advanced).toBe(1);
      expect(h.oracle.broadcasts).toEqual(['enter-dungeon']);

      // The assigned run id is recorded on its own pass, after the entry
      // confirms. It cannot be learnt on the pass that broadcast the entry: it
      // is a return value of a transaction that has not been mined yet.
      expect((await worker.runOnce()).advanced).toBe(1);
      expect(h.oracle.broadcasts).toEqual(['enter-dungeon']);
      expect((await h.runs.findById(run.id))?.lootMint?.chainRunId).toBe('77');

      expect((await worker.runOnce()).advanced).toBe(1);
      expect(h.oracle.broadcasts).toEqual(['enter-dungeon', 'commit-seed']);

      expect((await worker.runOnce()).minted).toBe(1);
      expect(h.oracle.broadcasts).toEqual(['enter-dungeon', 'commit-seed', 'reveal-and-resolve']);
    });

    it('stops considering a run once the mint is broadcast', async () => {
      const h = harness();
      await h.runOwedLoot();
      h.chain.statuses.set('0xcommit', 'success');
      const worker = h.minter();

      for (let i = 0; i < 4; i++) await worker.runOnce();
      const after = await worker.runOnce();

      // Nothing left to consider, so nothing to re-broadcast. A worker that kept
      // offering the run would mint a second NFT for a drop the table drew once.
      expect(after.considered).toBe(0);
      expect(h.oracle.broadcasts.filter((c) => c === 'reveal-and-resolve')).toHaveLength(1);
    });

    it('commits the hash the player was shown and reveals the seed they were given', async () => {
      // The whole point of committing this run's own seed rather than a fresh
      // secret: the drop stays recomputable from the one seed the player has. A
      // recomputed hash, or a different seed, would mint a tier nobody was told
      // about — and `reveal-and-resolve` checks sha256(seed) against the commit,
      // so a mismatched pair aborts on chain rather than minting anything.
      const h = harness();
      await h.runOwedLoot();
      h.chain.statuses.set('0xcommit', 'success');
      const worker = h.minter();

      for (let i = 0; i < 4; i++) await worker.runOnce();

      expect(h.oracle.commits).toEqual([{ runId: '77', seedHash: SEED_HASH }]);
      expect(h.oracle.resolves).toEqual([{ chainRunId: '77', seed: SEED }]);
    });

    it('commits against the chain run id, never the database one', async () => {
      // Two id spaces that both look like small integers. Committing against the
      // DB id would address a stranger's run on chain, or none at all.
      const h = harness();
      const run = await h.runOwedLoot();
      h.oracle.enteredRunId = '90210';
      const worker = h.minter();

      await worker.runOnce();
      await worker.runOnce();
      await worker.runOnce();

      expect(h.oracle.commits[0]?.runId).toBe('90210');
      expect(h.oracle.commits[0]?.runId).not.toBe(run.id);
    });
  });
});

describe('FreeRunLootMinter, waiting on the chain', () => {
  it('does not re-enter while the entry is still in the mempool', async () => {
    const h = harness();
    const run = await h.runOwedLoot();
    // Null from `readEnteredRunId` is "not mined yet", which is the state a
    // just-broadcast entry is in for minutes. Re-entering here would leave the
    // first run stranded and the oracle paying to create a second one.
    h.oracle.enteredRunId = null;
    const worker = h.minter();

    await worker.runOnce();
    const second = await worker.runOnce();
    const third = await worker.runOnce();

    expect(second.waiting).toBe(1);
    expect(third.waiting).toBe(1);
    expect(h.oracle.broadcasts).toEqual(['enter-dungeon']);
    expect((await h.runs.findById(run.id))?.lootMint?.chainRunId).toBeNull();
  });

  it('does not resolve while the commit is still in the mempool', async () => {
    const h = harness();
    await h.runOwedLoot();
    h.chain.statuses.set('0xcommit', 'pending');
    const worker = h.minter();

    for (let i = 0; i < 3; i++) await worker.runOnce();
    const fourth = await worker.runOnce();

    // The contract's own state machine refuses a reveal against a run whose
    // commit has not landed, so this would spend a fee to abort. Worse, it would
    // record a `resolveTxId` for a mint that never happened, which is the one
    // fact the worker reads as "this drop is done".
    expect(fourth.waiting).toBe(1);
    expect(h.oracle.broadcasts).not.toContain('reveal-and-resolve');
  });

  it('treats a txid the node has never heard of as pending, not as a failure', async () => {
    const h = harness();
    const run = await h.runOwedLoot();
    // Nothing in the status map: the 404 a Hiro node returns for a txid it has
    // not yet seen. A just-broadcast transaction reads this way for a few
    // seconds, and parking a ceremony that is about to work would need an
    // operator to un-park it.
    const worker = h.minter();

    for (let i = 0; i < 3; i++) await worker.runOnce();
    const fourth = await worker.runOnce();

    expect(fourth.waiting).toBe(1);
    expect(fourth.failed).toBe(0);
    expect((await h.runs.findById(run.id))?.lootMint?.failedReason).toBeNull();
  });
});

describe('FreeRunLootMinter, resuming after a restart', () => {
  it('picks up at the recorded step rather than starting over', async () => {
    // The txids are the state machine, and they are in the store rather than in
    // the worker. A restart mid-ceremony has to resume, because starting over
    // means a second entry, a second commit and eventually a second mint.
    const h = harness();
    const run = await h.runOwedLoot();
    h.chain.statuses.set('0xcommit', 'success');

    await h.minter().runOnce();
    await h.minter().runOnce();
    await h.minter().runOnce();
    const last = await h.minter().runOnce();

    expect(last.minted).toBe(1);
    expect(h.oracle.broadcasts).toEqual(['enter-dungeon', 'commit-seed', 'reveal-and-resolve']);
    expect((await h.runs.findById(run.id))?.lootMint).toEqual({
      chainRunId: '77',
      enterTxId: '0xenter-GZGM',
      commitTxId: '0xcommit',
      resolveTxId: '0xresolve',
      failedReason: null,
    });
  });

  it('re-reads the entry rather than re-entering when it died between the two', async () => {
    // The gap the separate `chainRunId` write exists to cover: a process that
    // broadcast the entry and went down before the id came back. The txid is on
    // the row, so the next worker reads that transaction instead of paying for a
    // second entry whose predecessor nobody will ever resolve.
    const h = harness();
    const run = await h.runOwedLoot();
    h.oracle.enteredRunId = null;
    await h.minter().runOnce();

    h.oracle.enteredRunId = '77';
    const resumed = await h.minter().runOnce();

    expect(resumed.advanced).toBe(1);
    expect(h.oracle.broadcasts).toEqual(['enter-dungeon']);
    expect((await h.runs.findById(run.id))?.lootMint?.chainRunId).toBe('77');
  });
});

describe('FreeRunLootMinter, a step that confirmed as failed', () => {
  it('parks a run whose entry aborted, and stops offering it', async () => {
    const h = harness();
    const run = await h.runOwedLoot();
    h.oracle.enteredRunId = new PaidOracleError('ENTER_ABORTED', 'entry aborted', 502);
    const worker = h.minter();

    await worker.runOnce();
    const second = await worker.runOnce();

    expect(second.failed).toBe(1);
    // Parked with the reason on the row, not retried. Retrying an abort spends
    // oracle STX on a fee every pass to fail in the same place; an operator needs
    // to see it, and clearing the reason is what hands the run back.
    expect((await h.runs.findById(run.id))?.lootMint?.failedReason).toBe(
      'ENTER_ABORTED: entry aborted',
    );
    expect(await h.runs.listFreeRunsAwaitingLootMint(10)).toEqual([]);
  });

  it('parks a run whose commit aborted, without reaching the mint', async () => {
    const h = harness();
    const run = await h.runOwedLoot();
    h.chain.statuses.set('0xcommit', 'abort_by_response');
    const worker = h.minter();

    for (let i = 0; i < 3; i++) await worker.runOnce();
    const fourth = await worker.runOnce();

    expect(fourth.failed).toBe(1);
    expect(h.oracle.broadcasts).not.toContain('reveal-and-resolve');
    expect((await h.runs.findById(run.id))?.lootMint?.failedReason).toBe(
      'commit-seed confirmed as abort_by_response',
    );
  });

  it('logs a parked ceremony loudly, because a player is owed an NFT', async () => {
    const h = harness();
    await h.runOwedLoot();
    h.chain.statuses.set('0xcommit', 'abort_by_post_condition');
    const worker = h.minter();

    for (let i = 0; i < 4; i++) await worker.runOnce();

    // The reward screen has already shown this drop. Silence here is a support
    // ticket nobody can answer, so the failure has to be findable in the log.
    expect(h.logs.some((m) => m.includes('FREE-RUN LOOT MINT FAILED'))).toBe(true);
  });

  it('parks a resolved run that has no revealed seed', async () => {
    // A corrupt row: resolved, owed loot, and nothing to reveal. The seed is what
    // makes the drop recomputable and what `reveal-and-resolve` hashes, so there
    // is no version of this ceremony that can proceed.
    const h = harness();
    const run = await h.runOwedLoot({ seedReveal: '' });

    const report = await h.minter().runOnce();

    expect(report.failed).toBe(1);
    expect(h.oracle.broadcasts).toEqual([]);
    expect((await h.runs.findById(run.id))?.lootMint?.failedReason).toBe(
      'run resolved with no revealed seed',
    );
  });
});

describe('FreeRunLootMinter, a pass over several runs', () => {
  it('records an unexpected error and still advances the rest of the batch', async () => {
    const h = harness();
    const stuck = await h.runOwedLoot({ resolvedAt: new Date('2026-01-01T00:00:00.000Z') });
    await h.minter().runOnce();
    await h.minter().runOnce();
    const fresh = await h.runOwedLoot({ resolvedAt: new Date('2026-01-02T00:00:00.000Z') });

    h.oracle.commitError = new Error('hiro 503');
    const report = await h.minter().runOnce();

    expect(report.errors).toEqual([`run ${stuck.id}: hiro 503`]);
    // The other run is not collateral: one bad row must not stall a backlog.
    expect(report.advanced).toBe(1);
    expect((await h.runs.findById(fresh.id))?.lootMint?.enterTxId).toBe('0xenter-GZGM');
    // Untouched rather than parked. A Hiro blip is not evidence the ceremony
    // failed on chain, and the next pass retries the same step.
    expect((await h.runs.findById(stuck.id))?.lootMint?.failedReason).toBeNull();
    expect((await h.runs.findById(stuck.id))?.lootMint?.commitTxId).toBeNull();
  });

  it('considers at most batchSize runs', async () => {
    // Small on purpose: every run in a pass costs a broadcast from one oracle
    // account whose nonce is sequential, so a bigger batch queues transactions
    // behind each other without minting anything sooner.
    const h = harness();
    await h.runOwedLoot({ resolvedAt: new Date('2026-01-01T00:00:00.000Z') });
    await h.runOwedLoot({ resolvedAt: new Date('2026-01-02T00:00:00.000Z') });
    await h.runOwedLoot({ resolvedAt: new Date('2026-01-03T00:00:00.000Z') });

    const report = await h.minter({ batchSize: 2 }).runOnce();

    expect(report.considered).toBe(2);
    expect(h.oracle.broadcasts).toEqual(['enter-dungeon', 'enter-dungeon']);
  });

  it('reports nothing to do when no free run is owed a drop', async () => {
    const h = harness();
    expect(await h.minter().runOnce()).toEqual({
      considered: 0,
      advanced: 0,
      minted: 0,
      waiting: 0,
      failed: 0,
      errors: [],
    });
  });
});

