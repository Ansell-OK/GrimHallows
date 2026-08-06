/**
 * Stacks signed-message verification.
 *
 * A login is a claim: "I am address X." The only thing that makes it true is a
 * signature over a challenge WE issued, recovering to X. Two rules follow, and
 * both are load-bearing:
 *
 *   1. The public key is RECOVERED from the signature, never taken from the
 *      request. `stx_signMessage` returns a publicKey alongside the signature,
 *      and trusting it would let a caller pair someone else's signature with
 *      their own key — or simply assert an address they cannot sign for.
 *   2. The recovered key must hash to the claimed address on the right network,
 *      so a mainnet signature cannot be replayed as a testnet login.
 *
 * The hashing convention matches @stacks/encryption's `hashMessage`:
 *
 *     sha256( "\x17Stacks Signed Message:\n" || varuint(len) || message )
 *
 * reimplemented here because that package is not a dependency of this app.
 * `test/messageSignature.test.ts` pins it against a known-good vector.
 */

import { sha256 } from '@noble/hashes/sha2';
import {
  getAddressFromPublicKey,
  publicKeyFromSignatureRsv,
} from '@stacks/transactions';
import type { StacksNetworkName } from '@grimhallow/shared';

/** The 0x17 is the length of the 23-character string that follows it. */
const CHAIN_PREFIX = '\x17Stacks Signed Message:\n';

/** Bitcoin-style CompactSize, as used by @stacks/encryption's varuint. */
export function encodeVaruint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`varuint expects a non-negative integer, got ${value}`);
  }
  if (value < 0xfd) return Uint8Array.of(value);

  if (value <= 0xffff) {
    const out = new Uint8Array(3);
    out[0] = 0xfd;
    new DataView(out.buffer).setUint16(1, value, true);
    return out;
  }
  if (value <= 0xffff_ffff) {
    const out = new Uint8Array(5);
    out[0] = 0xfe;
    new DataView(out.buffer).setUint32(1, value, true);
    return out;
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  new DataView(out.buffer).setBigUint64(1, BigInt(value), true);
  return out;
}

export function encodeMessage(message: string): Uint8Array {
  const prefix = new TextEncoder().encode(CHAIN_PREFIX);
  const body = new TextEncoder().encode(message);
  const length = encodeVaruint(body.length);

  const out = new Uint8Array(prefix.length + length.length + body.length);
  out.set(prefix, 0);
  out.set(length, prefix.length);
  out.set(body, prefix.length + length.length);
  return out;
}

export function hashMessage(message: string): Uint8Array {
  return sha256(encodeMessage(message));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Recover the signing address from an RSV signature over `message`.
 *
 * Returns null rather than throwing on any malformed input — a bad signature is
 * an expected condition on a public endpoint, not an exceptional one.
 */
export function recoverAddress(
  message: string,
  signature: string,
  network: StacksNetworkName,
): string | null {
  try {
    const publicKey = publicKeyFromSignatureRsv(toHex(hashMessage(message)), signature);
    // Devnet and testnet share an address version; mainnet does not.
    return getAddressFromPublicKey(publicKey, network === 'mainnet' ? 'mainnet' : 'testnet');
  } catch {
    return null;
  }
}

/**
 * True when `signature` over `message` was produced by `address`'s key.
 *
 * Address comparison is exact: Stacks c32 addresses are case-sensitive, and
 * normalising case here would accept addresses that are not the same principal.
 */
export function verifyMessageSignature(params: {
  message: string;
  signature: string;
  address: string;
  network: StacksNetworkName;
}): boolean {
  const recovered = recoverAddress(params.message, params.signature, params.network);
  return recovered !== null && recovered === params.address;
}
