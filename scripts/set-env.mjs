#!/usr/bin/env node
/**
 * Fill the non-key parts of `.env` for a given network, and generate JWT_SECRET
 * if it is empty.
 *
 * Companion to `derive-deployer-key.mjs`, which handles the one value that must
 * never be printed. Split apart on purpose: the key derivation reads a seed
 * phrase and this does not, so this one's output is safe to read in a terminal.
 *
 *   node scripts/set-env.mjs --network mainnet
 *   node scripts/set-env.mjs --network mainnet --oracle-is-owner
 *
 * `--oracle-is-owner` copies OWNER_PRIVATE_KEY into ORACLE_PRIVATE_KEY. That is
 * a deliberate downgrade of the key separation in 02-architecture.md #7 — the
 * oracle key lives in the API process and can move sponsor-pool funds, and the
 * owner key receives all three revenue lines. One key means one compromise
 * costs both. It is supported because a single operator seeding an MVP has a
 * real reason to want it; it is opt-in because nobody should arrive at it by
 * accident.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const netIndex = argv.indexOf('--network');
const network = netIndex === -1 ? null : argv[netIndex + 1];
const ORACLE_IS_OWNER = argv.includes('--oracle-is-owner');

if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
  console.error('Usage: node scripts/set-env.mjs --network devnet|testnet|mainnet');
  process.exit(1);
}

const envPath = resolve(ROOT, '.env');
let env = readFileSync(envPath, 'utf8');
const hadBom = env.startsWith('﻿');
env = env.replace(/^﻿/, '');

function read(key) {
  return env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

function setVar(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(env)) env = env.replace(pattern, `${key}=${value}`);
  else env = env.replace(/\s*$/, `\n${key}=${value}\n`);
}

const changes = [];
function apply(key, value, display = value) {
  if (read(key) === value) return;
  setVar(key, value);
  changes.push(`${key} = ${display}`);
}

apply('STACKS_NETWORK', network);
apply('VITE_STACKS_NETWORK', network);

if (!read('JWT_SECRET')) {
  // Session tokens only — no money authority — but an empty secret would let
  // anyone mint a session for any wallet address, which is how a player ends up
  // signing for someone else's run.
  apply('JWT_SECRET', randomBytes(32).toString('hex'), '<generated, 64 hex chars>');
}

const ownerKey = read('OWNER_PRIVATE_KEY');
const ownerAddress = read('OWNER_ADDRESS');

if (ORACLE_IS_OWNER) {
  if (!ownerKey) {
    console.error(
      'OWNER_PRIVATE_KEY is empty — run `node scripts/derive-deployer-key.mjs --write` first.',
    );
    process.exit(1);
  }
  apply('ORACLE_PRIVATE_KEY', ownerKey, '<same as OWNER_PRIVATE_KEY, redacted>');
  apply('ORACLE_ADDRESS', ownerAddress);
}

writeFileSync(envPath, (hadBom ? '﻿' : '') + env, 'utf8');

console.log(changes.length ? `Updated .env:\n  ${changes.join('\n  ')}` : '.env already matched.');

if (ORACLE_IS_OWNER) {
  console.log(`
The oracle and the owner are now the SAME principal (${ownerAddress}).
Revert before this is anything but a private playtest:
  1. generate a fresh account, put its key in ORACLE_PRIVATE_KEY and its
     address in ORACLE_ADDRESS
  2. re-run \`npm run seed\` — or just the set-oracle call — to point the
     contract at it
  3. fund it with a little STX; it pays its own tx fees`);
}

if (network === 'mainnet') {
  console.log(`
STACKS_NETWORK=mainnet: every gate fee, mint, and forge fee in the running
app is real, non-refundable STX. There is no faucet.`);
}
