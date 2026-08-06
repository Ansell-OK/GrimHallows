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
    txStatus: 'success',
    txType: 'contract_call',
    senderAddress: STACKS.deployer,
    contractId: GAME_CORE_ID,
    functionName: 'reveal-and-resolve',
    functionArgsRepr: [],
    resultRepr: '(ok true)',
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
