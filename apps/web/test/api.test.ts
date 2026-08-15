/**
 * API client tests.
 *
 * These pin the parts of the client that decide what the player is told and
 * what gets sent: the documented error envelope must survive as a code the UI
 * can branch on, a failed fetch must not be mistaken for an empty result, and
 * the login endpoints must go out unauthenticated (they are what produce the
 * token in the first place).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  BackendValidationError,
  NetworkError,
  buildForge,
  buildMintCharacter,
  claimPaidRun,
  enterFreeDungeon,
  enterPaidDungeon,
  errorMessage,
  explorerAddressLink,
  getCharacters,
  getForgeRecipes,
  getMap,
  getCurrentParty,
  getMintQuote,
  getRun,
  requestChallenge,
  submitAction,
  verifySignature,
  type ConfigResponse,
} from '../src/lib/api';
import { saveSession } from '../src/lib/session';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];

function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  });
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('successful calls', () => {
  it('sends the challenge request as a POST with no auth header', () => {
    // /auth/challenge is what you call *before* you have a token; sending a
    // stale one would be noise at best.
    stubFetch(() => json({ challenge: 'grimhallow-login-aa', expiresAt: 'x' }));
    saveSession({ token: 'stale', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });

    return requestChallenge().then((res) => {
      expect(res.challenge).toBe('grimhallow-login-aa');
      expect(calls[0].init.method).toBe('POST');
      expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  it('posts address, signature and challenge to /auth/verify', async () => {
    stubFetch(() => json({ token: 't', address: 'ST1', expiresAt: 'x' }));

    await verifySignature({ address: 'ST1', signature: 'sig', challenge: 'ch' });

    expect(calls[0].url).toMatch(/\/auth\/verify$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      address: 'ST1',
      signature: 'sig',
      challenge: 'ch',
    });
  });

  it('attaches the stored bearer token to /characters', async () => {
    saveSession({ token: 'tok-123', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ address: 'ST1', characters: [] }));

    await getCharacters('ST1');

    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok-123',
    );
  });

  it('omits the auth header when there is no session', async () => {
    stubFetch(() => json({ address: 'ST1', characters: [] }));
    await getCharacters('ST1');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('url-encodes the address query parameter', async () => {
    stubFetch(() => json({ address: 'x', characters: [] }));
    await getCharacters('ST1 & friends');
    expect(calls[0].url).toContain('address=ST1%20%26%20friends');
  });
});

describe('backend response validation', () => {
  it('rejects malformed party members before the UI consumes them', async () => {
    stubFetch(() => json({ party: { id: 'p1', inviteCode: 'code', createdBy: 'ST1', members: [{ address: 'ST1', role: 'leader', ready: 'yes' }] } }));
    await expect(getCurrentParty()).rejects.toBeInstanceOf(BackendValidationError);
  });
});

describe('error handling', () => {
  it('surfaces the API error code and message', async () => {
    stubFetch(() =>
      json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Stacks API unreachable' } }, 503),
    );

    const err = await getCharacters('ST1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(err.status).toBe(503);
    expect(err.message).toBe('Stacks API unreachable');
  });

  it('rejects rather than resolving empty when the response is an error', async () => {
    // An empty roster and a failed lookup must never be indistinguishable.
    stubFetch(() => json({ error: { code: 'INVALID_ADDRESS', message: 'bad' } }, 400));
    await expect(getCharacters('nope')).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('handles an error response that is not the documented envelope', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    const err = await getCharacters('ST1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.status).toBe(502);
  });

  it('reports an unreachable server as a NetworkError', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const err = await getCharacters('ST1').catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/could not reach/i);
  });

  it('lets an abort propagate untouched so callers can ignore it', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', () => Promise.reject(abort));
    await expect(getCharacters('ST1')).rejects.toBe(abort);
  });
});

describe('map & dungeon entry', () => {
  /**
   * The NFT the player is fielding.
   *
   * An identifier and nothing else — the same pair the API tests send. Kept as a
   * constant so the assertions below compare against one shape rather than four
   * hand-written literals that could drift apart.
   */
  const CHARACTER = {
    contractId: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.character-loot-nft',
    tokenId: '7',
  };

  it('fetches the map without a session', async () => {
    // The map renders before the player connects anything.
    saveSession({ token: 'tok', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ spawns: [], paidDungeon: null }));

    await getMap();

    expect(calls[0].url).toMatch(/\/map$/);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('passes a null paidDungeon through as null', async () => {
    // The client must not helpfully substitute a zeroed pool: null means the
    // chain read failed, and that is a different thing from "the pool is empty".
    stubFetch(() => json({ spawns: [], paidDungeon: null }));
    const res = await getMap();
    expect(res.paidDungeon).toBeNull();
  });

  it('keeps pool and fee as the separate strings the API sent', async () => {
    stubFetch(() =>
      json({
        spawns: [],
        paidDungeon: {
          dungeonId: 1,
          name: 'The Obsidian Spire',
          location: { x: 50, y: 40 },
          gateFeeUstx: '1000000',
          sponsorPoolUstx: '42350000',
        },
      }),
    );

    const res = await getMap();
    expect(res.paidDungeon?.gateFeeUstx).toBe('1000000');
    expect(res.paidDungeon?.sponsorPoolUstx).toBe('42350000');
  });

  it('enters a free dungeon with a session token and no wallet involvement', async () => {
    saveSession({ token: 'tok-123', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() =>
      json({
        dungeonType: 'free',
        runId: '1000000000',
        spawnId: 'abc',
        monsterTableId: 'forsaken-crypt',
        runToken: 'run-tok',
        expiresAt: '2999-01-01T00:00:00Z',
      }),
    );

    const res = await enterFreeDungeon('abc', CHARACTER);

    expect(calls[0].url).toMatch(/\/dungeons\/abc\/enter$/);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok-123',
    );
    expect(res.runToken).toBe('run-tok');
  });

  it('sends no fee, amount or transaction in the entry request', async () => {
    stubFetch(() => json({ dungeonType: 'free', runId: '1', runToken: 't' }));
    await enterFreeDungeon('abc', CHARACTER);

    // The character is an identifier and the loadout is a list of identifiers:
    // the whole body is what the server derives from, and nothing in it is a
    // value. Asserted exactly, because the way a free dungeon stops being free
    // is by a field appearing here that a wallet can be asked to sign.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      character: CHARACTER,
      powerUpTokenIds: [],
    });
  });

  it('sends power-up token ids and never a tier', async () => {
    stubFetch(() => json({ dungeonType: 'free', runId: '1', runToken: 't' }));
    await enterFreeDungeon('abc', CHARACTER, ['7', '9']);

    // Same reasoning as the character: a client that could send a tier could
    // send a better one. The server reads each tier from `get-token-tier` after
    // checking the wallet holds the token, so a tier sent from here would be a
    // number it must ignore — and one a future refactor might not.
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.powerUpTokenIds).toEqual(['7', '9']);
    expect(JSON.stringify(body)).not.toMatch(/tier/i);
  });

  it('enters unequipped when no loadout is given', async () => {
    stubFetch(() => json({ dungeonType: 'free', runId: '1', runToken: 't' }));
    await enterFreeDungeon('abc', CHARACTER);

    // The default is bare, not "whatever the wallet holds". Auto-equipping would
    // make the run's strength a property of the inventory rather than a choice,
    // and the empty loadout is the case that replays identically to every run
    // recorded before power-ups existed.
    expect(JSON.parse(calls[0].init.body as string).powerUpTokenIds).toEqual([]);
  });

  it('sends no stats — only the token identity', async () => {
    stubFetch(() => json({ dungeonType: 'free', runId: '1', runToken: 't' }));
    await enterFreeDungeon('abc', CHARACTER);

    // A client that could send stats could send better ones. Derivation is the
    // server's job and this is the request that would leak it to ours.
    const body = JSON.parse(calls[0].init.body as string);
    expect(Object.keys(body.character).sort()).toEqual(['contractId', 'tokenId']);
  });

  it('url-encodes the spawn id', async () => {
    stubFetch(() => json({ dungeonType: 'free', runId: '1', runToken: 't' }));
    await enterFreeDungeon('a/../b', CHARACTER);
    expect(calls[0].url).toContain('/dungeons/a%2F..%2Fb/enter');
  });

  it('surfaces SPAWN_EXPIRED as a branchable code', async () => {
    stubFetch(() =>
      json({ error: { code: 'SPAWN_EXPIRED', message: 'That dungeon has closed.' } }, 409),
    );
    const err = await enterFreeDungeon('abc', CHARACTER).catch((e) => e);
    expect(err.code).toBe('SPAWN_EXPIRED');
    expect(err.status).toBe(409);
  });
});

/**
 * Where a paid run's loadout goes.
 *
 * Two calls, and the split between them is deliberate: the quote builds an
 * unsigned transaction when no run exists and no money has moved, so there is
 * nothing to attach a loadout to. The claim happens after the fee is spent and
 * the entry is real, which is the first moment the wallet's holdings can be
 * checked against something. These tests pin that split, because attaching a
 * loadout to the quote would look harmless and would quietly mean a selection
 * was recorded against an entry that might never be paid for.
 */
describe('paid entry carries its loadout at claim time', () => {
  const CHARACTER = {
    contractId: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.character-loot-nft',
    tokenId: '7',
  };

  it('quotes with no loadout at all', async () => {
    stubFetch(() => json({ dungeonType: 'paid', dungeonId: 1, feeUstx: '1000000', tx: {} }));
    await enterPaidDungeon(1, CHARACTER);

    expect(JSON.parse(calls[0].init.body as string)).toEqual({ character: CHARACTER });
  });

  it('sends the loadout with the claim, as token ids', async () => {
    stubFetch(() => json({ runId: '1', runToken: 't', monsterTableId: 'x' }));
    await claimPaidRun(1, '0xdeadbeef', CHARACTER, ['7', '9']);

    expect(calls[0].url).toMatch(/\/dungeons\/1\/claim$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      enterTxId: '0xdeadbeef',
      character: CHARACTER,
      powerUpTokenIds: ['7', '9'],
    });
  });

  it('claims unequipped when no loadout is given', async () => {
    stubFetch(() => json({ runId: '1', runToken: 't', monsterTableId: 'x' }));
    await claimPaidRun(1, '0xdeadbeef', CHARACTER);

    expect(JSON.parse(calls[0].init.body as string).powerUpTokenIds).toEqual([]);
  });

  it('keeps the same txid across retries so the claim stays idempotent', async () => {
    // A retried claim must reach the same run, not mint a second one against a
    // fee that was only paid once. That property lives in the backend; what this
    // pins is that the client does not undermine it by varying the request.
    stubFetch(() => json({ runId: '1', runToken: 't', monsterTableId: 'x' }));
    await claimPaidRun(1, '0xdeadbeef', CHARACTER, ['7']);
    await claimPaidRun(1, '0xdeadbeef', CHARACTER, ['7']);

    expect(calls[0].url).toBe(calls[1].url);
    expect(calls[0].init.body).toBe(calls[1].init.body);
  });
});

describe('the combat loop', () => {
  /**
   * A run token, which is not a session token.
   *
   * It authorises submitting turns for one run. The tests below care about
   * *which header* it travels in, because the two credentials have to coexist:
   * a player mid-run still has a session, and a client that spent the bearer
   * slot on a run token would have logged them out of everything else.
   */
  const RUN_TOKEN = 'run-tok-abc';

  const runResponse = () => ({
    runId: '1000000000',
    dungeonType: 'free',
    state: 'committed',
    combatOutcome: null,
    turns: [],
    encounter: null,
    reward: null,
    verification: { seed: null, seedHash: 'ab'.repeat(32) },
  });

  it('sends the run token in its own header, alongside the session', async () => {
    saveSession({ token: 'sess-1', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json(runResponse()));

    await getRun('1000000000', RUN_TOKEN);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-run-token']).toBe(RUN_TOKEN);
    expect(headers.authorization).toBe('Bearer sess-1');
    expect(calls[0].url).toMatch(/\/runs\/1000000000$/);
  });

  it('works with only a run token, so a resumed run does not need a session', async () => {
    stubFetch(() => json(runResponse()));
    await getRun('1000000000', RUN_TOKEN);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-run-token']).toBe(RUN_TOKEN);
    expect(headers.authorization).toBeUndefined();
  });

  it('passes a withheld seed through as null', async () => {
    // Null means "not revealed yet", which is the whole of commit-reveal. A
    // client that substituted anything here would be inventing the one value
    // the server is deliberately holding back.
    stubFetch(() => json(runResponse()));
    const res = await getRun('1000000000', RUN_TOKEN);
    expect(res.verification.seed).toBeNull();
  });

  it('posts an action as powerId and targetId, and nothing else', async () => {
    stubFetch(() =>
      json({ runId: '1', turns: [], encounter: null, state: 'committed', combatOutcome: null }),
    );

    await submitAction('1000000000', RUN_TOKEN, { powerId: 'warrior-strike', targetId: 'm0' });

    expect(calls[0].url).toMatch(/\/runs\/1000000000\/actions$/);
    expect(calls[0].init.method).toBe('POST');
    // No dice, no damage, no outcome. Every one of those is derived server-side
    // from the committed seed; a field here that named a result would be a
    // client asking to decide one.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      powerId: 'warrior-strike',
      targetId: 'm0',
    });
  });

  it('sends a null target for a power that has none', async () => {
    stubFetch(() =>
      json({ runId: '1', turns: [], encounter: null, state: 'committed', combatOutcome: null }),
    );

    await submitAction('1000000000', RUN_TOKEN, { powerId: 'guard', targetId: null });

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      powerId: 'guard',
      targetId: null,
    });
  });

  it('returns only the turns this submission caused', async () => {
    const turns = [{ turnNumber: 4, actorId: 'p0' }, { turnNumber: 5, actorId: 'm0' }];
    stubFetch(() =>
      json({ runId: '1', turns, encounter: null, state: 'committed', combatOutcome: 'win' }),
    );

    const res = await submitAction('1', RUN_TOKEN, { powerId: 'guard', targetId: null });
    expect(res.turns).toHaveLength(2);
    expect(res.combatOutcome).toBe('win');
  });

  it('url-encodes the run id on both calls', async () => {
    stubFetch(() => json(runResponse()));
    await getRun('a/../b', RUN_TOKEN);
    expect(calls[0].url).toContain('/runs/a%2F..%2Fb');

    await submitAction('a/../b', RUN_TOKEN, { powerId: 'guard', targetId: null }).catch(
      () => undefined,
    );
    expect(calls[1].url).toContain('/runs/a%2F..%2Fb/actions');
  });

  it('surfaces RUN_ACCESS_DENIED as a branchable code', async () => {
    stubFetch(() =>
      json({ error: { code: 'RUN_ACCESS_DENIED', message: 'Not your run.' } }, 401),
    );

    const err = await submitAction('1', 'wrong', { powerId: 'guard', targetId: null }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('RUN_ACCESS_DENIED');
  });

  it('surfaces a refused action as a code rather than a silent no-op', async () => {
    // NOT_YOUR_TURN and friends must reach the UI: an action the server refused
    // changed nothing, and a client that shrugged would animate a turn that
    // never happened.
    stubFetch(() =>
      json({ error: { code: 'NOT_YOUR_TURN', message: 'Wait your turn.' } }, 409),
    );

    const err = await submitAction('1', RUN_TOKEN, {
      powerId: 'warrior-strike',
      targetId: 'm0',
    }).catch((e) => e);
    expect(err.code).toBe('NOT_YOUR_TURN');
    expect(err.status).toBe(409);
  });
});

/**
 * The forge and the character shop — the two revenue lines added after launch.
 *
 * Both build STX-moving payloads, and both are held to the same rule the paid
 * gate already follows: the amount is quoted by the server per request and the
 * client neither caches it nor computes one. What these tests pin is the client
 * half of that — that the calls carry a session (a post-condition has to name a
 * principal), that the request body contains an intent and never an identity or
 * an amount, and that a price arrives as the string it was sent as.
 */
describe('the forge', () => {
  it('reads the recipe ladder without a session', async () => {
    // Recipes are public chain state, and the screen renders before connecting.
    saveSession({ token: 'tok', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ recipes: [] }));

    await getForgeRecipes();

    expect(calls[0].url).toMatch(/\/forge\/recipes$/);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('keeps each rung’s fee as the string the API sent', async () => {
    // uSTX is a Clarity uint. It crosses this boundary as a decimal string and
    // is not turned into a JS number anywhere, at any size.
    stubFetch(() =>
      json({
        recipes: [
          { id: 1, inputTier: 1, inputCount: 3, outputTier: 2, stxFeeUstx: '9007199254740993' },
        ],
      }),
    );

    const { recipes } = await getForgeRecipes();
    expect(recipes[0].stxFeeUstx).toBe('9007199254740993');
  });

  it('sends the session token when building a burn', async () => {
    // Authenticated since forge-v2, unlike the ladder above. The payload carries
    // an STX post-condition and a post-condition has to name the principal it
    // binds — the only address worth pinning is the authenticated one.
    saveSession({ token: 'tok-123', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ feeUstx: '500000', postConditions: [] }));

    await buildForge(1, ['1', '2', '3']);

    expect(calls[0].url).toMatch(/\/forge$/);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('sends a recipe and its inputs, and no identity or amount', async () => {
    stubFetch(() => json({ feeUstx: '500000', postConditions: [] }));
    await buildForge(2, ['11', '22']);

    // Asserted exactly. An address here would be a second, weaker source for the
    // principal the server already knows from the session; a fee here would be a
    // client proposing what it is willing to pay.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      recipeId: 2,
      tokenIds: ['11', '22'],
    });
  });

  it('returns the fee the payload pins, as a string', async () => {
    stubFetch(() => json({ feeUstx: '2000000', postConditions: ['0x00'] }));
    const tx = await buildForge(1, ['1']);
    expect(tx.feeUstx).toBe('2000000');
  });

  it('surfaces an unreadable fee as an error rather than a payload', async () => {
    // The case the backend deliberately turned into a 503. A client that fell
    // back to a remembered fee would hand the wallet a post-condition that
    // aborts after signing, at the player's expense.
    stubFetch(() =>
      json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Nothing was burned.' } }, 503),
    );

    const err = await buildForge(1, ['1', '2', '3']).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('the character shop', () => {
  it('reads the price list without a session', async () => {
    saveSession({ token: 'tok', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ priceUstx: '1000000', paused: false, classes: [], disclosure: '' }));

    await getMintQuote();

    expect(calls[0].url).toMatch(/\/characters\/mint$/);
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('passes the price and the pause switch through untouched', async () => {
    stubFetch(() =>
      json({ priceUstx: '2500000', paused: true, classes: [], disclosure: 'not a wager' }),
    );

    const quote = await getMintQuote();
    expect(quote.priceUstx).toBe('2500000');
    expect(quote.paused).toBe(true);
  });

  it('sends the session token when building a mint', async () => {
    saveSession({ token: 'tok-123', address: 'ST1', expiresAt: '2999-01-01T00:00:00Z' });
    stubFetch(() => json({ priceUstx: '1000000', postConditions: [] }));

    await buildMintCharacter('mage');

    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('sends the chosen class and nothing else', async () => {
    stubFetch(() => json({ priceUstx: '1000000', postConditions: [] }));
    await buildMintCharacter('rogue');

    // No metadata URI, because the server picks it; no address, because the
    // session is the address; no price, because the chain sets it. The class is
    // the only thing the player actually decided.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ classId: 'rogue' });
  });

  it('returns the price the payload pins, as a string', async () => {
    stubFetch(() => json({ priceUstx: '3000000', postConditions: ['0x00'] }));
    expect((await buildMintCharacter('paladin')).priceUstx).toBe('3000000');
  });

  it('surfaces MINT_PAUSED as a branchable code', async () => {
    // A refusal the shop screen has to show differently from a failure: sales
    // are closed, nothing broke, and nothing was charged.
    stubFetch(() =>
      json({ error: { code: 'MINT_PAUSED', message: 'Nothing was charged.' } }, 409),
    );

    const err = await buildMintCharacter('warrior').catch((e) => e);
    expect(err.code).toBe('MINT_PAUSED');
    expect(err.status).toBe(409);
  });

  it('surfaces INVALID_CLASS rather than resolving with a substituted class', async () => {
    // The class is written on chain in the same transaction and cannot be
    // changed afterwards. A quietly corrected one would be a permanent character
    // the player never picked.
    stubFetch(() => json({ error: { code: 'INVALID_CLASS', message: 'Unknown class.' } }, 400));

    await expect(
      buildMintCharacter('necromancer' as Parameters<typeof buildMintCharacter>[0]),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('errorMessage', () => {
  it('reads API and network errors', () => {
    expect(errorMessage(new ApiRequestError('X', 'boom', 500))).toBe('boom');
    expect(errorMessage(new NetworkError())).toMatch(/could not reach/i);
  });

  it('falls back for non-Error throws', () => {
    expect(errorMessage('a string')).toBe('Something went wrong.');
    expect(errorMessage(undefined)).toBe('Something went wrong.');
  });
});

describe('explorerAddressLink', () => {
  const base: ConfigResponse = {
    network: 'testnet',
    explorerUrl: 'https://explorer.hiro.so',
    contracts: {},
  };

  it('uses the testnet chain param for devnet and testnet', () => {
    expect(explorerAddressLink(base, 'ST1.nft')).toBe(
      'https://explorer.hiro.so/address/ST1.nft?chain=testnet',
    );
    expect(explorerAddressLink({ ...base, network: 'devnet' }, 'ST1.nft')).toContain(
      'chain=testnet',
    );
  });

  it('uses mainnet only on mainnet', () => {
    expect(explorerAddressLink({ ...base, network: 'mainnet' }, 'SP1.nft')).toContain(
      'chain=mainnet',
    );
  });
});
