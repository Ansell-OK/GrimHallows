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
 * Three contract calls: `commit-seed`, `reveal-and-resolve`, and — since docs/09
 * B7 — `enter-dungeon`, all against `game-core`. It cannot sign `fund-pool`
 * (owner-only, and the owner key lives elsewhere), cannot sign a transfer, and
 * cannot sign anything on behalf of a player.
 *
 * `enterFreeDungeon` is the narrow one. It exists because loot now drops on free
 * runs too, `character-loot-nft.mint` is reachable only through
 * `reveal-and-resolve`, and that only settles a run the chain already knows
 * about — so a free run's drop has to be escorted through a real on-chain run.
 * It is pinned to `FREE_DUNGEON_ID`, whose gate fee is zero and whose `is-paid`
 * is false, and it carries a Deny-mode post-condition set of `[]`. So it cannot
 * charge anyone, cannot touch the sponsor pool, and would abort if it tried.
 *
 * And it signs neither of them unless the contract's `oracle` var is this key —
 * see `assertIsContractOracle`. A key the contract does not recognise produces
 * transactions that broadcast cleanly and abort on chain, which is worse than a
 * refusal because the database records them as settled.
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
  FREE_DUNGEON_ID,
  REWARD_ALGO_VERSION,
  contractId as buildContractId,
  resolveFreeRunReward,
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
   * The contract's `oracle` var, once it has been confirmed to be this key.
   *
   * Only a *match* is remembered. Caching a mismatch would mean the operator
   * fixing it on chain does not take effect until someone redeploys the API,
   * which for a bug whose whole nature is "settlement silently stopped working"
   * is the wrong way round.
   */
  private confirmedOracle: string | null = null;

  /**
   * Refuse to sign unless the contract would actually accept the signature.
   *
   * `commit-seed` and `reveal-and-resolve` both assert `tx-sender == (var-get
   * oracle)`, and the var is initialised at deploy to the deployer — so a
   * backend rotated onto its own key (the reason ORACLE_PRIVATE_KEY is separate
   * from OWNER_PRIVATE_KEY at all) is rejected by the contract until `set-oracle`
   * has been called. `npm run set-oracle` is that call.
   *
   * WHY THIS IS A PRE-FLIGHT READ RATHER THAN ERROR HANDLING. There is no error
   * to handle. `broadcastTransaction` succeeds — the node accepts a
   * well-formed transaction from a funded account — and the assert fires later,
   * on chain, as `(err u201)`. Nothing re-reads it, so the run is written to
   * Postgres as resolved and only the explorer disagrees. On mainnet this ran for
   * six consecutive oracle transactions: three paid entries were charged, all
   * three aborted, and all three read as settled in the database.
   *
   * One read-only call per oracle transaction, against a var that changes about
   * never. That is cheap next to signing a transaction that cannot succeed, and
   * far cheaper than a settled-looking run nobody was actually paid for.
   */
  private async assertIsContractOracle(): Promise<void> {
    const mine = this.oracleAddress;
    if (this.confirmedOracle === mine) return;

    const value = await this.deps.chain.callReadOnly({
      contractId: this.gameCoreId,
      functionName: 'get-oracle',
    });
    const onChain =
      value.type === ClarityType.PrincipalStandard ||
      value.type === ClarityType.PrincipalContract
        ? value.value
        : null;

    if (onChain !== mine) {
      // 500, not 409: nothing the player did caused this and nothing they can do
      // clears it. The detail goes to the log, not to them.
      this.deps.log?.('ORACLE MISMATCH — refusing to sign; the contract would reject it', {
        contract: this.gameCoreId,
        contractOracle: onChain ?? `unreadable (${value.type})`,
        signingKeyIs: mine,
        action: 'run `npm run set-oracle -- --confirm` from the owner workstation',
      });
      throw new PaidOracleError(
        'ORACLE_MISMATCH',
        `${this.gameCoreId} accepts oracle calls from ${onChain ?? 'an unreadable principal'}, ` +
          `but this instance signs as ${mine}. Refusing to broadcast a transaction that would abort.`,
        500,
      );
    }

    this.confirmedOracle = mine;
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
   * Post `reveal-and-resolve` for a free run's loot ceremony.
   *
   * Deliberately NOT `resolveRun`. That method draws from the paid table, which
   * has a 1% jackpot branch and reads the sponsor pool — pointing it at a free
   * run would pay STX for an entry that paid no gate fee, the exact thing B7
   * keeps behind the fee. This draws with `resolveFreeRunReward`, which has no
   * jackpot branch and takes no pool balance, so the guarantee is structural
   * rather than a check someone has to remember.
   *
   * The reward is still not an argument, for the same reason it is not one on
   * `resolveRun`: a caller may ask for a run to be settled, never for a
   * particular outcome. Both paths re-derive from the seed.
   *
   * `combatOutcome` is fixed to `win`. Only a winning free run reaches here —
   * `resolveFreeRunReward` returns nothing on a loss, so a loss never gets a
   * loot row for the worker to pick up.
   *
   * The empty post-condition set under Deny mode is the enforcement that this
   * cannot pay STX even if the reward argument were somehow wrong: a jackpot
   * would move uSTX out of `game-core`, and an unlisted movement aborts.
   */
  async resolveFreeLootRun(params: {
    /** The chain-assigned run id from the ceremony's entry, not the DB run id. */
    readonly chainRunId: string;
    readonly seed: string;
  }): Promise<{ readonly resolveTxId: string; readonly reward: RewardResult }> {
    const seed = normalizeHash(params.seed);
    const reward = resolveFreeRunReward({ seed, combatOutcome: 'win' });

    if (reward.kind === 'jackpot' || reward.amountUstx !== null) {
      // Unreachable via `resolveFreeRunReward`. Kept because the cost of being
      // wrong is paying the pool out to a free entry, and an assert costs nothing.
      throw new PaidOracleError(
        'FREE_RUN_STX_REWARD',
        'Refusing to submit an STX reward for a run that paid no gate fee.',
        500,
      );
    }

    const txId = await this.signAndBroadcast({
      functionName: 'reveal-and-resolve',
      functionArgs: [
        Cl.uint(BigInt(params.chainRunId)),
        Cl.bufferFromHex(seed),
        Cl.stringAscii('win'),
        rewardToClarity(reward),
      ],
      postConditions: [],
    });

    this.deps.log?.('free-run loot minted on chain', {
      chainRunId: params.chainRunId,
      rewardKind: reward.kind,
      tier: reward.tier,
      txId,
    });

    return { resolveTxId: txId, reward };
  }

  /**
   * Enter the free dungeon as the oracle, to carry a free run's loot drop.
   *
   * The run this creates is a **mint vehicle, not a fairness record**. The fight
   * it stands for was already fought and already attested off-chain, against a
   * seed the player has been shown; nothing reads this chain run's outcome, and
   * the drop it mints was decided by `resolveFreeRunReward` before it existed.
   * What it buys is the only thing it can: a run id `reveal-and-resolve` will
   * accept, which is the sole route to `character-loot-nft.mint`.
   *
   * Pinned to `FREE_DUNGEON_ID` rather than taking a dungeon id, so no caller can
   * point this at the paid dungeon and have the oracle pay a gate fee. That
   * dungeon's fee is zero and `transfer-gate-fee` no-ops on `is-paid false`, so
   * the empty Deny-mode post-condition set below is a statement the chain
   * enforces: nothing moves.
   *
   * `party` is the player, so the mint inside the later resolve credits them.
   * Returns the txid only — the chain-assigned run id is in the return value of
   * a transaction that has not confirmed yet, and is read afterwards by
   * `readEnteredRunId`.
   */
  async enterFreeDungeon(params: { readonly player: string }): Promise<string> {
    const txId = await this.signAndBroadcast({
      functionName: 'enter-dungeon',
      functionArgs: [
        Cl.uint(BigInt(FREE_DUNGEON_ID)),
        Cl.list([Cl.principal(params.player)]),
      ],
      postConditions: [],
    });
    this.deps.log?.('free-run loot ceremony entered on chain', {
      dungeonId: FREE_DUNGEON_ID,
      player: params.player,
      txId,
    });
    return txId;
  }

  /**
   * The run id `enter-dungeon` assigned, read off a confirmed transaction.
   *
   * Null while the transaction is still pending — not an error, just "ask again
   * next pass". Throws if it confirmed as anything other than a success, because
   * a run id from an aborted entry would name a run that does not exist, and
   * committing against it would strand the ceremony.
   *
   * Read from `resultRepr` rather than the `run-entered` print: the return value
   * is what the contract promises the caller, and it is one `(ok uN)` rather than
   * a tuple whose field ordering could change under a redeploy.
   */
  async readEnteredRunId(txId: string): Promise<string | null> {
    const tx = await this.deps.chain.getTransaction(txId);
    if (!tx || tx.txStatus === 'pending') return null;

    if (tx.txStatus !== 'success') {
      throw new PaidOracleError(
        'ENTER_ABORTED',
        `enter-dungeon ${txId} confirmed as ${tx.txStatus}.`,
        502,
      );
    }

    const match = /^\(ok u(\d+)\)$/.exec((tx.resultRepr ?? '').trim());
    if (!match) {
      // A success whose result does not parse means the contract's return shape
      // moved. Guessing a run id here would commit a seed against someone else's
      // run, so this refuses instead.
      throw new PaidOracleError(
        'ENTER_RESULT_UNREADABLE',
        `enter-dungeon ${txId} succeeded but returned ${tx.resultRepr ?? 'nothing'}.`,
        502,
      );
    }
    return match[1];
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
    // Here rather than in the two callers: every oracle transaction goes through
    // this method, so the check cannot be forgotten by whatever calls it next.
    await this.assertIsContractOracle();

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
