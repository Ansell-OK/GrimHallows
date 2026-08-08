#!/usr/bin/env node
/**
 * Point `game-core` at the key the backend actually signs with.
 *
 *   npm run set-oracle -- --confirm
 *
 * Without --confirm it prints what it would change and exits.
 *
 * WHY THIS SCRIPT EXISTS. `commit-seed` and `reveal-and-resolve` both assert
 * `tx-sender == (var-get oracle)`, and that var is set once at deploy to the
 * deployer. Rotating the backend to its own oracle key — which is the point of
 * `derive-oracle-key.mjs`, and of keeping ORACLE_PRIVATE_KEY separate from
 * OWNER_PRIVATE_KEY at all — is therefore two steps, and only one of them is
 * writing a `.env` file. Skip this one and the backend signs perfectly valid
 * transactions that the contract rejects.
 *
 * IT FAILS QUIETLY WHEN IT FAILS, which is the reason this is a script with a
 * read-back rather than a line in a runbook. `broadcastTransaction` succeeds —
 * the node accepts the transaction — and the `asserts!` fires later, on chain,
 * as `(err u201)`. Nothing in the request path re-reads it, so a mismatch looks
 * exactly like a working deployment right up until someone opens the explorer.
 * On mainnet this shipped: six consecutive oracle transactions aborted with
 * u201 while the database recorded their runs as resolved.
 *
 * WHAT IT DOES NOT DO. It moves no STX (only the transaction fee), and it does
 * not touch minter rights, dungeons, recipes, or the sponsor pool — `npm run
 * seed` owns those. Changing the oracle is reversible by running it again, but
 * it is not free: runs committed under the old oracle can only be revealed by
 * the old oracle, because the contract checks the caller at reveal time, not at
 * commit time. Rotate when nothing is mid-run.
 *
 * Run through npm, not bare `node`: this imports @grimhallow/shared, which the
 * workspace exports as TypeScript source, so it needs tsx as its loader.
 */

import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  broadcastTransaction,
  fetchCallReadOnlyFunction,
  cvToString,
  makeContractCall,
  PostConditionMode,
  principalCV,
  privateKeyToAddress,
} from '@stacks/transactions';
import { CONTRACT_NAMES, explorerTxUrl, formatStx, getNetworkConfig } from '@grimhallow/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');

const networkName = (process.env.STACKS_NETWORK || 'testnet').trim();
const network = networkName === 'mainnet' ? 'mainnet' : 'testnet';
const netCfg = getNetworkConfig(networkName, {
  deployer: process.env.STACKS_DEPLOYER_ADDRESS,
  apiUrl: process.env.STACKS_API_URL,
});

const ownerKey = process.env.OWNER_PRIVATE_KEY?.trim();
if (!ownerKey) {
  console.error('Missing OWNER_PRIVATE_KEY in .env — only the contract owner can set the oracle.');
  process.exit(1);
}
const ownerAddress = privateKeyToAddress(ownerKey, networkName);

/**
 * The principal to install.
 *
 * `--oracle <address>` overrides ORACLE_ADDRESS so this can be pointed at a key
 * the workstation does not hold. Deriving it from ORACLE_PRIVATE_KEY instead
 * would mean the machine that rotates the oracle has to hold the oracle's
 * secret, which is the arrangement this whole split exists to avoid.
 */
const oracleFlag = args.indexOf('--oracle');
const target = (
  oracleFlag >= 0 ? args[oracleFlag + 1] : process.env.ORACLE_ADDRESS || ''
).trim();

if (!/^S[0-9A-Z]{38,40}$/.test(target)) {
  console.error(
    `Oracle principal "${target || '(unset)'}" is not a Stacks address.\n` +
      'Set ORACLE_ADDRESS in .env (derive-oracle-key.mjs writes it) or pass --oracle <address>.',
  );
  process.exit(1);
}

// The contract asserts `tx-sender == CONTRACT-OWNER`, which is whoever deployed
// it. Checking here turns a wasted fee and an `(err u200)` on the explorer into
// a message before anything is signed.
if (ownerAddress !== netCfg.deployer) {
  console.error(
    `OWNER_PRIVATE_KEY is ${ownerAddress}, but ${CONTRACT_NAMES.gameCore} was deployed by\n` +
      `${netCfg.deployer} and only the deployer can call set-oracle. Refusing to broadcast.`,
  );
  process.exit(1);
}

async function readOnly(fn, args = []) {
  return fetchCallReadOnlyFunction({
    contractAddress: netCfg.deployer,
    contractName: CONTRACT_NAMES.gameCore,
    functionName: fn,
    functionArgs: args,
    senderAddress: netCfg.deployer,
    network,
    client: { baseUrl: netCfg.apiUrl },
  });
}

const current = cvToString(await readOnly('get-oracle'));

console.log(`network:  ${networkName}`);
console.log(`contract: ${netCfg.deployer}.${CONTRACT_NAMES.gameCore}`);
console.log(`owner:    ${ownerAddress}`);
console.log(`oracle:   ${current}  ->  ${target}`);

if (current === target) {
  console.log('\nAlready set. Nothing to do.');
  process.exit(0);
}

// The new oracle pays its own transaction fees from here on. An oracle with an
// empty balance cannot commit or reveal anything, and that failure looks like a
// different bug entirely — so it is worth one read before the switch, not after.
const balances = await fetch(
  `${netCfg.apiUrl}/extended/v1/address/${target}/balances`,
)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const balanceUstx = BigInt(balances?.stx?.balance ?? '0');

// Six decimals, not the default two: a fee balance is spent in fractions of a
// STX, and rounding 0.004 up to "0.00" would read as unfunded when it is not.
console.log(`\nThe new oracle holds ${formatStx(balanceUstx, 6)} STX for transaction fees.`);
if (balanceUstx === 0n) {
  console.log(
    'WARNING: that is nothing. It cannot commit or reveal a single run until it is funded.',
  );
}

console.log(
  '\nAfter this, only the new oracle can commit and reveal runs. Any run already\n' +
    'committed under the old oracle becomes unrevealable — the contract checks the\n' +
    'caller at reveal time. Make sure nothing is mid-run.',
);

if (!confirmed) {
  console.log('\nNot broadcast. Re-run with --confirm to actually send it.');
  process.exit(0);
}

const tx = await makeContractCall({
  contractAddress: netCfg.deployer,
  contractName: CONTRACT_NAMES.gameCore,
  functionName: 'set-oracle',
  functionArgs: [principalCV(target)],
  senderKey: ownerKey,
  network,
  client: { baseUrl: netCfg.apiUrl },
  // Nothing moves. Deny with no conditions says exactly that: if this call
  // somehow transferred an asset, it would abort instead of settling.
  postConditionMode: PostConditionMode.Deny,
  postConditions: [],
});

const result = await broadcastTransaction({
  transaction: tx,
  network,
  client: { baseUrl: netCfg.apiUrl },
});

if (!('txid' in result) || result.error) {
  console.error(`FAILED: ${result.error ?? ''} ${result.reason ?? ''}`.trim());
  process.exit(1);
}

console.log(`\nBroadcast: ${result.txid}`);
console.log(explorerTxUrl(netCfg, result.txid));
console.log(
  '\nBroadcast is not settlement. Wait for the transaction to confirm, then run\n' +
    '`npm run verify-seed` and check the oracle line reads ok before playing a run.',
);
