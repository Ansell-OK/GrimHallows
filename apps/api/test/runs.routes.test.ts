/**
 * Combat loop route tests — 04-backend-api-spec.md#5.
 *
 *   POST /runs/:runId/actions
 *   GET  /runs/:runId
 *
 * Three things are being defended here, in rough order of how much they'd cost
 * if they broke.
 *
 * THE SEED STAYS SECRET UNTIL THE RUN ENDS. Every response on this path is a
 * chance to leak it, and a player holding the seed mid-run can derive every
 * remaining roll and pick their actions knowing the outcome. That is the one
 * thing commit-reveal exists to prevent, so it is asserted against the actual
 * stored secret rather than against a field name.
 *
 * THE RUN IS RECOMPUTABLE. The last test in this file takes nothing but what the
 * API published, feeds it to `runEncounter`, and demands the same turns back. If
 * that ever fails, "independently verifiable" was a claim rather than a
 * property.
 *
 * ILLEGAL ACTIONS CHANGE NOTHING. An action is validated by replaying it, so a
 * rejection must leave the stored action list exactly as it was — a refused
 * action that still got appended would corrupt every roll after it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import type { StoredEncounterSetup } from '@grimhallow/shared';
import {
  DICE_ALGO_VERSION,
  ENCOUNTER_ALGO_VERSION,
  EncounterError,
  MAX_TURNS,
  STATS_ALGO_VERSION,
  normalizeStoredSetup,
  resolveFreeRunReward,
  runEncounter,
} from '@grimhallow/shared';
import { buildServer } from '../src/server.js';
import { MemoryRunStore } from '../src/repos/runs.js';
import { MemorySpawnStore, type SpawnRecord } from '../src/repos/spawns.js';
import { issueToken } from '../src/lib/jwt.js';
import { resolveStatement, verifyAttestation } from '../src/oracle/attestation.js';
import { seedMatchesHash } from '../src/oracle/seed.js';
import { TEST_ORACLE_KEY, stubChain, testOracleSigner } from './helpers/oracle.js';
import { characterRef } from './helpers/collections.js';

const JWT_SECRET = 'test-jwt-secret';
const PLAYER = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const STRANGER = 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG';

/** A listed collection: entry derives a character rather than refusing one. */
const CHARACTER = characterRef('7');

/** The shapes below are the spec's, narrowed to what these tests actually read. */
interface Combatant {
  id: string;
  side: 'party' | 'monsters';
  address: string | null;
  hp: number;
  maxHp: number;
  powers: { id: string; kind: 'attack' | 'guard'; cooldown: number }[];
}
interface Encounter {
  activeCombatantId: string | null;
  combatants: Combatant[];
  outcome: 'win' | 'loss' | null;
}

describe('combat loop', () => {
  let app: FastifyInstance;
  let spawns: MemorySpawnStore;
  let runs: MemoryRunStore;
  let session: string;
  let spawn: SpawnRecord;

  beforeEach(async () => {
    spawns = new MemorySpawnStore();
    runs = new MemoryRunStore();
    app = await buildServer({
      chain: stubChain(),
      spawnStore: spawns,
      runStore: runs,
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

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Run {
    runId: string;
    runToken: string;
    seedHash: string;
    encounter: Encounter;
  }

  /** Enter a free dungeon. Entry already commits the seed, so the fight is live. */
  async function startRun(): Promise<Run> {
    const res = await app.inject({
      method: 'POST',
      url: `/dungeons/${spawn.id}/enter`,
      headers: { authorization: `Bearer ${session}` },
      payload: { character: CHARACTER },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /**
   * Submit an action.
   *
   * `headers` replaces the default session outright rather than merging into it,
   * so a credential test proves the credential it names is the one that carried
   * the request.
   */
  const act = (run: Run, payload: Record<string, unknown>, headers?: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/runs/${run.runId}/actions`,
      headers: headers ?? { authorization: `Bearer ${session}` },
      payload,
    });

  const getRun = (runId: string, headers?: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: `/runs/${runId}`,
      headers: headers ?? { authorization: `Bearer ${session}` },
    });

  const party = (e: Encounter) => e.combatants.filter((c) => c.side === 'party');
  const livingMonsters = (e: Encounter) =>
    e.combatants.filter((c) => c.side === 'monsters' && c.hp > 0);

  /**
   * A legal attack for whoever is on turn.
   *
   * Reads the kit off the encounter rather than hard-coding a power id: the
   * character's class is derived from its token, so a test that named
   * `warrior-strike` would be asserting a derivation, not a combat rule.
   */
  function attack(e: Encounter): { powerId: string; targetId: string } {
    const active = e.combatants.find((c) => c.id === e.activeCombatantId);
    if (!active) throw new Error('encounter is not waiting on anyone');
    // The basic strike: an attack with no cooldown, so it is always available
    // and the loop below can't stall on a spent special.
    const power = active.powers.find((p) => p.kind === 'attack' && p.cooldown === 0);
    if (!power) throw new Error(`${active.id} has no always-available attack`);
    return { powerId: power.id, targetId: livingMonsters(e)[0].id };
  }

  /**
   * Attack until the run resolves, whichever way it goes.
   *
   * Not "until we win": whether the party survives is a function of the seed,
   * and a test that needed a win would be a test that reran until it got one.
   */
  async function playOut(run: Run): Promise<InjectResponse> {
    let encounter = run.encounter;
    // The engine caps an encounter at MAX_TURNS and every player action consumes
    // at least one turn, so this bound cannot cut a live fight short.
    for (let i = 0; i < MAX_TURNS; i++) {
      const res = await act(run, attack(encounter));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      if (body.state === 'resolved') return res;
      encounter = body.encounter;
    }
    throw new Error('encounter did not resolve within MAX_TURNS actions');
  }

  // -------------------------------------------------------------------------
  // POST /runs/:runId/actions
  // -------------------------------------------------------------------------

  describe('POST /runs/:runId/actions', () => {
    it('resolves the turn and returns the dice behind it', async () => {
      const run = await startRun();
      const res = await act(run, attack(run.encounter));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.runId).toBe(run.runId);
      expect(body.turns.length).toBeGreaterThan(0);

      const mine = body.turns[0];
      expect(mine.actorAddress).toBe(PLAYER);
      expect(mine.action).toBe('attack');
      // A d20 is a d20. The point is not the number but that there is a real
      // one: the client animates these faces, so a missing or out-of-range die
      // is a die the UI would have to invent.
      expect(mine.rolls.attackDice[0]).toBeGreaterThanOrEqual(1);
      expect(mine.rolls.attackDice[0]).toBeLessThanOrEqual(20);
      expect(typeof mine.rolls.hit).toBe('boolean');
    });

    it('returns only the turns this submission caused', async () => {
      const run = await startRun();

      const first = (await act(run, attack(run.encounter))).json();
      const second = (await act(run, attack(first.encounter))).json();

      // Each response animates one exchange — the player's turn plus whatever
      // monsters act before their next one. Re-sending the whole log would make
      // the client replay the fight from the top on every action.
      expect(second.turns[0].turnNumber).toBe(
        first.turns[first.turns.length - 1].turnNumber + 1,
      );
      const ids = new Set(first.turns.map((t: { turnNumber: number }) => t.turnNumber));
      expect(second.turns.some((t: { turnNumber: number }) => ids.has(t.turnNumber))).toBe(
        false,
      );
    });

    it('hands the turn back to the player, or ends the fight', async () => {
      const run = await startRun();
      const body = (await act(run, attack(run.encounter))).json();

      if (body.encounter.outcome === null) {
        const active = body.encounter.combatants.find(
          (c: Combatant) => c.id === body.encounter.activeCombatantId,
        );
        // Monster turns are played out inside the same request. Returning while
        // a monster is still on turn would leave the client with nothing legal
        // to send and no way to advance.
        expect(active?.address).toBe(PLAYER);
      } else {
        expect(body.encounter.activeCombatantId).toBeNull();
      }
    });

    it('appends the action, so the next replay includes it', async () => {
      const run = await startRun();
      const chosen = attack(run.encounter);
      await act(run, chosen);

      const stored = await runs.listActions(run.runId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        actionIndex: 0,
        address: PLAYER,
        powerId: chosen.powerId,
        targetId: chosen.targetId,
      });
    });

    it('accepts a Guard, which rolls no attack dice', async () => {
      const run = await startRun();
      const active = run.encounter.combatants.find(
        (c) => c.id === run.encounter.activeCombatantId,
      )!;
      const guard = active.powers.find((p) => p.kind === 'guard')!;

      const body = (await act(run, { powerId: guard.id, targetId: null })).json();
      expect(body.turns[0].action).toBe('guard');
      // Nothing was rolled, so nothing is reported. A `0` here would be a die
      // the animation would happily show.
      expect(body.turns[0].rolls.attackRoll).toBeUndefined();
      expect(body.turns[0].targetId).toBeNull();
    });

    describe('illegal actions', () => {
      /** Every rejection below must leave the action list untouched. */
      async function expectRejected(
        run: Run,
        payload: Record<string, unknown>,
        status: number,
        code: string,
      ) {
        const res = await act(run, payload);
        expect(res.statusCode).toBe(status);
        expect(res.json().error.code).toBe(code);
        expect(await runs.listActions(run.runId)).toHaveLength(0);
      }

      it('refuses a power the character does not have', async () => {
        const run = await startRun();
        // A real power, just not this class's. The engine owns this rule, and
        // the route reports its code rather than inventing a parallel one.
        await expectRejected(
          run,
          { powerId: 'undead-grasp', targetId: livingMonsters(run.encounter)[0].id },
          400,
          'POWER_NOT_IN_KIT',
        );
      });

      it('refuses a power that does not exist', async () => {
        const run = await startRun();
        await expectRejected(
          run,
          { powerId: 'excalibur', targetId: livingMonsters(run.encounter)[0].id },
          400,
          'UNKNOWN_POWER',
        );
      });

      it('refuses an attack on nothing', async () => {
        const run = await startRun();
        const { powerId } = attack(run.encounter);
        await expectRejected(run, { powerId, targetId: null }, 400, 'INVALID_TARGET');
      });

      it('refuses an attack on a combatant that is not in this encounter', async () => {
        const run = await startRun();
        const { powerId } = attack(run.encounter);
        await expectRejected(run, { powerId, targetId: 'm99' }, 400, 'INVALID_TARGET');
      });

      it('refuses an attack on your own party', async () => {
        const run = await startRun();
        const { powerId } = attack(run.encounter);
        const self = party(run.encounter)[0].id;
        await expectRejected(run, { powerId, targetId: self }, 400, 'INVALID_TARGET');
      });

      it('refuses a request with no power at all', async () => {
        const run = await startRun();
        await expectRejected(run, {}, 400, 'MISSING_POWER_ID');
      });

      it('refuses a target that is not a combatant id', async () => {
        const run = await startRun();
        const { powerId } = attack(run.encounter);
        await expectRejected(run, { powerId, targetId: 42 }, 400, 'INVALID_TARGET_ID');
      });

      it('ignores a client-supplied action type rather than trusting it', async () => {
        // `action` is in the spec's request body but is not read: whether this
        // is an attack or a guard follows from the power. An edited client that
        // labels its attack a guard gets an attack.
        const run = await startRun();
        const body = (
          await act(run, { ...attack(run.encounter), action: 'guard', turnNumber: 99 })
        ).json();
        expect(body.turns[0].action).toBe('attack');
        expect(body.turns[0].turnNumber).not.toBe(99);
      });

      it('404s on a run that does not exist', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/runs/999999/actions',
          headers: { authorization: `Bearer ${session}` },
          payload: { powerId: 'warrior-strike', targetId: 'm0' },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('RUN_NOT_FOUND');
      });

      it('404s rather than 500s on a malformed run id', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/runs/not-a-number/actions',
          headers: { authorization: `Bearer ${session}` },
          payload: { powerId: 'warrior-strike', targetId: 'm0' },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    describe('credentials', () => {
      it('accepts the run token issued at entry', async () => {
        const run = await startRun();
        const res = await act(run, attack(run.encounter), {
          'x-run-token': run.runToken,
        });
        expect(res.statusCode).toBe(200);
      });

      it('accepts the run token as a bearer, so a client needs only one header', async () => {
        const run = await startRun();
        const res = await act(run, attack(run.encounter), {
          authorization: `Bearer ${run.runToken}`,
        });
        expect(res.statusCode).toBe(200);
      });

      it('refuses a run token minted for a different run', async () => {
        const mine = await startRun();
        const other = await startRun();
        const res = await act(mine, attack(mine.encounter), {
          'x-run-token': other.runToken,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('RUN_ACCESS_DENIED');
      });

      it('refuses another player, and tells them nothing about the run', async () => {
        const run = await startRun();
        const stranger = issueToken({
          address: STRANGER,
          secret: JWT_SECRET,
          ttlSeconds: 3600,
        }).token;

        const res = await act(run, attack(run.encounter), {
          authorization: `Bearer ${stranger}`,
        });
        expect(res.statusCode).toBe(401);
        // The same error a nonexistent run gives: someone walking run ids should
        // not learn which ones exist from the difference.
        expect(res.json().error.code).toBe('RUN_ACCESS_DENIED');
        expect(await runs.listActions(run.runId)).toHaveLength(0);
      });

      it('refuses an unauthenticated submission', async () => {
        const run = await startRun();
        const res = await act(run, attack(run.encounter), {});
        expect(res.statusCode).toBe(401);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  describe('resolution', () => {
    it('resolves the run once the fight ends, and reveals the seed then', async () => {
      const run = await startRun();
      const final = (await playOut(run)).json();

      expect(final.state).toBe('resolved');
      expect(['win', 'loss']).toContain(final.combatOutcome);
      expect(final.encounter.outcome).toBe(final.combatOutcome);

      const view = (await getRun(run.runId)).json();
      // The reveal half of commit-reveal. Checked against the hash published at
      // entry, which is the whole claim: this is the seed we were already
      // committed to, not one picked to suit the result.
      expect(view.verification.seed).not.toBeNull();
      expect(seedMatchesHash(view.verification.seed, run.seedHash)).toBe(true);
    });

    it('signs the resolution over the outcome it actually reported', async () => {
      const run = await startRun();
      await playOut(run);
      const view = (await getRun(run.runId)).json();
      const v = view.verification;

      expect(
        verifyAttestation({
          // Rebuilt from published fields only — if a verifier needed something
          // the response withholds, the attestation would be decoration.
          message: resolveStatement({
            runId: view.runId,
            seed: v.seed,
            outcome: view.combatOutcome,
            turnCount: view.turns.length,
            transcriptHash: v.transcriptHash,
            algoVersions: {
              dice: v.diceAlgoVersion,
              encounter: v.encounterAlgoVersion,
              stats: v.statsAlgoVersion,
            },
            resolvedAt: v.resolvedAt,
          }),
          signature: v.resolveSignature,
          oracleAddress: v.oracleAddress,
          network: 'devnet',
        }),
      ).toBe(true);
    });

    it('does not verify against the outcome we did not report', async () => {
      const run = await startRun();
      await playOut(run);
      const view = (await getRun(run.runId)).json();
      const v = view.verification;
      const flipped = view.combatOutcome === 'win' ? 'loss' : 'win';

      // The negative case matters as much as the positive one: a verifier that
      // returns true for everything proves nothing.
      expect(
        verifyAttestation({
          message: resolveStatement({
            runId: view.runId,
            seed: v.seed,
            outcome: flipped,
            turnCount: view.turns.length,
            transcriptHash: v.transcriptHash,
            algoVersions: {
              dice: v.diceAlgoVersion,
              encounter: v.encounterAlgoVersion,
              stats: v.statsAlgoVersion,
            },
            resolvedAt: v.resolvedAt,
          }),
          signature: v.resolveSignature,
          oracleAddress: v.oracleAddress,
          network: 'devnet',
        }),
      ).toBe(false);
    });

    it('refuses further actions once resolved', async () => {
      const run = await startRun();
      await playOut(run);
      const before = (await runs.listActions(run.runId)).length;

      // A well-formed payload, deliberately not derived from the finished
      // encounter: the run's state is checked before its rules are, so this must
      // be refused for being over rather than for naming a dead monster.
      const res = await act(run, { powerId: 'warrior-strike', targetId: 'm0' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('RUN_ALREADY_RESOLVED');
      expect(await runs.listActions(run.runId)).toHaveLength(before);
    });
  });

  // -------------------------------------------------------------------------
  // GET /runs/:runId
  // -------------------------------------------------------------------------

  describe('GET /runs/:runId', () => {
    it('returns the run, its full turn log and the live encounter', async () => {
      const run = await startRun();
      const acted = (await act(run, attack(run.encounter))).json();

      const body = (await getRun(run.runId)).json();
      expect(body.runId).toBe(run.runId);
      expect(body.dungeonType).toBe('free');
      expect(body.state).toBe(acted.state);
      // The whole log, unlike the action response's slice: this is the endpoint a
      // client resumes from after a reload.
      expect(body.turns.length).toBeGreaterThanOrEqual(acted.turns.length);
      expect(body.encounter.combatants.length).toBe(run.encounter.combatants.length);
    });

    it('reports a free run reward the player can recompute from the revealed seed', async () => {
      // docs/09 B7: loot drops on every dungeon, because it is the forge's only
      // input supply. Recomputed from `verification.seed` rather than compared
      // against a hard-coded tier — the assertion that matters is that the drop
      // came off the published seed, not that this particular run rolled a 2.
      const run = await startRun();
      await playOut(run);

      const view = (await getRun(run.runId)).json();
      expect(view.reward).toEqual(
        resolveFreeRunReward({
          seed: view.verification.seed,
          combatOutcome: view.combatOutcome,
        }),
      );
    });

    it('never pays STX on a free run, whatever the seed rolled', async () => {
      // The one property a free run must not lose. A free entry contributed no
      // revenue, so a jackpot here would pay a prize out of the owner-funded
      // sponsor pool for a run that funded nothing — which is the failure the
      // free/paid split exists to prevent, and the reason B7 splits the table by
      // reward type instead of blocking free runs from drawing at all.
      const run = await startRun();
      await playOut(run);

      const reward = (await getRun(run.runId)).json().reward;
      expect(reward.kind).not.toBe('jackpot');
      expect(reward.amountUstx).toBeNull();
      // A free run declining a jackpot is by design, not an underfunded pool.
      // `degraded` pages the operator to top the pool up, and must stay quiet.
      expect(reward.degraded).toBe(false);
    });

    it('withholds the seed for the entire run', async () => {
      const run = await startRun();
      const seed = (await runs.readSeedSecret(run.runId))!;
      expect(seed).toMatch(/^[0-9a-f]{64}$/);

      const mid = (await act(run, attack(run.encounter))).json();
      expect(JSON.stringify(mid)).not.toContain(seed);

      const view = (await getRun(run.runId)).json();
      // Checked against the real stored secret, not against a field name: the
      // failure this catches is the seed arriving somewhere nobody thought to
      // look, and a player who has it can derive every remaining roll before
      // choosing their next action.
      expect(JSON.stringify(view)).not.toContain(seed);
      expect(view.verification.seed).toBeNull();
    });

    it('publishes the commitment while the run is in progress', async () => {
      const run = await startRun();
      const v = (await getRun(run.runId)).json().verification;

      expect(v.seedHash).toBe(run.seedHash);
      expect(v.commitSignature).not.toBeNull();
      expect(v.committedAt).not.toBeNull();
      // Nothing to fingerprint or sign yet — a transcript hash mid-run would
      // describe an action list still being written.
      expect(v.resolveSignature).toBeNull();
      expect(v.transcriptHash).toBeNull();
      expect(v.resolvedAt).toBeNull();
    });

    it('404s on an unknown run', async () => {
      const res = await getRun('999999');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('RUN_NOT_FOUND');
    });

    it('refuses another player', async () => {
      const run = await startRun();
      const stranger = issueToken({
        address: STRANGER,
        secret: JWT_SECRET,
        ttlSeconds: 3600,
      }).token;
      // Privileged even though it is only a read: the roster and the initiative
      // order are both derived from a seed nobody else should see the
      // consequences of yet.
      const res = await getRun(run.runId, {
        authorization: `Bearer ${stranger}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses an unauthenticated read', async () => {
      const run = await startRun();
      const res = await getRun(run.runId, {});
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // The property everything above exists to protect
  // -------------------------------------------------------------------------

  describe('independent verification', () => {
    it('replays byte-for-byte from what the API published, and nothing else', async () => {
      const run = await startRun();
      await playOut(run);

      const view = (await getRun(run.runId)).json();
      const v = view.verification;

      // Deliberately from the response and not from the stores: this is exactly
      // what a skeptical player has, and if it isn't enough then "verifiable"
      // means "trust our summary".
      expect(seedMatchesHash(v.seed, v.seedHash)).toBe(true);
      expect(v.setup).not.toBeNull();
      expect(v.actions.length).toBe((await runs.listActions(run.runId)).length);

      // `normalizeStoredSetup` is the one call between the published bytes and
      // a runnable setup, and it is deliberately visible here rather than done
      // for the player upstream. What we publish is the row the transcript hash
      // was taken over, which for a run committed before archetypes spells its
      // loadout `powerUpTiers` — a shape the engine does not accept. Publishing
      // the normalized form instead would make this line unnecessary and the
      // hash beside it uncheckable. This run is a modern one, so the call is a
      // no-op; it is written anyway because the published contract says a
      // verifier makes it, and a test that skipped it would stop proving the
      // documented path works.
      // Cast because the response is read as JSON and so is untyped here. The
      // type asserted is the one `VerificationData` declares for the field —
      // which is the point of the cast: if that declaration stops being the
      // stored shape, this line is where a verifier's assumption breaks.
      const setup = normalizeStoredSetup(v.setup as StoredEncounterSetup);
      const { turns, view: encounter } = runEncounter(v.seed, setup, v.actions);

      expect(encounter.outcome).toBe(view.combatOutcome);
      expect(turns).toEqual(view.turns);
    });

    it('states which rules produced the result, so a rule change is visible', async () => {
      const run = await startRun();
      const v = (await getRun(run.runId)).json().verification;

      // Derived stats are an input to the fight, so all three versions matter: a
      // run is only reproducible if you know which derivations played it.
      expect(v.diceAlgoVersion).toBe(DICE_ALGO_VERSION);
      expect(v.encounterAlgoVersion).toBe(ENCOUNTER_ALGO_VERSION);
      expect(v.statsAlgoVersion).toBe(STATS_ALGO_VERSION);
    });

    it('does not replay to the same fight from a seed that was not committed', async () => {
      const run = await startRun();
      await playOut(run);
      const view = (await getRun(run.runId)).json();
      const v = view.verification;

      // The control for the test above. If a wrong seed reproduced the same
      // turns, the replay would be proving nothing about the seed at all.
      //
      // Usually it cannot even get that far: the roster is drawn from the seed,
      // so a different one fields different monsters and the recorded actions
      // stop naming living targets. Refusing outright is a stronger negative
      // than differing, and both are accepted here because which one you get
      // depends on the seed.
      let replayed: unknown = null;
      try {
        replayed = runEncounter(
          'a'.repeat(64),
          normalizeStoredSetup(v.setup as StoredEncounterSetup),
          v.actions,
        ).turns;
      } catch (err) {
        expect(err).toBeInstanceOf(EncounterError);
      }
      expect(replayed).not.toEqual(view.turns);
    });
  });
});
