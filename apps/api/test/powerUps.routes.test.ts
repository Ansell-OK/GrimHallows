/**
 * GET /characters/:contractId/:tokenId/power-ups route tests.
 *
 * The property under test is the one 01-game-design.md#6 makes non-negotiable:
 * a power-up's bonus keys off its ON-CHAIN tier, never off its metadata. The
 * test that matters most sets a metadata URI claiming legendary on a tier-1
 * token and asserts the response still describes a tier-1 bonus.
 *
 * The rest is the contract the frontend was built against: the character in the
 * path determines how the dice upgrade reads, and a malformed request costs no
 * upstream call.
 *
 * Since the curated-collection delta the character in the path must also be a
 * character — a token from an unlisted collection has no class, and the route
 * says so rather than describing a bonus against a made-up one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, ClarityType, type ClarityValue } from '@stacks/transactions';
import { CONTRACT_NAMES, deriveClass, getNetworkConfig } from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unsupportedChainWrites } from './helpers/chain.js';

const stacks = getNetworkConfig('devnet');
const LOOT_CONTRACT = `${stacks.deployer}.${CONTRACT_NAMES.characterLootNft}`;
/**
 * The character in the path. A real allowlisted collection, because since the
 * curated-collection delta an unlisted contract has no class and so nothing to
 * describe a power-up against — see the 404 case at the bottom.
 */
const COLLECTION = 'SP16SRR777TVB1WS5XSS9QT3YEZEC9JQFKYZENRAJ.bitcoin-pepe';
/** One collection per class, for the "same tier reads differently" case. */
const ONE_PER_CLASS = [
  'SP2RNHHQDTHGHPEVX83291K4AQZVGWEJ7WCQQDA9R.giga-pepe-v2',
  'SP16SRR777TVB1WS5XSS9QT3YEZEC9JQFKYZENRAJ.bitcoin-pepe',
  'SP2N959SER36FZ5QT1CX9BR63W3E8X35WQCMBYYWC.leo-cats',
  'SP1FEWH3946B7BYS9W1CVGSPC9FDKK5K32ZTBSVBB.smoke-ethereals',
] as const;
/** Not in the allowlist: not a playable character. */
const UNLISTED = 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.the-explorer-guild';
const ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

function lootHolding(tokenId: string): NftHolding {
  return {
    assetIdentifier: `${LOOT_CONTRACT}::grimhallow-loot`,
    contractId: LOOT_CONTRACT,
    assetName: 'grimhallow-loot',
    tokenId,
    blockHeight: 1,
    txId: '0xabc',
  };
}

function tokenIdFromArgs(argsHex: readonly string[] | undefined): string {
  const hex = argsHex?.[0];
  if (!hex) throw new Error('expected a serialized token id argument');
  const cv = Cl.deserialize(hex);
  if (cv.type !== ClarityType.UInt) throw new Error(`expected a uint arg, got ${cv.type}`);
  return String(cv.value);
}

class FakeChain implements ChainClient {
  holdings: NftHolding[] = [];
  /** On-chain tier, keyed by token id. This is the only source of a bonus. */
  tiers = new Map<string, number>();
  /** Metadata URI, keyed by token id. Flavour — must never affect a number. */
  uris = new Map<string, string>();
  holdingsCalls = 0;

  async getNftHoldings(): Promise<NftHolding[]> {
    this.holdingsCalls += 1;
    return this.holdings;
  }

  async getTokenMetadata(): Promise<null> {
    return null;
  }

  async getBlockTimestamp(): Promise<number | null> {
    return null;
  }

  async getNftAcquisitionBlock(): Promise<number | null> {
    return null;
  }

  async callReadOnly(params: {
    contractId: string;
    functionName: string;
    functionArgsHex?: readonly string[];
  }): Promise<ClarityValue> {
    const tokenId = tokenIdFromArgs(params.functionArgsHex);

    if (params.functionName === 'get-token-tier') {
      const tier = this.tiers.get(tokenId);
      return tier === undefined ? Cl.none() : Cl.some(Cl.uint(tier));
    }
    if (params.functionName === 'get-token-uri') {
      const uri = this.uris.get(tokenId);
      return Cl.ok(uri === undefined ? Cl.none() : Cl.some(Cl.stringAscii(uri)));
    }
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
}

describe('GET /characters/:contractId/:tokenId/power-ups', () => {
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

  const get = (opts: { contract?: string; tokenId?: string; address?: string | null } = {}) => {
    const contract = opts.contract ?? COLLECTION;
    const tokenId = opts.tokenId ?? '1';
    const query = opts.address === null ? '' : `?address=${encodeURIComponent(opts.address ?? ADDRESS)}`;
    return app.inject({
      method: 'GET',
      url: `/characters/${encodeURIComponent(contract)}/${tokenId}/power-ups${query}`,
    });
  };

  it('describes each held power-up against the character in the path', async () => {
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 2);

    const res = await get();
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.address).toBe(ADDRESS);
    expect(body.character).toMatchObject({ contractId: COLLECTION, tokenId: '1' });
    expect(body.character.charClass).toBe(deriveClass(COLLECTION, '1')!.classId);
    expect(body.powerUps).toHaveLength(1);
    expect(body.powerUps[0]).toMatchObject({ tokenId: '7', tier: 2 });
    expect(body.powerUps[0].summary).toBeTruthy();
  });

  it('keys the bonus off the on-chain tier, not the metadata URI', async () => {
    // The load-bearing assertion. Token 7 is tier 1 on chain, but its metadata
    // URI claims legendary. Rewriting a JSON file must not change a single die.
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 1);
    chain.uris.set('7', 'ipfs://legendary-tier-4-i-promise');

    const body = (await get()).json();

    expect(body.powerUps[0].tier).toBe(1);
    // Reported as flavour, and only as flavour.
    expect(body.powerUps[0].metadataUri).toBe('ipfs://legendary-tier-4-i-promise');
    expect(body.powerUps[0].summary).toBe(
      (await get()).json().powerUps[0].summary,
    );
  });

  it('renders the same tier differently against different characters', async () => {
    // A Warrior's Strike is 1d8 and a Rogue's is 1d6, so the same tier reads as
    // a different upgrade depending on who would equip it. The underlying bonus
    // is identical; only the rendering differs.
    //
    // Varies the *collection* rather than the token id: class is now a fact
    // about the contract, so all eight tokens of one collection would render
    // identically and prove nothing.
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 1);

    const seen = new Set<string>();
    for (const contract of ONE_PER_CLASS) {
      const body = (await get({ contract })).json();
      const bonus = body.powerUps[0]?.diceFormulaBonus;
      if (bonus) seen.add(bonus);
    }

    // Across the four classes there is more than one rendering of tier 1.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reads the same tier identically for two tokens of one collection', async () => {
    // The other half of the rule above: one collection is one class, so the
    // token id cannot change the rendering.
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 1);

    const first = (await get({ tokenId: '1' })).json();
    const later = (await get({ tokenId: '4096' })).json();
    expect(later.character.charClass).toBe(first.character.charClass);
    expect(later.powerUps[0].diceFormulaBonus).toBe(first.powerUps[0].diceFormulaBonus);
  });

  it('returns an empty list for a wallet holding no power-ups', async () => {
    chain.holdings = [];
    const body = (await get()).json();
    expect(body.powerUps).toEqual([]);
  });

  it('ignores holdings from other collections', async () => {
    chain.holdings = [
      lootHolding('7'),
      {
        assetIdentifier: `${COLLECTION}::nft`,
        contractId: COLLECTION,
        assetName: 'nft',
        tokenId: '99',
        blockHeight: 1,
        txId: '0xdef',
      },
    ];
    chain.tiers.set('7', 3);

    const body = (await get()).json();
    expect(body.powerUps).toHaveLength(1);
    expect(body.powerUps[0].contractId).toBe(LOOT_CONTRACT);
  });

  it('rejects a missing address without an upstream call', async () => {
    const res = await get({ address: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_ADDRESS');
    expect(chain.holdingsCalls).toBe(0);
  });

  it('rejects a malformed address', async () => {
    const res = await get({ address: 'definitely-not-an-address' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ADDRESS');
    expect(chain.holdingsCalls).toBe(0);
  });

  it('rejects a malformed contract id', async () => {
    const res = await get({ contract: 'no-dot-here' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CONTRACT_ID');
    expect(chain.holdingsCalls).toBe(0);
  });

  it('rejects a non-numeric token id', async () => {
    const res = await get({ tokenId: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TOKEN_ID');
    expect(chain.holdingsCalls).toBe(0);
  });

  it('refuses a character from an unlisted collection', async () => {
    // Well-formed and real, just not one of the eight. There is no class to
    // describe a bonus against, and inventing one is what the delta removed.
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 1);

    const res = await get({ contract: UNLISTED });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('UNSUPPORTED_COLLECTION');
    expect(res.json().error.message).toContain(UNLISTED);
  });

  it('re-reads holdings on every request', async () => {
    // A power-up that has been sold or forged away has to disappear at once.
    chain.holdings = [lootHolding('7')];
    chain.tiers.set('7', 1);
    expect((await get()).json().powerUps).toHaveLength(1);

    chain.holdings = [];
    expect((await get()).json().powerUps).toHaveLength(0);
    expect(chain.holdingsCalls).toBe(2);
  });
});
