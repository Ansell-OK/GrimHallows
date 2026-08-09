/**
 * /forge route tests.
 *
 * GET is unauthenticated, and the tests assert why that is safe rather than
 * merely that it is the case: recipes are public chain state.
 *
 * POST is authenticated, and the tests assert why that changed. Since forge-v2
 * the payload carries an STX post-condition, and a post-condition has to name
 * the principal it binds. The only address worth pinning is the one the caller
 * authenticated as — taking it from the body would mean quoting a price to an
 * address we have no reason to believe in. It still signs nothing and custodies
 * nothing (02-architecture.md ground rule).
 *
 * The fee is read from chain on every build, never from
 * `FORGE_FEE_BY_OUTPUT_TIER`. A stale fee is not a cosmetic error: it produces a
 * post-condition that aborts the player's transaction after they signed it.
 *
 * The validation here is otherwise shape-only and deliberately so. It stops the
 * errors that would cost the player a network fee to discover, and stops short
 * of re-deciding whether the inputs satisfy the recipe — that is the contract's
 * job, and a second implementation of it would be free to drift.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, ClarityType, deserializeCV, type ClarityValue } from '@stacks/transactions';
import { buildServer } from '../src/server.js';
import { issueToken } from '../src/lib/jwt.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';
import { deserializePostCondition, type StxPostCondition } from './helpers/postConditions.js';

const JWT_SECRET = 'test-jwt-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const STRANGER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const RECIPE_FEE = 500_000n;

function recipe(fee: bigint = RECIPE_FEE): ClarityValue {
  return Cl.some(
    Cl.tuple({
      'input-tier': Cl.uint(1),
      'input-count': Cl.uint(3),
      'output-tier': Cl.uint(2),
      'output-uri': Cl.stringAscii('ipfs://epic'),
      'stx-fee': Cl.uint(fee),
    }),
  );
}

class FakeChain implements ChainClient {
  lastRecipeId: ClarityValue = Cl.uint(1);
  recipes = new Map<number, ClarityValue>([[1, recipe()]]);
  error: Error | null = null;

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
    functionName: string;
    functionArgsHex?: readonly string[];
  }): Promise<ClarityValue> {
    if (this.error) throw this.error;
    if (params.functionName === 'get-last-recipe-id') return this.lastRecipeId;
    if (params.functionName === 'get-recipe') {
      const arg = params.functionArgsHex?.[0];
      const cv = arg ? deserializeCV(arg) : null;
      const id = cv && cv.type === ClarityType.UInt ? Number(cv.value) : NaN;
      return this.recipes.get(id) ?? Cl.none();
    }
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
  getNftMintBlock: ChainClient['getNftMintBlock'] = unresolvedMintBlock().getNftMintBlock;
}

describe('/forge routes', () => {
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

  const post = (body: Record<string, unknown>, token: string | null = session) =>
    app.inject({
      method: 'POST',
      url: '/forge',
      payload: body,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });

  function onlyPostCondition(tx: { postConditions: string[] }): StxPostCondition {
    expect(tx.postConditions).toHaveLength(1);
    return deserializePostCondition(tx.postConditions[0]) as StxPostCondition;
  }

  describe('GET /forge/recipes', () => {
    it('mirrors the on-chain ladder', async () => {
      const res = await app.inject({ method: 'GET', url: '/forge/recipes' });
      expect(res.statusCode).toBe(200);

      const { recipes } = res.json();
      expect(recipes).toHaveLength(1);
      expect(recipes[0]).toMatchObject({ id: 1, inputTier: 1, inputCount: 3, outputTier: 2 });
    });

    it('publishes the fee the chain holds, as a string', async () => {
      const { recipes } = (await app.inject({ method: 'GET', url: '/forge/recipes' })).json();
      expect(recipes[0].stxFeeUstx).toBe('500000');
    });

    it('needs no session — recipes are public chain state', async () => {
      const res = await app.inject({ method: 'GET', url: '/forge/recipes' });
      expect(res.statusCode).toBe(200);
    });

    it('fails honestly rather than serving hardcoded recipes when the chain is down', async () => {
      // A ladder a player plans a burn against must come from chain or not at all.
      chain.error = new Error('node unreachable');

      const res = await app.inject({ method: 'GET', url: '/forge/recipes' });
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toContain('inputTier');
    });
  });

  describe('POST /forge', () => {
    it('returns an unsigned payload targeting forge-v2.forge', async () => {
      const res = await post({ recipeId: 1, tokenIds: [1, 2, 3] });
      expect(res.statusCode).toBe(200);

      const tx = res.json();
      expect(tx.contractName).toBe('forge-v2');
      expect(tx.functionName).toBe('forge');
      expect(tx.postConditionMode).toBe('deny');
    });

    it('requires a session, because the post-condition names a principal', async () => {
      const res = await post({ recipeId: 1, tokenIds: [1, 2, 3] }, null);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SESSION_INVALID');
    });

    it('rejects a forged or expired session', async () => {
      const forged = issueToken({ address: PLAYER, secret: 'wrong-secret', ttlSeconds: 3600 }).token;
      expect((await post({ recipeId: 1, tokenIds: [1, 2, 3] }, forged)).statusCode).toBe(401);
    });

    it('binds the fee to the session address, not to anything in the body', async () => {
      // The body is ignored as a source of identity. A caller who names someone
      // else gets a payload pinned to themselves.
      const tx = (
        await post({ recipeId: 1, tokenIds: [1, 2, 3], senderAddress: STRANGER })
      ).json();
      expect(onlyPostCondition(tx).address).toBe(PLAYER);
    });

    it('pins the exact fee the chain currently charges', async () => {
      chain.recipes.set(1, recipe(2_000_000n));

      const tx = (await post({ recipeId: 1, tokenIds: [1, 2, 3] })).json();
      const pc = onlyPostCondition(tx);

      expect(pc.condition).toBe('eq');
      expect(pc.amount).toBe('2000000');
      // Published alongside for display; the post-condition is what binds.
      expect(tx.feeUstx).toBe('2000000');
    });

    it('returns no signature and no key of any kind', async () => {
      // The ground rule in one assertion: the backend prepares, the wallet signs.
      const body = (await post({ recipeId: 1, tokenIds: [1, 2, 3] })).json();
      const serialized = JSON.stringify(body).toLowerCase();

      expect(serialized).not.toContain('signature');
      expect(serialized).not.toContain('privatekey');
      expect(serialized).not.toContain('senderkey');
      expect(serialized).not.toContain('txid');
    });

    it('never builds a sponsor-pool payload', async () => {
      // The forge fee is revenue, one hop to the operator. It must not be able
      // to reach the prize pool even by accident.
      const body = (await post({ recipeId: 1, tokenIds: [1, 2, 3] })).json();
      expect(JSON.stringify(body)).not.toContain('fund-pool');
      expect(JSON.stringify(body)).not.toContain('sponsor');
    });

    it('encodes the token ids the caller actually asked for', async () => {
      const tx = (await post({ recipeId: 1, tokenIds: [11, 22, 33] })).json();

      const ids = deserializeCV(tx.functionArgs[1]);
      expect(ids.type).toBe(ClarityType.List);
      const values = (ids as { value: { value: bigint }[] }).value.map((v) => BigInt(v.value));
      expect(values).toEqual([11n, 22n, 33n]);
    });

    it('accepts numeric token ids sent as strings', async () => {
      const res = await post({ recipeId: '1', tokenIds: ['1', '2', '3'] });
      expect(res.statusCode).toBe(200);
    });

    it('rejects a missing recipe id', async () => {
      const res = await post({ tokenIds: [1, 2, 3] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_RECIPE_ID');
    });

    it('rejects a non-positive recipe id', async () => {
      const res = await post({ recipeId: 0, tokenIds: [1, 2, 3] });
      expect(res.json().error.code).toBe('INVALID_RECIPE_ID');
    });

    it('rejects an empty token list', async () => {
      const res = await post({ recipeId: 1, tokenIds: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_TOKEN_IDS');
    });

    it('rejects a token list that is not an array', async () => {
      const res = await post({ recipeId: 1, tokenIds: 'nope' });
      expect(res.json().error.code).toBe('INVALID_TOKEN_IDS');
    });

    it('rejects a fractional token id', async () => {
      const res = await post({ recipeId: 1, tokenIds: [1, 2.5] });
      expect(res.json().error.code).toBe('INVALID_TOKEN_IDS');
    });

    it('rejects more tokens than the Clarity list accepts', async () => {
      // Caught here rather than on chain: the contract would reject it too, but
      // only after the player signed and paid a network fee.
      const res = await post({ recipeId: 1, tokenIds: [1, 2, 3, 4, 5, 6] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TOO_MANY_TOKENS');
    });

    it('rejects a duplicate token id', async () => {
      const res = await post({ recipeId: 1, tokenIds: [4, 4, 5] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DUPLICATE_TOKEN_IDS');
    });

    it('does not re-decide whether the inputs satisfy the recipe', async () => {
      // Inputs that plainly do not match recipe 1 (which burns 3) still build a
      // payload. The contract is the authority on this, and a backend that also
      // decided would be a second implementation of the same rule.
      const res = await post({ recipeId: 1, tokenIds: [1] });
      expect(res.statusCode).toBe(200);
    });

    it('refuses to build a payload for a recipe that does not exist', async () => {
      // Not a 200 with a guessed fee. There is no honest price for a rung the
      // chain does not have.
      const res = await post({ recipeId: 9, tokenIds: [1, 2, 3] });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.message).toMatch(/nothing was burned/i);
    });

    it('refuses to build a payload when the fee cannot be read', async () => {
      // This is the case that used to succeed. It must not: a payload built
      // without the chain's fee is a payload that aborts after signing.
      chain.error = new Error('node unreachable');

      const res = await post({ recipeId: 1, tokenIds: [1, 2, 3] });
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toContain('postConditions');
    });
  });
});
