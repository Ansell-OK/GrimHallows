/**
 * Session token tests.
 *
 * The token authenticates off-chain reads and convenience writes only — it can
 * never move money — but it can impersonate a player in the off-chain layer, so
 * forging one must be impossible. These tests cover the forgery routes:
 * tampering with claims, swapping the signature, changing the declared
 * algorithm, and replaying an expired token.
 */

import { describe, expect, it } from 'vitest';
import { bearerToken, issueToken, verifyToken } from '../src/lib/jwt.js';

const SECRET = 'test-secret-not-used-anywhere-real';
const ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const NOW = 1_800_000_000;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('issueToken', () => {
  it('round-trips the address and expiry', () => {
    const { token, claims } = issueToken({
      address: ADDRESS,
      secret: SECRET,
      ttlSeconds: 3600,
      nowSeconds: NOW,
    });

    expect(claims).toEqual({ sub: ADDRESS, iat: NOW, exp: NOW + 3600 });
    expect(verifyToken(token, SECRET, NOW)).toEqual(claims);
  });

  it('produces three dot-separated segments', () => {
    const { token } = issueToken({ address: ADDRESS, secret: SECRET, ttlSeconds: 60 });
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyToken', () => {
  const valid = issueToken({
    address: ADDRESS,
    secret: SECRET,
    ttlSeconds: 3600,
    nowSeconds: NOW,
  }).token;

  it('rejects a token signed with a different secret', () => {
    expect(verifyToken(valid, 'some-other-secret', NOW)).toBeNull();
  });

  it('rejects a tampered subject', () => {
    // Swap in another address while keeping the original signature.
    const [header, , signature] = valid.split('.');
    const forged = [header, b64url({ sub: 'ST2ATTACKER', iat: NOW, exp: NOW + 3600 }), signature].join(
      '.',
    );
    expect(verifyToken(forged, SECRET, NOW)).toBeNull();
  });

  it('rejects a token whose expiry was pushed out', () => {
    const [header, , signature] = valid.split('.');
    const forged = [
      header,
      b64url({ sub: ADDRESS, iat: NOW, exp: NOW + 10_000_000 }),
      signature,
    ].join('.');
    expect(verifyToken(forged, SECRET, NOW)).toBeNull();
  });

  it('rejects alg:none — the classic JWT downgrade', () => {
    // Even with no signature segment claimed to be needed, verification runs
    // the HMAC compare first and the header's alg is never consulted.
    const forged = [
      b64url({ alg: 'none', typ: 'JWT' }),
      b64url({ sub: ADDRESS, iat: NOW, exp: NOW + 3600 }),
      '',
    ].join('.');
    expect(verifyToken(forged, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token } = issueToken({
      address: ADDRESS,
      secret: SECRET,
      ttlSeconds: 60,
      nowSeconds: NOW,
    });
    expect(verifyToken(token, SECRET, NOW + 61)).toBeNull();
    expect(verifyToken(token, SECRET, NOW + 59)).not.toBeNull();
  });

  it('rejects a token expiring exactly now', () => {
    const { token } = issueToken({
      address: ADDRESS,
      secret: SECRET,
      ttlSeconds: 60,
      nowSeconds: NOW,
    });
    expect(verifyToken(token, SECRET, NOW + 60)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...', 'not-a-token']) {
      expect(verifyToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('rejects a token with an empty subject', () => {
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const payload = b64url({ sub: '', iat: NOW, exp: NOW + 3600 });
    // Sign it properly — the payload itself is what should be refused.
    const { token } = issueToken({ address: '', secret: SECRET, ttlSeconds: 3600, nowSeconds: NOW });
    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(verifyToken(token, SECRET, NOW)).toBeNull();
  });
});

describe('bearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for anything else', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('abc.def.ghi')).toBeNull();
  });
});
