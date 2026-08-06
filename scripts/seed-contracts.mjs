#!/usr/bin/env node
/**
 * Post-deploy seeding for GrimHallow's contracts.
 *
 * The contracts are inert as deployed: character-loot-nft trusts nobody to
 * mint, game-core has no dungeons and points its oracle at the deployer, and
 * forge-v2 has no recipes. This script performs the owner transactions that wire
 * them together, in the one order that works, driven entirely by the constants
 * in packages/shared/src/contracts.ts so the on-chain ids are predictable.
 *
 *   1. character-loot-nft.set-minter(<deployer>.game-core, true)
 *   2. character-loot-nft.set-minter(<deployer>.forge-v2, true)
 *   3. game-core.set-oracle(<oracle address>)
 *   4. game-core.create-dungeon(...)     x SEED_DUNGEONS
 *   5. forge-v2.create-recipe(...)       x SEED_RECIPES
 *
 * NOTE ON forge v1: the deployed forge.clar charges no STX fee and is
 * superseded by forge-v2. It is deliberately never authorized to mint — minter
 * rights are the only thing gating it, and a Clarity contract cannot be
 * withdrawn once deployed. See the comment on that call below.
 *
 * character-nft needs no seeding: its mint price is set in the contract and it
 * has no minter to authorize.
 *
 * DELIBERATELY NOT HERE: fund-pool. Crediting the sponsor pool moves real STX
 * out of the owner's wallet, and doing it as a side effect of deployment is
 * exactly the kind of implicit money movement this project's economic model
 * forbids. Use `npm run fund-pool -- <stx>` when you actually mean to.
 *
 * Signs with OWNER_PRIVATE_KEY only. The oracle key is never read here.
 *
 *   npm run seed -- --dry-run
 *   npm run seed
 *
 * Run through npm, not bare `node`: this imports @grimhallow/shared, which the
 * workspace exports as TypeScript source, so it needs tsx as its loader.
 */

import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnchorMode,
  broadcastTransaction,
  boolCV,
  fetchNonce,
  makeContractCall,
  principalCV,
  privateKeyToAddress,
  PostConditionMode,
  stringAsciiCV,
  uintCV,
} from '@stacks/transactions';
import {
  CHARACTER_MINT_PRICE_USTX,
  CONTRACT_NAMES,
  SEED_DUNGEONS,
  SEED_RECIPES,
  formatStx,
  getNetworkConfig,
} from '@grimhallow/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });

const DRY_RUN = process.argv.includes('--dry-run');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

const networkName = (process.env.STACKS_NETWORK || 'testnet').trim();
if (networkName === 'devnet') {
  console.error(
    'Refusing to run against devnet: seed devnet through Clarinet instead.',
  );
  process.exit(1);
}

const ownerKey = required('OWNER_PRIVATE_KEY');
const ownerAddress = privateKeyToAddress(ownerKey, networkName);

// The oracle ADDRESS is derived from its own key if present, but an explicit
// ORACLE_ADDRESS wins - the machine running deployments should not need the
// oracle's private key at all.
const oracleAddress =
  process.env.ORACLE_ADDRESS?.trim() ||
  (process.env.ORACLE_PRIVATE_KEY?.trim()
    ? privateKeyToAddress(process.env.ORACLE_PRIVATE_KEY.trim(), networkName)
    : null);

if (!oracleAddress) {
  console.error('Set ORACLE_ADDRESS (preferred) or ORACLE_PRIVATE_KEY in .env');
  process.exit(1);
}

if (oracleAddress === ownerAddress) {
  // Not fatal - one operator runs both for MVP - but the whole point of the
  // split is that a compromised oracle cannot also fund-pool or create-dungeon.
  console.warn(
    'WARNING: the oracle and owner are the same principal. The key separation ' +
      'in 02-architecture.md #7 assumes two distinct accounts.',
  );
}

const netCfg = getNetworkConfig(networkName, {
  deployer: process.env.STACKS_DEPLOYER_ADDRESS,
  apiUrl: process.env.STACKS_API_URL,
});
const deployer = netCfg.deployer;

if (deployer !== ownerAddress) {
  // CONTRACT-OWNER is bound to tx-sender at deploy time, so only the deploying
  // principal can pass the owner-only asserts.
  console.error(
    `The owner key resolves to ${ownerAddress}, but the contracts were ` +
      `deployed by ${deployer}. Only the deployer can call these functions.`,
  );
  process.exit(1);
}

const network = networkName === 'mainnet' ? 'mainnet' : 'testnet';

/** The seed transactions, in the only order that satisfies their dependencies. */
const calls = [
  {
    label: 'authorize game-core to mint loot',
    contract: CONTRACT_NAMES.characterLootNft,
    fn: 'set-minter',
    args: [principalCV(`${deployer}.${CONTRACT_NAMES.gameCore}`), boolCV(true)],
  },
  {
    // forge-v2, NOT forge. The deployed forge.clar takes no STX fee, and
    // authorizing it would leave a second, free forging path open forever —
    // minter rights are the only thing gating it, and Clarity contracts cannot
    // be withdrawn. It has never been authorized (mainnet has had zero contract
    // calls since deploy), so the migration is simply not granting it, which
    // costs one fewer transaction than granting and revoking.
    label: 'authorize forge-v2 to mint and burn loot',
    contract: CONTRACT_NAMES.characterLootNft,
    fn: 'set-minter',
    args: [principalCV(`${deployer}.${CONTRACT_NAMES.forgeV2}`), boolCV(true)],
  },
  {
    label: `point game-core's oracle at ${oracleAddress}`,
    contract: CONTRACT_NAMES.gameCore,
    fn: 'set-oracle',
    args: [principalCV(oracleAddress)],
  },
  ...SEED_DUNGEONS.map((d) => ({
    label: `create dungeon ${d.id}: ${d.label}`,
    contract: CONTRACT_NAMES.gameCore,
    fn: 'create-dungeon',
    args: [uintCV(d.gateFeeUstx), boolCV(d.isPaid)],
  })),
  ...SEED_RECIPES.map((r) => ({
    label:
      `create recipe ${r.id}: ${r.inputCount}x tier ${r.inputTier} -> tier ${r.outputTier} ` +
      `(${formatStx(r.stxFeeUstx)} STX)`,
    contract: CONTRACT_NAMES.forgeV2,
    fn: 'create-recipe',
    args: [
      uintCV(r.inputTier),
      uintCV(r.inputCount),
      uintCV(r.outputTier),
      stringAsciiCV(r.outputUri),
      uintCV(r.stxFeeUstx),
    ],
  })),
];

// character-nft needs no seeding at all: its mint price is initialised to
// CHARACTER_MINT_PRICE_USTX in the contract itself and it has no minter to
// authorize. Verified rather than assumed, because a mismatch would have the UI
// quoting one price while the contract charged another.
if (CHARACTER_MINT_PRICE_USTX !== 1_000_000n) {
  calls.push({
    label: `set character mint price to ${formatStx(CHARACTER_MINT_PRICE_USTX)} STX`,
    contract: CONTRACT_NAMES.characterNft,
    fn: 'set-mint-price',
    args: [uintCV(CHARACTER_MINT_PRICE_USTX)],
  });
}

console.log(`network:  ${networkName}`);
console.log(`deployer: ${deployer}`);
console.log(`oracle:   ${oracleAddress}`);
console.log(`${calls.length} transactions to broadcast\n`);

if (DRY_RUN) {
  for (const [i, c] of calls.entries()) {
    console.log(`${i + 1}. ${c.contract}.${c.fn} - ${c.label}`);
  }
  console.log('\nDry run: nothing broadcast.');
  process.exit(0);
}

// Nonces are assigned locally rather than refetched per call: these go out
// back to back and the node would still be reporting the pre-broadcast nonce.
let nonce = await fetchNonce({ address: ownerAddress, network });

for (const [i, call] of calls.entries()) {
  const label = `${i + 1}/${calls.length} ${call.contract}.${call.fn}`;
  try {
    const tx = await makeContractCall({
      contractAddress: deployer,
      contractName: call.contract,
      functionName: call.fn,
      functionArgs: call.args,
      senderKey: ownerKey,
      network,
      nonce,
      anchorMode: AnchorMode.Any,
      // None of these move STX, so there is nothing to constrain. fund-pool,
      // which does, sets an explicit post-condition in its own script.
      postConditionMode: PostConditionMode.Deny,
    });

    const result = await broadcastTransaction({ transaction: tx, network });
    if (result.error) {
      console.error(`${label} FAILED: ${result.error} ${result.reason ?? ''}`);
      console.error(`  ${call.label}`);
      process.exit(1);
    }

    console.log(`${label} ok  ${result.txid}`);
    console.log(`   ${call.label}`);
    nonce += 1n;
  } catch (err) {
    console.error(`${label} FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

console.log(`
All ${calls.length} seed transactions broadcast. They confirm in the order sent.
Watch them at ${netCfg.explorerUrl}/address/${deployer}?chain=${network}

The sponsor pool is still empty - that is intentional. Fund it deliberately:
  npm run fund-pool -- <stx amount>
`);
