/**
 * Holder-age service tests.
 *
 * The invariant under test is the one the whole rarity feature rests on: hold
 * duration is scoped to the CURRENT holder and resets on transfer
 * (01-game-design.md#4b). The end-to-end version of this runs against a real
 * devnet transfer; this is the unit-level version, which is what will catch a
 * regression on the day someone "optimises" the cache key.
 *
 * The second theme is that nothing here throws. Every upstream failure has to
 * land on `fallback_pending` with holdDays 0 — an underestimate, never an
 * exception, per 02-architecture.md#4.
 */

import { describe, it, expect } from 'vitest';
import { rarityFromHoldDays } from '@grimhallow/shared';
import type { ChainClient, NftHolding } from '../src/lib/hiro.js';
import type { HolderAgeEntry, HolderAgeRepo } from '../src/repos/holderAge.js';
import { HolderAgeService, holdingKey } from '../src/services/holderAgeService.js';

const COLLECTION = 'SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.some-collection';
const ALICE = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7';
const BOB = 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 0, 1);

function holding(overrides: Partial<NftHolding> = {}): NftHolding {
  return {
    assetIdentifier: `${COLLECTION}::some-nft`,
    contractId: COLLECTION,
    assetName: 'some-nft',
    tokenId: '1',
    blockHeight: 1000,
    txId: '0x' + 'ab'.repeat(32),
    ...overrides,
  };
}

/** In-memory repo with the same owner-scoped key the Postgres one uses. */
class FakeRepo implements HolderAgeRepo {
  readonly rows = new Map<string, HolderAgeEntry>();
  readonly blocks = new Map<number, number>();
  putCalls = 0;

  private key(owner: string, contractId: string, tokenId: string): string {
    return `${owner}|${contractId}|${tokenId}`;
  }

  async get(owner: string, contractId: string, tokenId: string): Promise<HolderAgeEntry | null> {
    return this.rows.get(this.key(owner, contractId, tokenId)) ?? null;
  }

  async put(entry: HolderAgeEntry): Promise<void> {
    this.putCalls++;
    this.rows.set(this.key(entry.ownerAddress, entry.contractId, entry.tokenId), entry);
  }

  async getBlockTimestamp(blockHeight: number): Promise<number | null> {
    return this.blocks.get(blockHeight) ?? null;
  }

  async putBlockTimestamp(blockHeight: number, unixSeconds: number): Promise<void> {
    this.blocks.set(blockHeight, unixSeconds);
  }
}

interface FakeChainOptions {
  blockTimes?: Record<number, number | null>;
  acquisitionBlock?: number | null;
  holdings?: NftHolding[];
  throwOn?: 'block' | 'history' | 'holdings';
}

function fakeChain(options: FakeChainOptions = {}): ChainClient & { blockCalls: number[] } {
  const blockCalls: number[] = [];
  return {
    blockCalls,
    async getNftHoldings(): Promise<NftHolding[]> {
      if (options.throwOn === 'holdings') throw new Error('hiro is down');
      return options.holdings ?? [];
    },
    async getBlockTimestamp(height: number): Promise<number | null> {
      blockCalls.push(height);
      if (options.throwOn === 'block') throw new Error('hiro is down');
      return options.blockTimes?.[height] ?? null;
    },
    async getNftAcquisitionBlock(): Promise<number | null> {
      if (options.throwOn === 'history') throw new Error('hiro is down');
      return options.acquisitionBlock ?? null;
    },
    // Tenure is the whole subject here and the rarity floor is a separate input,
    // so this fake never resolves one — see `unresolvedMintBlock` in
    // helpers/chain.ts for why null is an answer rather than a missing stub.
    async getNftMintBlock(): Promise<null> {
      return null;
    },
    async getTokenMetadata(): Promise<null> {
      return null;
    },
    async callReadOnly(): Promise<never> {
      throw new Error('not stubbed');
    },
    async getTransaction(): Promise<null> {
      return null;
    },
    async listContractCalls(): Promise<never[]> {
      return [];
    },
    async broadcastRawTx(): Promise<string> {
      throw new Error('not stubbed');
    },
  };
}

/** A block whose burn time is `days` before NOW. */
function blockAt(days: number): number {
  return Math.floor((NOW - days * DAY_MS) / 1000);
}

describe('the happy path uses the holdings block height', () => {
  it('reports hold days from the acquisition block’s timestamp', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ blockTimes: { 1000: blockAt(214) } });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forHolding(ALICE, holding(), NOW);

    expect(age.source).toBe('holdings_block_height');
    expect(age.holdDays).toBeCloseTo(214, 5);
    expect(rarityFromHoldDays(age.holdDays)).toBe('epic');
  });

  it('never asks Hiro for the same block twice', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ blockTimes: { 1000: blockAt(100) } });
    const service = new HolderAgeService({ chain, repo });

    // Twelve tokens bought in one transaction share one block.
    const batch = Array.from({ length: 12 }, (_, i) => holding({ tokenId: String(i) }));
    const ages = await service.forHoldings(ALICE, batch, NOW);

    expect(ages.size).toBe(12);
    expect(chain.blockCalls).toEqual([1000]);
    for (const age of ages.values()) expect(age.holdDays).toBeCloseTo(100, 5);
  });

  it('serves a second request from cache without touching the chain', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ blockTimes: { 1000: blockAt(45) } });
    const service = new HolderAgeService({ chain, repo });

    await service.forHolding(ALICE, holding(), NOW);
    const callsAfterFirst = chain.blockCalls.length;
    const second = await service.forHolding(ALICE, holding(), NOW);

    expect(chain.blockCalls.length).toBe(callsAfterFirst);
    expect(second.holdDays).toBeCloseTo(45, 5);
  });
});

describe('the clock resets on transfer — the correctness bar', () => {
  it('gives a new owner no cached tenure from the old one', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({
      // Alice has held since block 1000 (two years). The transfer to Bob lands
      // at block 9000, today.
      blockTimes: { 1000: blockAt(800), 9000: blockAt(0) },
    });
    const service = new HolderAgeService({ chain, repo });

    const aliceAge = await service.forHolding(ALICE, holding(), NOW);
    expect(rarityFromHoldDays(aliceAge.holdDays)).toBe('mythic');

    // The transfer. Bob's holdings entry carries the transfer's block, and the
    // cache key includes the owner, so Alice's row is simply not consulted.
    const bobAge = await service.forHolding(BOB, holding({ blockHeight: 9000 }), NOW);

    expect(bobAge.holdDays).toBeCloseTo(0, 5);
    expect(rarityFromHoldDays(bobAge.holdDays)).toBe('common');
    // Alice's row still exists and is still hers — unreachable, not wrong.
    expect(repo.rows.size).toBe(2);
  });

  it('does not let a re-buy reclaim the tenure that was sold away', async () => {
    // The history fallback must take the MOST RECENT acquiring event. Hiro
    // returns newest-first and the client takes the first match, so this pins
    // that the service asks for the acquisition block rather than a mint block.
    const repo = new FakeRepo();
    const chain = fakeChain({
      acquisitionBlock: 9000,
      blockTimes: { 9000: blockAt(3), 1000: blockAt(800) },
    });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forHolding(ALICE, holding({ blockHeight: null }), NOW);

    expect(age.source).toBe('history_fallback');
    expect(age.holdDays).toBeCloseTo(3, 5);
    expect(rarityFromHoldDays(age.holdDays)).toBe('common');
  });
});

describe('the history fallback', () => {
  it('is used when the holdings entry has no block height', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ acquisitionBlock: 4242, blockTimes: { 4242: blockAt(95) } });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forHolding(ALICE, holding({ blockHeight: null }), NOW);

    expect(age.source).toBe('history_fallback');
    expect(rarityFromHoldDays(age.holdDays)).toBe('rare');
  });

  it('degrades to pending when no acquiring event is found', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ acquisitionBlock: null });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forHolding(ALICE, holding({ blockHeight: null }), NOW);

    expect(age).toEqual({ holdDays: 0, source: 'fallback_pending' });
  });
});

describe('nothing here throws (02-architecture.md#4)', () => {
  it('degrades a block-timestamp failure to pending', async () => {
    const repo = new FakeRepo();
    const service = new HolderAgeService({ chain: fakeChain({ throwOn: 'block' }), repo });

    const age = await service.forHolding(ALICE, holding(), NOW);

    expect(age).toEqual({ holdDays: 0, source: 'fallback_pending' });
  });

  it('degrades a history failure to pending', async () => {
    const repo = new FakeRepo();
    const service = new HolderAgeService({ chain: fakeChain({ throwOn: 'history' }), repo });

    const age = await service.forHolding(ALICE, holding({ blockHeight: null }), NOW);

    expect(age).toEqual({ holdDays: 0, source: 'fallback_pending' });
  });

  it('keeps a known block height even when its timestamp is unavailable', async () => {
    // So the retry only has to redo the cheap half.
    const repo = new FakeRepo();
    const service = new HolderAgeService({ chain: fakeChain({ blockTimes: {} }), repo });

    await service.forHolding(ALICE, holding(), NOW);

    const stored = [...repo.rows.values()][0];
    expect(stored.acquiredBlockHeight).toBe(1000);
    expect(stored.acquiredAtMs).toBeNull();
    expect(stored.source).toBe('fallback_pending');
  });

  it('survives a repo that is entirely broken', async () => {
    const broken: HolderAgeRepo = {
      async get() {
        throw new Error('db down');
      },
      async put() {
        throw new Error('db down');
      },
      async getBlockTimestamp() {
        throw new Error('db down');
      },
      async putBlockTimestamp() {
        throw new Error('db down');
      },
    };
    const chain = fakeChain({ blockTimes: { 1000: blockAt(365) } });
    const service = new HolderAgeService({ chain: chain, repo: broken });

    const age = await service.forHolding(ALICE, holding(), NOW);

    // No cache, but still the right answer straight from chain.
    expect(rarityFromHoldDays(age.holdDays)).toBe('legendary');
  });

  it('returns an entry for every holding even when they all fail', async () => {
    const repo = new FakeRepo();
    const service = new HolderAgeService({ chain: fakeChain({ throwOn: 'block' }), repo });

    const batch = Array.from({ length: 9 }, (_, i) => holding({ tokenId: String(i) }));
    const ages = await service.forHoldings(ALICE, batch, NOW);

    expect(ages.size).toBe(9);
    for (const h of batch) {
      expect(ages.get(holdingKey(h.contractId, h.tokenId))).toEqual({
        holdDays: 0,
        source: 'fallback_pending',
      });
    }
  });
});

describe('forToken (the combat path)', () => {
  it('reuses the row the character list already warmed', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ blockTimes: { 1000: blockAt(500) } });
    const service = new HolderAgeService({ chain, repo });

    await service.forHoldings(ALICE, [holding()], NOW);
    const age = await service.forToken(ALICE, COLLECTION, '1', NOW);

    expect(age.holdDays).toBeCloseTo(500, 5);
    expect(rarityFromHoldDays(age.holdDays)).toBe('legendary');
    // One write from the list; the combat read added none.
    expect(repo.putCalls).toBe(1);
  });

  it('falls back to a holdings fetch on a cold cache', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({
      holdings: [holding()],
      blockTimes: { 1000: blockAt(200) },
    });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forToken(ALICE, COLLECTION, '1', NOW);

    expect(rarityFromHoldDays(age.holdDays)).toBe('epic');
  });

  it('degrades when the wallet no longer holds the token', async () => {
    const repo = new FakeRepo();
    const service = new HolderAgeService({ chain: fakeChain({ holdings: [] }), repo });

    expect(await service.forToken(ALICE, COLLECTION, '1', NOW)).toEqual({
      holdDays: 0,
      source: 'fallback_pending',
    });
  });

  it('matches the contract id case-insensitively', async () => {
    const repo = new FakeRepo();
    const chain = fakeChain({ holdings: [holding()], blockTimes: { 1000: blockAt(40) } });
    const service = new HolderAgeService({ chain, repo });

    const age = await service.forToken(ALICE, COLLECTION.toUpperCase(), '1', NOW);

    expect(rarityFromHoldDays(age.holdDays)).toBe('uncommon');
  });
});
