/**
 * Print-event decoding.
 *
 * A Clarity `print` is how a contract says what it actually did, and it is the
 * only account of a transaction that is not somebody's summary of it. This
 * module turns the three prints the indexer reads — `forged`, `loot-minted`,
 * `leaderboard-credit` — into plain objects, and returns null rather than
 * throwing when a value is not the shape expected.
 *
 * NULL, NOT A DEFAULT. Every accessor here refuses to guess. A `forged` event
 * with no `token-id` yields null, not token 0; a missing tier yields null, not
 * tier 1. The indexer skips what it cannot read and says so in a log line,
 * because a row invented from a half-parsed event is worse than a missing row:
 * the missing row is visibly missing, and the invented one is not.
 *
 * Decoding goes through `hexToCV` rather than a regex over the `repr` string
 * beside it. A repr is a rendering meant for humans, and a regex over one is a
 * parser that works until a field is reordered or a principal is formatted a
 * shade differently.
 */

import { ClarityType, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { ChainEvent, ChainTransaction } from '../lib/hiro.js';

/** Every `print` this transaction emitted from `contractId`, decoded. */
export function printEvents(
  tx: ChainTransaction,
  contractId: string,
): Record<string, ClarityValue>[] {
  const out: Record<string, ClarityValue>[] = [];
  for (const event of tx.events) {
    const tuple = printTuple(event, contractId);
    if (tuple) out.push(tuple);
  }
  return out;
}

/** One event as a Clarity tuple's fields, or null if it isn't one. */
function printTuple(event: ChainEvent, contractId: string): Record<string, ClarityValue> | null {
  if (event.eventType !== 'smart_contract_log') return null;
  if (event.contractId !== contractId) return null;
  if (!event.valueHex) return null;
  try {
    const value = hexToCV(event.valueHex);
    if (value.type !== ClarityType.Tuple) return null;
    return value.value;
  } catch {
    // An undecodable log is a fact about the node's response, not about the
    // game. Skipping it leaves the row unwritten, which the next pass retries.
    return null;
  }
}

/** The `event:` discriminator every GrimHallow print carries as its first field. */
export function eventName(tuple: Record<string, ClarityValue>): string | null {
  const value = tuple['event'];
  if (!value) return null;
  if (value.type === ClarityType.StringASCII || value.type === ClarityType.StringUTF8) {
    return value.value;
  }
  return null;
}

/**
 * A uint field as a decimal string.
 *
 * A string rather than a number because these are chain quantities — run ids and
 * token ids run past `Number.MAX_SAFE_INTEGER` and there is no reason to spend
 * precision on a value that is only ever stored and displayed.
 */
export function uintField(tuple: Record<string, ClarityValue>, field: string): string | null {
  const value = tuple[field];
  if (!value || value.type !== ClarityType.UInt) return null;
  return BigInt(value.value).toString();
}

/**
 * A uint field as a JS number, for the small ones only.
 *
 * Tiers and recipe ids are single digits by construction (the tier ladder has
 * four rungs; recipe ids come from a nonce that starts at 1). Returns null above
 * a sanity bound rather than a lossy number.
 */
export function smallUintField(
  tuple: Record<string, ClarityValue>,
  field: string,
): number | null {
  const raw = uintField(tuple, field);
  if (raw === null) return null;
  const asBig = BigInt(raw);
  if (asBig > 1_000_000n) return null;
  return Number(asBig);
}

/** A principal field as its address string. */
export function principalField(
  tuple: Record<string, ClarityValue>,
  field: string,
): string | null {
  const value = tuple[field];
  if (!value) return null;
  if (value.type === ClarityType.PrincipalStandard) return value.value;
  if (value.type === ClarityType.PrincipalContract) return value.value;
  return null;
}

/** A `(list ... uint)` field as decimal strings, or null if any element isn't a uint. */
export function uintListField(
  tuple: Record<string, ClarityValue>,
  field: string,
): string[] | null {
  const value = tuple[field];
  if (!value || value.type !== ClarityType.List) return null;
  const out: string[] = [];
  for (const item of value.value) {
    if (item.type !== ClarityType.UInt) return null;
    out.push(BigInt(item.value).toString());
  }
  return out;
}
