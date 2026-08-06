#!/usr/bin/env node
/**
 * Read back what seeding actually wrote, from chain.
 *
 * `npm run seed` reporting eight successes means eight transactions were
 * accepted, not that the contracts are in the state the game needs — a
 * `set-minter` that confirmed against the wrong principal looks identical from
 * the receipt. This asks the contracts themselves.
 *
 *   npm run verify-seed
 *
 * Read-only: no key is loaded and nothing is broadcast.
 */

import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClarityType,
  contractPrincipalCV,
  cvToString,
  fetchCallReadOnlyFunction,
  uintCV,
} from '@stacks/transactions';
import {
  CONTRACT_NAMES,
  FREE_DUNGEON_ID,
  PAID_DUNGEON_ID,
  SEED_RECIPES,
  formatStx,
  getNetworkConfig,
} from '@grimhallow/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });

const networkName = (process.env.STACKS_NETWORK || 'testnet').trim();
const network = networkName === 'mainnet' ? 'mainnet' : 'testnet';
const netCfg = getNetworkConfig(networkName, {
  deployer: process.env.STACKS_DEPLOYER_ADDRESS,
  apiUrl: process.env.STACKS_API_URL,
});
const deployer = netCfg.deployer;

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  console.log(`       ${ok ? actual : `got ${actual}, want ${expected}`}`);
}

async function readOnly(contract, fn, args = []) {
  return fetchCallReadOnlyFunction({
    contractAddress: deployer,
    contractName: contract,
    functionName: fn,
    functionArgs: args,
    senderAddress: deployer,
    network,
  });
}

/** Unwrap (ok x) / (some x) so callers compare against the inner value. */
function unwrap(cv) {
  let v = cv;
  while (
    v.type === ClarityType.ResponseOk ||
    v.type === ClarityType.OptionalSome
  ) {
    v = v.value;
  }
  return v;
}

console.log(`network:  ${networkName}`);
console.log(`deployer: ${deployer}\n`);

// --- Minter rights: the thing that gates loot existing at all -------------
console.log('character-loot-nft minter rights');
for (const [key, want] of [
  ['gameCore', true],
  ['forgeV2', true],
  // v1 forge must stay unauthorized forever. It charges no fee and cannot be
  // withdrawn from chain, so minter rights are the only thing keeping it inert.
  ['forge', false],
]) {
  const cv = await readOnly(CONTRACT_NAMES.characterLootNft, 'is-authorized-minter', [
    contractPrincipalCV(deployer, CONTRACT_NAMES[key]),
  ]);
  const actual = unwrap(cv).type === ClarityType.BoolTrue;
  check(`${CONTRACT_NAMES[key]} can mint loot`, String(actual), String(want));
}

// --- Oracle --------------------------------------------------------------
console.log('\ngame-core oracle');
const oracleCv = await readOnly(CONTRACT_NAMES.gameCore, 'get-oracle');
const oracle = cvToString(unwrap(oracleCv));
const expectedOracle = (process.env.ORACLE_ADDRESS || '').trim() || deployer;
check('oracle principal matches ORACLE_ADDRESS', oracle, expectedOracle);
if (oracle === deployer) {
  console.log(
    '       NOTE: oracle == deployer == owner. One key signs reveals, receives\n' +
      '       all revenue, and can fund-pool. Temporary by operator decision.',
  );
}

// --- Dungeons ------------------------------------------------------------
console.log('\ngame-core dungeons');
for (const [id, wantFee, wantPaid] of [
  [PAID_DUNGEON_ID, 1_000_000n, true],
  [FREE_DUNGEON_ID, 0n, false],
]) {
  const cv = unwrap(await readOnly(CONTRACT_NAMES.gameCore, 'get-dungeon', [uintCV(id)]));
  if (cv.type !== ClarityType.Tuple) {
    failures += 1;
    console.log(`FAIL dungeon ${id} exists`);
    console.log(`       got ${cvToString(cv)} — create-dungeon did not land`);
    continue;
  }
  const fee = cv.value['gate-fee'] ?? cv.value['gate-fee-ustx'];
  const paid = cv.value['is-paid'] ?? cv.value['paid'];
  check(`dungeon ${id} gate fee`, String(fee?.value), String(wantFee));
  check(
    `dungeon ${id} is-paid`,
    String(paid?.type === ClarityType.BoolTrue),
    String(wantPaid),
  );
}

// --- Recipes -------------------------------------------------------------
console.log('\nforge-v2 recipes');
for (const r of SEED_RECIPES) {
  const cv = unwrap(await readOnly(CONTRACT_NAMES.forgeV2, 'get-recipe', [uintCV(r.id)]));
  if (cv.type !== ClarityType.Tuple) {
    failures += 1;
    console.log(`FAIL recipe ${r.id} exists`);
    console.log(`       got ${cvToString(cv)} — create-recipe did not land`);
    continue;
  }
  const fee = cv.value['stx-fee'] ?? cv.value['stx-fee-ustx'];
  check(
    `recipe ${r.id}: ${r.inputCount}x tier ${r.inputTier} -> ${r.outputTier}, fee`,
    `${formatStx(BigInt(fee?.value ?? 0))} STX`,
    `${formatStx(r.stxFeeUstx)} STX`,
  );
  check(
    `recipe ${r.id} output tier`,
    String(cv.value['output-tier']?.value),
    String(r.outputTier),
  );
}

// --- The invariant the whole economy rests on ----------------------------
console.log('\nsponsor pool');
const poolCv = unwrap(await readOnly(CONTRACT_NAMES.gameCore, 'get-sponsor-pool'));
const pool = BigInt(poolCv.value);
console.log(`     ${formatStx(pool)} STX`);
if (pool === 0n) {
  console.log(
    '     Seeding did not credit it, which is correct — only fund-pool may.\n' +
      '     A paid run will resolve to no payout until you fund it.',
  );
}

// --- character-nft -------------------------------------------------------
console.log('\ncharacter-nft');
const priceCv = unwrap(await readOnly(CONTRACT_NAMES.characterNft, 'get-mint-price'));
console.log(`     mint price  ${formatStx(BigInt(priceCv.value))} STX`);
const pausedCv = unwrap(await readOnly(CONTRACT_NAMES.characterNft, 'is-mint-paused'));
console.log(`     paused      ${pausedCv.type === ClarityType.BoolTrue}`);

console.log(
  failures === 0
    ? '\nAll seeded state verified on chain.'
    : `\n${failures} check(s) FAILED — see above.`,
);
process.exit(failures === 0 ? 0 : 1);
