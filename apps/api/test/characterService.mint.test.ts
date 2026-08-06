/**
 * CharacterService and the on-chain class.
 *
 * Our own `character-nft` tokens are the only ones whose class is a stored fact
 * rather than a lookup: the player picked it, paid for it, and the contract wrote
 * it down. `classSource: 'mint'` therefore outranks `'supported_collection'` —
 * the allowlist says what a collection *is*, this says what one token was made
 * as.
 *
 * Since the curated-collection delta these tokens are also the only ones the
 * allowlist cannot answer for: `character-nft` is deliberately absent from it, so
 * a minted token whose class read fails has no class from any source and is
 * dropped from the list rather than shown with a derived one. Several tests below
 * pin exactly that, because the previous behaviour — a hashed fallback class —
 * was the thing the delta removed, and the tempting fix when a player reports a
 * missing character is to put it back.
 *
 * The load-bearing test is still the cache round-trip. `withHolderAge` re-derives
 * from (contractId, tokenId) rather than trusting the identity it is handed, so a
 * cached minted class has to be handed back to it explicitly. Dropping it would
 * now make a bought character vanish on the second request — same token, same
 * wallet, no character — and nothing else in the suite would notice.
 */

import { describe, expect, it } from 'vitest';
import { Cl, ClarityType, deserializeCV, type ClarityValue } from '@stacks/transactions';
import { contractId as buildContractId, getNetworkConfig } from '@grimhallow/shared';
import { CharacterService } from '../src/services/characterService.js';
import { CharacterMintService } from '../src/services/characterMintService.js';
import { HolderAgeService } from '../src/services/holderAgeService.js';
import { NullHolderAgeRepo } from '../src/repos/holderAge.js';
import type { CharacterCache, CharacterCacheEntry } from '../src/repos/characters.js';
import type { ChainClient, ChainTransaction, NftHolding, TokenMetadata } from '../src/lib/hiro.js';
import { unsupportedChainWrites } from './helpers/chain.js';

const stacks = getNetworkConfig('devnet');
const CHARACTER_NFT = buildContractId(stacks, 'characterNft');
/** One of the eight: a class without a chain call. */
const CURATED_COLLECTION = 'SP2N959SER36FZ5QT1CX9BR63W3E8X35WQCMBYYWC.leo-cats';
/** Not one of the eight and not ours: not a character. */
const UNLISTED_COLLECTION = 'SP2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173.the-explorer-guild';
const ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';

function holding(contractId: string, tokenId: string): NftHolding {
  return {
    assetIdentifier: `${contractId}::nft`,
    contractId,
    assetName: 'nft',
    tokenId,
    blockHeight: 1,
    txId: '0xabc',
  };
}

class FakeChain implements ChainClient {
  holdings: NftHolding[] = [];
  /** On-chain classes, keyed by token id. A missing id answers `none`. */
  classes = new Map<string, string>();
  classError: Error | null = null;
  /** Every `get-character-class` token id asked for, in order. */
  readonly classCalls: string[] = [];

  async getNftHoldings(): Promise<NftHolding[]> {
    return this.holdings;
  }

  async getTokenMetadata(): Promise<TokenMetadata | null> {
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
    if (params.functionName !== 'get-character-class') {
      throw new Error(`unexpected read-only call: ${params.functionName}`);
    }
    if (this.classError) throw this.classError;

    const arg = params.functionArgsHex?.[0];
    const cv = arg ? deserializeCV(arg) : null;
    const tokenId = cv && cv.type === ClarityType.UInt ? String(cv.value) : '';
    this.classCalls.push(tokenId);

    const classId = this.classes.get(tokenId);
    return Cl.ok(classId ? Cl.some(Cl.stringAscii(classId)) : Cl.none());
  }

  getTransaction: (txId: string) => Promise<ChainTransaction | null> =
    unsupportedChainWrites().getTransaction;
  broadcastRawTx: (rawTxHex: string) => Promise<string> = unsupportedChainWrites().broadcastRawTx;
  listContractCalls: ChainClient['listContractCalls'] = unsupportedChainWrites().listContractCalls;
}

/** A real cache, so the round-trip through `put` and `get` is exercised. */
class MemoryCharacterCache implements CharacterCache {
  readonly entries = new Map<string, CharacterCacheEntry>();

  async get(contractId: string, tokenId: string): Promise<CharacterCacheEntry | null> {
    return this.entries.get(`${contractId}/${tokenId}`) ?? null;
  }

  async put(entry: CharacterCacheEntry): Promise<void> {
    this.entries.set(`${entry.identity.contractId}/${entry.identity.tokenId}`, entry);
  }
}

function makeService(chain: FakeChain, cache: CharacterCache = new MemoryCharacterCache()) {
  return new CharacterService({
    chain,
    cache,
    stacks,
    holderAge: new HolderAgeService({ chain, repo: new NullHolderAgeRepo() }),
    characterMint: new CharacterMintService({ chain, stacks }),
  });
}

describe('CharacterService and the minted class', () => {
  it('reports the class the contract stored', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '1')];
    chain.classes.set('1', 'paladin');

    const [character] = await makeService(chain).listForAddress(ADDRESS);

    expect(character.classId).toBe('paladin');
    expect(character.classSource).toBe('mint');
    // The deprecated alias is the same value, never a second derivation.
    expect(character.charClass).toBe('paladin');
  });

  it('honours every class the player could have bought', async () => {
    // Not just one: a reader that ignored the stored value and answered with a
    // constant would still pass a single-class test.
    const chain = new FakeChain();
    chain.holdings = ['1', '2', '3', '4'].map((id) => holding(CHARACTER_NFT, id));
    chain.classes.set('1', 'warrior');
    chain.classes.set('2', 'paladin');
    chain.classes.set('3', 'rogue');
    chain.classes.set('4', 'mage');

    const characters = await makeService(chain).listForAddress(ADDRESS);
    expect(characters.map((c) => c.classId)).toEqual(['warrior', 'paladin', 'rogue', 'mage']);
    expect(characters.every((c) => c.classSource === 'mint')).toBe(true);
  });

  it('keeps the minted class across a cache hit', async () => {
    // The regression this file exists for. `withHolderAge` re-derives from
    // (contract, token), so the cached class has to be handed back explicitly;
    // without that the second request has no class for the token at all and the
    // character the player bought disappears from their own list.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '7')];
    chain.classes.set('7', 'mage');
    const service = makeService(chain);

    const first = (await service.listForAddress(ADDRESS))[0];
    const second = (await service.listForAddress(ADDRESS))[0];

    expect(first.classId).toBe('mage');
    expect(second.classId).toBe('mage');
    expect(second.classSource).toBe('mint');
  });

  it('does not re-read the class once it is cached', async () => {
    // The class is fixed at mint and does not move with the token, so it is as
    // cacheable as the token's name — one chain call, not one per request.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '7')];
    chain.classes.set('7', 'rogue');
    const service = makeService(chain);

    await service.listForAddress(ADDRESS);
    await service.listForAddress(ADDRESS);

    expect(chain.classCalls).toEqual(['7']);
  });

  it('spends no chain call on a curated collection', async () => {
    // Its class is in the allowlist, so asking the contract would be asking a
    // question we already have the answer to.
    const chain = new FakeChain();
    chain.holdings = [holding(CURATED_COLLECTION, '1')];

    const [character] = await makeService(chain).listForAddress(ADDRESS);

    expect(chain.classCalls).toEqual([]);
    expect(character.classSource).toBe('supported_collection');
    expect(character.classId).toBe('mage');
  });

  it('drops a collection that is neither ours nor curated', async () => {
    // Not an error, not a duller character — simply absent. This is the delta's
    // whole point: being unlisted costs playability, not flavour.
    const chain = new FakeChain();
    chain.holdings = [holding(UNLISTED_COLLECTION, '1')];

    expect(await makeService(chain).listForAddress(ADDRESS)).toEqual([]);
    expect(chain.classCalls).toEqual([]);
  });

  it('drops a minted token when the class read fails', async () => {
    // Painful but correct. `character-nft` is deliberately not in the allowlist,
    // so a failed read leaves no class from any source, and the only alternative
    // to omitting the character is inventing a class for something the player
    // paid to choose. Showing a bought Mage as a Warrior is worse than showing
    // nothing until the node answers.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '1')];
    chain.classError = new Error('node unreachable');

    expect(await makeService(chain).listForAddress(ADDRESS)).toEqual([]);
  });

  it('does not fail the whole list when one class read fails', async () => {
    // The other half of the rule above: one unreachable lookup drops one
    // character, not the wallet.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '1'), holding(CURATED_COLLECTION, '5')];
    chain.classError = new Error('node unreachable');

    const characters = await makeService(chain).listForAddress(ADDRESS);
    expect(characters.map((c) => c.contractId)).toEqual([CURATED_COLLECTION]);
  });

  it('drops a token this collection never minted', async () => {
    // `none` from the contract, not an error. Nothing was stored, so there is
    // nothing to show — the token is not a character we sold.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '999')];

    expect(await makeService(chain).listForAddress(ADDRESS)).toEqual([]);
  });

  it('ignores a class id the contract should never have accepted', async () => {
    // ERR-BAD-CLASS makes this impossible on chain, which is exactly why seeing
    // one means something upstream is wrong — and the safe reading of a value
    // that should be impossible is to not believe it. Disbelieving it now means
    // no class at all rather than a hashed one.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '1')];
    chain.classes.set('1', 'necromancer');

    expect(await makeService(chain).listForAddress(ADDRESS)).toEqual([]);
  });

  it('cannot list a minted character without the mint service', async () => {
    // The dependency is typed optional so a caller with only curated tokens need
    // not wire it, but omitting it in production would hide every character the
    // shop ever sold — there is no second way to learn a minted class.
    const chain = new FakeChain();
    chain.holdings = [holding(CHARACTER_NFT, '1'), holding(CURATED_COLLECTION, '2')];
    chain.classes.set('1', 'mage');

    const service = new CharacterService({
      chain,
      cache: new MemoryCharacterCache(),
      stacks,
      holderAge: new HolderAgeService({ chain, repo: new NullHolderAgeRepo() }),
    });

    const characters = await service.listForAddress(ADDRESS);
    expect(characters.map((c) => c.contractId)).toEqual([CURATED_COLLECTION]);
    expect(chain.classCalls).toEqual([]);
  });
});
