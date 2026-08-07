#!/usr/bin/env node
/**
 * Derive the ORACLE account's hex private key from its plaintext seed phrase and
 * write it into `.env` as ORACLE_PRIVATE_KEY / ORACLE_ADDRESS.
 *
 * Why this exists, and why it is separate from derive-deployer-key.mjs:
 *
 *   - The API signs attestations and paid-run settlements with a *hex* private
 *     key (`getAddressFromPrivateKey` in src/oracle/attestation.ts). It never
 *     touches Clarinet's credential system, so a Clarinet mnemonic — plaintext
 *     or its `clarinet deployments`-encrypted form (the `e96Ph…` blob) — cannot
 *     go into ORACLE_PRIVATE_KEY. Pasting the encrypted blob is exactly what
 *     produces the runtime `Invalid byte sequence`: it is not hex.
 *   - The oracle is a DIFFERENT account from the deployer/owner on purpose
 *     (02-architecture.md#7): the oracle key lives inside the API process and can
 *     move sponsor-pool funds via reveal-and-resolve, so it must not be the
 *     revenue-receiving owner key. derive-deployer-key.mjs handles the deployer;
 *     this handles the oracle, and the two are meant to land on distinct
 *     principals. This script warns if they collide.
 *
 * The phrase is read from a file, never an argument — a seed phrase on a command
 * line ends up in shell history. `oracle-mnemonic.txt` and `*.mnemonic` are
 * gitignored; create the file, run this, then delete it. The key itself is never
 * printed; only the address is, so you can verify and fund it.
 *
 *   node scripts/derive-oracle-key.mjs                       # report address only
 *   node scripts/derive-oracle-key.mjs --write               # also write .env
 *   node scripts/derive-oracle-key.mjs --network testnet
 *   node scripts/derive-oracle-key.mjs --mnemonic-file ./somewhere.mnemonic
 *
 * Stacks account 0 lives at m/44'/5757'/0'/0/0 — the same path Clarinet and the
 * Stacks wallets use for the first account. Any other index is a different
 * principal, which would sign attestations that recover to an address the
 * contract has never heard of.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { privateKeyToAddress } from '@stacks/transactions';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');

const netIndex = argv.indexOf('--network');
const network = netIndex === -1 ? 'mainnet' : argv[netIndex + 1];
if (network !== 'mainnet' && network !== 'testnet') {
  console.error(`--network must be mainnet or testnet, got ${network}`);
  process.exit(1);
}

const fileIndex = argv.indexOf('--mnemonic-file');
const mnemonicFile =
  fileIndex === -1 ? resolve(ROOT, 'oracle-mnemonic.txt') : resolve(argv[fileIndex + 1]);

if (!existsSync(mnemonicFile)) {
  console.error(`No mnemonic file at ${mnemonicFile}.`);
  console.error('');
  console.error("Put the ORACLE account's PLAINTEXT seed phrase in that file — the");
  console.error('decrypted form of the Clarinet encrypted mnemonic:');
  console.error('  clarinet deployments decrypt --encrypted-mnemonic <e96Ph…>');
  console.error('');
  console.error('The file is gitignored (oracle-mnemonic.txt / *.mnemonic). Delete it');
  console.error('once this has written the key.');
  process.exit(1);
}

// Read the phrase by its byte-order mark, not as blind UTF-8. PowerShell — the
// default shell on this machine — writes a plain `>` or Out-File redirect as
// UTF-16LE with a BOM. Read as UTF-8, that turns "abandon" into the tokens
// "a b a n d o n" (a null byte between every letter), which is why a perfectly
// clean paste still failed its checksum. Decode by the BOM so a file made with a
// plain redirect works the same as one saved as UTF-8.
function readPhraseText(path) {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le'); // UTF-16LE — the PowerShell default
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2); // UTF-16BE: swap each pair to LE, then decode
    const even = body.length - (body.length % 2);
    return Buffer.from(body.subarray(0, even)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8'); // UTF-8 with BOM (Out-File -Encoding utf8)
  }
  return buf.toString('utf8'); // UTF-8 / ASCII / ANSI — all fine for a-z words
}

// Normalize before validating: drop comment and blank lines, lowercase (wallets
// often show Capitalized words), and strip anything that is not a letter or
// space, so a stray label, list-numbering ("1." "2)"), comma, or quote falls
// away. BIP-39 English words are all lowercase a-z, so this only removes junk.
const words = readPhraseText(mnemonicFile)
  .replace(/^﻿/, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .join(' ')
  .toLowerCase()
  .replace(/[^a-z\s]/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

if (words.length === 0) {
  console.error(`${mnemonicFile} has no phrase in it (only blanks/comments).`);
  process.exit(1);
}

// Locate the actual phrase inside whatever was pasted. Naming "bad" tokens is
// unreliable — the most common label, "Secret Key:", is two *valid* BIP-39 words
// ("secret" and "key" are both in the list), so it counts toward the total
// rather than standing out, which is exactly how a 12-word phrase reads as 14.
//
// A real phrase is instead a contiguous run of 12/15/18/21/24 words that passes
// the BIP-39 checksum; a label, numbering, or trailing note around it does not.
// So find the unique valid run and use it. Longer lengths are tried first so a
// genuine 24-word phrase is never mistaken for a 12-word run that happens to sit
// inside it. Requiring the run to be UNIQUE means we never silently guess
// between two candidates — a wrong guess would derive a key for an account that
// owns nothing, with no error to show for it.
const BIP39_LENGTHS = [24, 21, 18, 15, 12];

let mnemonic = null;
let dropped = null;

if (BIP39_LENGTHS.includes(words.length) && validateMnemonic(words.join(' '), wordlist)) {
  mnemonic = words.join(' '); // The file is exactly the phrase — the common case.
} else {
  for (const len of BIP39_LENGTHS) {
    if (words.length < len) continue;
    const starts = [];
    for (let start = 0; start + len <= words.length; start++) {
      if (validateMnemonic(words.slice(start, start + len).join(' '), wordlist)) starts.push(start);
    }
    if (starts.length === 1) {
      const start = starts[0];
      mnemonic = words.slice(start, start + len).join(' ');
      dropped = [...words.slice(0, start), ...words.slice(start + len)];
      break;
    }
    if (starts.length > 1) {
      console.error(`Found ${starts.length} separate valid ${len}-word phrases in ${mnemonicFile}.`);
      console.error('Leave ONLY the seed words in the file — no label, no second phrase — and re-run.');
      process.exit(1);
    }
  }
}

if (!mnemonic) {
  // Nothing salvageable. Give the most useful diagnostic the tokens allow.
  const WORDSET = new Set(wordlist);
  const stray = [...new Set(words.filter((w) => !WORDSET.has(w)))];
  console.error(`No valid BIP-39 phrase found in ${mnemonicFile} (${words.length} tokens).`);
  if (stray.length > 0) {
    console.error(`Not BIP-39 words: ${stray.join(', ')} — likely a label or numbering.`);
    console.error('If you pasted the encrypted `e96Ph…` blob, decrypt it to words first:');
    console.error('  clarinet deployments decrypt --encrypted-mnemonic <blob>');
  } else {
    console.error('Every token is a real word, but no run of 12/15/18/21/24 passes the');
    console.error('checksum — a word is out of order or mistyped for another real word.');
  }
  process.exit(1);
}

if (dropped && dropped.length > 0) {
  // Report, don't hide: the operator should see the file had extra text so they
  // can confirm the phrase we locked onto is the one they meant.
  console.log(`ignored ${dropped.length} non-phrase token(s): ${dropped.join(', ')}`);
}

const seed = mnemonicToSeedSync(mnemonic);
const child = HDKey.fromMasterSeed(seed).derive("m/44'/5757'/0'/0/0");
if (!child.privateKey) {
  console.error('Derivation produced no private key.');
  process.exit(1);
}

// Stacks expects 33 bytes: the 32-byte key plus a 0x01 compression suffix — the
// same shape derive-deployer-key.mjs produces, so both keys look alike in .env.
const privateKey = Buffer.from(child.privateKey).toString('hex') + '01';
const address = privateKeyToAddress(privateKey, network);

console.log(`network:  ${network}`);
console.log(`phrase:   ${mnemonicFile}`);
console.log(`address:  ${address}`);
console.log(`path:     m/44'/5757'/0'/0/0`);

// Read .env once — needed to warn about a collision and to write. It should
// already exist (set-env / derive-deployer have run); tolerate its absence.
const envPath = resolve(ROOT, '.env');
const envExists = existsSync(envPath);
let env = envExists ? readFileSync(envPath, 'utf8') : '';
const hadBom = env.startsWith('﻿');
env = env.replace(/^﻿/, '');

function readVar(key) {
  return env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
}

const ownerAddress = readVar('OWNER_ADDRESS');
const deployerAddress = readVar('STACKS_DEPLOYER_ADDRESS');
if (address === ownerAddress || address === deployerAddress) {
  console.log('');
  console.log('WARNING: this oracle address is the SAME as the owner/deployer account.');
  console.log('The separation in 02-architecture.md#7 exists so a compromise of the API');
  console.log('process (which holds the oracle key) cannot reach the revenue/fund-pool');
  console.log('owner key. Same account means one compromise costs both. If you meant to');
  console.log('run one key for an MVP, `scripts/set-env.mjs --oracle-is-owner` is the');
  console.log('supported, explicit way to do it — you do not need this script for that.');
}

if (!WRITE) {
  console.log('');
  console.log('Nothing written. Re-run with --write to set ORACLE_PRIVATE_KEY in .env.');
  console.log(`Then delete the phrase file:  rm ${mnemonicFile}`);
  process.exit(0);
}

/**
 * Replace `KEY=` in place if present, append otherwise — same rule as the
 * deployer script: the .env comments document which key does what, so a second
 * appended line that silently wins would be a trap.
 */
function setVar(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(env)) env = env.replace(pattern, `${key}=${value}`);
  else env = env.replace(/\s*$/, `\n${key}=${value}\n`);
}

setVar('ORACLE_PRIVATE_KEY', privateKey);
setVar('ORACLE_ADDRESS', address);

writeFileSync(envPath, (hadBom ? '﻿' : '') + env, 'utf8');

console.log(`
Wrote to .env (the key itself was never printed):
  ORACLE_PRIVATE_KEY        <32-byte key + 01 suffix, redacted>
  ORACLE_ADDRESS            ${address}

Next:
  1. Delete the phrase file:  rm ${mnemonicFile}
  2. Copy ORACLE_PRIVATE_KEY from .env into Vercel (API project → Settings →
     Environment Variables → Production). It is 66 hex chars, only 0-9a-f.
  3. Fund ${address} with a little STX — the oracle pays its own tx fees on
     commit-seed / reveal-and-resolve.
  4. Register it on chain so attestations verify: point the contract's oracle at
     this address (the set-oracle call in \`npm run seed\`).
`);
