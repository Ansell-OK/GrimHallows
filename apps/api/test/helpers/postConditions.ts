/**
 * Post-condition decoding for tests.
 *
 * Every payload this backend hands a wallet carries its post-conditions as an
 * opaque hex blob, which is exactly what makes them worth asserting on: a test
 * that trusted a `feeUstx` field alongside the blob would pass while the blob
 * said something else entirely, and the blob is the part the chain enforces.
 *
 * `@stacks/transactions` v7 has no single `deserializePostCondition` — the trip
 * back is wire-decode then wire-to-object, so it is wrapped once here rather
 * than remembered in every test file.
 */

import {
  deserializePostConditionWire,
  wireToPostCondition,
  type PostCondition,
} from '@stacks/transactions';

/** The decoded shape of an STX post-condition, which is all we build. */
export interface StxPostCondition {
  readonly type: string;
  readonly address: string;
  readonly condition: string;
  readonly amount: string;
}

export function deserializePostCondition(hex: string): PostCondition {
  return wireToPostCondition(deserializePostConditionWire(hex));
}
