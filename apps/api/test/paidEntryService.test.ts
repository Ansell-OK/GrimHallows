/**
 * Paid-entry service tests — Phase 5.
 *
 * The service reads every fact from chain, never from the claim. A client sends
 * a txid and nothing more; the run id, the payer, the dungeon, the fee and the
 * party all come back from `getTransaction`. These tests exist to keep it that
 * way, so they drive ingestion against a fake chain and assert on what the
 * service extracted rather than on what it was told.
 *
 * The one that matters most is the last group: THE FEE RECORDED IS THE STX THAT
 * MOVED, not the fee the contract printed. `transfer-gate-fee` skips the
 * transfer when the entrant is the contract owner, so an owner's own entry
 * prints a full gate fee and moves nothing. Recording the printed number there
 * would credit the operator with revenue that never left their wallet.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cl, serializeCV } from '@stacks/transactions';
import { PAID_DUNGEON_ID, type NetworkConfig } from '@grimhallow/shared';
import { PaidEntryService } from '../src/services/paidEntryService.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import { CombatService } from '../src/services/combatService.js';
import { RunOracle } from '../src/oracle/runOracle.js';
import { PaidRunOracle } from '../src/oracle/paidRunOracle.js';
import { stubChain, testOracleSigner } from './helpers/oracle.js';
import { characterRef } from './helpers/collections.js';
import type { ChainClient, ChainTransaction } from '../src/lib/hiro.js';
import { ApiError } from '../src/lib/errors.js';

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const DEPLOYER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const TX_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
/**
 * The same txid as it is stored.
 *
 * `normalizeTxId` strips the `0x` and lowercases, so a claim and the row it
 * created do not spell the txid the same way. Tests assert against this form
 * rather than the input, which is what keeps the idempotency lookup honest —
 * comparing the input to itself would pass even if the store keyed on nothing.
 */
const STORED_TX_ID = TX_ID.slice(2);
const COMMIT_TX_ID = '0x2222222222222222222222222222222222222222222222222222222222222222';

/** A listed collection, so building the setup derives a character. */
const CHARACTER = characterRef('42');

const STACKS: NetworkConfig = {
  network: 'devnet',
  deployer: DEPLOYER,
  apiUrl: 'http://localhost:3999',
  explorerUrl: 'http://localhost:8000',
};

const GAME_CORE = `${DEPLOYER}.game-core`;
const GATE_FEE = '1000000';

/**
 * A successful `enter-dungeon` transaction, overridable field by field.
 *
 * Every rejection test below is this fixture with exactly one thing wrong, so
 * what the test is actually about is the override and nothing else.
 */
function enterTx(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  return {
    txId: TX_ID,
    txStatus: 'success',
    txType: 'contract_call',
    senderAddress: PLAYER,
    contractId: GAME_CORE,
    functionName: 'enter-dungeon',
    functionArgsRepr: [`u${PAID_DUNGEON_ID}`, `(list '${PLAYER})`],
    resultRepr: '(ok u1)',
    events: [printEvent(GATE_FEE), transferEvent(GATE_FEE, PLAYER, DEPLOYER)],
    blockHeight: 12_345,
    ...overrides,
  };
}

/** The contract's `run-entered` print, carrying the fee it charged. */
function printEvent(gateFeeUstx: string) {
  return {
    eventType: 'smart_contract_log',
    contractId: GAME_CORE,
    valueHex: `0x${serializeCV(
      Cl.tuple({
        event: Cl.stringAscii('run-entered'),
        'run-id': Cl.uint(1),
        'gate-fee': Cl.uint(BigInt(gateFeeUstx)),
      }),
    )}`,
    stxTransfer: null,
  };
}

/** An STX movement — what the operator was actually paid. */
function transferEvent(amountUstx: string, sender: string, recipient: string) {
  return {
    eventType: 'stx_asset',
    contractId: null,
    valueHex: null,
    stxTransfer: { assetEventType: 'transfer', sender, recipient, amountUstx },
  };
}

/** A chain that returns one transaction and refuses every other call. */
function chainReturning(tx: ChainTransaction | null): ChainClient {
  return stubChain({
    async getTransaction() {
      return tx;
    },
  });
}

/**
 * A `PaidRunOracle` that records the commit instead of broadcasting one.
 *
 * The real one builds and signs a transaction, which needs a node to estimate
 * its fee — a dependency this file has no business on. Ingestion's contract with
 * the oracle is narrow (hand it a run id and a seed hash, get a txid back), so a
 * double honours it exactly and the tests stay about ingestion.
 */
class FakePaidOracle {
  readonly commits: { runId: string; seedHash: string }[] = [];
  error: Error | null = null;

  async commitSeed(args: { runId: string; seedHash: string }): Promise<string> {
    if (this.error) throw this.error;
    this.commits.push({ ...args });
    return COMMIT_TX_ID;
  }
}

function buildService(chain: ChainClient, runs = new MemoryRunStore()) {
  const oracle = new RunOracle({ runs, signer: testOracleSigner() });
  const paidOracle = new FakePaidOracle();
  const service = new PaidEntryService({
    chain,
    runs,
    oracle: paidOracle as unknown as PaidRunOracle,
    combat: new CombatService({ oracle, chain }),
    powerUps: { resolveEquippedTiers: async () => [] } as any,
    stacks: STACKS,
  });
  return { service, runs, paidOracle };
}

/** Run an ingest and return the ApiError it threw. Fails if it didn't throw. */
async function ingestError(chain: ChainClient, claimedBy = PLAYER): Promise<ApiError> {
  const { service } = buildService(chain);
  try {
    await service.verifyAndIngest({
      enterTxId: TX_ID,
      claimedBy,
      character: CHARACTER,
      powerUpTiers: [],
    });
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected verifyAndIngest to throw, but it resolved');
}

describe('PaidEntryService', () => {
  describe('a valid entry', () => {
    let runs: MemoryRunStore;
    let result: Awaited<ReturnType<PaidEntryService['verifyAndIngest']>>;

    beforeEach(async () => {
      const built = buildService(chainReturning(enterTx()));
      runs = built.runs;
      result = await built.service.verifyAndIngest({
        enterTxId: TX_ID,
        claimedBy: PLAYER,
        character: CHARACTER,
        powerUpTiers: [],
      });
    });

    it('takes the run id the contract assigned, not one of its own', () => {
      // `(ok u1)` — the chain's id. A backend-generated id would not match the
      // one `reveal-and-resolve` has to be called with.
      expect(result.run.id).toBe('1');
    });

    it('records the entry as paid and attributes it to the payer', () => {
      expect(result.run.dungeonType).toBe('paid');
      expect(result.run.createdBy).toBe(PLAYER);
      expect(result.run.enterTxId).toBe(STORED_TX_ID);
    });

    it('records the fee as revenue against the run', () => {
      expect(result.run.feePaidUstx).toBe(GATE_FEE);
    });

    it('commits the seed, so the run is playable', async () => {
      expect(result.run.state).toBe('committed');
      expect(result.run.seedHash).toBeTruthy();
      expect(result.run.commitTxId).toBe(COMMIT_TX_ID);
      expect(result.setup.party).toHaveLength(1);
      expect(result.setup.party[0]?.address).toBe(PLAYER);
    });

    it('does not reveal the seed at entry', () => {
      // The whole value of commit-reveal. A seed readable at entry is a run the
      // player can compute the outcome of before acting.
      expect(result.run.seedReveal).toBeNull();
    });

    it('is idempotent — a retried claim returns the same run', async () => {
      const { service } = buildService(chainReturning(enterTx()), runs);
      const again = await service.verifyAndIngest({
        enterTxId: TX_ID,
        claimedBy: PLAYER,
        character: CHARACTER,
        powerUpTiers: [],
      });

      expect(again.run.id).toBe(result.run.id);
      expect(again.run.seedHash).toBe(result.run.seedHash);
      // Two runs citing one payment would be one run nobody paid for.
      expect(await runs.findByEnterTxId(STORED_TX_ID)).not.toBeNull();
    });
  });

  describe('the fee recorded is the STX that moved', () => {
    it('records zero when the owner enters their own dungeon', async () => {
      // `transfer-gate-fee` skips the transfer when the entrant is the owner:
      // the print still announces the full gate fee, and no STX moves. This is
      // the case where trusting the print would invent revenue.
      const { service } = buildService(
        chainReturning(
          enterTx({
            senderAddress: DEPLOYER,
            functionArgsRepr: [`u${PAID_DUNGEON_ID}`, `(list '${DEPLOYER})`],
            events: [printEvent(GATE_FEE)],
          }),
        ),
      );

      const result = await service.verifyAndIngest({
        enterTxId: TX_ID,
        claimedBy: DEPLOYER,
        character: CHARACTER,
        powerUpTiers: [],
      });

      expect(result.run.feePaidUstx).toBe('0');
    });

    it('ignores STX that moved to anyone but the operator', async () => {
      // A transfer to a third party is not revenue. Only what reached the
      // deployer counts.
      const { service } = buildService(
        chainReturning(
          enterTx({
            events: [printEvent(GATE_FEE), transferEvent(GATE_FEE, PLAYER, PLAYER)],
          }),
        ),
      );

      const result = await service.verifyAndIngest({
        enterTxId: TX_ID,
        claimedBy: PLAYER,
        character: CHARACTER,
        powerUpTiers: [],
      });

      expect(result.run.feePaidUstx).toBe('0');
    });

    it('records what actually moved when it differs from what was printed', async () => {
      const { service } = buildService(
        chainReturning(
          enterTx({
            events: [printEvent('9999999'), transferEvent(GATE_FEE, PLAYER, DEPLOYER)],
          }),
        ),
      );

      const result = await service.verifyAndIngest({
        enterTxId: TX_ID,
        claimedBy: PLAYER,
        character: CHARACTER,
        powerUpTiers: [],
      });

      expect(result.run.feePaidUstx).toBe(GATE_FEE);
    });
  });

  describe('transient states are reported as retryable', () => {
    it('reports an unknown transaction as not yet confirmed', async () => {
      const err = await ingestError(chainReturning(null));
      expect(err.code).toBe('TX_NOT_CONFIRMED');
      expect(err.statusCode).toBe(409);
    });

    it('reports a mempool transaction as not yet confirmed, not as a failure', async () => {
      // A player who has already paid must not be told their entry died just
      // because it is still queued.
      const err = await ingestError(chainReturning(enterTx({ txStatus: 'pending' })));
      expect(err.code).toBe('TX_NOT_CONFIRMED');
    });

    it('reports a recorded but uncommitted run as retryable', async () => {
      const runs = new MemoryRunStore();
      await runs.ingestPaidRun({
        id: '1',
        dungeonId: PAID_DUNGEON_ID,
        createdBy: PLAYER,
        character: CHARACTER,
        feePaidUstx: GATE_FEE,
        enterTxId: STORED_TX_ID,
      });

      const { service } = buildService(chainReturning(enterTx()), runs);
      await expect(
        service.verifyAndIngest({
          enterTxId: TX_ID,
          claimedBy: PLAYER,
          character: CHARACTER,
        powerUpTiers: [],
        }),
      ).rejects.toMatchObject({ code: 'RUN_NOT_COMMITTED', statusCode: 409 });
    });
  });

  describe('refuses an entry it cannot verify', () => {
    it('refuses a failed transaction', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ txStatus: 'abort_by_post_condition' })),
      );
      expect(err.code).toBe('TX_NOT_SUCCESS');
    });

    it('refuses a transaction that is not a contract call', async () => {
      const err = await ingestError(chainReturning(enterTx({ txType: 'token_transfer' })));
      expect(err.code).toBe('TX_WRONG_TYPE');
    });

    it('refuses a call to a different contract', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ contractId: `${DEPLOYER}.not-game-core` })),
      );
      expect(err.code).toBe('TX_WRONG_CONTRACT');
    });

    it('refuses a call to a different function', async () => {
      const err = await ingestError(chainReturning(enterTx({ functionName: 'fund-pool' })));
      expect(err.code).toBe('TX_WRONG_FUNCTION');
    });

    it('refuses a result that is not (ok u<run-id>)', async () => {
      const err = await ingestError(chainReturning(enterTx({ resultRepr: '(err u101)' })));
      expect(err.code).toBe('UNEXPECTED_RESULT');
    });

    it('refuses a call with no arguments', async () => {
      const err = await ingestError(chainReturning(enterTx({ functionArgsRepr: [] })));
      expect(err.code).toBe('MISSING_DUNGEON_ARG');
    });

    it('refuses a dungeon id that is not a uint', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ functionArgsRepr: ['"one"', `(list '${PLAYER})`] })),
      );
      expect(err.code).toBe('MALFORMED_DUNGEON_ID');
    });

    it('refuses a transaction with no print event', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ events: [transferEvent(GATE_FEE, PLAYER, DEPLOYER)] })),
      );
      expect(err.code).toBe('MISSING_PRINT_EVENT');
    });

    it('refuses a print event it cannot parse', async () => {
      const err = await ingestError(
        chainReturning(
          enterTx({
            events: [
              { eventType: 'smart_contract_log', contractId: GAME_CORE, valueHex: '0xdead', stxTransfer: null },
            ],
          }),
        ),
      );
      expect(err.code).toBe('MALFORMED_EVENT');
    });

    it("refuses to let a stranger claim someone else's entry", async () => {
      // The one that would otherwise hand a paid run to whoever asked first.
      const err = await ingestError(chainReturning(enterTx()), DEPLOYER);
      expect(err.code).toBe('NOT_YOUR_ENTRY');
      expect(err.statusCode).toBe(403);
    });

    it('refuses a call with no party argument', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ functionArgsRepr: [`u${PAID_DUNGEON_ID}`] })),
      );
      expect(err.code).toBe('MISSING_PARTY_ARG');
    });

    it('refuses a party argument that is not a list of principals', async () => {
      const err = await ingestError(
        chainReturning(enterTx({ functionArgsRepr: [`u${PAID_DUNGEON_ID}`, 'u5'] })),
      );
      expect(err.code).toBe('MALFORMED_PARTY');
    });

    it('refuses a party naming someone other than the payer', async () => {
      const err = await ingestError(
        chainReturning(
          enterTx({ functionArgsRepr: [`u${PAID_DUNGEON_ID}`, `(list '${DEPLOYER})`] }),
        ),
      );
      expect(err.code).toBe('PARTY_MISMATCH');
    });

    it('writes no run when it refuses', async () => {
      const { service, runs } = buildService(chainReturning(enterTx({ txStatus: 'pending' })));
      await service
        .verifyAndIngest({
          enterTxId: TX_ID,
          claimedBy: PLAYER,
          character: CHARACTER,
          powerUpTiers: [],
        })
        .catch(() => undefined);

      // A refused claim that still wrote a row would be a run with no verified
      // payment behind it.
      expect(await runs.findByEnterTxId(STORED_TX_ID)).toBeNull();
    });
  });
});
