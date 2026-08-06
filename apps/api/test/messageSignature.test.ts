/**
 * Signed-message verification tests.
 *
 * This is the security boundary of wallet login, so the tests are about attacks,
 * not just happy paths: a signature for a different message, a different
 * address, a different network, or a caller-supplied public key must all fail.
 *
 * The message-hashing convention is pinned by signing with a known private key
 * and checking the recovered address — if the prefix or varuint encoding ever
 * drifted from @stacks/encryption's, real wallet signatures would stop
 * verifying, and these tests would catch it before a player did.
 */

import { describe, expect, it } from 'vitest';
import {
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
  signMessageHashRsv,
} from '@stacks/transactions';
import {
  encodeMessage,
  encodeVaruint,
  hashMessage,
  recoverAddress,
  verifyMessageSignature,
} from '../src/lib/messageSignature.js';

// Clarinet's standard first test wallet.
const PRIVATE_KEY = '753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601';
const TESTNET_ADDRESS = getAddressFromPrivateKey(PRIVATE_KEY, 'testnet');
const MAINNET_ADDRESS = getAddressFromPrivateKey(PRIVATE_KEY, 'mainnet');

const OTHER_KEY = '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a wallet does for `stx_signMessage`. */
function sign(message: string, privateKey = PRIVATE_KEY): string {
  return signMessageHashRsv({
    messageHash: toHex(hashMessage(message)),
    privateKey,
  });
}

describe('encodeVaruint', () => {
  it('encodes single-byte lengths directly', () => {
    expect(Array.from(encodeVaruint(0))).toEqual([0]);
    expect(Array.from(encodeVaruint(0xfc))).toEqual([0xfc]);
  });

  it('switches to the 0xfd 16-bit form at the boundary', () => {
    // 0xfd is where CompactSize stops being a single byte.
    expect(Array.from(encodeVaruint(0xfd))).toEqual([0xfd, 0xfd, 0x00]);
    expect(Array.from(encodeVaruint(0xffff))).toEqual([0xfd, 0xff, 0xff]);
  });

  it('uses the 32-bit form beyond 16 bits', () => {
    expect(Array.from(encodeVaruint(0x10000))).toEqual([0xfe, 0x00, 0x00, 0x01, 0x00]);
  });

  it('rejects negative and fractional lengths', () => {
    expect(() => encodeVaruint(-1)).toThrow();
    expect(() => encodeVaruint(1.5)).toThrow();
  });
});

describe('encodeMessage', () => {
  it('prefixes with the 23-byte Stacks marker and a length', () => {
    const encoded = encodeMessage('hello');
    // \x17 + "Stacks Signed Message:\n" = 24 bytes, then varuint(5), then 5 bytes.
    expect(encoded.length).toBe(24 + 1 + 5);
    expect(encoded[0]).toBe(0x17);
    expect(new TextDecoder().decode(encoded.subarray(1, 24))).toBe(
      'Stacks Signed Message:\n',
    );
    expect(encoded[24]).toBe(5);
  });

  it('counts UTF-8 bytes, not code points', () => {
    // A 1-character emoji is 4 bytes; a length of 1 here would corrupt the hash.
    const encoded = encodeMessage('🎲');
    expect(encoded[24]).toBe(4);
  });
});

describe('hashMessage', () => {
  it('is deterministic and 32 bytes', () => {
    const a = hashMessage('grimhallow-login-abc');
    const b = hashMessage('grimhallow-login-abc');
    expect(a.length).toBe(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('differs for messages differing by one character', () => {
    expect(toHex(hashMessage('challenge-a'))).not.toBe(toHex(hashMessage('challenge-b')));
  });
});

describe('recoverAddress', () => {
  it('recovers the signer address from a real wallet-style signature', () => {
    const message = 'grimhallow-login-deadbeef';
    expect(recoverAddress(message, sign(message), 'testnet')).toBe(TESTNET_ADDRESS);
  });

  it('recovers the mainnet form of the same key on mainnet', () => {
    const message = 'grimhallow-login-deadbeef';
    const signature = sign(message);
    expect(recoverAddress(message, signature, 'mainnet')).toBe(MAINNET_ADDRESS);
    expect(MAINNET_ADDRESS).not.toBe(TESTNET_ADDRESS);
  });

  it('treats devnet as testnet for address versioning', () => {
    const message = 'grimhallow-login-deadbeef';
    expect(recoverAddress(message, sign(message), 'devnet')).toBe(TESTNET_ADDRESS);
  });

  it('returns null for malformed signatures instead of throwing', () => {
    // A public endpoint receives garbage as a matter of course.
    expect(recoverAddress('m', 'not-a-signature', 'testnet')).toBeNull();
    expect(recoverAddress('m', '', 'testnet')).toBeNull();
    expect(recoverAddress('m', '00'.repeat(65), 'testnet')).toBeNull();
  });
});

describe('verifyMessageSignature', () => {
  const message = 'grimhallow-login-0123456789abcdef';

  it('accepts a signature from the claimed address', () => {
    expect(
      verifyMessageSignature({
        message,
        signature: sign(message),
        address: TESTNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(true);
  });

  it('rejects a signature over a DIFFERENT message', () => {
    // The replay case: a signature captured elsewhere must not authenticate a
    // login for a challenge it was never produced for.
    expect(
      verifyMessageSignature({
        message,
        signature: sign('some-other-message'),
        address: TESTNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(false);
  });

  it('rejects a valid signature paired with someone else’s address', () => {
    // The impersonation case: signing correctly with your own key does not let
    // you claim to be another principal.
    const attackerAddress = getAddressFromPrivateKey(OTHER_KEY, 'testnet');
    expect(attackerAddress).not.toBe(TESTNET_ADDRESS);
    expect(
      verifyMessageSignature({
        message,
        signature: sign(message, OTHER_KEY),
        address: TESTNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(false);
  });

  it('rejects a mainnet-form address on the testnet network', () => {
    // Same key, wrong network encoding — must not cross-authenticate.
    expect(
      verifyMessageSignature({
        message,
        signature: sign(message),
        address: MAINNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(false);
  });

  it('ignores any public key the caller might supply', () => {
    // The key is recovered from the signature. This test exists to document
    // that: verifyMessageSignature has no parameter to pass one in, so a caller
    // cannot pair a stolen signature with a key of their choosing.
    const callerSuppliedKey = publicKeyToHex(privateKeyToPublic(OTHER_KEY));
    expect(callerSuppliedKey).toBeTruthy();
    expect(
      verifyMessageSignature({
        message,
        signature: sign(message, OTHER_KEY),
        address: TESTNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(
      verifyMessageSignature({
        message,
        signature: '',
        address: TESTNET_ADDRESS,
        network: 'testnet',
      }),
    ).toBe(false);
  });
});
