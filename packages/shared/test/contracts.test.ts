/**
 * Address-resolution tests.
 *
 * This module is the single source of truth for deployed contract addresses, so
 * the failure mode it has to guard against is a config that looks fine and is
 * pointed at the wrong chain. `contractId()` will happily build a
 * well-formed-looking identifier out of any principal, so a deployer belonging
 * to another network doesn't throw anywhere — reads just come back empty and
 * unsigned txs get built against a contract that isn't there.
 *
 * That is not hypothetical: setting STACKS_DEPLOYER_ADDRESS to the mainnet
 * deployer while STACKS_NETWORK was still `devnet` is exactly how the
 * /characters loot-exclusion check silently stopped matching. Hence the prefix
 * check, and hence this file.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSET_NAMES,
  CONTRACT_NAMES,
  DEPLOY_ORDER,
  PAID_DUNGEON_GATE_FEE_USTX,
  SEED_DUNGEONS,
  SEED_RECIPES,
  assetIdentifier,
  contractId,
  getNetworkConfig,
} from '../src/index.js';

const MAINNET_DEPLOYER = 'SP1MNXD30JHNT2Y0P8KZ06J43ACCH27N3BTBZ90AR';

describe('getNetworkConfig', () => {
  it('resolves the recorded mainnet deployer with no override', () => {
    expect(getNetworkConfig('mainnet').deployer).toBe(MAINNET_DEPLOYER);
  });

  it('resolves the devnet deployer with no override', () => {
    expect(getNetworkConfig('devnet').deployer).toMatch(/^ST/);
  });

  it('lets an override replace the compiled-in deployer', () => {
    const cfg = getNetworkConfig('devnet', { deployer: 'ST000000000000000000002AMW42H' });
    expect(cfg.deployer).toBe('ST000000000000000000002AMW42H');
  });

  it('ignores a blank override rather than treating it as unset-and-fatal', () => {
    expect(getNetworkConfig('mainnet', { deployer: '   ' }).deployer).toBe(MAINNET_DEPLOYER);
  });

  it('refuses a mainnet principal on devnet', () => {
    expect(() => getNetworkConfig('devnet', { deployer: MAINNET_DEPLOYER })).toThrow(
      /not a devnet principal/,
    );
  });

  it('refuses a mainnet principal on testnet', () => {
    expect(() => getNetworkConfig('testnet', { deployer: MAINNET_DEPLOYER })).toThrow(
      /not a testnet principal/,
    );
  });

  it('refuses a testnet principal on mainnet — the expensive direction', () => {
    expect(() =>
      getNetworkConfig('mainnet', { deployer: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM' }),
    ).toThrow(/not a mainnet principal/);
  });

  it('accepts multisig prefixes on both sides', () => {
    expect(() => getNetworkConfig('mainnet', { deployer: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTVN' })).not.toThrow();
    expect(() => getNetworkConfig('devnet', { deployer: 'SN3VDXK3WZZSA84XXFKAFAF15NNZX32CTVN' })).not.toThrow();
  });

  it('still reports an unset deployer as unset, not as a bad prefix', () => {
    expect(() => getNetworkConfig('testnet')).toThrow(/No deployer address configured/);
  });

  it('rejects an unknown network', () => {
    // @ts-expect-error — deliberately outside the union, since env parsing is stringly-typed.
    expect(() => getNetworkConfig('stagingnet')).toThrow(/Unknown network/);
  });
});

describe('contractId', () => {
  it('qualifies every contract against the resolved deployer', () => {
    const cfg = getNetworkConfig('mainnet');
    for (const key of DEPLOY_ORDER) {
      expect(contractId(cfg, key)).toBe(`${MAINNET_DEPLOYER}.${CONTRACT_NAMES[key]}`);
    }
  });
});

/**
 * SIP-009 asset names, pinned against the contracts that declare them.
 *
 * These are read straight out of the `.clar` sources rather than restated here,
 * because a copy of a constant is only as good as the day it was copied. The
 * failure this guards is quiet in a way most config mistakes are not: Hiro's NFT
 * routes key on `contract-id::asset-name`, and a wrong asset name is not an error
 * but an EMPTY RESULT SET. A token's whole history comes back as "no history",
 * which the mint-seed lookup reads as "not confirmed yet" and degrades on — so
 * every minted character would silently lose its rarity floor, forever, with
 * nothing anywhere reporting a fault.
 *
 * The names are also not derivable: a contract called `character-nft` declares an
 * asset called `grimhallow-character`.
 */
describe('asset names', () => {
  /** Every `define-non-fungible-token` name in a contract source. */
  function declaredAssets(contractName: string): string[] {
    const source = readFileSync(
      fileURLToPath(new URL(`../../../contracts/contracts/${contractName}.clar`, import.meta.url)),
      'utf8',
    );
    return [...source.matchAll(/\(define-non-fungible-token\s+([a-zA-Z0-9-]+)/g)].map((m) => m[1]);
  }

  it('matches what each contract actually declares', () => {
    for (const [key, assetName] of Object.entries(ASSET_NAMES)) {
      const contractName = CONTRACT_NAMES[key as keyof typeof CONTRACT_NAMES];
      expect(declaredAssets(contractName)).toContain(assetName);
    }
  });

  it('is not merely the contract name, which is why it has to be recorded', () => {
    // If these ever coincided, the constant would look redundant and be at risk
    // of someone "simplifying" it away.
    expect(ASSET_NAMES.characterNft).not.toBe(CONTRACT_NAMES.characterNft);
    expect(ASSET_NAMES.characterNft).toBe('grimhallow-character');
  });

  it('builds the `contract::asset` form Hiro expects', () => {
    const cfg = getNetworkConfig('mainnet');
    expect(assetIdentifier(cfg, 'characterNft')).toBe(
      `${MAINNET_DEPLOYER}.character-nft::grimhallow-character`,
    );
  });
});

describe('seed configuration', () => {
  it('gates dungeon 1 at exactly 1 STX and leaves dungeon 2 free', () => {
    const [paid, free] = SEED_DUNGEONS;
    expect(paid.isPaid).toBe(true);
    expect(paid.gateFeeUstx).toBe(PAID_DUNGEON_GATE_FEE_USTX);
    expect(paid.gateFeeUstx).toBe(1_000_000n);
    expect(free.isPaid).toBe(false);
    expect(free.gateFeeUstx).toBe(0n);
  });

  it('ladders the forge recipes 1->2, 2->3, 3->4 with no gaps', () => {
    expect(SEED_RECIPES.map((r) => [r.inputTier, r.outputTier])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(SEED_RECIPES.every((r) => r.inputCount === 3)).toBe(true);
  });
});
