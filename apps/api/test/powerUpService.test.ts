/**
 * PowerUpService tests.
 *
 * The anti-spoofing property is what matters most, and archetypes widened it
 * rather than weakening it: BOTH numbers a power-up grants come from the token's
 * on-chain `token-metadata` entry — `tier` from `get-token-tier`, archetype from
 * the URI STRING `get-token-uri` returns — and neither is ever read out of the
 * JSON document that string names. Nothing here fetches a document at all, which
 * is why rewriting a pinned file still cannot change a die.
 *
 * The rest guards partial-failure honesty, and the two failure modes are
 * deliberately NOT symmetric:
 *
 *   - An unreadable or unrecognized URI degrades to `relic`. It is 256 bytes the
 *     contract never inspected, so an odd one is an ordinary event, and `relic`
 *     is exactly what the token would have been before archetypes existed.
 *   - An unreadable or out-of-range TIER drops the item when listing and throws
 *     when equipping. `tier` is a range-checked `uint`, so a bad value means our
 *     read is wrong rather than the token being unusual.
 *
 * And the listing/equipping split is itself load-bearing: listing an inventory
 * can afford to drop a row, equipping cannot, because a silently dropped power-up
 * starts a fight weaker than the player chose on an entry they already paid for.
 */

import { describe, expect, it } from 'vitest';
import { Cl, ClarityType, type ClarityValue } from '@stacks/transactions';
import {
  CONTRACT_NAMES,
  MAX_EQUIPPED_POWER_UPS,
  MAX_POWER_UP_TIER,
  archetypeBonusVector,
  getNetworkConfig,
  lootFileStem,
} from '@grimhallow/shared';
import { PowerUpOwnershipError, PowerUpService } from '../src/services/powerUpService.js';
import type { ChainClient, ChainTransaction, NftHolding } from '../src/lib/hiro.js';
import { unresolvedMintBlock, unsupportedChainWrites } from './helpers/chain.js';

const stacks = getNetworkConfig('devnet');
const LOOT_CONTRACT = `${stacks.deployer}.${CONTRACT_NAMES.characterLootNft}`;
const ADDRESS = 'ST2X0TZ59D5SZ8ACQ6YMCHHNR2ZN51Z32E2CJ173';

/**
 * A URI in the shape Phase 3 will pin, for an archetype and tier.
 *
 * Built through `lootFileStem` rather than typed as a literal, so these tests
 * read tokens the same way the real mint writes them. A hand-written path here
 * would keep passing after the shape changed, while every real token stopped
 * parsing — which is the exact bug this suite exists to catch.
 */
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const uriFor = (slug: string, tier: number): string =>
  `ipfs://${CID}/${lootFileStem(slug as never, tier)}.json`;

/** The URI every token minted before archetypes carries. Parses to `relic`. */
const LEGACY_URI = 'ipfs://grimhallow/power-up/tier-1.json';

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

/** A service that records what it logged, for the cases where logging IS the behaviour. */
function makeLoggingService(chain: FakeChain): {
  service: PowerUpService;
  logs: { message: string; detail?: Record<string, unknown> }[];
} {
  const logs: { message: string; detail?: Record<string, unknown> }[] = [];
  const service = new PowerUpService({
    chain,
    stacks,
    log: (message, detail) => logs.push({ message, detail }),
  });
  return { service, logs };
}

describe('PowerUpService.listForAddress', () => {
  it('reads both facts from chain, neither from a fetched document', async () => {
    // The load-bearing assertion. Tier comes from `get-token-tier`; archetype is
    // parsed out of the uri STRING. The fake chain has no way to serve a JSON
    // document at all, which is the point: if this service ever started fetching
    // one, every test in this file would fail rather than quietly pass.
    const chain = new FakeChain();
    chain.holdings = [holding('5')];
    chain.answers.set('get-token-tier:5', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:5', Cl.ok(Cl.some(Cl.stringAscii(uriFor('chestplate', 2)))));

    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe(2);
    expect(items[0].archetype).toBe('chestplate');
    expect(items[0].name).toBe('Epic Chestplate #5');
    expect(items[0].tierName).toBe('epic');
    // Chestplate T2 is pure HP: (0,0,0,0,15).
    expect(items[0].maxHpBonus).toBe(15);
    expect(items[0].defenseBonus).toBe(0);
    expect(items[0].summary).toBe('+15 Max HP');
  });

  it('gives two tokens of one tier different stats when their archetypes differ', async () => {
    // THE TEST THAT PROVES ARCHETYPE REACHES THE PLAYER. Before Phase 4 both of
    // these would have described identically, because tier was the whole item.
    // Asserting they now differ is what shows the uri is being read for a number
    // rather than reported as flavour beside one.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('boots', 4)))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 4)))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);
    const byId = new Map(items.map((i) => [i.tokenId, i]));

    // Expected values read from the catalog, not typed in: a table edit should
    // move this test's expectation with it, since the claim being made is "the
    // service reports what the table says", not "boots grant exactly +5".
    expect(byId.get('1')?.defenseBonus).toBe(archetypeBonusVector('boots', 4).defenseBonus);
    expect(byId.get('2')?.defenseBonus).toBe(archetypeBonusVector('sword', 4).defenseBonus);
    expect(byId.get('1')?.defenseBonus).not.toBe(byId.get('2')?.defenseBonus);
    expect(byId.get('1')?.name).toBe('Legendary Boots #1');
    expect(byId.get('2')?.name).toBe('Legendary Sword #2');
  });

  it('reads a pre-archetype token exactly as it played before', async () => {
    // Mainnet loot token #1 is held by a real player and carries this uri. It has
    // no `<slug>-` prefix, so it parses to `relic`, whose vectors are
    // byte-identical to the tier-only table it was earned under. Nobody is
    // re-statted by this feature, and this is where that is checked at the
    // service boundary rather than only in the pure package.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(LEGACY_URI))));

    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items[0].archetype).toBe('relic');
    expect(items[0].name).toBe('Rare Relic #1');
    // What tier 1 has always granted: +1 die size, nothing else.
    expect(items[0].diceFormulaBonus).toBe('1d8->1d10');
    expect(items[0].defenseBonus).toBe(0);
    expect(items[0].maxHpBonus).toBe(0);
  });

  it('reports what the ITEM grants, not the power it was described against', async () => {
    // `grantedPowerId` used to echo the caller's `basePowerId`, so every row
    // claimed to grant whatever power the character was already going to cast.
    // Harmless while nothing granted anything; wrong the moment `elixir` does.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 2)))));

    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items[0].grantedPowerId).toBeNull();
  });

  it('describes the bonus against the specified power', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1))); // relic T1: +1 die size
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(LEGACY_URI))));

    // Warrior Strike is 1d8. Tier 1 is +1 die size, so 1d8->1d10.
    const items = await makeService(chain).listForAddress(ADDRESS, 'warrior-strike');

    expect(items[0].diceFormulaBonus).toBe('1d8->1d10');
  });

  it('drops an item whose tier is out of range rather than guessing', async () => {
    // A tier the bonus table cannot price. Showing it with the wrong bonus is
    // worse than not showing it at all. Note the asymmetry with the uri, one test
    // below: a bad tier drops the item, a bad uri does not.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(MAX_POWER_UP_TIER + 1)));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 4)))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items.map((i) => i.tokenId)).toEqual(['1']);
  });

  it('keeps an item whose uri it cannot understand, as relic', async () => {
    // THE OTHER HALF OF THE ASYMMETRY. A uri is 256 bytes `mint` never inspected,
    // so an unrecognized one is an ordinary event — a future scheme, a typo, a
    // gateway that mangled it — and the honest answer is the item the token would
    // have been before archetypes. Dropping it would hide a token the player
    // genuinely owns.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii('ipfs://trebuchet-tier-3.json'))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toHaveLength(1);
    expect(items[0].archetype).toBe('relic');
    expect(items[0].tier).toBe(3);
    // Reported verbatim even though it was not understood — the player can see
    // what their token actually says.
    expect(items[0].metadataUri).toBe('ipfs://trebuchet-tier-3.json');
  });

  it('unwraps the SIP-009 ResponseOk wrapper from get-token-uri', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('3')];
    chain.answers.set('get-token-tier:3', Cl.some(Cl.uint(3)));
    // SIP-009 signature is `(response (optional (string-ascii 256)) uint)`.
    chain.answers.set('get-token-uri:3', Cl.ok(Cl.some(Cl.stringAscii(uriFor('amulet', 3)))));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items[0].metadataUri).toBe(uriFor('amulet', 3));
    // And the unwrap is load-bearing now, not cosmetic: failing it would silently
    // turn every token into a relic rather than merely blanking a display field.
    expect(items[0].archetype).toBe('amulet');
  });

  it('handles a missing URI without dropping the item', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('4')];
    chain.answers.set('get-token-tier:4', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-uri:4', Cl.ok(Cl.none()));

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toHaveLength(1);
    expect(items[0].metadataUri).toBeNull();
    expect(items[0].archetype).toBe('relic');
  });

  it('trusts get-token-tier over the tier in the uri, and says so', async () => {
    // The two can only disagree if our own mint path wrote them inconsistently,
    // which is invisible from outside. The chain wins — it is what `forge-v2`
    // validates against and what the contract range-checks — and the
    // disagreement is logged so it is not silent.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 4)))));

    const { service, logs } = makeLoggingService(chain);
    const items = await service.listForAddress(ADDRESS, null);

    expect(items[0].tier).toBe(2);
    expect(items[0].archetype).toBe('sword');
    expect(items[0].name).toBe('Epic Sword #1');
    expect(logs.some((l) => l.message.includes('disagrees'))).toBe(true);
  });

  it('sorts by tier descending, then by token id ascending', async () => {
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2'), holding('3')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii(uriFor('axe', 3)))));
    chain.answers.set('get-token-tier:3', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:3', Cl.ok(Cl.some(Cl.stringAscii(uriFor('helm', 3)))));

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
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));

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
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 2)))));
    chain.tierErrors.add('2');

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    // The first read succeeded; the second failed and took down only that item.
    expect(items.map((i) => i.tokenId)).toEqual(['1']);
  });

  it('keeps an item whose uri read throws', async () => {
    // Same asymmetry once more, this time on a transport failure rather than a
    // malformed string: the tier is known, so the item is real and displayable.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    // No `get-token-uri:1` answer registered, so the fake throws for it.

    const items = await makeService(chain).listForAddress(ADDRESS, null);

    expect(items).toHaveLength(1);
    expect(items[0].archetype).toBe('relic');
    expect(items[0].metadataUri).toBeNull();
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
describe('PowerUpService.resolveEquippedItems', () => {
  it('reads both halves of each item from chain and returns them in canonical order', async () => {
    // Sorted so a loadout's stored list is a function of the set chosen and not
    // of the order a UI listed it in. Bonuses are summed before they are applied,
    // so this cannot change the fight — it only makes two identical loadouts
    // store identically, which matters because the setup is the artifact a
    // verifier replays. Tier ascending, then archetype, so the two tier-3 items
    // below order by slug.
    const chain = new FakeChain();
    chain.holdings = [holding('7'), holding('8'), holding('9')];
    chain.answers.set('get-token-tier:7', Cl.some(Cl.uint(4)));
    chain.answers.set('get-token-uri:7', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 4)))));
    chain.answers.set('get-token-tier:8', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:8', Cl.ok(Cl.some(Cl.stringAscii(uriFor('helm', 3)))));
    chain.answers.set('get-token-tier:9', Cl.some(Cl.uint(3)));
    chain.answers.set('get-token-uri:9', Cl.ok(Cl.some(Cl.stringAscii(uriFor('axe', 3)))));

    const items = await makeService(chain).resolveEquippedItems(ADDRESS, ['7', '8', '9']);

    expect(items).toEqual([
      { archetype: 'axe', tier: 3 },
      { archetype: 'helm', tier: 3 },
      { archetype: 'sword', tier: 4 },
    ]);
  });

  it('equips a pre-archetype token as relic rather than refusing it', async () => {
    // A player holding only mainnet token #1 must still be able to equip it. This
    // is the path that decides a run's dice, so degrading here — rather than
    // throwing on an unrecognized uri — is what keeps that player in the game.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(LEGACY_URI))));

    expect(await makeService(chain).resolveEquippedItems(ADDRESS, ['1'])).toEqual([
      { archetype: 'relic', tier: 1 },
    ]);
  });

  it('costs no chain call for an empty loadout', async () => {
    // The common case — every run before the player owns their first drop. It
    // must not pay for a holdings lookup to learn nothing.
    const chain = new FakeChain();
    chain.holdings = [];

    expect(await makeService(chain).resolveEquippedItems(ADDRESS, [])).toEqual([]);
  });

  it('refuses a loadout longer than the equip cap', async () => {
    // The cap is checked at the route too, but this is the function that decides
    // what a run's dice are, and the pure engine's dice-budget proof assumes it:
    // the worst legal loadout is three axe T4 (9 dice against MAX_DAMAGE_DICE 14),
    // and a fourth would take it to 11 — still under, but the proof stops holding
    // the moment the count is unbounded. Overrunning the ceiling throws mid-combat
    // and aborts a run the player has already paid for.
    //
    // Every token here is genuinely held and genuinely readable, so the ownership
    // check would pass. Only the cap can produce this failure, which is what makes
    // the assertion about the cap rather than about the fixture.
    const chain = new FakeChain();
    const tooMany = Array.from({ length: MAX_EQUIPPED_POWER_UPS + 1 }, (_, i) => String(i + 1));
    chain.holdings = tooMany.map(holding);
    for (const id of tooMany) {
      chain.answers.set(`get-token-tier:${id}`, Cl.some(Cl.uint(1)));
      chain.answers.set(`get-token-uri:${id}`, Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));
    }

    await expect(
      makeService(chain).resolveEquippedItems(ADDRESS, tooMany),
    ).rejects.toThrow(`at most ${MAX_EQUIPPED_POWER_UPS}`);
  });

  it('refuses a token the wallet does not hold', async () => {
    // The whole point of the check. A request naming somebody else's legendary
    // would otherwise equip its bonus.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(1)));

    await expect(
      makeService(chain).resolveEquippedItems(ADDRESS, ['1', '2']),
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
      makeService(chain).resolveEquippedItems(ADDRESS, ['1']),
    ).rejects.toThrow(PowerUpOwnershipError);
  });

  it('refuses the whole loadout when one tier cannot be read', async () => {
    // Not "equip the two that worked". A partial loadout is a fight the player
    // did not choose, and on a paid run they cannot get their entry back.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 2)))));
    chain.answers.set('get-token-uri:2', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 2)))));
    chain.tierErrors.add('2');

    await expect(
      makeService(chain).resolveEquippedItems(ADDRESS, ['1', '2']),
    ).rejects.toThrow();
  });

  it('equips the rest of a loadout when one uri cannot be read', async () => {
    // Deliberately NOT the same answer as the tier case above. An unreadable uri
    // has a correct default — the item the token was before archetypes — and
    // refusing the run over one would strand a player behind a gateway hiccup
    // rather than protect them from anything.
    const chain = new FakeChain();
    chain.holdings = [holding('1'), holding('2')];
    chain.answers.set('get-token-tier:1', Cl.some(Cl.uint(2)));
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 2)))));
    chain.answers.set('get-token-tier:2', Cl.some(Cl.uint(2)));
    // No `get-token-uri:2` answer registered, so the fake throws for it.

    expect(await makeService(chain).resolveEquippedItems(ADDRESS, ['1', '2'])).toEqual([
      { archetype: 'relic', tier: 2 },
      { archetype: 'sword', tier: 2 },
    ]);
  });

  it('refuses a token the chain has no tier for', async () => {
    // `(none)` from `get-token-tier` means the loot contract does not know this
    // token. Treating it as tier 0, or as unarmed, would both be guesses.
    const chain = new FakeChain();
    chain.holdings = [holding('1')];
    chain.answers.set('get-token-tier:1', Cl.none());
    chain.answers.set('get-token-uri:1', Cl.ok(Cl.some(Cl.stringAscii(uriFor('sword', 1)))));

    await expect(
      makeService(chain).resolveEquippedItems(ADDRESS, ['1']),
    ).rejects.toThrow(PowerUpOwnershipError);
  });

  it('names the offending token so the player can fix it', async () => {
    const chain = new FakeChain();
    chain.holdings = [];

    const err = await makeService(chain)
      .resolveEquippedItems(ADDRESS, ['42'])
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(err?.message).toContain('42');
  });
});
