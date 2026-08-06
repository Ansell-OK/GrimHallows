#!/usr/bin/env node
/**
 * Credit the sponsor pool.
 *
 * This is the ONLY way the prize pool ever grows. It is a deliberate, manual,
 * owner-signed transaction that moves real STX out of your wallet - never a
 * side effect of a deployment, an entry fee, or anything else. If you are
 * looking for the code that tops the pool up automatically from entry revenue,
 * it does not exist and must not be added; see the README's two-money-flows
 * table and docs/03-smart-contracts-spec.md sections 2-3.
 *
 *   npm run fund-pool -- <stx amount> --confirm
 *
 * Without --confirm it prints what it would do and exits.
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
  makeContractCall,
  Pc,
  PostConditionMode,
  privateKeyToAddress,
  uintCV,
} from '@stacks/transactions';
import {
  CONTRACT_NAMES,
  MICROSTX_PER_STX,
  getNetworkConfig,
} from '@grimhallow/shared';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const amountStx = Number(args.find((a) => !a.startsWith('--')));

if (!Number.isFinite(amountStx) || amountStx <= 0) {
  console.error('Usage: npm run fund-pool -- <stx amount> --confirm');
  process.exit(1);
}

const amountUstx = BigInt(Math.round(amountStx * Number(MICROSTX_PER_STX)));

const networkName = (process.env.STACKS_NETWORK || 'testnet').trim();
const ownerKey = process.env.OWNER_PRIVATE_KEY?.trim();
if (!ownerKey) {
  console.error('Missing OWNER_PRIVATE_KEY in .env');
  process.exit(1);
}

const ownerAddress = privateKeyToAddress(ownerKey, networkName);
const netCfg = getNetworkConfig(networkName, {
  deployer: process.env.STACKS_DEPLOYER_ADDRESS,
  apiUrl: process.env.STACKS_API_URL,
});
const network = networkName === 'mainnet' ? 'mainnet' : 'testnet';
const target = `${netCfg.deployer}.${CONTRACT_NAMES.gameCore}`;

console.log(`network: ${networkName}`);
console.log(`from:    ${ownerAddress}`);
console.log(`to:      ${target} (sponsor pool)`);
console.log(`amount:  ${amountStx} STX (${amountUstx} uSTX)`);
console.log('\nThis STX leaves your wallet and becomes prize budget. It can only');
console.log('come back out as a jackpot payout to players.\n');

if (!confirmed) {
  console.log('Not broadcast. Re-run with --confirm to actually send it.');
  process.exit(0);
}

const tx = await makeContractCall({
  contractAddress: netCfg.deployer,
  contractName: CONTRACT_NAMES.gameCore,
  functionName: 'fund-pool',
  functionArgs: [uintCV(amountUstx)],
  senderKey: ownerKey,
  network,
  anchorMode: AnchorMode.Any,
  // Bound the transfer to exactly the stated amount: this is the one owner
  // action that moves money, so it does not go out unconstrained.
  postConditionMode: PostConditionMode.Deny,
  postConditions: [Pc.principal(ownerAddress).willSendEq(amountUstx).ustx()],
});

const result = await broadcastTransaction({ transaction: tx, network });
if (result.error) {
  console.error(`FAILED: ${result.error} ${result.reason ?? ''}`);
  process.exit(1);
}

console.log(`Broadcast: ${result.txid}`);
console.log(`${netCfg.explorerUrl}/txid/0x${result.txid}?chain=${network}`);
