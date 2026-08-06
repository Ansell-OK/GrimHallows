/**
 * Server-signed attestations for off-chain (free) runs.
 *
 * INTERNAL — same rule as `seed.ts`: no route may import this.
 *
 * Paid runs get their fairness guarantee from the chain: `commit-seed` and
 * `reveal-and-resolve` are transactions anyone can read, and the contract itself
 * asserts `sha256(seed) == seed-hash`. Free dungeons stay off-chain for MVP
 * (07-glossary-and-open-questions.md#2), so there is no transaction to point at
 * — 04-backend-api-spec.md#5 calls for a *server-signed* commit and resolution
 * log instead.
 *
 * WHAT A SIGNATURE HERE DOES AND DOESN'T PROVE
 *
 * It proves the oracle key stands behind a specific statement: this run, this
 * seed hash, this action list, this outcome. A player who is handed the
 * attestation can check the signature recovers to the published oracle address,
 * re-derive every roll from the revealed seed, and catch us if the outcome we
 * reported isn't the one the dice produce.
 *
 * It does NOT prove *when* we committed. The timestamp is self-asserted, and a
 * dishonest operator with the key could backdate one. That gap is exactly what
 * posting on-chain closes, and it is the accepted MVP tradeoff for free
 * dungeons — where nothing is at stake but rank. Do not extend this module to
 * cover a paid run: those go through the contract.
 *
 * The statements are line-based and versioned rather than JSON, because a
 * signature is only checkable if both sides serialize identically, and JSON key
 * order is not something to bet a verification on.
 */

import { sha256 } from '@noble/hashes/sha2';
import { getAddressFromPrivateKey, signMessageHashRsv } from '@stacks/transactions';
import type { CombatOutcome, StacksNetworkName } from '@grimhallow/shared';
import { hashMessage, recoverAddress } from '../lib/messageSignature.js';
import { COMMIT_SCHEME_VERSION, normalizeHex32 } from './seed.js';

export const COMMIT_STATEMENT_TAG = `GrimHallow ${COMMIT_SCHEME_VERSION} commit` as const;
export const RESOLVE_STATEMENT_TAG = `GrimHallow ${COMMIT_SCHEME_VERSION} resolve` as const;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic serialization, used only to fingerprint a transcript.
 *
 * Object keys are emitted in sorted order so two runs of the same data always
 * produce the same bytes. `JSON.stringify` alone preserves insertion order,
 * which is stable in practice and not something a signature should depend on.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Fingerprint of everything the encounter is a function of, apart from the seed.
 *
 * `runEncounter(seed, setup, actions)` is pure, so pinning `(setup, actions)`
 * plus the seed pins the entire result. Without this the attestation would say
 * "this run ended in a win" while leaving what was fought and what was done
 * unstated — and an unstated input is one that can be quietly changed.
 */
export function transcriptHash(setup: unknown, actions: unknown): string {
  return toHex(
    sha256(new TextEncoder().encode(canonicalize({ actions, setup }))),
  );
}

export interface CommitStatementInput {
  readonly runId: string;
  readonly seedHash: string;
  /** ISO-8601. Self-asserted — see the module note. */
  readonly committedAt: string;
}

export function commitStatement(input: CommitStatementInput): string {
  return [
    COMMIT_STATEMENT_TAG,
    `run=${input.runId}`,
    `seedHash=${normalizeHex32(input.seedHash, 'seedHash')}`,
    `committedAt=${input.committedAt}`,
  ].join('\n');
}

export interface ResolveStatementInput {
  readonly runId: string;
  /** The revealed seed. Public by the time this statement is made. */
  readonly seed: string;
  readonly outcome: CombatOutcome;
  readonly turnCount: number;
  readonly transcriptHash: string;
  /** Every algorithm version the result depends on, so a rule change is visible. */
  readonly algoVersions: Readonly<Record<string, string>>;
  readonly resolvedAt: string;
}

export function resolveStatement(input: ResolveStatementInput): string {
  const algo = Object.keys(input.algoVersions)
    .sort()
    .map((k) => `${k}:${input.algoVersions[k]}`)
    .join(',');
  return [
    RESOLVE_STATEMENT_TAG,
    `run=${input.runId}`,
    `seed=${normalizeHex32(input.seed, 'seed')}`,
    `outcome=${input.outcome}`,
    `turns=${input.turnCount}`,
    `transcript=${input.transcriptHash}`,
    `algo=${algo}`,
    `resolvedAt=${input.resolvedAt}`,
  ].join('\n');
}

/**
 * The oracle's signing capability, narrowed to exactly one verb.
 *
 * An interface rather than a concrete class so tests can drive the real resolve
 * path without a key on disk, and so the key-holding implementation stays one
 * small file that is easy to audit.
 */
export interface OracleSigner {
  /** The public principal players check attestations against. */
  readonly address: string;
  /** RSV-encoded signature over the Stacks signed-message hash of `message`. */
  sign(message: string): string;
}

export class StacksOracleSigner implements OracleSigner {
  readonly address: string;

  /**
   * @param privateKey the ORACLE key — never the owner key, and never a
   * player's. Held only here and in `config.loadOracleKey()`.
   */
  constructor(
    private readonly privateKey: string,
    network: StacksNetworkName,
  ) {
    this.address = getAddressFromPrivateKey(
      privateKey,
      network === 'mainnet' ? 'mainnet' : 'testnet',
    );
  }

  sign(message: string): string {
    return signMessageHashRsv({
      messageHash: toHex(hashMessage(message)),
      privateKey: this.privateKey,
    });
  }
}

/**
 * Check an attestation the way a skeptical player would.
 *
 * The address is RECOVERED from the signature, never read from alongside it —
 * the same rule that makes login sound (`lib/messageSignature.ts`). An
 * attestation is only worth anything if it recovers to the oracle address we
 * publish, and nowhere else.
 *
 * Exported so this backs both our own tests and any verification tooling: if it
 * returns false for a real attestation, that is a bug worth finding before a
 * player finds it.
 */
export function verifyAttestation(params: {
  message: string;
  signature: string;
  oracleAddress: string;
  network: StacksNetworkName;
}): boolean {
  const recovered = recoverAddress(params.message, params.signature, params.network);
  return recovered !== null && recovered === params.oracleAddress;
}
