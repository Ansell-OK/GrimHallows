/**
 * Test doubles for the two dependencies `buildServer` refuses to invent for
 * itself: the oracle signing key and the chain.
 *
 * `buildServer` throws rather than defaulting when `ORACLE_PRIVATE_KEY` is
 * missing (src/server.ts), which is the behaviour we want in production and an
 * obstacle in a test. The answer is to inject a signer rather than to weaken the
 * check — so every test here signs with a real key and produces attestations
 * that really verify, instead of a stub that returns a constant string and would
 * let a broken signature path pass.
 *
 * The key below is Clarinet's devnet `wallet_3` (contracts/settings/Devnet.toml),
 * published in that file and in every Clarinet install on earth. It is
 * deliberately NOT one of the keys the auth tests use as a player: the oracle
 * signing a run for an address it also plays as would hide a whole class of
 * confusion between the two roles.
 */

import { StacksOracleSigner, type OracleSigner } from '../../src/oracle/attestation.js';
import type { ChainClient, NftHolding, TokenMetadata } from '../../src/lib/hiro.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './chain.js';

/** Devnet `wallet_3`. Never used on testnet or mainnet, and worth nothing. */
export const TEST_ORACLE_KEY =
  '530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101';

export function testOracleSigner(): OracleSigner {
  return new StacksOracleSigner(TEST_ORACLE_KEY, 'devnet');
}

/**
 * A chain that answers nothing.
 *
 * Entry reads NFT metadata to derive stats, and a test that did not stub this
 * would reach the real Hiro API — slow, flaky, and quietly dependent on someone
 * else's uptime. Returning null exercises the path stats derivation already has
 * to handle anyway: metadata is a file on a server that may be gone.
 */
export function stubChain(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    async getNftHoldings(): Promise<NftHolding[]> {
      return [];
    },
    async getTokenMetadata(): Promise<TokenMetadata | null> {
      return null;
    },
    async getBlockTimestamp(): Promise<number | null> {
      return null;
    },
    async getNftAcquisitionBlock(): Promise<number | null> {
      return null;
    },
    async callReadOnly() {
      throw new Error('callReadOnly is not stubbed in this test');
    },
    ...unsupportedChainWrites(),
    ...unresolvedMintBlock(),
    ...overrides,
  } as ChainClient;
}
