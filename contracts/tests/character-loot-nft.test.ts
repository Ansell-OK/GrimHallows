import { Cl } from '@stacks/transactions';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * character-loot-nft tests.
 *
 * Covers docs/03-smart-contracts-spec.md §8:
 *   - "Unauthorized principal cannot mint on `character-loot-nft` directly"
 *
 * plus the §1 invariant that there is no public mint entrypoint, and the
 * burn/transfer paths forge and players depend on.
 *
 * Note on authorizing a *standard* principal in these tests: `mint` gates on
 * `contract-caller`, which for a direct call from a wallet is that wallet. So
 * authorizing `wallet_1` lets us exercise the authorized path before game-core
 * and forge exist. In production only the two contract principals are ever
 * authorized.
 */

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!;
const wallet1 = accounts.get('wallet_1')!;
const wallet2 = accounts.get('wallet_2')!;
const wallet3 = accounts.get('wallet_3')!;

const NFT = 'character-loot-nft';

const ERR_NOT_OWNER = Cl.uint(100);
const ERR_NOT_AUTHORIZED_MINTER = Cl.uint(101);
const ERR_NOT_TOKEN_OWNER = Cl.uint(103);
const ERR_TIER_ZERO = Cl.uint(104);

const URI = 'ipfs://loot/1.json';

/** Authorize `who` to mint/burn, as the contract owner. */
function authorize(who: string) {
  const { result } = simnet.callPublicFn(
    NFT,
    'set-minter',
    [Cl.principal(who), Cl.bool(true)],
    deployer,
  );
  expect(result).toBeOk(Cl.bool(true));
}

/** Mint one token to `recipient` from an already-authorized `minter`. */
function mint(minter: string, recipient: string, tier = 1, uri = URI) {
  return simnet.callPublicFn(
    NFT,
    'mint',
    [Cl.principal(recipient), Cl.stringAscii(uri), Cl.uint(tier)],
    minter,
  );
}

describe('character-loot-nft: minter authorization', () => {
  it('rejects a mint from an unauthorized principal', () => {
    const { result } = mint(wallet1, wallet1);
    expect(result).toBeErr(ERR_NOT_AUTHORIZED_MINTER);
  });

  it('rejects a mint from the deployer too - there is no public mint entrypoint', () => {
    // The owner can *authorize* minters but is not itself one by default. This
    // is the spec's "no public mint entrypoint" invariant: minting is reachable
    // only through game-core and forge.
    const { result } = mint(deployer, deployer);
    expect(result).toBeErr(ERR_NOT_AUTHORIZED_MINTER);
  });

  it('mints nothing when unauthorized - nonce and supply stay at zero', () => {
    mint(wallet1, wallet1);
    const { result } = simnet.callReadOnlyFn(NFT, 'get-last-token-id', [], wallet1);
    expect(result).toBeOk(Cl.uint(0));
  });

  it('only the contract owner can authorize a minter', () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'set-minter',
      [Cl.principal(wallet1), Cl.bool(true)],
      wallet1,
    );
    expect(result).toBeErr(ERR_NOT_OWNER);

    // ...and the failed call left no authorization behind.
    const check = simnet.callReadOnlyFn(
      NFT,
      'is-authorized-minter',
      [Cl.principal(wallet1)],
      wallet1,
    );
    expect(check.result).toBeBool(false);
  });

  it('lets the owner revoke an authorization', () => {
    authorize(wallet1);
    expect(mint(wallet1, wallet1).result).toBeOk(Cl.uint(1));

    simnet.callPublicFn(
      NFT,
      'set-minter',
      [Cl.principal(wallet1), Cl.bool(false)],
      deployer,
    );
    expect(mint(wallet1, wallet1).result).toBeErr(ERR_NOT_AUTHORIZED_MINTER);
  });
});

describe('character-loot-nft: minting', () => {
  beforeEach(() => authorize(wallet1));

  it('mints sequential token ids starting at 1', () => {
    expect(mint(wallet1, wallet2).result).toBeOk(Cl.uint(1));
    expect(mint(wallet1, wallet2).result).toBeOk(Cl.uint(2));
    expect(mint(wallet1, wallet3).result).toBeOk(Cl.uint(3));

    const { result } = simnet.callReadOnlyFn(NFT, 'get-last-token-id', [], wallet1);
    expect(result).toBeOk(Cl.uint(3));
  });

  it('assigns the token to the recipient, not the minter', () => {
    mint(wallet1, wallet2);
    const { result } = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(1)], wallet1);
    expect(result).toBeOk(Cl.some(Cl.principal(wallet2)));
  });

  it('stores uri and tier on-chain so forge can validate recipes', () => {
    mint(wallet1, wallet2, 3, 'ipfs://loot/epic.json');

    const uri = simnet.callReadOnlyFn(NFT, 'get-token-uri', [Cl.uint(1)], wallet1);
    expect(uri.result).toBeOk(Cl.some(Cl.stringAscii('ipfs://loot/epic.json')));

    const tier = simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(1)], wallet1);
    expect(tier.result).toBeOk(Cl.some(Cl.uint(3)));

    const meta = simnet.callReadOnlyFn(NFT, 'get-token-metadata', [Cl.uint(1)], wallet1);
    expect(meta.result).toBeOk(
      Cl.some(
        Cl.tuple({ uri: Cl.stringAscii('ipfs://loot/epic.json'), tier: Cl.uint(3) }),
      ),
    );
  });

  it('rejects tier 0, which would otherwise be indistinguishable from "no tier"', () => {
    expect(mint(wallet1, wallet2, 0).result).toBeErr(ERR_TIER_ZERO);
  });

  it('returns none for an unminted token id', () => {
    const owner = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(99)], wallet1);
    expect(owner.result).toBeOk(Cl.none());

    const tier = simnet.callReadOnlyFn(NFT, 'get-token-tier', [Cl.uint(99)], wallet1);
    expect(tier.result).toBeOk(Cl.none());
  });
});

describe('character-loot-nft: burning', () => {
  beforeEach(() => {
    authorize(wallet1);
    mint(wallet1, wallet2, 2);
  });

  it('rejects a burn from an unauthorized principal', () => {
    // Notably including the token's own owner: only forge burns loot, and it
    // does so as part of a recipe. A player cannot destroy a token ad hoc.
    const { result } = simnet.callPublicFn(
      NFT,
      'burn',
      [Cl.uint(1), Cl.principal(wallet2)],
      wallet2,
    );
    expect(result).toBeErr(ERR_NOT_AUTHORIZED_MINTER);
  });

  it('rejects a burn naming the wrong owner', () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'burn',
      [Cl.uint(1), Cl.principal(wallet3)],
      wallet1,
    );
    expect(result).toBeErr(ERR_NOT_TOKEN_OWNER);
  });

  it('destroys the token and its metadata', () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'burn',
      [Cl.uint(1), Cl.principal(wallet2)],
      wallet1,
    );
    expect(result).toBeOk(Cl.bool(true));

    const owner = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(1)], wallet1);
    expect(owner.result).toBeOk(Cl.none());

    const meta = simnet.callReadOnlyFn(NFT, 'get-token-metadata', [Cl.uint(1)], wallet1);
    expect(meta.result).toBeOk(Cl.none());
  });

  it('does not rewind the nonce - a burned id is never reissued', () => {
    simnet.callPublicFn(NFT, 'burn', [Cl.uint(1), Cl.principal(wallet2)], wallet1);
    expect(mint(wallet1, wallet2).result).toBeOk(Cl.uint(2));
  });
});

describe('character-loot-nft: SIP-009 transfer', () => {
  beforeEach(() => {
    authorize(wallet1);
    mint(wallet1, wallet2);
  });

  it('lets the token owner transfer', () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'transfer',
      [Cl.uint(1), Cl.principal(wallet2), Cl.principal(wallet3)],
      wallet2,
    );
    expect(result).toBeOk(Cl.bool(true));

    const owner = simnet.callReadOnlyFn(NFT, 'get-owner', [Cl.uint(1)], wallet1);
    expect(owner.result).toBeOk(Cl.some(Cl.principal(wallet3)));
  });

  it('rejects a transfer initiated by anyone but the sender', () => {
    const { result } = simnet.callPublicFn(
      NFT,
      'transfer',
      [Cl.uint(1), Cl.principal(wallet2), Cl.principal(wallet3)],
      wallet3,
    );
    expect(result).toBeErr(ERR_NOT_TOKEN_OWNER);
  });

  it('rejects a transfer of a token the sender does not own', () => {
    // tx-sender matches `sender`, so our assert passes and nft-transfer? itself
    // rejects it (u1 = sender does not own the asset). Guards against one
    // principal spoofing a transfer of someone else's token.
    const { result } = simnet.callPublicFn(
      NFT,
      'transfer',
      [Cl.uint(1), Cl.principal(wallet3), Cl.principal(deployer)],
      wallet3,
    );
    expect(result).toBeErr(Cl.uint(1));
  });
});
