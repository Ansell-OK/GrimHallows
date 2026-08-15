/**
 * POST /dungeons/:id/enter tests.
 *
 * Free entry is the one flow in the game where nothing is at stake, and these
 * tests mostly exist to keep it that way. The response must contain no
 * transaction payload, no fee, and no promise about money, because the moment it
 * contains one of those a client could put it in front of a wallet.
 *
 * The other half is credential scope. Entry hands out a run token; a run token
 * must not be usable as a session token, or playing one free dungeon would
 * silently grant every session-authenticated endpoint.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Cl, ClarityType } from '@stacks/transactions';
import {
  CONTRACT_NAMES,
  type LootArchetype,
  MAX_EQUIPPED_POWER_UPS,
  PAID_DUNGEON_ID,
  getNetworkConfig,
  lootFileStem,
} from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import { MemoryPartyStore } from '../src/repos/parties.js';
import { MemorySpawnStore, type SpawnRecord } from '../src/repos/spawns.js';
import { issueToken, verifyRunToken, verifyToken } from '../src/lib/jwt.js';
import {
  commitStatement,
  verifyAttestation,
} from '../src/oracle/attestation.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';
import { FakeGameCore } from './helpers/chain.js';
import { UNLISTED_COLLECTION, characterRef } from './helpers/collections.js';
import {
  deserializePostCondition,
  type StxPostCondition,
} from './helpers/postConditions.js';

const JWT_SECRET = 'test-jwt-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const LOOT_CONTRACT = `${getNetworkConfig('devnet').deployer}.${CONTRACT_NAMES.characterLootNft}`;

/**
 * A loot URI shaped exactly as a minted one, built without `lootUriFor`.
 *
 * `lootUriFor` throws while `LOOT_METADATA_CID` is unset (Phase 3 has not
 * pinned), and these tests are about the route reading a uri off chain, not
 * about which CID we mint against. The stem comes from `lootFileStem` so the
 * part that actually has to round-trip through `parseLootUri` is the shared
 * one — a stem change breaks these tests rather than sliding past them.
 */
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const uriFor = (slug: LootArchetype, tier: number): string =>
  `ipfs://${CID}/${lootFileStem(slug, tier)}.json`;

describe('POST /dungeons/:id/enter', () => {
  let app: FastifyInstance;
  let spawns: MemorySpawnStore;
  let runs: MemoryRunStore;
  let parties: MemoryPartyStore;
  let gameCore: FakeGameCore;
  let session: string;
  let spawn: SpawnRecord;

  beforeEach(async () => {
    spawns = new MemorySpawnStore();
    runs = new MemoryRunStore();
    parties = new MemoryPartyStore();
    gameCore = new FakeGameCore();
    app = await buildServer({
      chain: stubChain({
        getNftHoldings: async () => [{
          assetIdentifier: `${CHARACTER.contractId}::character`,
          contractId: CHARACTER.contractId,
          assetName: 'character',
          tokenId: CHARACTER.tokenId,
          blockHeight: 1,
          txId: '0xcharacter',
        }],
        callReadOnly: (params) => gameCore.callReadOnly(params),
      }),
      spawnStore: spawns,
      runStore: runs,
      partyStore: parties,
      oracleSigner: testOracleSigner(),
      oraclePrivateKey: TEST_ORACLE_KEY,
      jwtSecret: JWT_SECRET,
      logger: false,
    });
    session = issueToken({ address: PLAYER, secret: JWT_SECRET, ttlSeconds: 3600 }).token;
    spawn = await spawns.create({
      x: 30,
      y: 70,
      monsterTableId: 'forsaken-crypt',
      expiresAt: new Date(Date.now() + 600_000),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * The character being fielded. Required by the route because the encounter
   * engine needs a stat block, and stats are derived from `(contractId,
   * tokenId)`. Any test that isn't specifically about the character sends this
   * one and forgets about it.
   *
   * It has to be a *listed* collection: since the curated-collection delta an
   * unlisted principal has no class, and entry answers 400 rather than building
   * an encounter.
   */
  const CHARACTER = characterRef('7');

  const enter = (id: string, opts: { token?: string | null; body?: unknown } = {}) =>
    app.inject({
      method: 'POST',
      url: `/dungeons/${id}/enter`,
      headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? session}` },
      payload: opts.body ?? { character: CHARACTER },
    });

  describe('free entry', () => {
    it('needs only a session — no transaction, no fee, no signature', async () => {
      const res = await enter(spawn.id);
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.dungeonType).toBe('free');
      expect(body.spawnId).toBe(spawn.id);
      expect(body.monsterTableId).toBe('forsaken-crypt');
      expect(typeof body.runId).toBe('string');
      expect(typeof body.runToken).toBe('string');

      // Asserted as an exact key set rather than "no tx field present": a new
      // field here should have to be argued for in this test, because the way a
      // free dungeon stops being free is by someone adding a payload to sign.
      //
      // The four commitment fields are the argued-for ones. They are the
      // opposite of a payload: `seedHash` and `commitSignature` are what let a
      // player prove afterwards that the dice were fixed before they moved, and
      // publishing them costs nothing because the seed itself stays secret until
      // the run resolves.
      expect(Object.keys(body).sort()).toEqual([
        'commitSignature',
        'committedAt',
        'dungeonType',
        'encounter',
        'expiresAt',
        'monsterTableId',
        'oracleAddress',
        'runId',
        'runToken',
        'seedHash',
        'spawnId',
      ]);
    });

    describe('the seed commitment', () => {
      it('hands over a hash, and never the seed behind it', async () => {
        const body = (await enter(spawn.id)).json();

        expect(body.seedHash).toMatch(/^[0-9a-f]{64}$/);

        // Read deliberately, through the one method that exposes it — the same
        // shape the oracle uses, and the reason `RunRecord` has no seed field.
        const seed = await runs.readSeedSecret(body.runId);
        expect(seed).toMatch(/^[0-9a-f]{64}$/);
        // The seed is the one value that must not appear here. A player holding
        // it could derive every remaining roll and pick their actions knowing
        // the outcome, which is the single thing commit-reveal exists to stop.
        expect(JSON.stringify(body)).not.toContain(seed);
      });

      it('is signed by the oracle, verifiably', async () => {
        const body = (await enter(spawn.id)).json();

        expect(body.oracleAddress).toBe(testOracleSigner().address);
        expect(
          verifyAttestation({
            // Rebuilt from published fields only. If a verifier needed anything
            // the response doesn't carry, the attestation would be unusable by
            // the person it exists for.
            message: commitStatement({
              runId: body.runId,
              seedHash: body.seedHash,
              committedAt: body.committedAt,
            }),
            signature: body.commitSignature,
            // Recovered from the signature inside `verifyAttestation`, not
            // trusted from here — a check that read the address alongside the
            // signature would pass for a signature by anyone.
            oracleAddress: body.oracleAddress,
            network: 'devnet',
          }),
        ).toBe(true);
      });

      it('does not verify against a seed hash that was not the one committed', async () => {
        const body = (await enter(spawn.id)).json();
        expect(
          verifyAttestation({
            message: commitStatement({
              runId: body.runId,
              seedHash: 'f'.repeat(64),
              committedAt: body.committedAt,
            }),
            signature: body.commitSignature,
            oracleAddress: body.oracleAddress,
            network: 'devnet',
          }),
        ).toBe(false);
      });

      it('commits a different seed for every run', async () => {
        const first = (await enter(spawn.id)).json();
        const second = (await enter(spawn.id)).json();
        expect(first.seedHash).not.toBe(second.seedHash);
      });
    });

    describe('the opening encounter', () => {
      it('is built and returned, waiting on the player', async () => {
        const { encounter } = (await enter(spawn.id)).json();

        expect(encounter.monsterTableId).toBe('forsaken-crypt');
        expect(encounter.outcome).toBeNull();
        expect(encounter.order.length).toBe(encounter.combatants.length);

        // Not asserted as turn 1: initiative comes from the seed, so monsters
        // that rolled higher have already taken their turns by the time the
        // player is asked for one. What must hold is that the encounter is
        // waiting on *them* — an entry that returned mid-monster-turn would
        // leave a client with nothing legal to send.
        expect(encounter.turnNumber).toBeGreaterThanOrEqual(1);
        const active = encounter.combatants.find(
          (c: { id: string }) => c.id === encounter.activeCombatantId,
        );
        expect(active?.address).toBe(PLAYER);
      });

      it('fields the character that was sent, with a full starter kit', async () => {
        const { encounter } = (await enter(spawn.id)).json();

        const party = encounter.combatants.filter(
          (c: { side: string }) => c.side === 'party',
        );
        expect(party).toHaveLength(1);
        expect(party[0].address).toBe(PLAYER);
        // Not `hp === maxHp`: monsters that won initiative may already have
        // landed a hit, and which ones did is a function of a random seed. What
        // is invariant is that the player is alive and being asked to act.
        expect(party[0].hp).toBeGreaterThan(0);
        expect(party[0].hp).toBeLessThanOrEqual(party[0].maxHp);
        // Attack / Guard / class special (06-mvp-roadmap.md Phase 4).
        expect(party[0].powers).toHaveLength(3);
      });

      it('spawns at least one monster to fight', async () => {
        const { encounter } = (await enter(spawn.id)).json();
        const monsters = encounter.combatants.filter(
          (c: { side: string }) => c.side === 'monsters',
        );
        expect(monsters.length).toBeGreaterThan(0);
        // A monster has no wallet. A placeholder address here would put a
        // wallet-shaped string in front of a client that may render it as one.
        expect(monsters.every((m: { address: string | null }) => m.address === null)).toBe(
          true,
        );
      });
    });

    it('records the run against the spawn, seed already committed', async () => {
      const body = (await enter(spawn.id)).json();
      const run = await runs.findById(body.runId);
      expect(run).not.toBeNull();
      expect(run?.dungeonType).toBe('free');
      expect(run?.spawnId).toBe(spawn.id);
      // `committed`, not `pending`: entry commits the seed before returning, so
      // that the hash the player is handed is provably older than their first
      // action. A run left pending until the first turn would let the seed be
      // chosen after seeing it.
      expect(run?.state).toBe('committed');
      expect(run?.committedAt).toBeInstanceOf(Date);
    });

    it('creates a distinct run each time', async () => {
      const first = (await enter(spawn.id)).json();
      const second = (await enter(spawn.id)).json();
      expect(first.runId).not.toBe(second.runId);
    });

    it('returns a run token bound to that run', async () => {
      const body = (await enter(spawn.id)).json();
      const claims = verifyRunToken(body.runToken, JWT_SECRET, body.runId);
      expect(claims?.sub).toBe(PLAYER);
      expect(claims?.scope).toBe('run');
    });

    it('reports when the run token expires', async () => {
      const body = (await enter(spawn.id)).json();
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('run token scope', () => {
    it('is not accepted as a session token', async () => {
      // Same secret signs both, so this is the only thing keeping a
      // play-one-dungeon credential from becoming a full session.
      const body = (await enter(spawn.id)).json();
      expect(verifyToken(body.runToken, JWT_SECRET)).toBeNull();
    });

    it('cannot be replayed against a different run', async () => {
      const first = (await enter(spawn.id)).json();
      const second = (await enter(spawn.id)).json();
      expect(verifyRunToken(first.runToken, JWT_SECRET, second.runId)).toBeNull();
    });

    it('does not authorise entering another dungeon', async () => {
      const body = (await enter(spawn.id)).json();
      const res = await enter(spawn.id, { token: body.runToken });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('rejections', () => {
    it('401s without a session', async () => {
      const res = await enter(spawn.id, { token: null });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SESSION_INVALID');
    });

    it('401s on an expired session', async () => {
      const stale = issueToken({
        address: PLAYER,
        secret: JWT_SECRET,
        ttlSeconds: 60,
        nowSeconds: Math.floor(Date.now() / 1000) - 3600,
      }).token;
      expect((await enter(spawn.id, { token: stale })).statusCode).toBe(401);
    });

    it('401s on a token signed with the wrong secret', async () => {
      const forged = issueToken({ address: PLAYER, secret: 'not-the-secret', ttlSeconds: 3600 })
        .token;
      expect((await enter(spawn.id, { token: forged })).statusCode).toBe(401);
    });

    it('404s on an unknown spawn', async () => {
      const res = await enter('0f1e2d3c-4b5a-4967-8899-aabbccddeeff');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SPAWN_NOT_FOUND');
    });

    it('404s rather than 500s on a malformed id', async () => {
      const res = await enter('not-a-uuid');
      expect(res.statusCode).toBe(404);
    });

    it('409s on an expired spawn, and creates no run', async () => {
      const closed = await spawns.create({
        x: 1,
        y: 1,
        monsterTableId: 'echoing-cavern',
        expiresAt: new Date(Date.now() - 1000),
      });

      const res = await enter(closed.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SPAWN_EXPIRED');
      expect(runs.all()).toHaveLength(0);
    });
  });

  /**
   * Equipping power-ups at entry.
   *
   * THE BODY CARRIES TOKEN IDS, NEVER TIERS. A tier decides how much extra
   * damage the run deals, so a request that could name one could name a better
   * one. Everything the fight is resolved with is read from chain here, and the
   * tests below are mostly about what the route refuses.
   *
   * A rejected loadout must also leave no run behind. A free entry that created a
   * row and then 400'd would strand a run the player cannot act on, and on the
   * paid path the equivalent has already been charged for.
   */
  describe('equipping power-ups', () => {
    const enterWith = (tokenIds: unknown) =>
      enter(spawn.id, { body: { character: CHARACTER, powerUpTokenIds: tokenIds } });

    /**
     * Give the wallet these loot NFTs, and nothing else.
     *
     * An archetype is part of a holding because it is part of the item: since
     * archetypes, `get-token-tier` alone does not describe a token, and a stub
     * that answered only that would let every assertion below pass against
     * `relic` — the parser's safe default — while proving nothing about the half
     * of an item that picks which stat it raises.
     */
    const holding = (tokenId: string, tier: number, archetype: LootArchetype = 'sword') => ({
      tokenId,
      tier,
      archetype,
    });

    const withLoot = async (...owned: ReturnType<typeof holding>[]) => {
      await app.close();
      const held = new Map(owned.map((o) => [o.tokenId, o]));
      app = await buildServer({
        chain: stubChain({
          getNftHoldings: async () =>
            owned.map((o) => ({
              assetIdentifier: `${LOOT_CONTRACT}::grimhallow-loot`,
              contractId: LOOT_CONTRACT,
              assetName: 'grimhallow-loot',
              tokenId: o.tokenId,
              blockHeight: 1,
              txId: '0xabc',
            })),
          callReadOnly: async (params) => {
            const isTier = params.functionName === 'get-token-tier';
            const isUri = params.functionName === 'get-token-uri';
            if (isTier || isUri) {
              const hex = params.functionArgsHex?.[0];
              if (!hex) throw new Error('expected a token id argument');
              const cv = Cl.deserialize(hex);
              if (cv.type !== ClarityType.UInt) throw new Error('expected a uint');
              const item = held.get(String(cv.value));
              if (isTier) {
                return item === undefined ? Cl.none() : Cl.some(Cl.uint(item.tier));
              }
              // `get-token-uri` is `(response (optional (string-ascii 256)) uint)`,
              // so an unknown token is `(ok none)` rather than a bare `none`.
              return item === undefined
                ? Cl.ok(Cl.none())
                : Cl.ok(Cl.some(Cl.stringAscii(uriFor(item.archetype, item.tier))));
            }
            return gameCore.callReadOnly(params);
          },
        }),
        spawnStore: spawns,
        runStore: runs,
        oracleSigner: testOracleSigner(),
        oraclePrivateKey: TEST_ORACLE_KEY,
        jwtSecret: JWT_SECRET,
        logger: false,
      });
    };

    it('enters unequipped when the field is absent', async () => {
      // The common case, and it must not require the client to send anything:
      // every run before the player owns their first drop looks like this.
      const res = await enter(spawn.id);
      expect(res.statusCode).toBe(200);
      expect(runs.all()[0].setup?.party[0].powerUpItems).toEqual([]);
    });

    it('freezes the equipped items into the committed setup', async () => {
      // The setup is what `VerificationData` publishes, so this is what makes an
      // upgraded damage roll recomputable by a skeptical player. Items stored
      // anywhere else would leave the published record unable to explain its own
      // dice.
      //
      // Both halves are asserted because both halves pick the dice: a tier-4
      // sword and a tier-4 chestplate cost the same budget and roll completely
      // differently. Storing the tier and losing the archetype would reproduce
      // neither.
      await withLoot(holding('7', 4, 'chestplate'), holding('8', 1, 'boots'));

      const res = await enterWith(['7', '8']);
      expect(res.statusCode).toBe(200);
      // Tier ascending then archetype, so the stored list is a function of the
      // set chosen rather than of the order the request happened to list it in.
      expect(runs.all()[0].setup?.party[0].powerUpItems).toEqual([
        { archetype: 'boots', tier: 1 },
        { archetype: 'chestplate', tier: 4 },
      ]);
    });

    it('takes the item from chain, not from anything the client says', async () => {
      // The anti-spoofing assertion. The body names token 8, which is tier 1 on
      // chain; a legendary in the request body must not make it a legendary. The
      // same holds for archetype now that it is the other half of an item — and
      // it is enforced identically, by the request carrying ids and nothing else.
      await withLoot(holding('8', 1));

      const res = await enterWith([{ tokenId: '8', tier: 4, archetype: 'warhammer' }]);
      // Rejected outright: the shape check only accepts ids, so an object
      // carrying a tier is not a token id at all.
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_POWER_UPS');
      expect(runs.all()).toHaveLength(0);
    });

    it('400s on a token the wallet does not hold, and creates no run', async () => {
      await withLoot(holding('7', 4));

      const res = await enterWith(['7', '99']);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('POWER_UP_NOT_HELD');
      expect(res.json().error.message).toContain('99');
      expect(runs.all()).toHaveLength(0);
    });

    it('400s past the equip cap', async () => {
      const ids = Array.from({ length: MAX_EQUIPPED_POWER_UPS + 1 }, (_, i) => String(i + 1));
      await withLoot(...ids.map((id) => holding(id, 1)));

      const res = await enterWith(ids);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TOO_MANY_POWER_UPS');
      expect(runs.all()).toHaveLength(0);
    });

    it('accepts exactly the cap', async () => {
      const ids = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, (_, i) => String(i + 1));
      await withLoot(...ids.map((id) => holding(id, 2)));

      expect((await enterWith(ids)).statusCode).toBe(200);
    });

    it('400s on the same power-up equipped twice', async () => {
      // Deduplicating silently would grant one bonus where the player believes
      // they stacked two, and they would have no way to tell.
      await withLoot(holding('7', 4));

      const res = await enterWith(['7', '7']);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DUPLICATE_POWER_UPS');
    });

    it('400s on a malformed loadout rather than ignoring it', async () => {
      for (const bad of ['7', { '0': '7' }, ['abc'], [-1], [1.5], [null]]) {
        const res = await enterWith(bad);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('INVALID_POWER_UPS');
      }
    });

    it('accepts a numeric token id as well as a string one', async () => {
      // A JSON body from a hand-rolled client is as likely to send 7 as "7", and
      // both name the same NFT.
      await withLoot(holding('7', 3));

      const res = await enterWith([7]);
      expect(res.statusCode).toBe(200);
      expect(runs.all()[0].setup?.party[0].powerUpItems).toEqual([
        { archetype: 'sword', tier: 3 },
      ]);
    });

    it('makes the equipped run actually roll bigger damage', async () => {
      // End to end, and the roadmap line this whole path exists for: the tiers
      // reach the resolver, not just the database.
      await withLoot(holding('7', 4));

      const bare = await enter(spawn.id);
      const geared = await enterWith(['7']);
      expect(geared.statusCode).toBe(200);

      // The kit comes from the character's derived class, so the attack power is
      // read off the response rather than named — a test that hardcoded a
      // warrior's would break the day stat derivation reassigns token 7.
      const attacks = (res: typeof bare) =>
        res
          .json()
          .encounter.combatants.find((c: { id: string }) => c.id === 'p0')
          .powers.filter((p: { diceFormula: string | null }) => p.diceFormula !== null);

      const before = attacks(bare);
      const after = attacks(geared);
      expect(before.length).toBeGreaterThan(0);

      // Every attack in the kit rolls bigger. Tier 4 steps the die twice, adds a
      // die and adds +3, so no formula can come back unchanged.
      after.forEach((power: { id: string; diceFormula: string }, i: number) => {
        expect(power.id).toBe(before[i].id);
        expect(power.diceFormula).not.toBe(before[i].diceFormula);
        const dice = (f: string) => Number(f.split('d')[0]);
        expect(dice(power.diceFormula)).toBe(dice(before[i].diceFormula) + 1);
        expect(power.diceFormula).toMatch(/\+\d+$/);
      });
    });
  });

  describe('paid entry', () => {
    it('returns an unsigned transaction, never a signed one', async () => {
      const res = await enter(String(PAID_DUNGEON_ID));
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.dungeonType).toBe('paid');
      expect(body.dungeonId).toBe(PAID_DUNGEON_ID);
      expect(body.tx.functionName).toBe('enter-dungeon');

      // The backend prepares; the wallet signs. Anything resembling a signature
      // or a key in this response would mean the backend had custodied the
      // player's authority (02-architecture.md ground rules).
      const raw = JSON.stringify(body);
      for (const forbidden of ['signature', 'privateKey', 'senderKey', 'signedTx', 'rawTx']) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it('quotes the live gate fee from chain, not a constant', async () => {
      gameCore.gateFeeUstx = 2_500_000n;
      const body = (await enter(String(PAID_DUNGEON_ID))).json();

      expect(body.feeUstx).toBe('2500000');
      expect(gameCore.calls).toContain('get-dungeon');
    });

    it('creates no run — the run begins on chain, not here', async () => {
      // A run row here would be a run nobody paid for: the player may never
      // sign the payload they were just handed.
      await enter(String(PAID_DUNGEON_ID));
      expect(runs.all()).toHaveLength(0);
    });

    it('commits no seed before the fee is paid', async () => {
      const body = (await enter(String(PAID_DUNGEON_ID))).json();
      // Committing now would commit to a run that might never exist.
      expect(body.seedHash).toBeUndefined();
      expect(body.runToken).toBeUndefined();
      expect(body.encounter).toBeUndefined();
    });

    it('states plainly that the fee is not a wager and not refundable', async () => {
      const body = (await enter(String(PAID_DUNGEON_ID))).json();
      const text = `${body.disclosure} ${body.tx.summary}`.toLowerCase();

      expect(text).toContain('not a wager');
      expect(text).toContain('no refund');
      expect(body.disclosure).toMatch(/does not go into the prize pool/i);
    });

    it('reports the pool as a separate figure, never folded into the fee', async () => {
      gameCore.gateFeeUstx = 1_000_000n;
      gameCore.sponsorPoolUstx = 42_350_000n;
      const body = (await enter(String(PAID_DUNGEON_ID))).json();

      expect(body.feeUstx).toBe('1000000');
      expect(body.sponsorPoolUstx).toBe('42350000');
      expect(body.sponsorPoolUstx).not.toBe('43350000'); // fee + pool
    });

    it('refuses a dungeon id it has not read terms for', async () => {
      const res = await enter('9999');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DUNGEON_NOT_FOUND');
    });

    it('refuses to quote a fee it could not read, rather than guessing one', async () => {
      // A defaulted fee is a transaction the player signs for the wrong amount.
      gameCore.error = new Error('Stacks API unreachable');
      const res = await enter(String(PAID_DUNGEON_ID));

      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('refuses when the dungeon is unseeded or deactivated', async () => {
      gameCore.seeded = false;
      expect((await enter(String(PAID_DUNGEON_ID))).statusCode).toBe(503);

      gameCore.seeded = true;
      gameCore.active = false;
      expect((await enter(String(PAID_DUNGEON_ID))).statusCode).toBe(503);
    });

    it('needs a session, like every attributed action', async () => {
      const res = await enter(String(PAID_DUNGEON_ID), { token: null });
      expect(res.statusCode).toBe(401);
    });

    it('validates the character before spending an upstream call', async () => {
      const res = await enter(String(PAID_DUNGEON_ID), { body: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CHARACTER');
      expect(gameCore.calls).toHaveLength(0);
    });

    /**
     * THE INVARIANT (02-architecture.md#3, 03-smart-contracts-spec.md#2).
     *
     * An entry fee is operator revenue. It must never, by any path, increase
     * `sponsor-pool`. These are the strongest checks this suite makes, because
     * getting this wrong is the difference between a game and a pool the
     * players are unknowingly funding.
     */
    describe('the fee never touches the sponsor pool', () => {
      it('builds a payload that calls enter-dungeon and nothing else', async () => {
        const body = (await enter(String(PAID_DUNGEON_ID))).json();

        expect(body.tx.functionName).toBe('enter-dungeon');
        expect(body.tx.functionName).not.toBe('fund-pool');
        expect(JSON.stringify(body)).not.toContain('fund-pool');
      });

      it('pins the player to sending exactly the fee, in deny mode', async () => {
        // Deny + one equality condition is the mechanical guarantee: if the
        // contract also tried to take a "pool contribution" from the entrant,
        // the transaction would abort on chain instead of quietly succeeding.
        const body = (await enter(String(PAID_DUNGEON_ID))).json();

        expect(body.tx.postConditionMode).toBe('deny');
        expect(body.tx.postConditions).toHaveLength(1);

        const pc = deserializePostCondition(body.tx.postConditions[0]) as StxPostCondition;
        expect(pc.type).toBe('stx-postcondition');
        expect(pc.condition).toBe('eq');
        expect(pc.address).toBe(PLAYER);
        expect(pc.amount).toBe(body.feeUstx);
      });

      it('leaves the pool balance untouched across many quotes', async () => {
        const before = gameCore.sponsorPoolUstx;
        for (let i = 0; i < 25; i += 1) {
          expect((await enter(String(PAID_DUNGEON_ID))).statusCode).toBe(200);
        }
        expect(gameCore.sponsorPoolUstx).toBe(before);
      });

      it('reads the pool and never writes to it', async () => {
        await enter(String(PAID_DUNGEON_ID));
        // `get-sponsor-pool` is a read-only function; there is no write to make
        // here. If a broadcast ever appeared on this path, the stub throws.
        expect(gameCore.calls).toContain('get-sponsor-pool');
        expect(gameCore.calls.every((c) => c.startsWith('get-'))).toBe(true);
      });
    });
  });

  describe('parties', () => {
    it('rejects an unknown free party instead of silently dropping it', async () => {
      const res = await enter(spawn.id, { body: { partyId: 'some-party' } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PARTY_NOT_FOUND');
      expect(runs.all()).toHaveLength(0);
    });

    it('keeps paid party entry disabled', async () => {
      const res = await enter(String(PAID_DUNGEON_ID), { body: { partyId: 'some-party' } });
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('PARTY_RUNS_NOT_ENABLED');
    });

    it('starts a free run from a prepared party snapshot', async () => {
      const created = await parties.create(PLAYER);
      if (created.kind !== 'created') throw new Error('party fixture failed');
      await parties.setCharacter(created.party.id, PLAYER, CHARACTER.contractId, CHARACTER.tokenId);
      await parties.setReady(created.party.id, PLAYER, true);
      const res = await enter(spawn.id, { body: { partyId: created.party.id } });
      expect(res.statusCode).toBe(200);
      const stored = await runs.findById(res.json().runId);
      expect(stored?.partyId).toBe(created.party.id);
      expect(stored?.character).toBeNull();
      expect(stored?.setup?.party).toEqual([expect.objectContaining({ id: 'p0', address: PLAYER })]);
    });

    it('accepts an explicitly null partyId as a solo run', async () => {
      const res = await enter(spawn.id, { body: { partyId: null, character: CHARACTER } });
      expect(res.statusCode).toBe(200);
    });

    it('rejects an entry with no character rather than inventing one', async () => {
      // The engine needs a stat block, and stats are derived from the NFT. The
      // alternative to refusing is fielding a default character, which would let
      // a player enter with a token they don't own — or with none at all.
      const res = await app.inject({
        method: 'POST',
        url: `/dungeons/${spawn.id}/enter`,
        headers: { authorization: `Bearer ${session}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CHARACTER');
      expect(runs.all()).toHaveLength(0);
    });
  });
});
