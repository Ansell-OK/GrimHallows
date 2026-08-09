/**
 * Chain-client test doubles.
 *
 * `ChainClient` gained `getTransaction` and `broadcastRawTx` in Phase 5 and
 * `listContractCalls` in Phase 7, and most route tests have no business with any
 * of them. Rather than each fake growing stub methods that quietly return null
 * or an empty array, they mix in these — which throw.
 *
 * Throwing is the point. A read-path test that unexpectedly reaches a broadcast
 * should fail loudly and name the call, not proceed against a stub that
 * pretended a transaction went out. `listContractCalls` throws for the same
 * reason in reverse: an empty array is a *valid* answer meaning "this contract
 * has no history", so a route that started walking chain history by accident
 * would silently pass with an empty result instead of failing.
 *
 * `unresolvedMintBlock` is the exception that proves the rule — see its own note
 * for why a null there is a specified answer rather than an unstubbed call.
 */

import type { ChainClient, ChainTransaction, MintBlock } from '../../src/lib/hiro.js';
import { Cl, ClarityType, type ClarityValue } from '@stacks/transactions';

export interface ChainWriteStubs {
  getTransaction(txId: string): Promise<ChainTransaction | null>;
  broadcastRawTx(rawTxHex: string): Promise<string>;
  listContractCalls: ChainClient['listContractCalls'];
}

export function unsupportedChainWrites(): ChainWriteStubs {
  return {
    async getTransaction(txId: string): Promise<ChainTransaction | null> {
      throw new Error(`getTransaction(${txId}) is not stubbed for this test`);
    },
    async broadcastRawTx(_rawTxHex: string): Promise<string> {
      throw new Error('broadcastRawTx must never be called from a read-path test');
    },
    async listContractCalls(params): Promise<ChainTransaction[]> {
      throw new Error(`listContractCalls(${params.contractId}) is not stubbed for this test`);
    },
  };
}

/**
 * A mint-block lookup that never resolves one.
 *
 * Returns null rather than throwing, unlike the stubs above, because null is a
 * *specified* answer here and not a gap: it is the documented degrade for a mint
 * whose block the API cannot see yet, and it means "derive with no rarity floor"
 * (`stats.ts` `effectiveRarity`). So a test that reaches this gets a character at
 * its tenure tier — the same thing production serves in that situation — instead
 * of a fabricated floor that would move stats no test asked to move.
 *
 * A test that cares about the floor overrides it with a real block hash. That is
 * the only way a floor appears in a fixture, which is what keeps the ones that
 * don't mention rarity floors reading exactly as they did before stats-v4.
 */
export function unresolvedMintBlock(): Pick<ChainClient, 'getNftMintBlock'> {
  return {
    async getNftMintBlock(): Promise<MintBlock | null> {
      return null;
    },
  };
}

/**
 * A `game-core` that answers the two reads a paid quote makes.
 *
 * Both figures are settable and are deliberately kept as separate fields with
 * no arithmetic between them anywhere in this helper — the same separation the
 * contract enforces. A test that wants to prove a fee didn't reach the pool
 * reads `pool` before and after and expects the same number, which only means
 * something because nothing here could have moved it.
 */
export class FakeGameCore {
  gateFeeUstx = 1_000_000n;
  sponsorPoolUstx = 42_350_000n;
  active = true;
  seeded = true;
  error: Error | null = null;
  /** Every read-only function name called, in order. */
  readonly calls: string[] = [];

  async callReadOnly(params: { functionName: string }): Promise<ClarityValue> {
    this.calls.push(params.functionName);
    if (this.error) throw this.error;
    if (params.functionName === 'get-sponsor-pool') return Cl.uint(this.sponsorPoolUstx);
    if (params.functionName === 'get-dungeon') {
      if (!this.seeded) return Cl.none();
      return Cl.some(
        Cl.tuple({
          'gate-fee': Cl.uint(this.gateFeeUstx),
          'is-paid': Cl.bool(true),
          active: Cl.bool(this.active),
        }),
      );
    }
    throw new Error(`unexpected read-only call: ${params.functionName}`);
  }
}

/** Decode a Clarity uint answer from a fake, for assertions. */
export function asUint(value: ClarityValue): bigint {
  if (value.type !== ClarityType.UInt) throw new Error(`expected a uint, got ${value.type}`);
  return BigInt(value.value);
}
