import { Cl } from '@stacks/transactions';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoStxMovement, expectRevenueNotPool, sponsorPool, stx } from './helpers/revenue';

/**
 * character-nft tests.
 *
 * THE TEST THAT MATTERS: the mint price lands with contract-owner and never
 * touches sponsor-pool. That runs through `expectRevenueNotPool`, the one shared
 * assertion for all three revenue lines, rather than a hand-written balance
 * check — see tests/helpers/revenue.ts for what it actually verifies and why a
 * bare `expect(sponsorPool()).toBe(0n)` is weaker than it looks.
 *
 * The rest, in rough order of how much money a regression would cost:
 *   - an unknown class id is rejected, never coerced to a default
 *   - a rejected mint costs the buyer nothing and mints nothing
 *   - the price is owner-only to change and takes effect immediately
 *   - transfer moves the token without moving any STX, and the on-chain class
 *     survives the transfer unchanged (rarity is what resets, not class)
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!; // CONTRACT-OWNER
const alice = accounts.get('wallet_1')!;
const bob = accounts.get('wallet_2')!;
const mallory = accounts.get('wallet_3')!;

const NFT = 'character-nft';

const ERR_NOT_OWNER = Cl.uint(400);
const ERR_BAD_CLASS = Cl.uint(401);
const ERR_NOT_TOKEN_OWNER = Cl.uint(402);
const ERR_PRICE_ZERO = Cl.uint(403);
const ERR_MINT_PAUSED = Cl.uint(404);

const MINT_PRICE = stx(1); // the operator's chosen launch price

function mint(classId: string, sender: string, uri = 'ipfs://character/1.json') {
  return simnet.callPublicFn(
    NFT,
    'mint-character',
    [Cl.stringAscii(classId), Cl.stringAscii(uri)],
    sender,
  );
}

function mintPrice(): bigint {
  const { result } = simnet.callReadOnlyFn(NFT, 'get-mint-price', [], deployer);
  return (result as unknown as { value: bigint }).value;
}

function lastTokenId(): bigint {
  const { result } = simnet.callReadOnlyFn(NFT, 'get-last-token-id', [], deployer);
  return (result as unknown as { value: { value: bigint } }).value.value;
}

function characterClass(tokenId: number) {
  const { result } = simnet.callReadOnlyFn(NFT, 'get-character-class', [Cl.uint(tokenId)], deployer);
  return result;
}

function tokenOwner(tokenId: number) {
  const { result } = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(tokenId)], deployer);
  return result;
}

describe('mint-character revenue (the load-bearing invariant)', () => {
  it('sends the mint price to contract-owner and never to sponsor-pool', async () => {
    // The single most important test in this delta. Same shared assertion the
    // gate fee and the forge fee use.
    const result = expectRevenueNotPool({
      payer: alice,
      owner: deployer,
      amountUstx: MINT_PRICE,
      label: 'mint-character',
      call: () => mint('warrior', alice),
    });

    expect(result).toBeOk(Cl.uint(1));
  });

  it('leaves a funded pool at exactly the amount the owner funded it with', async () => {
    // The zero-pool version of this test would pass even if the fee were being
    // added to a pool that happened to be empty. Fund it first so a credit has
    // somewhere visible to land.
    simnet.callPublicFn('game-core', 'fund-pool', [Cl.uint(stx(10))], deployer);
    expect(sponsorPool(deployer)).toBe(stx(10));

    expectRevenueNotPool({
      payer: alice,
      owner: deployer,
      amountUstx: MINT_PRICE,
      label: 'mint-character (funded pool)',
      call: () => mint('mage', alice),
    });

    expect(sponsorPool(deployer)).toBe(stx(10));
  });

  it('keeps every buyer’s payment in revenue', async () => {
    for (const buyer of [alice, bob, mallory]) {
      expectRevenueNotPool({
        payer: buyer,
        owner: deployer,
        amountUstx: MINT_PRICE,
        label: `mint-character (${buyer})`,
        call: () => mint('rogue', buyer),
      });
    }
    expect(lastTokenId()).toBe(3n);
    expect(sponsorPool(deployer)).toBe(0n);
  });

  it('charges the updated price after the owner changes it', async () => {
    simnet.callPublicFn(NFT, 'set-mint-price', [Cl.uint(stx(3))], deployer);

    expectRevenueNotPool({
      payer: alice,
      owner: deployer,
      amountUstx: stx(3),
      label: 'mint-character (repriced)',
      call: () => mint('paladin', alice),
    });
  });
});

describe('class selection', () => {
  it('records exactly the class the buyer chose', async () => {
    for (const [i, classId] of ['warrior', 'paladin', 'rogue', 'mage'].entries()) {
      const { result } = mint(classId, alice);
      expect(result).toBeOk(Cl.uint(i + 1));
      expect(characterClass(i + 1)).toBeOk(Cl.some(Cl.stringAscii(classId)));
    }
  });

  it('rejects an unknown class id rather than defaulting', async () => {
    // Coercing a typo to warrior would mint a token whose on-chain class is not
    // the one the buyer paid for, with no way to correct it afterwards.
    for (const bad of ['Warrior', 'WARRIOR', 'warrior ', 'necromancer', 'w', '']) {
      const { result } = mint(bad, alice);
      expect(result).toBeErr(ERR_BAD_CLASS);
    }
    expect(lastTokenId()).toBe(0n);
  });

  it('costs the buyer nothing when the class id is rejected', async () => {
    // A failed mint must be free apart from the transaction fee — the STX
    // transfer and the mint have to fail together or not at all.
    expectNoStxMovement({
      principals: [alice, deployer],
      owner: deployer,
      label: 'rejected mint',
      call: () => mint('necromancer', alice),
    });
    expect(tokenOwner(1)).toBeOk(Cl.none());
  });
});

describe('owner administration', () => {
  it('refuses a price change from anyone but the owner', async () => {
    const { result } = simnet.callPublicFn(NFT, 'set-mint-price', [Cl.uint(stx(99))], mallory);
    expect(result).toBeErr(ERR_NOT_OWNER);
    expect(mintPrice()).toBe(MINT_PRICE);
  });

  it('refuses a zero price, which would break minting rather than make it free', async () => {
    const { result } = simnet.callPublicFn(NFT, 'set-mint-price', [Cl.uint(0)], deployer);
    expect(result).toBeErr(ERR_PRICE_ZERO);
    expect(mintPrice()).toBe(MINT_PRICE);
  });

  it('stops and resumes sales through the pause flag', async () => {
    simnet.callPublicFn(NFT, 'set-mint-paused', [Cl.bool(true)], deployer);

    expectNoStxMovement({
      principals: [alice, deployer],
      owner: deployer,
      label: 'paused mint',
      call: () => mint('warrior', alice),
    });
    expect(mint('warrior', alice).result).toBeErr(ERR_MINT_PAUSED);

    simnet.callPublicFn(NFT, 'set-mint-paused', [Cl.bool(false)], deployer);
    expect(mint('warrior', alice).result).toBeOk(Cl.uint(1));
  });

  it('refuses a pause toggle from anyone but the owner', async () => {
    const { result } = simnet.callPublicFn(NFT, 'set-mint-paused', [Cl.bool(true)], mallory);
    expect(result).toBeErr(ERR_NOT_OWNER);
    expect(mint('warrior', alice).result).toBeOk(Cl.uint(1));
  });
});

describe('transfer', () => {
  beforeEach(() => {
    mint('rogue', alice);
  });

  it('moves the token without moving any STX', async () => {
    expectNoStxMovement({
      principals: [alice, bob, deployer],
      owner: deployer,
      label: 'transfer',
      call: () =>
        simnet.callPublicFn(
          NFT,
          'transfer',
          [Cl.uint(1), Cl.principal(alice), Cl.principal(bob)],
          alice,
        ),
    });

    expect(tokenOwner(1)).toBeOk(Cl.some(Cl.principal(bob)));
  });

  it('keeps the class through a transfer — class is the token, rarity is the ledger', async () => {
    simnet.callPublicFn(
      NFT,
      'transfer',
      [Cl.uint(1), Cl.principal(alice), Cl.principal(bob)],
      alice,
    );

    // The class the buyer paid for survives resale unchanged. Hold duration is
    // what resets, and it is not stored here at all — there is deliberately no
    // field on this token for a transfer to have to reset.
    expect(characterClass(1)).toBeOk(Cl.some(Cl.stringAscii('rogue')));
    const { result } = simnet.callReadOnlyFn(NFT, 'get-character', [Cl.uint(1)], deployer);
    expect(result).toBeOk(
      Cl.some(
        Cl.tuple({
          uri: Cl.stringAscii('ipfs://character/1.json'),
          'class-id': Cl.stringAscii('rogue'),
          // minted-by stays alice: it records who bought it, not who holds it.
          'minted-by': Cl.principal(alice),
        }),
      ),
    );
  });

  it('refuses a transfer initiated by someone who is not the sender', async () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'transfer',
      [Cl.uint(1), Cl.principal(alice), Cl.principal(mallory)],
      mallory,
    );
    expect(result).toBeErr(ERR_NOT_TOKEN_OWNER);
    expect(tokenOwner(1)).toBeOk(Cl.some(Cl.principal(alice)));
  });
});

/**
 * Meta-tests: does the shared assertion actually fail when it should?
 *
 * An invariant check that cannot fail is worse than no check, because it reads
 * like coverage. `fund-pool` is the one call in the entire system that is SUPPOSED
 * to credit the pool, which makes it the perfect negative control: if
 * `expectRevenueNotPool` passes on it, the helper is inert and every test above
 * is decoration.
 */
describe('the shared revenue assertion has teeth', () => {
  it('fails on a call that credits the pool', async () => {
    expect(() =>
      expectRevenueNotPool({
        payer: alice,
        owner: deployer,
        amountUstx: stx(5),
        label: 'fund-pool (negative control)',
        call: () => simnet.callPublicFn('game-core', 'fund-pool', [Cl.uint(stx(5))], deployer),
      }),
    ).toThrow(/sponsor pool changed/);
  });

  it('fails when the owner receives nothing', async () => {
    expect(() =>
      expectRevenueNotPool({
        payer: alice,
        owner: deployer,
        amountUstx: MINT_PRICE,
        label: 'no-op (negative control)',
        call: () => simnet.callReadOnlyFn(NFT, 'get-mint-price', [], deployer) as never,
      }),
    ).toThrow(/should have received exactly/);
  });

  it('refuses a vacuous self-payment rather than passing it', async () => {
    // owner-pays-owner nets to zero and would satisfy every balance assertion.
    expect(() =>
      expectRevenueNotPool({
        payer: deployer,
        owner: deployer,
        amountUstx: MINT_PRICE,
        label: 'self-payment',
        call: () => mint('warrior', deployer),
      }),
    ).toThrow(/same principal/);
  });
});

describe('isolation from the rest of the system', () => {
  it('cannot mint into the loot collection', async () => {

    // The two collections are separate supplies. A character is not a power-up.
    mint('mage', alice);
    const { result } = simnet.callReadOnlyFn(
      'character-loot-nft',
      'get-last-token-id',
      [],
      deployer,
    );
    expect(result).toBeOk(Cl.uint(0));
  });

  it('holds no STX balance of its own at any point', async () => {
    // The contract is never the recipient, so there is no balance for a later
    // function to sweep — including into the pool.
    for (const buyer of [alice, bob]) mint('warrior', buyer);
    const held = simnet.getAssetsMap().get('STX')?.get(`${deployer}.${NFT}`) ?? 0n;
    expect(held).toBe(0n);
  });
});
