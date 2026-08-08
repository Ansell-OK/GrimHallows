#!/usr/bin/env node
/**
 * Smoke-test the built Vercel bundle.
 *
 * `npm run build` succeeding proves the code type-checks and links. It does not
 * prove the artifact runs — an ESM bundle of a mostly-CommonJS dependency tree
 * fails at import time, not at build time, and the failure modes it has (a
 * missing `require` shim, a package that reads `__dirname`, a top-level await
 * down-levelled by the wrong target) all look like a perfectly good build right
 * up until the first request. On Vercel that first request is in production.
 *
 * So this imports the real bundle, mounts it behind a throwaway HTTP server the
 * same way the platform does, and asks it for two routes that touch no database
 * and no chain.
 *
 * Runs against deliberately fake credentials. Real keys are never needed here —
 * `dotenv` does not override variables already present in the environment, so
 * setting them below keeps the operator's actual .env out of the process even
 * though config.ts will read the file.
 *
 *   npm run build && node scripts/smoke-vercel.mjs
 */

import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Set before the bundle is imported: config.ts reads the environment at module
// load. The oracle key is Clarinet's published devnet account — it holds nothing
// on any real network and signs nothing here.
process.env.STACKS_NETWORK = 'testnet';
// Pinned so the check does not depend on the operator's .env. Leaving this unset
// lets the real deployer address through, and a mainnet SP… address against
// STACKS_NETWORK=testnet trips the config guard before the server is built —
// which proves the guard works but tells us nothing about the bundle.
process.env.STACKS_DEPLOYER_ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.ORACLE_PRIVATE_KEY =
  '530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101';
// No Postgres: the in-memory stores are used, which is what we want — this is a
// test of the bundle, not of the database.
process.env.DATABASE_URL = '';
// Switches the cron surface on so the check below tests a live gate rather than
// the "not configured" branch. Not the deployed secret and not a secret at all —
// the only request made against it is one that must be refused.
process.env.CRON_SECRET = 'smoke-test-cron-secret';

const bundle = resolve(API_ROOT, '.vercel/output/functions/index.func/index.mjs');
const { default: handler } = await import(pathToFileURL(bundle).href);

const server = createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;

async function check(path, assert) {
  try {
    const res = await fetch(`${base}${path}`);
    const body = await res.json();
    const problem = assert(res, body);
    if (problem) {
      console.error(`  FAIL  ${path} — ${problem}`);
      failed += 1;
    } else {
      console.log(`  ok    ${path}`);
    }
  } catch (err) {
    console.error(`  FAIL  ${path} — ${err.message}`);
    failed += 1;
  }
}

console.log(`Smoke-testing ${bundle}\n`);

await check('/health', (res, body) => {
  if (res.status !== 200) return `expected 200, got ${res.status}`;
  if (body.status !== 'ok') return `expected status "ok", got ${JSON.stringify(body.status)}`;
  return null;
});

await check('/config', (res, body) => {
  if (res.status !== 200) return `expected 200, got ${res.status}`;
  // The web app reads contract ids from here; an empty map would deploy a
  // frontend that cannot build a single transaction.
  if (!body.contracts || Object.keys(body.contracts).length === 0) {
    return 'no contract addresses returned';
  }
  if (!body.explorerUrl) return 'no explorerUrl returned';
  return null;
});

// A route that does not exist must be the API's JSON 404, not a platform error
// page — the web client parses `{ error: { code } }` on every failure.
await check('/definitely-not-a-route', (res, body) => {
  if (res.status !== 404) return `expected 404, got ${res.status}`;
  if (body?.error?.code !== 'NOT_FOUND') return `expected NOT_FOUND, got ${JSON.stringify(body)}`;
  return null;
});

// The cron endpoint, unauthenticated. Two things at once, and both are the sort
// that only fail in production: that the scheduled path exists in the bundle at
// all (a 404 here means the platform's cron would call nothing every minute, and
// report success for it), and that it refuses a caller without the secret. A GET
// because that is the only method Vercel Cron issues.
await check('/jobs/loot-mint', (res, body) => {
  if (res.status !== 401) return `expected 401, got ${res.status}`;
  if (body?.error?.code !== 'CRON_AUTH_FAILED') {
    return `expected CRON_AUTH_FAILED, got ${JSON.stringify(body)}`;
  }
  return null;
});

await new Promise((r) => server.close(r));

if (failed) {
  console.error(`\n${failed} check(s) failed — the bundle is not deployable.`);
  process.exit(1);
}
console.log('\nBundle serves. Safe to deploy.');
