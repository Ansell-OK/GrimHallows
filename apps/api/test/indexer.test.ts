/**
 * Indexer tests.
 *
 * The leaderboard is only "a verifiable index over chain history" if the
 * indexer's inputs really are chain history. So these tests are mostly about
 * what the indexer *refuses* to do:
 *
 *   - a failed forge transaction never becomes a forge
 *   - a print it cannot fully read never becomes a half-guessed row
 *   - running twice never doubles a count — the property that would otherwise
 *     let anyone climb the table by restarting the server
 *   - one job's outage never stops the others
 *   - a loot token id is written once and never rewritten
 *
 * The stores are the real in-memory implementations, not doubles, so the
 * aggregation being asserted is the same code the Postgres path mirrors.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cl, serializeCV, type ClarityValue } from '@stacks/transactions';
import { CONTRACT_NAMES, SCORE_WEIGHTS, getNetworkConfig } from '@grimhallow/shared';
import { Indexer } from '../src/indexer/indexer.js';
import { MemoryForgeHistoryStore } from '../src/repos/forgeHistory.js';
import { MemoryPlayerStatsStore } from '../src/repos/playerStats.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import type { ChainClient, ChainTransaction } from '../src/lib/hiro.js';
import type { ForgeService } from '../src/services/forgeService.js';
import { stubChain } from './helpers/oracle.js';

const STACKS = getNetworkConfig('devnet');
const FORGE_ID = `${STACKS.deployer}.${CONTRACT_NAMES.forge}`;
const GAME_CORE_ID = `${STACKS.deployer}.${CONTRACT_NAMES.gameCore}`;

const ALICE = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const BOB = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

const RECIPES = [
  {
    id: 1,
    inputTier: 1,
    inputTierName: 'rare',
    inputCount: 3,
    outputTier: 2,
    outputTierName: 'epic',
    outputUri: 'ipfs://2',
  },
  {
    id: 2,
    inputTier: 2,
    inputTierName: 'epic',
    inputCount: 3,
    outputTier: 3,
    outputTierName: 'mythic',
    outputUri: 'ipfs://3',
  },
];

/** A `ForgeService` reduced to the one method the indexer calls. */
function forgeServiceReturning(recipes: typeof RECIPES): ForgeService {
  return { listRecipes: async () => [...recipes] } as unknown as ForgeService;
}

function txId(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** A confirmed `forge` transaction carrying a well-formed `forged` print. */
function forgeTx(params: {
  n: number;
  forger: string;
  recipeId: number;
  mintedTokenId: number;
  status?: string;
  /** Overrides the print's fields; pass null to omit the print entirely. */
  print?: Record<string, ClarityValue> | null;
}): ChainTransaction {
  const tuple =
    params.print === null
      ? null
      : Cl.tuple({
          event: Cl.stringAscii('forged'),
          'recipe-id': Cl.uint(params.recipeId),
          forger: Cl.principal(params.forger),
          burned: Cl.list([Cl.uint(11), Cl.uint(12), Cl.uint(13)]),
          'token-id': Cl.uint(params.mintedTokenId),
          'output-tier': Cl.uint(2),
          ...(params.print ?? {}),
        });

  return {
    txId: txId(params.n),
    txStatus: params.status ?? 'success',
    txType: 'contract_call',
    senderAddress: params.forger,
    contractId: FORGE_ID,
    functionName: 'forge',
    functionArgsRepr: [`u${params.recipeId}`, '(list u11 u12 u13)'],
    resultRepr: `(ok u${params.mintedTokenId})`,
    events: tuple
      ? [
          {
            eventType: 'smart_contract_log',
            contractId: FORGE_ID,
            valueHex: `0x${serializeCV(tuple)}`,
            stxTransfer: null,
          },
        ]
      : [],
    blockHeight: 100 + params.n,
  };
}

/** A `reveal-and-resolve` transaction carrying a `loot-minted` print. */
function resolveTx(params: {
  n: number;
  runId: string;
  recipient: string;
  tokenId: number;
  status?: string;
  resultRepr?: string;
}): ChainTransaction {
  const tuple = Cl.tuple({
    event: Cl.stringAscii('loot-minted'),
    'run-id': Cl.uint(BigInt(params.runId)),
    recipient: Cl.principal(params.recipient),
    'token-id': Cl.uint(params.tokenId),
    tier: Cl.uint(1),
  });

  return {
    txId: txId(params.n),
    txStatus: params.status ?? 'success',
    txType: 'contract_call',
    senderAddress: STACKS.deployer,
    contractId: GAME_CORE_ID,
    functionName: 'reveal-and-resolve',
    functionArgsRepr: [],
    resultRepr: params.resultRepr ?? '(ok true)',
    events: [
      {
        eventType: 'smart_contract_log',
        contractId: GAME_CORE_ID,
        valueHex: `0x${serializeCV(tuple)}`,
        stxTransfer: null,
      },
    ],
    blockHeight: 200 + params.n,
  };
}

/**
 * A chain that serves a fixed set of transactions, newest first.
 *
 * `listContractCalls` honours the watermark exactly as `HiroChainClient` does —
 * stop at the first known txid — because the indexer's idempotence depends on
 * that contract, and a fake that ignored it would let a broken watermark pass.
 */
function chainWith(
  transactions: ChainTransaction[],
  counters?: { getTransaction: number },
): ChainClient {
  const byId = new Map(transactions.map((t) => [t.txId, t]));
  return stubChain({
    async listContractCalls(params) {
      const out: ChainTransaction[] = [];
      for (const tx of transactions) {
        if (params.stopAtTxIds?.has(tx.txId)) return out;
        if (params.functionName && tx.functionName !== params.functionName) continue;
        out.push(tx);
      }
      return out;
    },
    async getTransaction(id: string) {
      if (counters) counters.getTransaction += 1;
      return byId.get(id) ?? null;
    },
  });
}

interface Harness {
  indexer: Indexer;
  runs: MemoryRunStore;
  forgeHistory: MemoryForgeHistoryStore;
  playerStats: MemoryPlayerStatsStore;
  logs: string[];
}

function harness(chain: ChainClient, recipes = RECIPES): Harness {
  const runs = new MemoryRunStore();
  const forgeHistory = new MemoryForgeHistoryStore();
  const playerStats = new MemoryPlayerStatsStore(() => runs.all(), forgeHistory);
  const logs: string[] = [];
  const indexer = new Indexer({
    chain,
    stacks: STACKS,
    runs,
    forgeHistory,
    playerStats,
    forge: forgeServiceReturning(recipes),
    log: (message) => logs.push(message),
  });
  return { indexer, runs, forgeHistory, playerStats, logs };
}

/** A second indexer over the same stores, pointed at a different chain. */
function indexerOver(h: Harness, chain: ChainClient): Indexer {
  return new Indexer({
    chain,
    stacks: STACKS,
    runs: h.runs,
    forgeHistory: h.forgeHistory,
    playerStats: h.playerStats,
    forge: forgeServiceReturning(RECIPES),
  });
}

/** Drive a run all the way to resolved, the way the real flow does. */
async function resolvedRun(
  runs: MemoryRunStore,
  params: {
    address: string;
    type: 'free' | 'paid';
    outcome: 'win' | 'loss';
    reward?: {
      kind: 'jackpot' | 'loot' | 'none';
      amountUstx?: string | null;
      lootTokenId?: string | null;
      degraded?: boolean;
    };
    resolveTxId?: string | null;
  },
): Promise<string> {
  const character = { contractId: `${STACKS.deployer}.character-loot-nft`, tokenId: '1' };
  const run =
    params.type === 'free'
      ? await runs.createFreeRun({
          spawnId: 'spawn-1',
          partyId: null,
          createdBy: params.address,
          character,
        })
      : await runs.ingestPaidRun({
          id: String(700 + runs.all().length),
          dungeonId: 1,
          createdBy: params.address,
          character,
          feePaidUstx: '1000000',
          enterTxId: txId(900 + runs.all().length),
        });

  await runs.commit(run.id, {
    seedHash: 'hash',
    seed: 'seed',
    setup: { algoVersion: 'encounter-v1' } as never,
    commitSignature: null,
    oracleAddress: null,
    committedAt: new Date(),
  });

  await runs.resolve(run.id, {
    seedReveal: 'seed',
    combatOutcome: params.outcome,
    resolveSignature: null,
    reward: params.reward
      ? {
          kind: params.reward.kind,
          amountUstx: params.reward.amountUstx ?? null,
          lootTokenId: params.reward.lootTokenId ?? null,
          degraded: params.reward.degraded ?? false,
        }
      : null,
    resolveTxId: params.resolveTxId ?? null,
    resolvedAt: new Date(),
  });

  return run.id;
}

describe('indexer — forge history', () => {
  it('records a confirmed forge read off its print event', async () => {
    const h = harness(chainWith([forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50 })]));

    expect(await h.indexer.syncForges()).toBe(1);

    const [row] = await h.forgeHistory.list(null);
    expect(row.address).toBe(ALICE);
    expect(row.recipeId).toBe(1);
    expect(row.mintedTokenId).toBe('50');
    expect(row.burnedTokenIds).toEqual(['11', '12', '13']);
    expect(row.txId).toBe(txId(1));
  });

  /**
   * The single most important property in this file. A forge is user-signed and
   * read back off chain, so the only thing between "indexed fact" and "number
   * that grows when the server restarts" is idempotence.
   */
  it('records nothing new on a second pass', async () => {
    const h = harness(
      chainWith([
        forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50 }),
        forgeTx({ n: 2, forger: BOB, recipeId: 2, mintedTokenId: 51 }),
      ]),
    );

    expect(await h.indexer.syncForges()).toBe(2);
    expect(await h.indexer.syncForges()).toBe(0);
    expect(await h.indexer.syncForges()).toBe(0);
    expect(await h.forgeHistory.list(null)).toHaveLength(2);
  });

  it('stops walking at the watermark instead of re-reading known history', async () => {
    const counters = { getTransaction: 0 };
    const h = harness(
      chainWith(
        [
          forgeTx({ n: 3, forger: ALICE, recipeId: 1, mintedTokenId: 52 }),
          forgeTx({ n: 2, forger: ALICE, recipeId: 1, mintedTokenId: 51 }),
          forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50 }),
        ],
        counters,
      ),
    );

    await h.indexer.syncForges();
    expect(counters.getTransaction).toBe(3);

    // Second pass: the newest transaction is already known, so the walk stops
    // immediately and no transaction is re-read.
    await h.indexer.syncForges();
    expect(counters.getTransaction).toBe(3);
  });

  it('ignores a forge that did not succeed', async () => {
    const h = harness(
      chainWith([
        forgeTx({
          n: 1,
          forger: ALICE,
          recipeId: 1,
          mintedTokenId: 50,
          status: 'abort_by_post_condition',
        }),
      ]),
    );

    expect(await h.indexer.syncForges()).toBe(0);
    expect(await h.forgeHistory.list(null)).toEqual([]);
  });

  it('skips a transaction whose print is missing rather than inventing a row', async () => {
    const h = harness(
      chainWith([forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50, print: null })]),
    );

    expect(await h.indexer.syncForges()).toBe(0);
    expect(h.logs).toContain('skipping unreadable forge transaction');
  });

  it('skips a print with a malformed field rather than half-reading it', async () => {
    // A `token-id` that is not a uint. Recording the row anyway would put a
    // forge in history whose minted token is a guess.
    const h = harness(
      chainWith([
        forgeTx({
          n: 1,
          forger: ALICE,
          recipeId: 1,
          mintedTokenId: 50,
          print: { 'token-id': Cl.stringAscii('nope') },
        }),
      ]),
    );

    expect(await h.indexer.syncForges()).toBe(0);
    expect(await h.forgeHistory.list(null)).toEqual([]);
  });
});

describe('indexer — recipe mirror', () => {
  it('mirrors the ladder so a forge row can resolve its output tier', async () => {
    const h = harness(chainWith([forgeTx({ n: 1, forger: ALICE, recipeId: 2, mintedTokenId: 60 })]));

    await h.indexer.syncRecipes();
    await h.indexer.syncForges();

    const [row] = await h.forgeHistory.list(null);
    expect(row.outputTier).toBe(3);
  });

  it('leaves a forge visible with a null tier when its recipe is not mirrored', async () => {
    // The lookup is missing, not the forge. Dropping the row would make history
    // disappear because of a gap in a cache.
    const h = harness(chainWith([forgeTx({ n: 1, forger: ALICE, recipeId: 9, mintedTokenId: 60 })]));

    await h.indexer.syncRecipes();
    await h.indexer.syncForges();

    const [row] = await h.forgeHistory.list(null);
    expect(row.recipeId).toBe(9);
    expect(row.outputTier).toBeNull();
  });
});

describe('indexer — loot token id backfill', () => {
  let h: Harness;
  let runId: string;

  beforeEach(async () => {
    h = harness(chainWith([]));
    runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(500),
    });
  });

  it('fills the token id from the resolve transaction that minted it', async () => {
    const indexer = indexerOver(
      h,
      chainWith([resolveTx({ n: 500, runId, recipient: ALICE, tokenId: 77 })]),
    );

    expect(await indexer.backfillLoot()).toBe(1);
    expect((await h.runs.findById(runId))?.reward?.lootTokenId).toBe('77');
  });

  it('is write-once — a second pass does not rewrite an id already recorded', async () => {
    const indexer = indexerOver(
      h,
      chainWith([resolveTx({ n: 500, runId, recipient: ALICE, tokenId: 77 })]),
    );

    expect(await indexer.backfillLoot()).toBe(1);
    expect(await indexer.backfillLoot()).toBe(0);
    expect((await h.runs.findById(runId))?.reward?.lootTokenId).toBe('77');
  });

  it('leaves the id null when the resolve transaction is not yet visible', async () => {
    const indexer = indexerOver(h, chainWith([]));

    expect(await indexer.backfillLoot()).toBe(0);
    expect((await h.runs.findById(runId))?.reward?.lootTokenId).toBeNull();
  });

  it('refuses a print that names a different run', async () => {
    // The transaction was looked up *by* this run's own resolve txid, so a print
    // for another run means the txid on the row is wrong. Attaching the token
    // anyway would hide that.
    const indexer = indexerOver(
      h,
      chainWith([resolveTx({ n: 500, runId: '999999', recipient: ALICE, tokenId: 77 })]),
    );

    expect(await indexer.backfillLoot()).toBe(0);
    expect((await h.runs.findById(runId))?.reward?.lootTokenId).toBeNull();
  });

  /**
   * Free runs (docs/09 B7).
   *
   * Their drop is minted minutes later, by the loot minter's ceremony, under a
   * run id the chain assigned that has nothing to do with the row's own id. So
   * both the transaction to read and the id to match against come off `lootMint`
   * — and the failure mode being guarded is not a wrong token but no token at
   * all, since comparing two unrelated counters rejects every print forever.
   */
  describe('a free run, whose mint happened in a separate ceremony', () => {
    let freeRunId: string;

    beforeEach(async () => {
      freeRunId = await resolvedRun(h.runs, {
        address: BOB,
        type: 'free',
        outcome: 'win',
        reward: { kind: 'loot' },
        // No resolve txid: a free fight is settled by oracle signature, off chain.
      });
      await h.runs.updateLootMint(freeRunId, {
        chainRunId: '4242',
        enterTxId: txId(600),
        commitTxId: txId(601),
        resolveTxId: txId(602),
      });
    });

    it('fills the token id from the ceremony resolve, matched on the chain run id', async () => {
      const indexer = indexerOver(
        h,
        chainWith([resolveTx({ n: 602, runId: '4242', recipient: BOB, tokenId: 88 })]),
      );

      expect(await indexer.backfillLoot()).toBe(1);
      expect((await h.runs.findById(freeRunId))?.reward?.lootTokenId).toBe('88');
    });

    it('does not match the print against the database run id', async () => {
      // The two id spaces both look like small integers, so a print naming this
      // row's own id is the shape a conflation bug produces. It is not this
      // ceremony's mint and must not be attached.
      const indexer = indexerOver(
        h,
        chainWith([resolveTx({ n: 602, runId: freeRunId, recipient: BOB, tokenId: 88 })]),
      );

      expect(await indexer.backfillLoot()).toBe(0);
      expect((await h.runs.findById(freeRunId))?.reward?.lootTokenId).toBeNull();
    });

    it('waits rather than guessing while the ceremony is still under way', async () => {
      // A run part-way through the ceremony has an entry and a commit but no
      // mint. There is no transaction to read a token id off yet, and the next
      // pass — after the minter has advanced it — will find one.
      const midCeremony = await resolvedRun(h.runs, {
        address: BOB,
        type: 'free',
        outcome: 'win',
        reward: { kind: 'loot' },
      });
      await h.runs.updateLootMint(midCeremony, {
        chainRunId: '4243',
        enterTxId: txId(610),
        commitTxId: txId(611),
      });

      const indexer = indexerOver(h, chainWith([]));

      expect(await indexer.backfillLoot()).toBe(0);
      expect((await h.runs.findById(midCeremony))?.reward?.lootTokenId).toBeNull();
    });
  });
});

describe('indexer — settlement verification', () => {
  /**
   * WHAT THIS GROUP IS ABOUT. `resolve()` records a run as settled the moment
   * `broadcastTransaction` hands back a txid — and a txid only means the node
   * accepted a well-formed, funded transaction. A failed `asserts!` inside
   * `reveal-and-resolve` aborts it afterwards, on chain, and nothing looked
   * again. So `reward_kind = 'loot'` and an NFT that was never minted read
   * identically in Postgres.
   *
   * That shipped. On mainnet the contract's `oracle` var still named the deployer
   * while the backend signed as its own key, so every oracle transaction aborted
   * with `(err u201)` — three paid entries charged, all three recorded as
   * settled. This pass is what would have caught it.
   *
   * The load-bearing distinction below is between an abort and a pending
   * transaction. An abort is final and must be flagged; a pending one is
   * ordinary and must not be, because a slow settlement and a dead one look
   * identical until the chain decides.
   */

  /** An indexer over the harness's stores with a pinned clock and captured log details. */
  function verifier(h: Harness, chain: ChainClient, now?: Date) {
    const entries: { message: string; detail?: Record<string, unknown> }[] = [];
    const indexer = new Indexer({
      chain,
      stacks: STACKS,
      runs: h.runs,
      forgeHistory: h.forgeHistory,
      playerStats: h.playerStats,
      forge: forgeServiceReturning(RECIPES),
      log: (message, detail) => entries.push({ message, detail }),
      ...(now ? { now: () => now } : {}),
    });
    return { indexer, entries };
  }

  it('marks a settlement the chain confirmed', async () => {
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(500),
    });
    const { indexer } = verifier(
      h,
      chainWith([resolveTx({ n: 500, runId, recipient: ALICE, tokenId: 77 })]),
    );

    expect(await indexer.verifySettlements()).toEqual({ verified: 1, aborted: 0 });
    const run = await h.runs.findById(runId);
    expect(run?.settlementVerifiedAt).not.toBeNull();
    // Null reason is the positive result, not an absence of information.
    expect(run?.settlementAbortReason).toBeNull();
  });

  it('flags a settlement the chain refused, and records the status verbatim', async () => {
    // The mainnet bug, reproduced: broadcast accepted, `(err u201)` on chain,
    // database says the player won loot.
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(501),
    });
    const { indexer } = verifier(
      h,
      chainWith([
        resolveTx({
          n: 501,
          runId,
          recipient: ALICE,
          tokenId: 77,
          status: 'abort_by_response',
          resultRepr: '(err u201)',
        }),
      ]),
    );

    expect(await indexer.verifySettlements()).toEqual({ verified: 1, aborted: 1 });
    // The chain's own vocabulary, so an operator can search for the string the
    // explorer shows them rather than a translation of it.
    expect((await h.runs.findById(runId))?.settlementAbortReason).toBe('abort_by_response');
  });

  it('logs the Clarity error and the reward that does not exist', async () => {
    // `(err u201)` is ERR-NOT-ORACLE and names the assert that failed — the single
    // most useful field for working out why, and the one thing six aborted
    // mainnet transactions never put in a log.
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'jackpot', amountUstx: '5000000' },
      resolveTxId: txId(502),
    });
    const { indexer, entries } = verifier(
      h,
      chainWith([
        resolveTx({
          n: 502,
          runId,
          recipient: ALICE,
          tokenId: 1,
          status: 'abort_by_response',
          resultRepr: '(err u201)',
        }),
      ]),
    );

    await indexer.verifySettlements();

    const line = entries.find((e) => e.message.includes('SETTLEMENT ABORTED'));
    expect(line?.detail?.result).toBe('(err u201)');
    expect(line?.detail?.rewardKind).toBe('jackpot');
    expect(line?.detail?.rewardAmountUstx).toBe('5000000');
    expect(line?.detail?.createdBy).toBe(ALICE);
  });

  it('leaves a pending transaction unverified rather than guessing', async () => {
    // A settlement in the mempool is the normal case for the first minute of its
    // life. Marking it either way here would be inventing an answer the chain has
    // not given.
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(503),
    });
    const { indexer } = verifier(
      h,
      chainWith([
        resolveTx({ n: 503, runId, recipient: ALICE, tokenId: 77, status: 'pending' }),
      ]),
    );

    expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });
    const run = await h.runs.findById(runId);
    expect(run?.settlementVerifiedAt).toBeNull();
    expect(run?.settlementAbortReason).toBeNull();
  });

  it('says nothing about a transaction that has only just been broadcast', async () => {
    // Every settlement passes through "unconfirmed". Logging each one would bury
    // the aborts this job exists to surface.
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(504),
    });
    const { indexer, entries } = verifier(h, chainWith([]));

    await indexer.verifySettlements();
    expect(entries).toEqual([]);
  });

  it('reports a settlement still unconfirmed an hour later, without marking it failed', async () => {
    // A transaction the mempool dropped never confirms and never aborts — it just
    // stops existing. Nothing on chain will ever say so, which is why elapsed time
    // is the only signal, and why it produces a log line rather than a verdict.
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(505),
    });
    const twoHoursOn = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { indexer, entries } = verifier(h, chainWith([]), twoHoursOn);

    expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });

    const line = entries.find((e) => e.message.includes('still unconfirmed'));
    expect(line?.detail?.runId).toBe(runId);
    expect(line?.detail?.known).toBe(false);
    // Still open, not closed as failed. The chain has not spoken.
    expect((await h.runs.findById(runId))?.settlementVerifiedAt).toBeNull();
  });

  it('is write-once — a verified settlement is not re-read on the next pass', async () => {
    // A confirmed transaction is final, so a second look can only replace a real
    // answer with a worse one (a node that has since pruned it, say).
    const h = harness(chainWith([]));
    const runId = await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot' },
      resolveTxId: txId(506),
    });
    const counters = { getTransaction: 0 };
    const chain = chainWith(
      [resolveTx({ n: 506, runId, recipient: ALICE, tokenId: 77 })],
      counters,
    );
    const { indexer } = verifier(h, chain);

    expect(await indexer.verifySettlements()).toEqual({ verified: 1, aborted: 0 });
    expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });
    expect(counters.getTransaction).toBe(1);
  });

  it('ignores a free run with no drop to mint', async () => {
    // A free fight settles by oracle signature, and one that drew nothing has no
    // transaction anywhere. Selecting it would be work that can never complete.
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });
    const { indexer } = verifier(h, chainWith([]));

    expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });
  });

  /**
   * Free-run loot mints (docs/09 B7).
   *
   * A free run has no `resolveTxId` — but a free run that drew loot has a mint
   * ceremony, and its `reveal-and-resolve` is the transaction that actually
   * creates the NFT. It can abort for every reason a paid settlement can.
   *
   * The hole this closes is exactly the one this whole group exists for, reopened
   * on the other path: `FreeRunLootMinter` records the ceremony's resolve txid the
   * moment the node accepts it and then stops considering the run, so if nothing
   * reads it back, an aborted ceremony leaves a row promising a drop and no token
   * — and nothing anywhere says so.
   */
  describe('a free run whose drop was minted by a separate ceremony', () => {
    /** A free run that drew loot, with its ceremony carried as far as `steps` says. */
    async function freeRunOwedLoot(
      h: Harness,
      steps: { enterTxId: string; commitTxId?: string; resolveTxId?: string },
    ) {
      const runId = await resolvedRun(h.runs, {
        address: BOB,
        type: 'free',
        outcome: 'win',
        reward: { kind: 'loot' },
      });
      await h.runs.updateLootMint(runId, { chainRunId: '4242', ...steps });
      return runId;
    }

    it('marks a ceremony the chain confirmed', async () => {
      const h = harness(chainWith([]));
      const runId = await freeRunOwedLoot(h, {
        enterTxId: txId(650),
        commitTxId: txId(651),
        resolveTxId: txId(652),
      });
      const { indexer } = verifier(
        h,
        chainWith([resolveTx({ n: 652, runId: '4242', recipient: BOB, tokenId: 88 })]),
      );

      expect(await indexer.verifySettlements()).toEqual({ verified: 1, aborted: 0 });
      expect((await h.runs.findById(runId))?.settlementAbortReason).toBeNull();
    });

    it('flags a ceremony the chain refused', async () => {
      // The player was shown a drop and the row still says loot. Without this the
      // only record that the NFT does not exist is the explorer.
      const h = harness(chainWith([]));
      const runId = await freeRunOwedLoot(h, {
        enterTxId: txId(653),
        commitTxId: txId(654),
        resolveTxId: txId(655),
      });
      const { indexer, entries } = verifier(
        h,
        chainWith([
          resolveTx({
            n: 655,
            runId: '4242',
            recipient: BOB,
            tokenId: 88,
            status: 'abort_by_response',
            resultRepr: '(err u201)',
          }),
        ]),
      );

      expect(await indexer.verifySettlements()).toEqual({ verified: 1, aborted: 1 });
      expect((await h.runs.findById(runId))?.settlementAbortReason).toBe('abort_by_response');

      const line = entries.find((e) => e.message.includes('SETTLEMENT ABORTED'));
      expect(line?.detail?.resolveTxId).toBe(txId(655));
      // Which path failed. A free run's abort means the mint ceremony broke, not
      // the fight, and the operator's next move is different.
      expect(line?.detail?.dungeonType).toBe('free');
    });

    it('leaves a ceremony still in the mempool alone', async () => {
      const h = harness(chainWith([]));
      const runId = await freeRunOwedLoot(h, {
        enterTxId: txId(656),
        commitTxId: txId(657),
        resolveTxId: txId(658),
      });
      const { indexer } = verifier(
        h,
        chainWith([
          resolveTx({ n: 658, runId: '4242', recipient: BOB, tokenId: 88, status: 'pending' }),
        ]),
      );

      expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });
      expect((await h.runs.findById(runId))?.settlementVerifiedAt).toBeNull();
    });

    it('does not read an entry transaction back as if it were the settlement', async () => {
      // A ceremony part-way along has an entry txid and no mint. That entry
      // confirms successfully — it is a `enter-dungeon` call and there is nothing
      // in it to fail — so a work list widened to any recorded txid would read it,
      // see `success`, and close the run as verified while the NFT was still
      // unminted. Which is worse than not looking at all: it turns an open item
      // into a settled one.
      const h = harness(chainWith([]));
      const runId = await freeRunOwedLoot(h, { enterTxId: txId(660), commitTxId: txId(661) });
      const { indexer } = verifier(
        h,
        chainWith([
          resolveTx({ n: 660, runId: '4242', recipient: BOB, tokenId: 88 }),
          resolveTx({ n: 661, runId: '4242', recipient: BOB, tokenId: 88 }),
        ]),
      );

      expect(await indexer.verifySettlements()).toEqual({ verified: 0, aborted: 0 });
      expect((await h.runs.findById(runId))?.settlementVerifiedAt).toBeNull();
    });
  });
});

describe('indexer — player stats', () => {
  it('credits a won free dungeon and a won paid dungeon at their own weights', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'none' },
    });

    expect(await h.indexer.recomputeStats()).toBe(1);

    const [row] = await h.playerStats.readTop(10);
    expect(row.address).toBe(ALICE);
    expect(row.freeDungeonsCompleted).toBe(1);
    expect(row.paidDungeonsCompleted).toBe(1);
    expect(row.score).toBe(SCORE_WEIGHTS.freeDungeon + SCORE_WEIGHTS.paidDungeon);
  });

  /**
   * A loss is not a completion (01-game-design.md#8, and `rewards.ts` reads the
   * same word the same way). It is also the only reading under which a paid
   * entry cannot buy rank, since the 1 STX is spent either way.
   */
  it('does not credit a lost run, paid or free', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'loss' });
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'loss',
      reward: { kind: 'none' },
    });

    await h.indexer.recomputeStats();
    expect(await h.playerStats.readTop(10)).toEqual([]);
  });

  it('does not credit a run that has not resolved', async () => {
    const h = harness(chainWith([]));
    await h.runs.createFreeRun({
      spawnId: 'spawn-1',
      partyId: null,
      createdBy: ALICE,
      character: null,
    });

    await h.indexer.recomputeStats();
    expect(await h.playerStats.readTop(10)).toEqual([]);
  });

  it('counts a paid jackpot', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'jackpot', amountUstx: '10000000' },
    });

    await h.indexer.recomputeStats();
    const [row] = await h.playerStats.readTop(10);
    expect(row.jackpotsWon).toBe(1);
    expect(row.score).toBe(SCORE_WEIGHTS.paidDungeon + SCORE_WEIGHTS.jackpot);
  });

  /**
   * A degraded jackpot was *paid as loot* — the pool could not cover it, so the
   * stored kind is `loot` and no jackpot STX left the pool. Counting it would
   * credit a payout that never happened.
   */
  it('does not count a degraded jackpot as a jackpot', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'loot', degraded: true },
    });

    await h.indexer.recomputeStats();
    const [row] = await h.playerStats.readTop(10);
    expect(row.jackpotsWon).toBe(0);
    // Still the completed dungeon it was.
    expect(row.paidDungeonsCompleted).toBe(1);
  });

  /**
   * No money reaches the score. Two players with identical run shapes and wildly
   * different payouts must rank identically — the counts are the only inputs the
   * scoring function accepts, and `reward_amount_ustx` is never read.
   */
  it('scores identically regardless of the STX a jackpot paid', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, {
      address: ALICE,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'jackpot', amountUstx: '1000000' },
    });
    await resolvedRun(h.runs, {
      address: BOB,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'jackpot', amountUstx: '900000000' },
    });

    await h.indexer.recomputeStats();
    const rows = await h.playerStats.readTop(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].score).toBe(rows[1].score);
  });

  it('scores the highest forge tier reached, not a count of forges', async () => {
    const h = harness(
      chainWith([
        forgeTx({ n: 1, forger: ALICE, recipeId: 2, mintedTokenId: 61 }),
        forgeTx({ n: 2, forger: ALICE, recipeId: 1, mintedTokenId: 60 }),
        forgeTx({ n: 3, forger: ALICE, recipeId: 1, mintedTokenId: 59 }),
      ]),
    );

    await h.indexer.runOnce();

    const [row] = await h.playerStats.readTop(10);
    // Three forges, tiers 3, 2, 2 — the score is one tier weight × 3, not × 7.
    expect(row.highestForgeTier).toBe(3);
    expect(row.score).toBe(3 * SCORE_WEIGHTS.forgeTier);
  });

  it('drops a player whose source rows are gone rather than leaving a stale rank', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });
    await h.indexer.recomputeStats();
    const ranked = await h.playerStats.readTop(10);
    expect(ranked).toHaveLength(1);

    // A store that now derives from nothing, seeded with the rank above.
    // `replaceAll` must prune, not merge.
    const empty = new MemoryPlayerStatsStore(() => [], h.forgeHistory);
    await empty.replaceAll(ranked);
    const indexer = new Indexer({
      chain: chainWith([]),
      stacks: STACKS,
      runs: h.runs,
      forgeHistory: h.forgeHistory,
      playerStats: empty,
      forge: forgeServiceReturning(RECIPES),
    });
    await indexer.recomputeStats();

    expect(await empty.readTop(10)).toEqual([]);
  });

  it('ranks best score first', async () => {
    const h = harness(chainWith([]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });
    await resolvedRun(h.runs, {
      address: BOB,
      type: 'paid',
      outcome: 'win',
      reward: { kind: 'jackpot', amountUstx: '10000000' },
    });

    await h.indexer.recomputeStats();
    const rows = await h.playerStats.readTop(10);
    expect(rows.map((r) => r.address)).toEqual([BOB, ALICE]);
  });
});

describe('indexer — a whole pass', () => {
  it('reports what each job did', async () => {
    const h = harness(chainWith([forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50 })]));
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });

    const report = await h.indexer.runOnce();
    expect(report.recipesMirrored).toBe(RECIPES.length);
    expect(report.forgesRecorded).toBe(1);
    expect(report.lootTokenIdsFilled).toBe(0);
    expect(report.playersRanked).toBe(1);
    expect(report.errors).toEqual([]);
  });

  /**
   * Hiro rate-limits and goes down. One job failing must not freeze the rest — a
   * 429 on the forge walk should not stop ranks being recomputed from runs this
   * backend already has.
   */
  it('keeps going when one job throws, and names the one that failed', async () => {
    const h = harness(
      stubChain({
        async listContractCalls() {
          throw new Error('429 Too Many Requests');
        },
      }),
    );
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });

    const report = await h.indexer.runOnce();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].job).toBe('syncForges');
    expect(report.errors[0].message).toContain('429');
    // The recompute still ran.
    expect(report.playersRanked).toBe(1);
    expect(await h.playerStats.readTop(10)).toHaveLength(1);
  });

  it('converges — running the same pass twice changes nothing', async () => {
    const h = harness(
      chainWith([
        forgeTx({ n: 1, forger: ALICE, recipeId: 1, mintedTokenId: 50 }),
        forgeTx({ n: 2, forger: BOB, recipeId: 2, mintedTokenId: 51 }),
      ]),
    );
    await resolvedRun(h.runs, { address: ALICE, type: 'free', outcome: 'win' });
    await resolvedRun(h.runs, { address: BOB, type: 'free', outcome: 'win' });

    await h.indexer.runOnce();
    const first = await h.playerStats.readTop(10);

    const second = await h.indexer.runOnce();
    expect(second.forgesRecorded).toBe(0);
    expect((await h.playerStats.readTop(10)).map((r) => [r.address, r.score])).toEqual(
      first.map((r) => [r.address, r.score]),
    );
  });
});
