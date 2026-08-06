/**
 * /characters route tests.
 *
 * Two properties matter most here and both are anti-spoofing properties:
 *
 *   1. Stats are a function of the token's IDENTITY, so the same token always
 *      derives the same character no matter what its metadata says.
 *   2. Metadata can only nudge stats within a bounded range, so a holder who
 *      rewrites their token's JSON cannot field a god character.
 *
 * A third joined them with the curated-collection delta, and it is the one that
 * decides what a player even sees: eligibility is a hard filter. A token from
 * outside the eight listed collections is absent from the roster entirely — not
 * present with a generic class — so the "unlisted" cases below assert an empty
 * list rather than a fallback.
 *
 * The rest is plumbing: our own loot collection is not a character, upstream
 * failures surface honestly instead of as an empty roster, and the derivation
 * cache never gets to answer the ownership question.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CONTRACT_NAMES, STATS_ALGO_VERSION, deriveStats } from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { upstreamUnavailable, type ApiError } from '../src/lib/errors.js';
import type { ChainClient, ChainTransaction, NftHolding, TokenMetadata } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unsupportedChainWrites } from './helpers/chain.js';
import { CHARACTER_COLLECTION, UNLISTED_COLLECTION } from './helpers/collections.js';

const ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const DEVNET_DEPLOYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const LOOT_CONTRACT = `${DEVNET_DEPLOYER}.${CONTRACT_NAMES.characterLootNft}`;
/** A listed collection: these tokens are characters. */
const COLLECTION = CHARACTER_COLLECTION;

function holding(contractId: string, tokenId: string, assetName = 'nft'): NftHolding {
  return {
    assetIdentifier: `${contractId}::${assetName}`,
    contractId,
    assetName,
    tokenId,
    blockHeight: 1,
    txId: '0xabc',
  };
}

class FakeChain implements ChainClient {
  holdings: NftHolding[] = [];
  metadata = new Map<string, TokenMetadata>();
  holdingsError: Error | null = null;
  holdingsCalls = 0;
  /** Burn timestamp in unix SECONDS, keyed by block height. */
  blockTimes = new Map<number, number>();

  async getNftHoldings(): Promise<NftHolding[]> {
    this.holdingsCalls += 1;
    if (this.holdingsError) throw this.holdingsError;
    return this.holdings;
  }

  async getTokenMetadata(contractId: string, tokenId: string): Promise<TokenMetadata | null> {
    return this.metadata.get(`${contractId}/${tokenId}`) ?? null;
  }

  /** Unmapped heights read as unknown, i.e. Common — the documented fail direction. */
  async getBlockTimestamp(blockHeight: number): Promise<number | null> {
    return this.blockTimes.get(blockHeight) ?? null;
  }

  async getNftAcquisitionBlock(): Promise<number | null> {
    return null;
  }

  async callReadOnly(): Promise<never> {
    throw new Error('not used');
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
}

describe('GET /characters', () => {
  let app: FastifyInstance;
  let chain: FakeChain;

  beforeEach(async () => {
    chain = new FakeChain();
    app = await buildServer({
      chain,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'test-jwt-secret',
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (address: string) =>
    app.inject({ method: 'GET', url: `/characters?address=${encodeURIComponent(address)}` });

  it('derives a character for each held SIP-009 token', async () => {
    chain.holdings = [holding(COLLECTION, '1'), holding(COLLECTION, '2')];

    const res = await get(ADDRESS);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.address).toBe(ADDRESS);
    expect(body.characters).toHaveLength(2);

    const [first] = body.characters;
    expect(first.contractId).toBe(COLLECTION);
    expect(first.tokenId).toBe('1');
    expect(first.algoVersion).toBe(STATS_ALGO_VERSION);
    expect(first.stats).toEqual(deriveStats(COLLECTION, '1', null));
    expect(['warrior', 'paladin', 'rogue', 'mage']).toContain(first.charClass);
  });

  it('returns the same stats for the same token every time', async () => {
    chain.holdings = [holding(COLLECTION, '77')];

    const a = (await get(ADDRESS)).json().characters[0];
    const b = (await get(ADDRESS)).json().characters[0];
    expect(a).toEqual(b);
  });

  it('excludes our own loot collection — power-ups are items, not characters', async () => {
    chain.holdings = [
      holding(COLLECTION, '1'),
      holding(LOOT_CONTRACT, '5', 'grimhallow-loot'),
    ];

    const body = (await get(ADDRESS)).json();
    expect(body.characters).toHaveLength(1);
    expect(body.characters[0].contractId).toBe(COLLECTION);
  });

  it('omits an unlisted collection entirely rather than giving it a class', async () => {
    // The point of the curated-collection delta. Before it, this token came back
    // with a hashed class and `classSource: 'fallback_hash'`, which made every
    // NFT on Stacks a character and left the roster to a caller-side filter.
    chain.holdings = [holding(UNLISTED_COLLECTION, '1'), holding(COLLECTION, '2')];

    const body = (await get(ADDRESS)).json();
    expect(body.characters.map((c: { contractId: string }) => c.contractId)).toEqual([COLLECTION]);
  });

  it('returns an empty roster for a wallet holding nothing listed', async () => {
    // Empty, not an error: holding no characters is a normal thing to hold.
    chain.holdings = [holding(UNLISTED_COLLECTION, '1'), holding(UNLISTED_COLLECTION, '2')];

    const res = await get(ADDRESS);
    expect(res.statusCode).toBe(200);
    expect(res.json().characters).toEqual([]);
  });

  it('names only the two real derivation paths', async () => {
    chain.holdings = [holding(COLLECTION, '1')];
    const character = (await get(ADDRESS)).json().characters[0];
    expect(['supported_collection', 'mint']).toContain(character.classSource);
  });

  it('caps what metadata can add, so a rewritten JSON is not pay-to-win', async () => {
    // Same token, derived twice: once bare, once with absurd trait values.
    chain.holdings = [holding(COLLECTION, '42')];
    const bare = (await get(ADDRESS)).json().characters[0];

    chain.metadata.set(`${COLLECTION}/42`, {
      name: 'Definitely Legit',
      attributes: [
        { trait_type: 'str', value: 9999 },
        { trait_type: 'vit', value: 9999 },
        { trait_type: 'hp', value: 9999 },
        { trait_type: 'agi', value: 9999 },
        { trait_type: 'int', value: 9999 },
      ],
    });

    // Rebuild so the (address-independent) derivation runs again with metadata.
    const spoofed = (await app.inject({
      method: 'GET',
      url: `/characters?address=${ADDRESS}`,
    })).json().characters[0];

    // The bonus is bounded per stat (+4, and +20 HP), not multiplied by 9999.
    expect(spoofed.stats.str).toBeLessThanOrEqual(bare.stats.str + 4);
    expect(spoofed.stats.vit).toBeLessThanOrEqual(bare.stats.vit + 4);
    expect(spoofed.stats.agi).toBeLessThanOrEqual(bare.stats.agi + 4);
    expect(spoofed.stats.int).toBeLessThanOrEqual(bare.stats.int + 4);
    expect(spoofed.stats.hp).toBeLessThanOrEqual(bare.stats.hp + 20);
    // Class and rarity come from identity alone, so metadata cannot touch them.
    expect(spoofed.charClass).toBe(bare.charClass);
    expect(spoofed.rarity).toBe(bare.rarity);
  });

  it('uses metadata name and image when present', async () => {
    chain.holdings = [holding(COLLECTION, '9')];
    chain.metadata.set(`${COLLECTION}/9`, {
      name: 'Void Revenant',
      image: 'ipfs://QmExample/9.png',
    });

    const character = (await get(ADDRESS)).json().characters[0];
    expect(character.name).toBe('Void Revenant');
    // ipfs:// is not loadable by a browser, so it is rewritten to a gateway URL.
    expect(character.imageUrl).toBe('https://ipfs.io/ipfs/QmExample/9.png');
  });

  it('falls back to a readable name when metadata is missing', async () => {
    chain.holdings = [holding(COLLECTION, '404', 'explorer-guild')];
    const character = (await get(ADDRESS)).json().characters[0];
    expect(character.name).toBe('explorer guild #404');
    expect(character.imageUrl).toBeNull();
  });

  it('returns an empty roster for a wallet holding nothing', async () => {
    const body = (await get(ADDRESS)).json();
    expect(body.characters).toEqual([]);
  });

  it('rejects a missing or malformed address', async () => {
    const missing = await app.inject({ method: 'GET', url: '/characters' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('MISSING_ADDRESS');

    const malformed = await get('definitely-not-an-address');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('INVALID_ADDRESS');

    // A rejected request must not have cost an upstream call.
    expect(chain.holdingsCalls).toBe(0);
  });

  it('surfaces an upstream outage as 503 rather than an empty roster', async () => {
    // Showing "you own no characters" when Hiro is down would read as loss.
    chain.holdingsError = upstreamUnavailable('Stacks API unreachable') as ApiError;

    const res = await get(ADDRESS);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('re-reads ownership from chain on every request', async () => {
    // The derivation cache must never answer "who owns this?" — a sold token
    // has to disappear from the roster immediately.
    chain.holdings = [holding(COLLECTION, '1')];
    expect((await get(ADDRESS)).json().characters).toHaveLength(1);

    chain.holdings = [];
    expect((await get(ADDRESS)).json().characters).toHaveLength(0);
    expect(chain.holdingsCalls).toBe(2);
  });
});

/**
 * Rarity over the route, not just over the pure function.
 *
 * `packages/shared/test/rarity.test.ts` already pins the ladder itself. What
 * these add is that the wiring in between — holdings block → timestamp →
 * holdDays → tier → stat multiplier — survives a real request, and that the
 * derivation cache (keyed by token, with no owner column) cannot leak one
 * holder's tenure to the next. That last one is the correctness bar for the
 * whole feature (01-game-design.md#4b).
 */
describe('GET /characters — rarity from the current holder’s tenure', () => {
  let app: FastifyInstance;
  let chain: FakeChain;

  const BUYER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
  const DAY_MS = 86_400_000;

  /** A holding acquired `days` ago, with the matching block time registered. */
  function aged(tokenId: string, days: number, blockHeight: number): NftHolding {
    chain.blockTimes.set(blockHeight, Math.floor((Date.now() - days * DAY_MS) / 1000));
    return { ...holding(COLLECTION, tokenId), blockHeight };
  }

  beforeEach(async () => {
    chain = new FakeChain();
    app = await buildServer({
      chain,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: 'test-jwt-secret',
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (address: string) =>
    app.inject({ method: 'GET', url: `/characters?address=${encodeURIComponent(address)}` });

  it('reports the tier the hold duration earns', async () => {
    chain.holdings = [
      aged('1', 5, 1001),
      aged('2', 45, 1002),
      aged('3', 120, 1003),
      aged('4', 200, 1004),
      aged('5', 400, 1005),
      aged('6', 900, 1006),
    ];

    const characters = (await get(ADDRESS)).json().characters;
    expect(characters.map((c: { rarityTier: string }) => c.rarityTier)).toEqual([
      'common',
      'uncommon',
      'rare',
      'epic',
      'legendary',
      'mythic',
    ]);
    // holdDays is reported alongside so the UI can render a progress bar.
    expect(characters[1].holdDays).toBeGreaterThan(44);
    expect(characters[1].holdDays).toBeLessThan(46);
  });

  it('scales stats with the tier while leaving class alone', async () => {
    chain.holdings = [aged('77', 0, 2001)];
    const fresh = (await get(ADDRESS)).json().characters[0];

    chain.holdings = [aged('77', 900, 2002)];
    const seasoned = (await get(ADDRESS)).json().characters[0];

    expect(fresh.rarityTier).toBe('common');
    expect(seasoned.rarityTier).toBe('mythic');
    expect(seasoned.stats.hp).toBeGreaterThan(fresh.stats.hp);
    // Class is holder-independent — the same token is the same class forever.
    expect(seasoned.classId).toBe(fresh.classId);
    expect(seasoned.className).toBe(fresh.className);
  });

  it('gives a buyer none of the seller’s tenure — the transfer invariant', async () => {
    // The seller has held token 9 for two and a half years.
    chain.holdings = [aged('9', 900, 3001)];
    const seller = (await get(ADDRESS)).json().characters[0];
    expect(seller.rarityTier).toBe('mythic');

    // The sale. Same token, same contract, new wallet, new acquisition block.
    // The stats cache is keyed (contract, token) with no owner column, so if it
    // ever held rarity the buyer would inherit Mythic here.
    chain.holdings = [aged('9', 0, 3002)];
    const buyer = (await get(BUYER)).json().characters[0];

    expect(buyer.tokenId).toBe('9');
    expect(buyer.rarityTier).toBe('common');
    expect(buyer.holdDays).toBeLessThan(1);
    expect(buyer.stats.hp).toBeLessThan(seller.stats.hp);
    // Everything holder-independent came back identical — the cache did its job
    // on exactly the half of the record it is allowed to serve.
    expect(buyer.classId).toBe(seller.classId);
    expect(buyer.name).toBe(seller.name);
  });

  it('falls back to Common when the block time cannot be read', async () => {
    // Fail weaker, never stronger: an outage must not be a way to farm rarity.
    chain.holdings = [{ ...holding(COLLECTION, '12'), blockHeight: 9999 }]; // no time registered

    const character = (await get(ADDRESS)).json().characters[0];
    expect(character.rarityTier).toBe('common');
    expect(character.holdDays).toBe(0);
  });

  it('keeps the deprecated aliases in step with the fields that replaced them', async () => {
    // The frontend still reads charClass/rarity. They are aliases, never a
    // second derivation, so they can never disagree.
    chain.holdings = [aged('31', 400, 4001)];
    const character = (await get(ADDRESS)).json().characters[0];

    expect(character.charClass).toBe(character.classId);
    expect(character.rarity).toBe(character.rarityTier);
    expect(character.rarity).toBe('legendary');
  });
});
