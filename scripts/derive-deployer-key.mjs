#!/usr/bin/env node
/**
 * Derive the deployer's private key from the mnemonic in
 * `contracts/settings/Mainnet.toml` (or Testnet.toml) and write it into `.env`.
 *
 * Why this exists: clarinet signs deploys straight from that mnemonic, but
 * `scripts/seed-contracts.mjs` and the API sign with a hex private key in
 * `.env`. Those are the same account — CONTRACT-OWNER is bound to whoever
 * deployed — so the key has to be derived from the phrase rather than invented.
 * Hand-copying it through a terminal is how seed phrases end up in shell
 * history; this never prints it.
 *
 * It only ever WRITES to .env. It prints the derived address so you can check it
 * against the deployer recorded in the deployment plan, and nothing else.
 *
 *   node scripts/derive-deployer-key.mjs                # report the address only
 *   node scripts/derive-deployer-key.mjs --write        # also write .env keys
 *   node scripts/derive-deployer-key.mjs --network testnet
 *
 * Stacks account 0 lives at m/44'/5757'/0'/0/0, which is what Clarinet's
 * `accounts.deployer` resolves to. Any other index is a different principal and
 * would fail every owner-only assert on chain.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { privateKeyToAddress } from '@stacks/transactions';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const netArgIndex = process.argv.indexOf('--network');
const network = netArgIndex === -1 ? 'mainnet' : process.argv[netArgIndex + 1];

if (network !== 'mainnet' && network !== 'testnet') {
  console.error(`--network must be mainnet or testnet, got ${network}`);
  process.exit(1);
}

const settingsFile = resolve(
  ROOT,
  'contracts/settings',
  network === 'mainnet' ? 'Mainnet.toml' : 'Testnet.toml',
);

// Deliberately a line match rather than a TOML parse: no TOML parser is in this
// workspace's dependency tree, and pulling one in to read one field would be a
// new dependency on the path that handles the seed phrase.
const toml = readFileSync(settingsFile, 'utf8').replace(/^﻿/, '');
const match = toml.match(/^\s*mnemonic\s*=\s*["'](.+?)["']\s*$/m);
if (!match) {
  console.error(`No plaintext \`mnemonic = "..."\` found in ${settingsFile}.`);
  console.error(
    'If it is an encrypted mnemonic, decrypt it into a plaintext copy first —' +
      ' this script cannot prompt for a password.',
  );
  process.exit(1);
}

const mnemonic = match[1].trim().replace(/\s+/g, ' ');
if (!validateMnemonic(mnemonic, wordlist)) {
  // Wrong checksum means a typo or a truncated phrase, and it would silently
  // derive a valid-looking key for an account that owns nothing.
  console.error(
    `The mnemonic in ${settingsFile} fails BIP-39 checksum validation ` +
      `(${mnemonic.split(' ').length} words). It is mistyped or incomplete.`,
  );
  process.exit(1);
}

const seed = mnemonicToSeedSync(mnemonic);
const child = HDKey.fromMasterSeed(seed).derive("m/44'/5757'/0'/0/0");
if (!child.privateKey) {
  console.error('Derivation produced no private key.');
  process.exit(1);
}

// Stacks expects 33 bytes: the 32-byte key plus a 0x01 compression suffix.
const privateKey =
  Buffer.from(child.privateKey).toString('hex') + '01';
const address = privateKeyToAddress(privateKey, network);

console.log(`network:  ${network}`);
console.log(`settings: ${settingsFile}`);
console.log(`address:  ${address}`);
console.log(
  '\nCheck that against `expected-sender` in ' +
    `contracts/deployments/default.${network}-plan.yaml before writing anything.`,
);

if (!WRITE) {
  console.log('\nNothing written. Re-run with --write to update .env.');
  process.exit(0);
}

const envPath = resolve(ROOT, '.env');
let env = readFileSync(envPath, 'utf8');
const hadBom = env.startsWith('﻿');
env = env.replace(/^﻿/, '');

/**
 * Replace `KEY=` in place if present, append otherwise. In place matters: the
 * file's comments are the only documentation of which key is allowed to do
 * what, and appending duplicates would leave two lines where the last one
 * silently wins.
 */
function setVar(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(env)) {
    env = env.replace(pattern, `${key}=${value}`);
  } else {
    env = env.replace(/\s*$/, `\n${key}=${value}\n`);
  }
}

setVar('OWNER_PRIVATE_KEY', privateKey);
setVar('OWNER_ADDRESS', address);
setVar('STACKS_DEPLOYER_ADDRESS', address);
setVar('VITE_STACKS_DEPLOYER_ADDRESS', address);

writeFileSync(envPath, (hadBom ? '﻿' : '') + env, 'utf8');

console.log(`
Wrote to .env (the key itself was never printed):
  OWNER_PRIVATE_KEY          <32-byte key, redacted>
  OWNER_ADDRESS              ${address}
  STACKS_DEPLOYER_ADDRESS    ${address}
  VITE_STACKS_DEPLOYER_ADDRESS ${address}

ORACLE_PRIVATE_KEY was NOT touched. Setting the oracle to this same account
puts the revenue-receiving, fund-pool-authorised key inside the API process —
see 02-architecture.md #7. If you do it anyway, do it knowingly.
`);
