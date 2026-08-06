/**
 * Attestation tests.
 *
 * A signature is worth exactly as much as a verifier's ability to rebuild the
 * bytes that were signed. So the questions here are not "does signing work" but:
 *
 *   Can the statement be reconstructed byte-for-byte by someone who only has the
 *   published fields? (If not, the attestation is decoration.)
 *
 *   Does changing any signed field break the check? A verifier that says yes to
 *   everything proves nothing, so most of this file is negative cases — one per
 *   field, because a field that can change without breaking the signature is a
 *   field nobody is actually attesting to.
 *
 *   Is the address RECOVERED rather than read? `verifyAttestation` must reject a
 *   real signature by the wrong key. Reading the claimed signer from alongside
 *   the signature is the classic way to build a check that passes for anyone.
 *
 * The transcript hash gets the same treatment: it exists to pin `(setup,
 * actions)` so the outcome cannot be restated over a quietly different fight.
 */

import { describe, expect, it } from 'vitest';
import { getAddressFromPrivateKey } from '@stacks/transactions';
import {
  COMMIT_STATEMENT_TAG,
  RESOLVE_STATEMENT_TAG,
  StacksOracleSigner,
  commitStatement,
  resolveStatement,
  transcriptHash,
  verifyAttestation,
} from '../src/oracle/attestation.js';
import { TEST_ORACLE_KEY, testOracleSigner } from './helpers/oracle.js';

/** A second devnet key, standing in for "somebody else's oracle". */
const OTHER_KEY = 'd655b2523bcd65e34889725c73064feb17ceb796831c0e111ba1a552b0f31b3901';

const RUN_ID = '4242';
const SEED = 'a'.repeat(64);
const SEED_HASH = 'b'.repeat(64);
const COMMITTED_AT = '2026-01-01T00:00:00.000Z';
const RESOLVED_AT = '2026-01-01T00:05:00.000Z';

const commitInput = () => ({ runId: RUN_ID, seedHash: SEED_HASH, committedAt: COMMITTED_AT });

const resolveInput = () => ({
  runId: RUN_ID,
  seed: SEED,
  outcome: 'win' as const,
  turnCount: 7,
  transcriptHash: 'c'.repeat(64),
  algoVersions: { dice: 'dice-v1', encounter: 'encounter-v1', stats: 'stats-v1' },
  resolvedAt: RESOLVED_AT,
});

describe('commitStatement', () => {
  it('names the scheme it belongs to on the first line', async () => {
    // Domain separation. Without a tag, a commit statement and some future
    // statement of the same shape would be one signature that satisfies both.
    expect(commitStatement(commitInput()).split('\n')[0]).toBe(COMMIT_STATEMENT_TAG);
    expect(COMMIT_STATEMENT_TAG).not.toBe(RESOLVE_STATEMENT_TAG);
  });

  it('carries the run, the hash and the instant, and nothing else', async () => {
    expect(commitStatement(commitInput())).toBe(
      [
        COMMIT_STATEMENT_TAG,
        `run=${RUN_ID}`,
        `seedHash=${SEED_HASH}`,
        `committedAt=${COMMITTED_AT}`,
      ].join('\n'),
    );
  });

  it('never contains the seed', async () => {
    // The commitment is published while the seed is still secret. A statement
    // that leaked it would hand a mid-run player every remaining roll.
    expect(commitStatement(commitInput())).not.toContain(SEED);
  });

  it('is byte-identical when rebuilt from the same fields', async () => {
    expect(commitStatement(commitInput())).toBe(commitStatement(commitInput()));
  });

  it('accepts a 0x-prefixed hash and normalizes it', async () => {
    // One spelling of a hash, or a verifier who pasted the `0x` form gets a
    // false negative on an honest attestation.
    expect(commitStatement({ ...commitInput(), seedHash: `0x${SEED_HASH.toUpperCase()}` })).toBe(
      commitStatement(commitInput()),
    );
  });

  it('refuses a hash that is not 32 bytes', async () => {
    // Better to throw at signing time than to sign a statement whose seedHash
    // line can never match what the contract would accept.
    expect(() => commitStatement({ ...commitInput(), seedHash: 'abc' })).toThrow();
  });
});

describe('resolveStatement', () => {
  it('carries every input the outcome depends on', async () => {
    expect(resolveStatement(resolveInput())).toBe(
      [
        RESOLVE_STATEMENT_TAG,
        `run=${RUN_ID}`,
        `seed=${SEED}`,
        'outcome=win',
        'turns=7',
        `transcript=${'c'.repeat(64)}`,
        'algo=dice:dice-v1,encounter:encounter-v1,stats:stats-v1',
        `resolvedAt=${RESOLVED_AT}`,
      ].join('\n'),
    );
  });

  it('orders the algorithm versions rather than trusting key order', async () => {
    // Signed bytes must not depend on how an object literal happened to be
    // written. This is the same reason the statements are lines and not JSON.
    const shuffled = resolveStatement({
      ...resolveInput(),
      algoVersions: { stats: 'stats-v1', dice: 'dice-v1', encounter: 'encounter-v1' },
    });
    expect(shuffled).toBe(resolveStatement(resolveInput()));
  });

  it('refuses a seed that is not 32 bytes', async () => {
    expect(() => resolveStatement({ ...resolveInput(), seed: 'ff' })).toThrow();
  });
});

describe('transcriptHash', () => {
  const setup = { monsterTableId: 'forsaken-crypt', party: [{ id: 'p0' }] };
  const actions = [{ powerId: 'warrior-strike', targetId: 'm0' }];

  it('is stable across calls', async () => {
    expect(transcriptHash(setup, actions)).toBe(transcriptHash(setup, actions));
  });

  it('does not depend on key order', async () => {
    expect(transcriptHash({ party: [{ id: 'p0' }], monsterTableId: 'forsaken-crypt' }, actions))
      .toBe(transcriptHash(setup, actions));
  });

  it('changes when the fight changes', async () => {
    // The whole point: an outcome signed over a transcript hash cannot be
    // restated over a different roster.
    expect(transcriptHash({ ...setup, monsterTableId: 'echoing-cavern' }, actions)).not.toBe(
      transcriptHash(setup, actions),
    );
  });

  it('changes when an action changes', async () => {
    expect(transcriptHash(setup, [{ powerId: 'guard', targetId: null }])).not.toBe(
      transcriptHash(setup, actions),
    );
  });

  it('changes when actions are reordered', async () => {
    // Position is meaning: the list is replayed in order, so a swap is a
    // different fight even though the multiset is the same.
    const a = { powerId: 'warrior-strike', targetId: 'm0' };
    const b = { powerId: 'guard', targetId: null };
    expect(transcriptHash(setup, [a, b])).not.toBe(transcriptHash(setup, [b, a]));
  });

  it('distinguishes an empty action list from a missing one', async () => {
    expect(transcriptHash(setup, [])).not.toBe(transcriptHash(setup, null));
  });

  it('is 32 bytes of hex', async () => {
    expect(transcriptHash(setup, actions)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('StacksOracleSigner', () => {
  it('publishes the address its key derives to', async () => {
    const signer = testOracleSigner();
    expect(signer.address).toBe(getAddressFromPrivateKey(TEST_ORACLE_KEY, 'testnet'));
  });

  it('signs deterministically, so the same statement checks the same way twice', async () => {
    const signer = testOracleSigner();
    const message = commitStatement(commitInput());
    expect(signer.sign(message)).toBe(signer.sign(message));
  });
});

describe('verifyAttestation', () => {
  const signer = testOracleSigner();
  const other = new StacksOracleSigner(OTHER_KEY, 'devnet');

  const check = (message: string, signature: string, oracleAddress = signer.address) =>
    verifyAttestation({ message, signature, oracleAddress, network: 'devnet' as const });

  it('accepts a real signature over a rebuilt statement', async () => {
    const message = commitStatement(commitInput());
    // Rebuilt, not reused: this is what a verifier does, and it is the only
    // thing that proves the statement is reconstructible from published fields.
    expect(check(commitStatement(commitInput()), signer.sign(message))).toBe(true);
  });

  it('rejects a real signature by the wrong key', async () => {
    const message = commitStatement(commitInput());
    // The address is recovered from the signature, never read from beside it. A
    // check that trusted the claimed signer would pass here — and would pass for
    // anybody who could produce any valid signature at all.
    expect(check(message, other.sign(message))).toBe(false);
  });

  it('rejects when the published oracle address is not the signer', async () => {
    const message = commitStatement(commitInput());
    expect(check(message, signer.sign(message), other.address)).toBe(false);
  });

  describe('every signed field is load-bearing', () => {
    const message = commitStatement(commitInput());
    const signature = signer.sign(message);

    it('rejects a changed run id', async () => {
      expect(check(commitStatement({ ...commitInput(), runId: '4243' }), signature)).toBe(false);
    });

    it('rejects a changed seed hash', async () => {
      expect(
        check(commitStatement({ ...commitInput(), seedHash: 'f'.repeat(64) }), signature),
      ).toBe(false);
    });

    it('rejects a changed timestamp', async () => {
      expect(
        check(
          commitStatement({ ...commitInput(), committedAt: '2026-01-01T00:00:01.000Z' }),
          signature,
        ),
      ).toBe(false);
    });

    it('rejects a resolve statement signed as a commit', async () => {
      // Cross-scheme replay. The tags exist for exactly this, and this is the
      // test that would notice if one were dropped.
      expect(check(resolveStatement(resolveInput()), signature)).toBe(false);
    });
  });

  it('rejects a resolution restated over a different outcome', async () => {
    const message = resolveStatement(resolveInput());
    const signature = signer.sign(message);

    expect(check(message, signature)).toBe(true);
    expect(check(resolveStatement({ ...resolveInput(), outcome: 'loss' }), signature)).toBe(
      false,
    );
  });

  it('rejects a resolution restated over a different transcript', async () => {
    const signature = signer.sign(resolveStatement(resolveInput()));
    expect(
      check(
        resolveStatement({ ...resolveInput(), transcriptHash: 'e'.repeat(64) }),
        signature,
      ),
    ).toBe(false);
  });

  it('rejects a resolution restated under different rules', async () => {
    // An algo version bump changes what the seed means. Signing over the
    // versions is what makes a rule change visible rather than retroactive.
    const signature = signer.sign(resolveStatement(resolveInput()));
    expect(
      check(
        resolveStatement({
          ...resolveInput(),
          algoVersions: { dice: 'dice-v2', encounter: 'encounter-v1', stats: 'stats-v1' },
        }),
        signature,
      ),
    ).toBe(false);
  });

  it('rejects a malformed signature rather than throwing', async () => {
    // A verifier is fed whatever a caller has. Throwing would turn a bad input
    // into a 500 on a route whose job is to answer "is this real?".
    expect(check(commitStatement(commitInput()), 'not-a-signature')).toBe(false);
    expect(check(commitStatement(commitInput()), '')).toBe(false);
    expect(check(commitStatement(commitInput()), '00'.repeat(65))).toBe(false);
  });
});
