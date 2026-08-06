/**
 * Session tokens (HS256 JWT).
 *
 * Scope, deliberately narrow: this token authenticates non-money-moving reads
 * and off-chain convenience writes (party formation, action submission). It can
 * NEVER authorize a transfer of STX or an NFT. Every money-moving action is a
 * transaction the user signs in their own wallet, so a stolen token cannot spend
 * anything — it can only impersonate someone in the off-chain layer.
 *
 * Hand-rolled over node:crypto rather than pulling in a JWT library: HS256 is
 * ~30 lines, and the usual reason to reach for a library — the alg-confusion
 * family of attacks — is handled by not being generic. `alg` is not read from
 * the header at all; the only accepted algorithm is the one hardcoded below.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const ALG = 'HS256' as const;

export interface SessionClaims {
  /** Subject: the wallet address this token speaks for. */
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * A token scoped to a single run, handed out by free-dungeon entry
 * (04-backend-api-spec.md#3). It authorises submitting turns for that run and
 * nothing else — not another run, and not the general session endpoints.
 */
export interface RunClaims extends SessionClaims {
  readonly scope: 'run';
  readonly run: string;
}


function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function issueToken(params: {
  address: string;
  secret: string;
  ttlSeconds: number;
  /** Injectable for tests; defaults to now. */
  nowSeconds?: number;
}): { token: string; claims: SessionClaims } {
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: params.address,
    iat,
    exp: iat + params.ttlSeconds,
  };

  return { token: encode(claims, params.secret), claims };
}

/**
 * Issue a run-scoped token.
 *
 * Separate function rather than an options bag on `issueToken`, so that adding
 * a scope is a deliberate act at the call site and a session token can never
 * acquire one by a default changing underneath it.
 */
export function issueRunToken(params: {
  address: string;
  runId: string;
  secret: string;
  ttlSeconds: number;
  nowSeconds?: number;
}): { token: string; claims: RunClaims } {
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: RunClaims = {
    sub: params.address,
    iat,
    exp: iat + params.ttlSeconds,
    scope: 'run',
    run: params.runId,
  };

  return { token: encode(claims, params.secret), claims };
}

function encode(claims: SessionClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify the signature and the common claims, returning the raw payload.
 *
 * Callers must still check `scope` — see `verifyToken` and `verifyRunToken`,
 * which are the only two intended entry points.
 */
function verifyAny(
  token: string,
  secret: string,
  nowSeconds: number,
): (SessionClaims & { scope?: unknown; run?: unknown }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);

  // Constant-time: a length-varying or early-exit compare here would leak the
  // expected MAC one byte at a time.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    // The header's `alg` is deliberately not consulted — see the module note.
    const claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as SessionClaims & {
      scope?: unknown;
    };
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Verify and decode a session token, or return null.
 *
 * Null for every failure mode — bad shape, bad signature, expired. Callers get
 * one answer ("not a valid session"), so nothing leaks about which part failed.
 *
 * A run-scoped token is NOT a session token and is rejected here. Both are
 * signed with the same secret, so without this check a token issued to play one
 * free dungeon would authenticate every session endpoint — a narrower
 * credential must never widen just because it validates.
 */
export function verifyToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionClaims | null {
  const claims = verifyAny(token, secret, nowSeconds);
  if (!claims || claims.scope !== undefined) return null;
  return { sub: claims.sub, iat: claims.iat, exp: claims.exp };
}

/**
 * Verify a run token and confirm it was issued for `runId`.
 *
 * The run id is checked here rather than by the caller so that a token for run
 * A can never be replayed against run B by a handler that forgot to compare.
 */
export function verifyRunToken(
  token: string,
  secret: string,
  runId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RunClaims | null {
  const claims = verifyAny(token, secret, nowSeconds);
  if (!claims || claims.scope !== 'run') return null;
  if (typeof claims.run !== 'string' || claims.run !== runId) return null;
  return { sub: claims.sub, iat: claims.iat, exp: claims.exp, scope: 'run', run: claims.run };
}

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer (.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}
