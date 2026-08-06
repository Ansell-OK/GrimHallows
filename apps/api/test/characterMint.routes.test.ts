/**
 * /characters/mint route tests — the character shop.
 *
 * The mint is the third revenue line, and it is held to the same three rules as
 * the gate fee and the forge fee:
 *
 *   1. The price comes from chain on every request, never from
 *      `CHARACTER_MINT_PRICE_USTX`. That constant is what the deploy script
 *      *writes*; `mint-price` is what the contract *charges*, and the owner can
 *      change it without redeploying. A stale quote produces a post-condition
 *      that aborts the player's transaction after they signed it.
 *   2. The payment is buyer -> operator, one hop. Nothing in the payload may
 *      name the sponsor pool.
 *   3. The backend prepares; the wallet signs. No key, no signature, no txid.
 *
 * The fourth property is about honesty rather than money: the class the player
 * picks is written on chain in the same transaction and cannot be changed
 * afterwards, so an unknown class is rejected outright rather than coerced to a
 * default the player did not choose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, ClarityType, deserializeCV, type ClarityValue } from '@stacks/transactions';
import { CLASS_IDS, CONTRACT_NAMES } from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { issueToken } from '../src/lib/jwt.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unsupportedChainWrites } from './helpers/chain.js';
import { deserializePostCondition, type StxPostCondition } from './helpers/postConditions.js';

const JWT_SECRET = 'test-jwt-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const STRANGER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

class FakeChain implements ChainClient {
  mintPrice = 1_000_000n;
  paused = false;
  error: Error | null = null;
  /** Every read-only call, as `contractId::functionName`. */
  readonly calls: string[] = [];

  async getNftHoldings(): Promise<NftHolding[]> {
    return [];
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
    this.calls.push(`${params.contractId}::${params.functionName}`);
    if (this.error) throw this.error;
    if (params.functionName === 'get-mint-price') return Cl.uint(this.mintPrice);
    if (params.functionName === 'is-mint-paused') return Cl.bool(this.paused);
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
}

describe('/characters/mint', () => {
  let app: FastifyInstance;
  let chain: FakeChain;
  let session: string;

  beforeEach(async () => {
    chain = new FakeChain();
    app = await buildServer({
      chain,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    session = issueToken({ address: PLAYER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;
  });

  afterEach(async () => {
    await app.close();
  });

  const getShop = () => app.inject({ method: 'GET', url: '/characters/mint' });

  const post = (body: Record<string, unknown>, token: string | null = session) =>
    app.inject({
      method: 'POST',
      url: '/characters/mint',
      payload: body,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });

  function onlyPostCondition(tx: { postConditions: string[] }): StxPostCondition {
    expect(tx.postConditions).toHaveLength(1);
    return deserializePostCondition(tx.postConditions[0]) as StxPostCondition;
  }

  describe('GET /characters/mint', () => {
    it('quotes the price the contract currently charges', async () => {
      chain.mintPrice = 2_500_000n;

      const res = await getShop();
      expect(res.statusCode).toBe(200);
      // A string, not a number — uSTX is a Clarity uint and JSON loses precision
      // above 2^53, so every uSTX value crosses this boundary the same way.
      expect(res.json().priceUstx).toBe('2500000');
    });

    it('reads the price from character-nft, not from a constant', async () => {
      await getShop();
      expect(chain.calls.some((c) => c.endsWith(`.${CONTRACT_NAMES.characterNft}::get-mint-price`)))
        .toBe(true);
    });

    it('reports the owner’s pause switch', async () => {
      expect((await getShop()).json().paused).toBe(false);
      chain.paused = true;
      expect((await getShop()).json().paused).toBe(true);
    });

    it('publishes the same four classes the contract accepts', async () => {
      const { classes } = (await getShop()).json();
      expect(classes.map((c: { classId: string }) => c.classId)).toEqual([...CLASS_IDS]);
      // Each entry carries enough for a picker to render without hardcoding.
      for (const entry of classes) {
        expect(entry.name).toBeTruthy();
        expect(entry.blurb).toBeTruthy();
        expect(entry.emphasis.length).toBeGreaterThan(0);
      }
    });

    it('says plainly that this is a purchase, not a wager', async () => {
      // The same disclosure the paid dungeon carries, for the same reason: a
      // price that funded a prize pool or shifted odds would be a different
      // product with different rules attached to it.
      const { disclosure } = (await getShop()).json();
      expect(disclosure).toMatch(/not a wager/i);
      expect(disclosure).toMatch(/does not fund the prize pool/i);
      expect(disclosure).toMatch(/does not affect your odds/i);
    });

    it('needs no session — it is a price list', async () => {
      expect((await getShop()).statusCode).toBe(200);
    });

    it('fails honestly rather than quoting a guessed price', async () => {
      chain.error = new Error('node unreachable');

      const res = await getShop();
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toContain('priceUstx');
    });
  });

  describe('POST /characters/mint', () => {
    it('returns an unsigned payload targeting character-nft.mint-character', async () => {
      const res = await post({ classId: 'warrior' });
      expect(res.statusCode).toBe(200);

      const tx = res.json();
      expect(tx.contractName).toBe('character-nft');
      expect(tx.functionName).toBe('mint-character');
      expect(tx.postConditionMode).toBe('deny');
    });

    it('requires a session, because the post-condition names a principal', async () => {
      const res = await post({ classId: 'warrior' }, null);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SESSION_INVALID');
    });

    it('pins the session address sending exactly the live price', async () => {
      chain.mintPrice = 3_000_000n;

      const tx = (await post({ classId: 'mage' })).json();
      const pc = onlyPostCondition(tx);

      expect(pc.address).toBe(PLAYER);
      expect(pc.condition).toBe('eq');
      expect(pc.amount).toBe('3000000');
      expect(tx.priceUstx).toBe('3000000');
    });

    it('ignores an address in the body', async () => {
      const stranger = issueToken({
        address: STRANGER,
        secret: JWT_SECRET,
        ttlSeconds: 3600,
      }).token;

      const mine = (await post({ classId: 'rogue', senderAddress: STRANGER })).json();
      expect(onlyPostCondition(mine).address).toBe(PLAYER);

      const theirs = (await post({ classId: 'rogue' }, stranger)).json();
      expect(onlyPostCondition(theirs).address).toBe(STRANGER);
    });

    it('re-reads the price rather than trusting what the shop screen showed', async () => {
      // The client may have quoted an old price minutes ago. Building against
      // that number would abort on chain and cost the player a network fee.
      chain.mintPrice = 9_000_000n;
      expect(onlyPostCondition((await post({ classId: 'paladin' })).json()).amount).toBe('9000000');
    });

    it('encodes the class the player picked, as string-ascii', async () => {
      const tx = (await post({ classId: 'rogue' })).json();

      const classCv = deserializeCV(tx.functionArgs[0]);
      expect(classCv.type).toBe(ClarityType.StringASCII);
      expect((classCv as { value: string }).value).toBe('rogue');
    });

    it('rejects an unknown class rather than coercing it to a default', async () => {
      // The class is written on chain and cannot be changed afterwards, so a
      // silent substitution would hand the player a permanent character they
      // never asked for. The contract answers ERR-BAD-CLASS too; this is the
      // half that costs nothing.
      for (const bad of ['necromancer', 'Warrior', '', 42, null]) {
        const res = await post({ classId: bad });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_CLASS');
      }
    });

    it('refuses while the mint is paused, before the player signs anything', async () => {
      chain.paused = true;

      const res = await post({ classId: 'warrior' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('MINT_PAUSED');
      expect(res.json().error.message).toMatch(/nothing was charged/i);
    });

    it('refuses when the price cannot be read', async () => {
      chain.error = new Error('node unreachable');

      const res = await post({ classId: 'warrior' });
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toContain('postConditions');
    });

    it('never authorises a sponsor-pool payment', async () => {
      const body = JSON.stringify((await post({ classId: 'warrior' })).json());
      expect(body).not.toContain('fund-pool');
      expect(body).not.toContain('sponsor');
    });

    it('returns no signature and no key of any kind', async () => {
      const serialized = JSON.stringify((await post({ classId: 'warrior' })).json()).toLowerCase();
      expect(serialized).not.toContain('signature');
      expect(serialized).not.toContain('privatekey');
      expect(serialized).not.toContain('senderkey');
      expect(serialized).not.toContain('txid');
    });

    it('does not let the caller choose the metadata uri', async () => {
      // Harmless under the no-metadata-in-the-power-path rule — which is exactly
      // why a player-chosen URI is the first thing that would make breaking that
      // rule expensive. The server picks it.
      const tx = (await post({ classId: 'mage', metadataUri: 'https://evil.example/x.json' })).json();
      const uriCv = deserializeCV(tx.functionArgs[1]);
      expect((uriCv as { value: string }).value).not.toContain('evil.example');
      expect((uriCv as { value: string }).value).toContain('mage');
    });
  });
});
