/**
 * Paid-run settlement — the only module that signs with the oracle key.
 *
 * INTERNAL. No route imports this. It is reachable from `services/` and from the
 * admin surface, never from a player-facing handler, because it holds the key
 * that `reveal-and-resolve` accepts — the key that can move sponsor-pool funds
 * (04-backend-api-spec.md#5).
 *
 * WHAT THIS MODULE IS ALLOWED TO SIGN
 *
 * Exactly two contract calls: `commit-seed` and `reveal-and-resolve`, both
 * against `game-core`, both for a run the chain says exists. It cannot sign
 * `fund-pool` (owner-only, and the owner key lives elsewhere), cannot sign a
 * transfer, and cannot sign anything on behalf of a player.
 *
 * WHERE THE OUTCOME COMES FROM
 *
 * From a replay of the encounter, and from the reward table in
 * `@grimhallow/shared`. Never from an argument. A caller can ask this module to
 * settle a run; it cannot tell it what the run said. That distinction is the
 * whole reason `resolveRun` takes a run id and not a result.
 *
 * THE DEGRADE RULE (03-smart-contracts-spec.md#3)
 *
 * Before resolving, the live `get-sponsor-pool` balance is read from chain. A
 * rolled jackpot larger than that balance is degraded to a loot mint rather than
 * submitted — a submitted over-payout would revert, costing a fee and stranding
 * the run in `committed`. Each degrade is logged distinctly, because "the pool
 * needed topping up" is an operational signal, not a footnote.
 *
 * The contract's own revert-on-insufficient-pool check remains the hard backstop
 * (§3.3). Nothing here is trusted to be the thing preventing an over-payout.
 */

import {
  Cl,
  makeContractCall,
  broadcastTransaction,
  getAddressFromPrivateKey,
  PostConditionMode,
  Pc,
  type ClarityValue,
} from '@stacks/transactions';
import {
  DICE_ALGO_VERSION,
  REWARD_ALGO_VERSION,
  contractId as buildContractId,
  resolveReward,
  type CombatOutcome,
  type NetworkConfig,
  type RewardResult,
} from '@grimhallow/shared';
import { ClarityType } from '@stacks/transactions';
import type { ChainClient } from '../lib/hiro.js';

/** Raised when a paid run cannot be settled. Never surfaced to a player verbatim. */
export class PaidOracleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'PaidOracleError';
  }
}

export interface PaidOracleDeps {
  readonly chain: ChainClient;
  readonly stacks: NetworkConfig;
  /**
   * The oracle's private key.
   *
   * Injected rather than read from config here so tests can drive this module
   * with a throwaway key, and so the one place it is loaded stays
   * `config.loadOracleKey()` — grep-able, and separate from the owner key.
   */
  readonly oraclePrivateKey: string;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

/** What settling a run actually did on chain. */
export interface PaidResolution {
  readonly runId: string;
  readonly combatOutcome: CombatOutcome;
  readonly reward: RewardResult;
  /** Pool balance read immediately before deciding. Published for the audit log. */
  readonly sponsorPoolUstx: string;
  readonly resolveTxId: string;
  readonly rewardAlgoVersion: string;
}

/**
 * The wire-format network name.
 *
 * Devnet speaks the testnet format; only the API endpoint differs, which is why
 * `client.baseUrl` is always passed explicitly alongside this.
 */
type TxNetworkName = 'mainnet' | 'testnet';

function toTxNetwork(network: NetworkConfig['network']): TxNetworkName {
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

export class PaidRunOracle {
  constructor(private readonly deps: PaidOracleDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get oracleAddress(): string {
    return getAddressFromPrivateKey(
      this.deps.oraclePrivateKey,
      toTxNetwork(this.deps.stacks.network),
    );
  }

  private get gameCoreId(): string {
    return buildContractId(this.deps.stacks, 'gameCore');
  }

  /**
   * The live sponsor pool, in microSTX.
   *
   * Always read fresh at the moment of the decision. A cached balance would let
   * the degrade check disagree with the contract's own check, and the contract's
   * is the one that reverts.
   */
  async readSponsorPool(): Promise<bigint> {
    const value = await this.deps.chain.callReadOnly({
      contractId: this.gameCoreId,
      functionName: 'get-sponsor-pool',
    });
    if (value.type !== ClarityType.UInt) {
      throw new PaidOracleError(
        'POOL_READ_FAILED',
        `get-sponsor-pool returned ${value.type}, expected a uint`,
        502,
      );
    }
    return BigInt(value.value);
  }

  /**
   * Post `commit-seed` for a run the chain already knows about.
   *
   * The run id comes from `enter-dungeon`'s return value, read off a confirmed
   * transaction — never from a client. Committing against an id nobody paid for
   * would be signing a promise about a run that does not exist.
   */
  async commitSeed(params: {
    readonly runId: string;
    readonly seedHash: string;
  }): Promise<string> {
    const hash = normalizeHash(params.seedHash);
    const txId = await this.signAndBroadcast({
      functionName: 'commit-seed',
      functionArgs: [Cl.uint(BigInt(params.runId)), Cl.bufferFromHex(hash)],
      // Nothing moves. Deny mode with no conditions says exactly that: if this
      // call somehow transferred an asset, it would abort.
      postConditions: [],
    });
    this.deps.log?.('paid run seed committed on chain', {
      runId: params.runId,
      seedHash: hash,
      txId,
    });
    return txId;
  }

  /**
   * Decide the reward and post `reveal-and-resolve`.
   *
   * `combatOutcome` and `seed` come from the caller's replay of the encounter,
   * which is itself derived from this seed — the caller cannot choose them
   * freely, but this module does not verify that, so its callers must live
   * behind the same internal boundary. The *reward* is decided here, from the
   * shared table, and is not an input at all.
   */
  async resolveRun(params: {
    readonly runId: string;
    readonly seed: string;
    readonly combatOutcome: CombatOutcome;
    /** Party member 0 — who a loot mint is credited to, per game-core. */
    readonly lootRecipient: string;
  }): Promise<PaidResolution> {
    const seed = normalizeHash(params.seed);
    const sponsorPoolUstx = await this.readSponsorPool();

    const reward = resolveReward({
      seed,
      combatOutcome: params.combatOutcome,
      sponsorPoolUstx,
    });

    if (reward.degraded) {
      // Distinctly logged per 03-smart-contracts-spec.md#3.2 — this is the
      // operator's cue that the pool needs topping up, and it must not be
      // indistinguishable from an ordinary loot drop in the log.
      this.deps.log?.('REWARD DEGRADED — sponsor pool could not cover a rolled jackpot', {
        runId: params.runId,
        sponsorPoolUstx: sponsorPoolUstx.toString(),
        degradedToTier: reward.tier,
        action: 'call fund-pool to top up the prize budget',
      });
    }

    // Belt and braces on top of the shared table's own check. If these ever
    // disagree, refusing to sign is the correct failure: an attempted
    // over-payout burns a fee and leaves the run stuck in `committed`.
    if (reward.kind === 'jackpot' && BigInt(reward.amountUstx ?? '0') > sponsorPoolUstx) {
      throw new PaidOracleError(
        'JACKPOT_EXCEEDS_POOL',
        'Refusing to submit a jackpot larger than the sponsor pool.',
        500,
      );
    }

    const txId = await this.signAndBroadcast({
      functionName: 'reveal-and-resolve',
      functionArgs: [
        Cl.uint(BigInt(params.runId)),
        Cl.bufferFromHex(seed),
        Cl.stringAscii(params.combatOutcome),
        rewardToClarity(reward),
      ],
      // A jackpot moves STX *out of the contract*, so the post-condition is on
      // the contract principal, not on us. Pinned to the exact amount: if the
      // contract paid more than the table said, this aborts.
      postConditions:
        reward.kind === 'jackpot'
          ? [
              Pc.principal(this.gameCoreId)
                .willSendEq(BigInt(reward.amountUstx as string))
                .ustx(),
            ]
          : [],
    });

    this.deps.log?.('paid run resolved on chain', {
      runId: params.runId,
      outcome: params.combatOutcome,
      rewardKind: reward.kind,
      rewardAmountUstx: reward.amountUstx,
      degraded: reward.degraded,
      txId,
      resolvedAt: this.now().toISOString(),
    });

    return {
      runId: params.runId,
      combatOutcome: params.combatOutcome,
      reward,
      sponsorPoolUstx: sponsorPoolUstx.toString(),
      resolveTxId: txId,
      rewardAlgoVersion: `${REWARD_ALGO_VERSION}+${DICE_ALGO_VERSION}`,
    };
  }

  /**
   * Sign with the oracle key and broadcast.
   *
   * Private, and the only place in the codebase that turns the oracle key into a
   * signature. `PostConditionMode.Deny` everywhere: an unexpected asset movement
   * aborts rather than settling.
   */
  private async signAndBroadcast(params: {
    functionName: string;
    functionArgs: ClarityValue[];
    postConditions: Parameters<typeof makeContractCall>[0]['postConditions'];
  }): Promise<string> {
    const [contractAddress, contractName] = this.gameCoreId.split('.');
    const network = toTxNetwork(this.deps.stacks.network);

    const tx = await makeContractCall({
      contractAddress,
      contractName,
      functionName: params.functionName,
      functionArgs: params.functionArgs,
      senderKey: this.deps.oraclePrivateKey,
      network,
      client: { baseUrl: this.deps.stacks.apiUrl },
      postConditionMode: PostConditionMode.Deny,
      postConditions: params.postConditions,
    });

    const result = await broadcastTransaction({
      transaction: tx,
      network,
      client: { baseUrl: this.deps.stacks.apiUrl },
    });

    if (!('txid' in result) || 'error' in result) {
      const rejection = result as { error?: string; reason?: string };
      throw new PaidOracleError(
        'BROADCAST_FAILED',
        `${params.functionName} was rejected: ${rejection.reason ?? rejection.error ?? 'unknown'}`,
        502,
      );
    }
    return result.txid;
  }
}

/**
 * The `(optional {kind, amount, loot-uri, tier})` argument `reveal-and-resolve`
 * takes.
 *
 * `none` is passed as `none`, not as a tuple with kind `"none"`: the contract
 * treats an absent reward-roll and a present-but-empty one differently, and
 * sending a tuple would make a no-reward run indistinguishable on chain from one
 * where the table was consulted and paid nothing.
 */
export function rewardToClarity(reward: RewardResult): ClarityValue {
  if (reward.kind === 'none') return Cl.none();

  return Cl.some(
    Cl.tuple({
      kind: Cl.stringAscii(reward.kind),
      amount: reward.amountUstx ? Cl.some(Cl.uint(BigInt(reward.amountUstx))) : Cl.none(),
      'loot-uri': reward.lootUri ? Cl.some(Cl.stringAscii(reward.lootUri)) : Cl.none(),
      tier: reward.tier !== null ? Cl.some(Cl.uint(reward.tier)) : Cl.none(),
    }),
  );
}

/** 32-byte hex, `0x`-stripped and lowercased. Refuses anything else. */
function normalizeHash(value: string): string {
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new PaidOracleError('MALFORMED_HASH', `Expected 32 bytes of hex; got "${value}"`, 400);
  }
  return hex;
}
