/**
 * PowerUpService tests.
 *
 * The anti-spoofing property is what matters most: tier comes from
 * `get-token-tier` (the on-chain map) and never from metadata. The rest guards
 * partial-failure honesty: an out-of-range tier is dropped rather than guessed,
 * a missing URI does not blank the whole item, and the SIP-009 `ResponseOk`
 * wrapper is correctly unwrapped.
 */

import { describe, expect, it } from 'vitest';
import { Cl, ClarityType, type ClarityValue } from '@stacks/transactions';
import { CONTRACT_NAMES, getNetworkConfig, MAX_POWER_UP_TIER } from '@grimhallow/shared';
import { PowerUpOwnershipError, PowerUpService } from '../src/services/powerUpService.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';

const stacks = getNetworkConfig('devnet');
const LOOT_CONTRACT = `${stacks.deployer}.${CONTRACT_NAMES.characterLootNft}`;
const ADDRESS = 'ST2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173';

function holding(tokenId: string): NftHolding {
  return {
    assetIdentifier: `${LOOT_CONTRACT}::grimhallow-loot`,
    contractId: LOOT_CONTRACT,
    assetName: 'grimhallow-loot',
    tokenId,
    blockHeight: 1,
    txId: '0xabc',
  };
}

/**
 * Decode the token id the service asked about.
 *
 * The service serializes it as a Clarity uint, so the fake deserializes rather
 * than keying off call order — the service batches its reads concurrently, so
 * call order is not a reliable identifier.
 */
function tokenIdFromArgs(argsHex: readonly string[] | undefined): string {
  const hex = argsHex?.[0];
  if (!hex) throw new Error('expected a serialized token id argument');
  const cv = Cl.deserialize(hex);
  if (cv.type !== ClarityType.UInt) throw new Error(`expected a uint arg, got ${cv.type}`);
  return String(cv.value);
}

class FakeChain implements ChainClient {
  holdings: NftHolding[] = [];
  /** Keyed by `${functionName}:${tokenId}`. */
  answers = new Map<string, ClarityValue>();
  /** Token ids whose tier read should throw. */
  tierErrors = new Set<string>();

  async getNftHoldings(): Promise<NftHolding[]> {
    return this.holdings;
  }

  async getTokenMetadata(): Promise<null> {
    return null;
  }

  async getBlockTimestamp(): Promise<number | null> {
    return null;
  }

  async getNftAcquisitionBlock(): Promise<number | null> {
    return null;
  }

  async callReadOnly(params: {
    contractId: string;
    functionName: string;
    functionArgsHex?: readonly string[];
  }): Promise<ClarityValue> {
    const tokenId = tokenIdFromArgs(params.functionArgsHex);

    if (params.functionName === 'get-token-tier' && this.tierErrors.has(tokenId)) {
      throw new Error(`chain unreachable for token ${tokenId}`);
    }

    const answer = this.answers.get(`${params.functionName}:${tokenId}`);
    if (!answer) throw new Error(`no answer for ${params.functionName}:${tokenId}`);
    return answer;
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
  getNftMintBlock: ChainClient['getNftMintBlock'] = unresolvedMintBlock().getNftMintBlock;
}

function makeService(chain: FakeChain): PowerUpService {
  return new PowerUpService({ chain, stacks });
}

describe('PowerUpService.listForAddress', () => {
  it('reads tier from get-token-tier, not from metadata', async () => {
    // The load-bearing assertion: metadata is flavor, tier is on chain.
    const chain = new FakeChain();
    chain.holdings = [holding('5')];
    chain.answers.set('get-token-tier:5', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:5', Cl.ok(Cl.some(Cl.stringAscii('ipfs://epic'))));

    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe(2);
    expect(items[0].tierName).toBeTruthy();
    // The bonus is computed from tier, not from any JSON.
    expect(items[0].summary).toBeTruthy();
    expect(typeof items[0].defenseBonus).toBe('number');
  });

  it('describes the bonus against the specified power', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1))); // +1 die size
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://a'))));

    // Warrior Strike is 1d8. Tier 1 is +1 die size, so 1d8->1d10.
    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items[0].diceFormulaBonus).toBe('1d8->1d10');
  });

  it('drops an item whose tier is out of range rather than guessing', async () => {
    // A tier the bonus table cannot price. Showing it with the wrong bonus is
    // worse than not showing it at all.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://a'))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(MAX_POWER_UP_TIER + 1)));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items.map((i) => i.tokenId)).toEqual(['1']);
  });

  it('unwraps the SIP-009 ResponseOk wrapper from get-token-uri', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('3')];
    chain.answers.set('get-token-tier:3', Cl.some(Cl.uint(3)));
    // SIP-009 signature is `(response (optional (string-ascii 256)) uint)`.
    chain.answers.set('get-token-uri:3', Cl.ok(Cl.some(Cl.stringAscii('ipfs://mythic'))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items[0].metadataUri).toBe('ipfs://mythic');
  });

  it('handles a missing URI without dropping the item', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('4')];
    chain.answers.set('get-token-tier:4', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-uri:4', Cl.ok(Cl.none()));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toHaveLength(1);
    expect(items[0].metadataUri).toBeNull();
  });

  it('sorts by tier descending, then by token id ascending', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2'), holding('3')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://a'))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii('ipfs://b'))));
    chain.answers.set('get-token-tier:3', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:3', Cl.ok(Cl.some(Cl.stringAscii('ipfs://c'))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items.map((i) => ({ id: i.tokenId, tier: i.tier }))).toEqual([
      { id: '2', tier: 3 },
      { id: '3', tier: 3 },
      { id: '1', tier: 1 },
    ]);
  });

  it('filters holdings to the loot contract only', async () => {
    const chain = new FakeChain();
    chain.holdings = [
      holding('1'),
      {
        assetIdentifier: 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.other::nft',
        contractId: 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.other',
        assetName: 'nft',
        tokenId: '99',
        blockHeight: 1,
        txId: '0xdef',
      },
    ];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://a'))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toHaveLength(1);
    expect(items[0].contractId).toBe(LOOT_CONTRACT);
  });

  it('returns an empty list when the wallet holds no loot', async () => {
    const chain = new FakeChain();
    chain.holdings = [];

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toEqual([]);
  });

  it('drops an item whose tier read fails, but keeps the rest', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://a'))));
    chain.tierErrors.add('2');

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    // The first read succeeded; the second failed and took down only that item.
    expect(items.map((i) => i.tokenId)).toEqual(['1']);
  });
});

/**
 * Resolving an equipped loadout.
 *
 * Listing an inventory can afford to drop an item it cannot read — the player
 * just sees one fewer row. Equipping cannot: a silently dropped power-up starts
 * the run weaker than the player chose, on a paid entry they have already been
 * charged for. So every failure here is loud, and that difference is what these
 * tests pin.
 */
describe('PowerUpService.resolveEquippedTiers', () => {
  it('reads each tier from chain and returns them ascending', async () => {
    // Sorted so a loadout's stored tier list is a function of the set chosen and
    // not of the order a UI listed it in. Bonuses sum, so this cannot change the
    // fight — it only makes two identical loadouts store identically.
    const chain = new FakeChain();
    chain.holdings = [holding('7'), holding('8'), holding('9')];
    chain.answers.set('get-token-tier:7', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-tier:8', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-tier:9', Cl.some(Cl.uint(3)));

    const tiers = await makeService(chain).resolveEquippedTiers(ADDRESS, ['7', '8', '9']);

    expect(tiers).toEqual([1, 3, 4]);
  });

  it('costs no chain call for an empty loadout', async () => {
    // The common case — every run before the player owns their first drop. It
    // must not pay for a holdings lookup to learn nothing.
    const chain = new FakeChain();
    chain.holdings = [];

    expect(await makeService(chain).resolveEquippedTiers(ADDRESS, [])).toEqual([]);
  });

  it('refuses a token the wallet does not hold', async () => {
    // The whole point of the check. A request naming somebody else's legendary
    // would otherwise equip its bonus.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));

    await expect(
      makeService(chain).resolveEquippedTiers(ADDRESS, ['1', '2']),
    ).rejects.toThrow(PowerUpOwnershipError);
  });

  it('refuses a token held in a different contract', async () => {
    // A same-numbered token in an unrelated NFT contract is not a power-up. The
    // holdings filter is what stops one being passed off as one.
    const chain = new FakeChain();
    chain.holdings = [
      {
        assetIdentifier: 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.other::nft',
        contractId: 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.other',
        assetName: 'nft',
        tokenId: '1',
        blockHeight: 1,
        txId: '0xdef',
      },
    ];

    await expect(
      makeService(chain).resolveEquippedTiers(ADDRESS, ['1']),
    ).rejects.toThrow(PowerUpOwnershipError);
  });

  it('refuses the whole loadout when one tier cannot be read', async () => {
    // Not "equip the two that worked". A partial loadout is a fight the player
    // did not choose, and on a paid run they cannot get their entry back.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    chain.tierErrors.add('2');

    await expect(
      makeService(chain).resolveEquippedTiers(ADDRESS, ['1', '2']),
    ).rejects.toThrow();
  });

  it('refuses a token the chain has no tier for', async () => {
    // `(none)` from `get-token-tier` means the loot contract does not know this
    // token. Treating it as tier 0, or as unarmed, would both be guesses.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.none());

    await expect(
      makeService(chain).resolveEquippedTiers(ADDRESS, ['1']),
    ).rejects.toThrow(PowerUpOwnershipError);
  });

  it('names the offending token so the player can fix it', async () => {
    const chain = new FakeChain();
    chain.holdings = [];

    const err = await makeService(chain)
      .resolveEquippedTiers(ADDRESS, ['42'])
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(err?.message).toContain('42');
  });
});
