/**
 * `lootMint` on the run view (docs/09 B7).
 *
 * WHAT THIS FIELD IS FOR. A paid win's NFT is minted inside the same
 * `reveal-and-resolve` that settles the fight, so by the time a client can read
 * the run, the mint is done and there is nothing to report. A free win's drop is
 * escorted on chain minutes later by its own three-step ceremony — which means
 * there is a real, ordinary interval in which the tier is true and the token does
 * not exist. The reward screen has to be able to say so, and it can only say so
 * from a field that distinguishes the two.
 *
 * THE PROPERTY THAT MATTERS IS WHICH FACT PROMOTES A RUN TO `minted`. It is the
 * token id, never the txid. A txid is recorded when the node accepts a broadcast,
 * and a failed `asserts!` aborts the transaction afterwards — the whole reason
 * `verifySettlements` exists. The token id is only ever written by the indexer
 * after reading a *successful* transaction's print event, so it is the one stored
 * value that cannot be true of a mint that did not happen. Every case below is
 * some version of that distinction.
 *
 * The store is the real `MemoryRunStore` rather than a literal `RunRecord`,
 * because the shape under test is precisely which columns the write paths leave
 * set at each step — a hand-written record would let this drift from what the
 * worker and the indexer actually write while both kept passing.
 */

import { describe, expect, it } from 'vitest';
import { toRunResponse } from '../src/services/combatService.js';
import { MemoryRunStore, type RunRecord } from '../src/repos/runs.js';
import type { RunView } from '../src/oracle/runOracle.js';
import { characterRef } from './helpers/collections.js';

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const SEED = 'ab'.repeat(32);

/** The one field of the view these tests read. The rest is not consulted. */
function viewOf(run: RunRecord): RunView {
  return {
    run,
    turns: [],
    encounter: { combatants: [], activeCombatantId: null, outcome: run.combatOutcome },
    actions: [],
    transcriptHash: 'ff'.repeat(32),
  } as unknown as RunView;
}

/** A resolved run of either type, with whatever reward the caller wants recorded. */
async function resolved(
  runs: MemoryRunStore,
  type: 'free' | 'paid',
  reward: { kind: 'loot' | 'none'; lootTokenId?: string | null } | null,
  resolveTxId: string | null = null,
): Promise<string> {
  const character = characterRef('7');
  const run =
    type === 'free'
      ? await runs.createFreeRun({
          spawnId: 'spawn-1',
          partyId: null,
          createdBy: PLAYER,
          character,
        })
      : await runs.ingestPaidRun({
          id: '700',
          dungeonId: 1,
          createdBy: PLAYER,
          character,
          feePaidUstx: '1000000',
          enterTxId: `0x${'a'.repeat(64)}`,
        });

  await runs.commit(run.id, {
    seedHash: 'hash',
    seed: SEED,
    setup: { algoVersion: 'encounter-v1' } as never,
    commitSignature: null,
    oracleAddress: null,
    committedAt: new Date(),
  });

  await runs.resolve(run.id, {
    seedReveal: SEED,
    combatOutcome: 'win',
    resolveSignature: null,
    reward: reward
      ? {
          kind: reward.kind,
          amountUstx: null,
          lootTokenId: reward.lootTokenId ?? null,
          degraded: false,
        }
      : null,
    resolveTxId,
    resolvedAt: new Date(),
  });

  return run.id;
}

/** The `lootMint` block a client would receive for this run. */
async function lootMintOf(runs: MemoryRunStore, runId: string) {
  const run = (await runs.findById(runId))!;
  return toRunResponse(viewOf(run)).lootMint;
}

describe('RunResponse.lootMint', () => {
  it('is null on a paid run, whose mint is part of its own settlement', async () => {
    // There is no second thing to report on: `reveal-and-resolve` transfers the
    // jackpot or mints the loot, and `verification.resolveTxId` already points at
    // it. A status block here would invite doubt about something already done.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'paid', { kind: 'loot' }, `0x${'b'.repeat(64)}`);

    expect(await lootMintOf(runs, runId)).toBeNull();
  });

  it('is null on a free run that drew nothing', async () => {
    // Nothing to mint, so nothing is owed and no ceremony will ever run. A
    // `pending` here would be a spinner for an item that does not exist.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'none' });

    expect(await lootMintOf(runs, runId)).toBeNull();
  });

  it('is pending before the ceremony has started', async () => {
    // The state every free drop passes through, between the fight resolving and
    // the worker's next pass. No txid yet because nothing has been broadcast.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });

    expect(await lootMintOf(runs, runId)).toEqual({
      state: 'pending',
      txId: null,
      tokenId: null,
      failedReason: null,
    });
  });

  it('is still pending once the mint is broadcast but not yet read back', async () => {
    // The case this whole field exists for. The ceremony has resolved, a txid
    // exists, and the NFT may or may not — the node accepted a transaction, which
    // is not the same as the contract accepting it. Calling this `minted` would
    // reintroduce exactly the claim `verifySettlements` was written to catch.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });
    await runs.updateLootMint(runId, {
      chainRunId: '4242',
      enterTxId: `0x${'1'.repeat(64)}`,
      commitTxId: `0x${'2'.repeat(64)}`,
      resolveTxId: `0x${'3'.repeat(64)}`,
    });

    const mint = await lootMintOf(runs, runId);
    expect(mint?.state).toBe('pending');
    // The txid is published even so — a player can watch it confirm themselves,
    // which is a better answer than being told to wait.
    expect(mint?.txId).toBe(`0x${'3'.repeat(64)}`);
    expect(mint?.tokenId).toBeNull();
  });

  it('is minted once the indexer has read a token id off the confirmed transaction', async () => {
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });
    await runs.updateLootMint(runId, {
      chainRunId: '4242',
      enterTxId: `0x${'1'.repeat(64)}`,
      commitTxId: `0x${'2'.repeat(64)}`,
      resolveTxId: `0x${'3'.repeat(64)}`,
    });
    await runs.setLootTokenId(runId, '88');

    expect(await lootMintOf(runs, runId)).toEqual({
      state: 'minted',
      txId: `0x${'3'.repeat(64)}`,
      tokenId: '88',
      failedReason: null,
    });
  });

  it('is failed when the worker parked the ceremony', async () => {
    // A parked ceremony never advances on its own — the worker stops considering
    // the run. Reporting it as pending would leave a player waiting on work
    // nobody is doing.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });
    await runs.updateLootMint(runId, {
      chainRunId: '4242',
      enterTxId: `0x${'1'.repeat(64)}`,
      failedReason: 'ENTER_ABORTED: entry aborted',
    });

    const mint = await lootMintOf(runs, runId);
    expect(mint?.state).toBe('failed');
    expect(mint?.failedReason).toBe('ENTER_ABORTED: entry aborted');
  });

  it('is failed when the chain refused a ceremony that was broadcast fine', async () => {
    // The other half of the same outcome, arriving from the other direction: the
    // worker did its job and the contract rejected the result, which only the
    // settlement verifier ever notices. Both mean the player is owed a drop they
    // do not have, so both read the same to a client.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });
    await runs.updateLootMint(runId, {
      chainRunId: '4242',
      enterTxId: `0x${'1'.repeat(64)}`,
      commitTxId: `0x${'2'.repeat(64)}`,
      resolveTxId: `0x${'3'.repeat(64)}`,
    });
    await runs.markSettlementVerified(runId, 'abort_by_response', new Date());

    const mint = await lootMintOf(runs, runId);
    expect(mint?.state).toBe('failed');
    expect(mint?.failedReason).toBe('abort_by_response');
  });

  it('stays minted when the settlement verifier confirms the transaction', async () => {
    // `markSettlementVerified` is called with a null reason on success. Reading
    // "verified" as a failure signal would flip every healthy mint to failed the
    // moment the indexer looked at it.
    const runs = new MemoryRunStore();
    const runId = await resolved(runs, 'free', { kind: 'loot' });
    await runs.updateLootMint(runId, {
      chainRunId: '4242',
      enterTxId: `0x${'1'.repeat(64)}`,
      commitTxId: `0x${'2'.repeat(64)}`,
      resolveTxId: `0x${'3'.repeat(64)}`,
    });
    await runs.setLootTokenId(runId, '88');
    await runs.markSettlementVerified(runId, null, new Date());

    expect((await lootMintOf(runs, runId))?.state).toBe('minted');
  });
});
