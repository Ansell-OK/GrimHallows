/**
 * The pre-flight check that the contract will actually accept our signature.
 *
 * WHY THIS FILE IS SEPARATE from `paidRunOracle.test.ts`: that file replaces
 * `signAndBroadcast` on the instance, because what it tests is the reward
 * decision that precedes the signature. The guard lives *inside*
 * `signAndBroadcast`, so it can only be reached by letting that method run — and
 * letting it run means mocking the two @stacks/transactions calls that need a
 * node.
 *
 * WHAT IS BEING PREVENTED. `commit-seed` and `reveal-and-resolve` both assert
 * `tx-sender == (var-get oracle)`. Fail that assert and the transaction still
 * broadcasts fine — the node accepts a well-formed, funded transaction — and
 * aborts later, on chain, as `(err u201)`. Nothing in the request path re-reads
 * it, so the run is written to Postgres as resolved. This is not hypothetical:
 * it shipped to mainnet, where six consecutive oracle transactions aborted with
 * u201 while three paid entries were charged and recorded as settled.
 *
 * So the assertions that matter here are about a transaction NOT being built. A
 * thrown error alone would not prove it: `resolveRun` could just as well have
 * decided the reward, signed, broadcast, and thrown afterwards — which is the bug,
 * not the fix. Hence `makeContractCall` is a spy and the test reads its call count.
 *
 * THE MISMATCH IS NEVER CACHED, and that is a deliberate asymmetry. The operator
 * clears this by running `npm run set-oracle -- --confirm`, which changes a
 * contract var and nothing about the API. If a refusal were remembered, the fix
 * would not take effect until someone redeployed — for a bug whose whole
 * character is "settlement silently stopped working", the wrong way round.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const makeContractCall = vi.fn(async () => ({ mocked: 'transaction' }));
const broadcastTransaction = vi.fn(async () => ({ txid: 'abc123' }));

// Only the two calls that need a live node are replaced. `Cl`, `ClarityType`,
// `Pc`, `PostConditionMode` and `getAddressFromPrivateKey` stay real, so the
// address this instance signs as is really derived from the key.
vi.mock('@stacks/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stacks/transactions')>()),
  makeContractCall: (...args: unknown[]) => makeContractCall(...(args as [])),
  broadcastTransaction: (...args: unknown[]) => broadcastTransaction(...(args as [])),
}));

import { Cl } from '@stacks/transactions';
import type { NetworkConfig } from '@grimhallow/shared';
import { PaidRunOracle, PaidOracleError } from '../src/oracle/paidRunOracle.js';
import { stubChain, TEST_ORACLE_KEY } from './helpers/oracle.js';

const STACKS: NetworkConfig = {
  network: 'devnet',
  deployer: 'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0',
  apiUrl: 'http://localhost:3999',
  explorerUrl: 'http://localhost:8000',
};

/** What TEST_ORACLE_KEY (devnet wallet_3) derives to. The key the API signs as. */
const OURS = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
/** Some other principal — on mainnet this was the deployer, set at deploy time. */
const SOMEONE_ELSE = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

const SEED = 'a'.repeat(64);
const HASH = 'b'.repeat(64);

/**
 * An oracle whose chain answers `get-oracle` with `oracleVar`.
 *
 * `reads` records every read-only function asked for, which is how the caching
 * tests below distinguish "checked once" from "checked every time".
 */
function buildOracle(oracleVar: string | null) {
  const reads: string[] = [];
  const logs: { message: string; detail?: Record<string, unknown> }[] = [];

  const chain = stubChain({
    async callReadOnly(params: { functionName: string }) {
      reads.push(params.functionName);
      if (params.functionName === 'get-oracle') {
        // Null models an unreadable answer — a contract without the getter, or a
        // node returning something that is not a principal at all.
        return oracleVar === null ? Cl.uint(1) : Cl.standardPrincipal(oracleVar);
      }
      return Cl.uint(50_000_000);
    },
  });

  const oracle = new PaidRunOracle({
    chain,
    stacks: STACKS as unknown as NetworkConfig,
    oraclePrivateKey: TEST_ORACLE_KEY,
    log: (message, detail) => logs.push({ message, detail }),
  });

  return { oracle, reads, logs };
}

beforeEach(() => {
  makeContractCall.mockClear();
  broadcastTransaction.mockClear();
});

describe('the contract oracle matches the signing key', () => {
  it('signs the key it derives, and confirms that against the contract first', async () => {
    const { oracle, reads } = buildOracle(OURS);

    expect(oracle.oracleAddress).toBe(OURS);
    expect(await oracle.commitSeed({ runId: '1', seedHash: HASH })).toBe('abc123');
    // The check ran, and it ran before the transaction was built.
    expect(reads).toContain('get-oracle');
    expect(makeContractCall).toHaveBeenCalledTimes(1);
  });

  it('checks once and remembers the match, rather than re-reading per transaction', async () => {
    // The var changes about never. Paying a read per commit AND per resolve, for
    // every run, to re-learn the same answer is waste the cache exists to avoid.
    const { oracle, reads } = buildOracle(OURS);

    await oracle.commitSeed({ runId: '1', seedHash: HASH });
    await oracle.commitSeed({ runId: '2', seedHash: HASH });

    expect(reads.filter((r) => r === 'get-oracle')).toHaveLength(1);
  });
});

describe('a mismatched oracle is refused before anything is signed', () => {
  it('builds no transaction at all when the contract names someone else', async () => {
    const { oracle } = buildOracle(SOMEONE_ELSE);

    await expect(oracle.commitSeed({ runId: '1', seedHash: HASH })).rejects.toThrow(
      PaidOracleError,
    );
    // The assertion the whole file exists for. Throwing after a broadcast would
    // be the mainnet bug reproduced, not fixed.
    expect(makeContractCall).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('refuses a resolve too, not just a commit', async () => {
    // Both oracle entrypoints assert the same thing on chain, so both must be
    // guarded. The guard sits in the method they share for exactly this reason.
    const { oracle } = buildOracle(SOMEONE_ELSE);

    await expect(
      oracle.resolveRun({
        runId: '1',
        seed: SEED,
        combatOutcome: 'win',
        lootRecipient: SOMEONE_ELSE,
      }),
    ).rejects.toThrow(/Refusing to broadcast/);
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('reports ORACLE_MISMATCH as a 500, because no player caused it', async () => {
    // A player retrying cannot clear this, so it must not read as a conflict they
    // could resolve by trying again.
    const { oracle } = buildOracle(SOMEONE_ELSE);

    const err = await oracle.commitSeed({ runId: '1', seedHash: HASH }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PaidOracleError);
    expect((err as InstanceType<typeof PaidOracleError>).code).toBe('ORACLE_MISMATCH');
    expect((err as InstanceType<typeof PaidOracleError>).status).toBe(500);
  });

  it('names both principals and the fix in the log, not in the error', async () => {
    // The operator needs to know which key to install; the player needs none of
    // it. Six aborted mainnet transactions produced no log line saying this.
    const { oracle, logs } = buildOracle(SOMEONE_ELSE);

    await oracle.commitSeed({ runId: '1', seedHash: HASH }).catch(() => undefined);

    const line = logs.find((l) => l.message.includes('ORACLE MISMATCH'));
    expect(line).toBeDefined();
    expect(line?.detail?.contractOracle).toBe(SOMEONE_ELSE);
    expect(line?.detail?.signingKeyIs).toBe(OURS);
    expect(line?.detail?.action).toContain('set-oracle');
  });

  it('refuses when get-oracle answers something that is not a principal', async () => {
    // An unreadable answer is not permission to proceed. Treating it as one would
    // restore the silent failure for exactly the case where the contract is not
    // the shape we think it is.
    const { oracle } = buildOracle(null);

    await expect(oracle.commitSeed({ runId: '1', seedHash: HASH })).rejects.toThrow(
      /unreadable principal/,
    );
    expect(makeContractCall).not.toHaveBeenCalled();
  });

  it('re-checks after a refusal, so set-oracle takes effect with no redeploy', async () => {
    // The operator's fix is a contract var, not a deploy. A remembered refusal
    // would keep settlement broken until someone restarted the API.
    let installed = SOMEONE_ELSE;
    const chain = stubChain({
      async callReadOnly(params: { functionName: string }) {
        if (params.functionName === 'get-oracle') return Cl.standardPrincipal(installed);
        return Cl.uint(50_000_000);
      },
    });
    const oracle = new PaidRunOracle({
      chain,
      stacks: STACKS as unknown as NetworkConfig,
      oraclePrivateKey: TEST_ORACLE_KEY,
    });

    await expect(oracle.commitSeed({ runId: '1', seedHash: HASH })).rejects.toThrow(
      PaidOracleError,
    );

    installed = OURS; // what `npm run set-oracle -- --confirm` does
    expect(await oracle.commitSeed({ runId: '1', seedHash: HASH })).toBe('abc123');
  });
});
