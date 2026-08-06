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
import {
  CONTRACT_NAMES,
  DEPLOY_ORDER,
  PAID_DUNGEON_GATE_FEE_USTX,
  SEED_DUNGEONS,
  SEED_RECIPES,
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
