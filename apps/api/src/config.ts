/**
 * Environment configuration.
 *
 * KEY SEPARATION (non-negotiable, per 02-architecture.md#7):
 *   - ORACLE_PRIVATE_KEY  — signs commit-seed / reveal-and-resolve ONLY.
 *   - OWNER_PRIVATE_KEY   — signs owner admin actions (fund-pool, create-*).
 *
 * These are kept as distinct config entries even when one person operates both
 * for MVP. The oracle key can move sponsor-pool funds via reveal-and-resolve,
 * so its blast radius must stay separable from routine admin signing.
 *
 * The backend NEVER holds or signs with a player's key. Every money-moving
 * player action is an unsigned tx payload returned to the client to sign.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getNetworkConfig, type StacksNetworkName } from '@grimhallow/shared';

// One .env at the monorepo root serves both apps/api and apps/web, so the
// network and deployer address can't drift between them. Resolved relative to
// this file rather than cwd, which differs between `npm run dev` and a direct
// node invocation.
//
// NOT under vitest. The unit suite builds servers with explicit fixtures and
// asserts against hardcoded testnet addresses, so reading the operator's real
// .env makes the suite's result depend on machine state: pointing .env at
// mainnet flips every recovered address from ST… to SP… and fails seventeen
// signature tests, and setting OWNER_ADDRESS silently switches on the admin
// routes that one test exists to prove are off by default. Both are true
// failures of the test environment, not of the code, and neither is visible
// from the assertion message. Vitest sets VITEST itself.
if (!process.env.VITEST) {
  loadDotenv({
    path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
    quiet: true,
  });
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function parseNetwork(): StacksNetworkName {
  const v = optional('STACKS_NETWORK', 'devnet');
  if (v !== 'devnet' && v !== 'testnet' && v !== 'mainnet') {
    throw new Error(`STACKS_NETWORK must be devnet|testnet|mainnet; got "${v}"`);
  }
  return v;
}

/**
 * Browser origins allowed to call this API, as a comma-separated list.
 *
 * A list rather than a single value because a hosted frontend has more than one
 * URL: Vercel gives production a stable domain and every preview deployment its
 * own. With one slot the operator hits a CORS wall on the first preview, and the
 * obvious fix — reflecting whatever Origin arrives, or allowing `*.vercel.app` —
 * would let any page on the platform make credentialed requests here. Listing
 * the origins costs one env-var edit per environment and keeps the check exact.
 *
 * Empty entries and stray whitespace are dropped so a trailing comma is not a
 * silent "" origin.
 */
function parseWebOrigins(): string[] {
  const raw = optional('WEB_ORIGIN', 'http://localhost:3000');
  return parseOriginList(raw);
}

/** Exported for tests; `parseWebOrigins` is the caller that reads the env. */
export function parseOriginList(raw: string): string[] {
  const origins = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error('WEB_ORIGIN was set but contained no origins');
  }
  return origins;
}

const network = parseNetwork();

export const config = {
  network,
  port: Number.parseInt(optional('PORT', '8080'), 10),
  host: optional('HOST', '0.0.0.0'),
  webOrigins: parseWebOrigins(),

  stacks: getNetworkConfig(network, {
    deployer: optional('STACKS_DEPLOYER_ADDRESS'),
    apiUrl: optional('STACKS_API_URL'),
  }),

  hiroApiKey: optional('HIRO_API_KEY'),
  databaseUrl: optional('DATABASE_URL'),
  jwtSecret: optional('JWT_SECRET'),
} as const;

/**
 * Signing keys, loaded lazily and separately.
 *
 * Deliberately NOT part of `config` — nothing that handles a public request
 * should be able to reach these by touching the general config object. Only
 * the internal oracle module (Phase 5) calls these.
 */
export function loadOracleKey(): string {
  return required('ORACLE_PRIVATE_KEY');
}

export function loadOwnerKey(): string {
  return required('OWNER_PRIVATE_KEY');
}

/** Owner's principal — the paid-entry revenue recipient. */
export function ownerAddress(): string {
  return required('OWNER_ADDRESS');
}

/**
 * Owner's principal, or null when unset.
 *
 * The admin surface uses this rather than `ownerAddress()` so a deployment
 * without an owner configured still boots and still serves players — the admin
 * route refuses instead. Null must always read as "admin is off", never as
 * "no owner check".
 */
export function ownerAddressOrNull(): string | null {
  return optional('OWNER_ADDRESS') || null;
}
