/**
 * Unsigned transaction builder tests.
 *
 * This module is the boundary between "the backend decided something" and "the
 * player's wallet is about to move money". Two things are asserted throughout:
 *
 *   1. The post-conditions really say what the summary claims. They are decoded
 *      from hex, not trusted — the hex is the part the chain enforces, and a
 *      test that only read the human-readable fields would pass while the blob
 *      authorised something else.
 *   2. Nothing here can produce a signature. That is asserted structurally, by
 *      grepping the module's own source for signing imports, because a comment
 *      promising it does not survive a future edit.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deserializeCV, ClarityType } from '@stacks/transactions';
import { MAX_PARTY_SIZE, getNetworkConfig } from '@grimhallow/shared';
import {
  CHARACTER_URI_MAX_LENGTH,
  buildEnterDungeonTx,
  buildForgeTx,
  buildFundPoolTx,
  buildMintCharacterTx,
} from '../src/lib/txBuilder.js';
import {
  deserializePostCondition,
  type StxPostCondition,
} from './helpers/postConditions.js';

const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const OWNER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';
const OTHER = 'ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC';
const GATE_FEE = 1_000_000n;

const stacks = getNetworkConfig('devnet', { deployer: PLAYER });

const enter = (overrides: Partial<Parameters<typeof buildEnterDungeonTx>[0]> = {}) =>
  buildEnterDungeonTx({
    stacks,
    senderAddress: PLAYER,
    dungeonId: 1,
    party: [PLAYER],
    gateFeeUstx: GATE_FEE,
    ...overrides,
  });

function onlyPostCondition(tx: { postConditions: readonly string[] }): StxPostCondition {
  expect(tx.postConditions).toHaveLength(1);
  return deserializePostCondition(tx.postConditions[0]) as StxPostCondition;
}

describe('buildEnterDungeonTx', () => {
  it('targets game-core.enter-dungeon', () => {
    const tx = enter();
    expect(tx.contractName).toBe('game-core');
    expect(tx.functionName).toBe('enter-dungeon');
    expect(tx.contractAddress).toBe(PLAYER);
    expect(tx.network).toBe('devnet');
  });

  it('encodes the dungeon id and party as Clarity values the wallet can decode', () => {
    // Serialized here rather than in the browser: the browser is where a
    // tampered argument would be cheapest to introduce.
    const tx = enter({ dungeonId: 7, party: [PLAYER] });

    const id = deserializeCV(tx.functionArgs[0]);
    expect(id.type).toBe(ClarityType.UInt);
    expect(BigInt((id as { value: bigint }).value)).toBe(7n);

    const party = deserializeCV(tx.functionArgs[1]);
    expect(party.type).toBe(ClarityType.List);
    expect((party as { value: unknown[] }).value).toHaveLength(1);
  });

  describe('the post-condition', () => {
    it('pins the sender to exactly the gate fee, in deny mode', () => {
      const tx = enter();
      expect(tx.postConditionMode).toBe('deny');

      const pc = onlyPostCondition(tx);
      expect(pc.type).toBe('stx-postcondition');
      expect(pc.address).toBe(PLAYER);
      expect(pc.condition).toBe('eq');
      expect(pc.amount).toBe(GATE_FEE.toString());
    });

    it('is `eq`, not `lte` — the fee is exact, not a ceiling', () => {
      // `lte` would let the contract charge anything up to the fee, including a
      // split where part of it went somewhere the player never agreed to.
      expect(onlyPostCondition(enter()).condition).toBe('eq');
    });

    it('permits no second STX movement out of the player', () => {
      // THE INVARIANT: one condition in deny mode means a contract that also
      // took a "pool contribution" from the entrant aborts on chain.
      // 02-architecture.md#3, 03-smart-contracts-spec.md#2.
      const tx = enter();
      expect(tx.postConditions).toHaveLength(1);
      expect(tx.postConditionMode).toBe('deny');
    });

    it('tracks a changed gate fee rather than a hardcoded 1 STX', () => {
      const pc = onlyPostCondition(enter({ gateFeeUstx: 2_500_000n }));
      expect(pc.amount).toBe('2500000');
    });
  });

  describe('what it refuses to build', () => {
    it('refuses a zero or negative fee', () => {
      // A zero-fee post-condition asserts the player sends nothing — which then
      // passes while the contract takes the real fee.
      expect(() => enter({ gateFeeUstx: 0n })).toThrow(/positive/i);
      expect(() => enter({ gateFeeUstx: -1n })).toThrow(/positive/i);
    });

    it('refuses a party the sender is not in', () => {
      // The entrant pays; paying for a party you are not in is not an entry.
      expect(() => enter({ party: [OTHER] })).toThrow(/must be a member/i);
    });

    it('refuses an empty or oversized party', () => {
      expect(() => enter({ party: [] })).toThrow(/1\.\./);
      const tooMany = Array.from({ length: MAX_PARTY_SIZE + 1 }, () => PLAYER);
      expect(() => enter({ party: tooMany })).toThrow(/1\.\./);
    });

    it('refuses a non-positive or non-integer dungeon id', () => {
      for (const dungeonId of [0, -1, 1.5, Number.NaN]) {
        expect(() => enter({ dungeonId })).toThrow(/positive integer/i);
      }
    });
  });

  it('says in plain words that this is an entry fee, not a wager', () => {
    const summary = enter().summary;
    expect(summary).toMatch(/not a wager/i);
    expect(summary).toMatch(/does not fund the prize pool/i);
    expect(summary).toMatch(/non-refundable/i);
  });
});

describe('buildFundPoolTx', () => {
  const fund = (amountUstx = 5_000_000n) =>
    buildFundPoolTx({ stacks, ownerAddress: OWNER, amountUstx });

  it('targets game-core.fund-pool', () => {
    const tx = fund();
    expect(tx.contractName).toBe('game-core');
    expect(tx.functionName).toBe('fund-pool');
  });

  it('pins the owner sending exactly the amount, in deny mode', () => {
    const tx = fund(3_141_592n);
    expect(tx.postConditionMode).toBe('deny');

    const pc = onlyPostCondition(tx);
    expect(pc.address).toBe(OWNER);
    expect(pc.condition).toBe('eq');
    expect(pc.amount).toBe('3141592');
  });

  it('refuses a non-positive amount', () => {
    expect(() => fund(0n)).toThrow(/positive/i);
    expect(() => fund(-1n)).toThrow(/positive/i);
  });
});

describe('the two money flows stay separate', () => {
  it('are different functions signed by different principals', () => {
    // The entire economic model, asserted: a player pays a fee to the operator;
    // the operator, separately and deliberately, funds the prize pool. Neither
    // transaction can do the other's job.
    const entry = enter();
    const topUp = buildFundPoolTx({ stacks, ownerAddress: OWNER, amountUstx: GATE_FEE });

    expect(entry.functionName).not.toBe(topUp.functionName);
    expect(onlyPostCondition(entry).address).toBe(PLAYER);
    expect(onlyPostCondition(topUp).address).toBe(OWNER);
  });

  it('never builds a fund-pool payload from an entry request', () => {
    expect(JSON.stringify(enter())).not.toContain('fund-pool');
    expect(JSON.stringify(enter())).not.toContain('sponsor');
  });
});

describe('buildForgeTx', () => {
  const FORGE_FEE = 500_000n;

  const forge = (overrides: Partial<Parameters<typeof buildForgeTx>[0]> = {}) =>
    buildForgeTx({
      stacks,
      senderAddress: PLAYER,
      recipeId: 1,
      tokenIds: [1, 2, 3],
      feeUstx: FORGE_FEE,
      ...overrides,
    });

  it('targets forge-v2.forge, never the deployed v1', () => {
    // v1 is still on chain and always will be — Clarity contracts cannot be
    // withdrawn. It is simply never granted minter rights, so a payload aimed
    // at it would abort. Asserted by name because "which forge" is the whole
    // difference between a working forge and a wasted network fee.
    const tx = forge();
    expect(tx.contractName).toBe('forge-v2');
    expect(tx.functionName).toBe('forge');
    expect(tx.contractAddress).toBe(PLAYER);
    expect(tx.network).toBe('devnet');
  });

  it('encodes the recipe id and token list as Clarity values', () => {
    const tx = forge({ recipeId: 2, tokenIds: [7, 8, 9] });

    const id = deserializeCV(tx.functionArgs[0]);
    expect(id.type).toBe(ClarityType.UInt);
    expect(BigInt((id as { value: bigint }).value)).toBe(2n);

    const ids = deserializeCV(tx.functionArgs[1]);
    expect(ids.type).toBe(ClarityType.List);
    expect((ids as { value: unknown[] }).value).toHaveLength(3);
  });

  it('pins the signer sending exactly the recipe fee, in deny mode', () => {
    // Decoded from the hex the chain enforces, not read off the summary. The
    // amount has to be the recipe's real fee: too low and the transfer exceeds
    // what the player consented to and aborts; too high and it aborts as well.
    const tx = forge({ feeUstx: 2_000_000n });
    expect(tx.postConditionMode).toBe('deny');

    const pc = onlyPostCondition(tx);
    expect(pc.address).toBe(PLAYER);
    expect(pc.condition).toBe('eq');
    expect(pc.amount).toBe('2000000');
  });

  it('binds the fee to the signer, never to another principal', () => {
    const tx = forge({ senderAddress: OTHER });
    expect(onlyPostCondition(tx).address).toBe(OTHER);
  });

  it('refuses a non-positive fee', () => {
    // `stx-transfer?` fails on zero, so a zero-fee recipe cannot be forged at
    // all; the contract rejects one at `create-recipe` (ERR-BAD-RECIPE). A
    // payload quoting zero would therefore be a payload that cannot succeed.
    expect(() => forge({ feeUstx: 0n })).toThrow(/positive/i);
    expect(() => forge({ feeUstx: -1n })).toThrow(/positive/i);
  });

  it('never authorises a sponsor-pool payment', () => {
    // The forge fee is revenue: buyer -> CONTRACT-OWNER, one hop. It must never
    // touch the pool, and the payload must not even name the function that could.
    const serialized = JSON.stringify(forge());
    expect(serialized).not.toContain('sponsor');
    expect(serialized).not.toContain('fund-pool');
  });

  it('rejects a duplicate token id', () => {
    // The contract catches this too, but only after the player signed and paid
    // a network fee — the second burn finds no owner because the first took it.
    expect(() => forge({ tokenIds: [1, 1, 2] })).toThrow(/same token twice/i);
  });

  it('rejects more tokens than the Clarity list accepts', () => {
    // The signature is `(list 5 uint)`; a longer list aborts on chain.
    expect(() => forge({ tokenIds: [1, 2, 3, 4, 5, 6] })).toThrow(/1\.\.5/);
  });

  it('accepts exactly the list bound', () => {
    expect(() => forge({ tokenIds: [1, 2, 3, 4, 5] })).not.toThrow();
  });

  it('rejects an empty token list', () => {
    expect(() => forge({ tokenIds: [] })).toThrow();
  });

  it('rejects a non-positive or fractional token id', () => {
    expect(() => forge({ tokenIds: [0] })).toThrow(/positive integer/i);
    expect(() => forge({ tokenIds: [-1] })).toThrow(/positive integer/i);
    expect(() => forge({ tokenIds: [1.5] })).toThrow(/positive integer/i);
  });

  it('rejects a non-positive recipe id', () => {
    expect(() => forge({ recipeId: 0 })).toThrow(/positive integer/i);
  });

  it('states in the summary that the burn is permanent and the fee is not refundable', () => {
    // The player is about to spend STX and destroy NFTs. The wallet prompt shows
    // the amount but cannot say what it buys or that the burn is irreversible,
    // so our own UI text has to.
    expect(forge().summary).toMatch(/burn/i);
    expect(forge().summary).toMatch(/cannot be undone/i);
    expect(forge().summary).toContain(String(FORGE_FEE));
    expect(forge().summary).toMatch(/non-refundable/i);
  });
});

describe('buildMintCharacterTx', () => {
  const PRICE = 1_000_000n;

  const mint = (overrides: Partial<Parameters<typeof buildMintCharacterTx>[0]> = {}) =>
    buildMintCharacterTx({
      stacks,
      senderAddress: PLAYER,
      classId: 'warrior',
      metadataUri: 'ipfs://grimhallow/character/warrior.json',
      priceUstx: PRICE,
      ...overrides,
    });

  it('targets character-nft.mint-character', () => {
    const tx = mint();
    expect(tx.contractName).toBe('character-nft');
    expect(tx.functionName).toBe('mint-character');
    expect(tx.contractAddress).toBe(PLAYER);
    expect(tx.network).toBe('devnet');
  });

  it('encodes the class and uri as string-ascii, in that order', () => {
    const tx = mint({ classId: 'rogue' });

    const classCv = deserializeCV(tx.functionArgs[0]);
    expect(classCv.type).toBe(ClarityType.StringASCII);
    expect((classCv as { value: string }).value).toBe('rogue');

    const uriCv = deserializeCV(tx.functionArgs[1]);
    expect(uriCv.type).toBe(ClarityType.StringASCII);
  });

  it('pins the signer sending exactly the mint price, in deny mode', () => {
    const tx = mint({ priceUstx: 2_500_000n });
    expect(tx.postConditionMode).toBe('deny');

    const pc = onlyPostCondition(tx);
    expect(pc.address).toBe(PLAYER);
    expect(pc.condition).toBe('eq');
    expect(pc.amount).toBe('2500000');
  });

  it('binds the price to the signer, never to another principal', () => {
    expect(onlyPostCondition(mint({ senderAddress: OTHER })).address).toBe(OTHER);
  });

  it('rejects a class the contract would reject', () => {
    // The contract answers ERR-BAD-CLASS and never coerces an unknown id to a
    // default. Catching it here is the half that costs the player nothing.
    expect(() => mint({ classId: 'necromancer' })).toThrow(/unknown class/i);
    expect(() => mint({ classId: 'Warrior' })).toThrow(/unknown class/i);
    expect(() => mint({ classId: '' })).toThrow(/unknown class/i);
  });

  it('rejects a non-positive price', () => {
    expect(() => mint({ priceUstx: 0n })).toThrow(/positive/i);
    expect(() => mint({ priceUstx: -1n })).toThrow(/positive/i);
  });

  it('rejects a uri the Clarity argument could not hold', () => {
    expect(() => mint({ metadataUri: '' })).toThrow(/1\.\./);
    expect(() => mint({ metadataUri: 'x'.repeat(CHARACTER_URI_MAX_LENGTH + 1) })).toThrow(/1\.\./);
    expect(() => mint({ metadataUri: 'x'.repeat(CHARACTER_URI_MAX_LENGTH) })).not.toThrow();
  });

  it('rejects a non-ASCII uri rather than letting serialization mangle it', () => {
    // `string-ascii` is not `string-utf8`. A multi-byte character would either
    // fail to serialize or arrive on chain as something else.
    expect(() => mint({ metadataUri: 'ipfs://grimhallow/character/wärrior.json' })).toThrow(
      /ascii/i,
    );
  });

  it('says in the summary that the class is permanent', () => {
    // The one irreversible part of the purchase. A player who expected to
    // re-roll a class after minting would have no recourse on chain.
    expect(mint().summary).toMatch(/cannot be changed/i);
    expect(mint().summary).toContain(String(PRICE));
  });

  it('never authorises a sponsor-pool payment', () => {
    // Third revenue line, same invariant as the other two: the mint price is
    // buyer -> operator, and nothing about it touches the prize pool.
    const serialized = JSON.stringify(mint());
    expect(serialized).not.toContain('sponsor');
    expect(serialized).not.toContain('fund-pool');
  });
});

describe('the module cannot sign', () => {
  /**
   * Structural, not behavioural. The ground rule is that this module has no
   * access to a private key; the way that stays true is by it never importing
   * anything that could use one. A future edit that added `makeContractCall`
   * here would fail this test before it ever reached a wallet.
   */
  it('imports no signing function and no key loader', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/lib/txBuilder.ts', import.meta.url)),
      'utf8',
    );

    for (const forbidden of [
      'makeContractCall',
      'broadcastTransaction',
      'signMessage',
      'privateKey',
      'senderKey',
      'loadOracleKey',
      'loadOwnerKey',
    ]) {
      expect(source, `txBuilder.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});
