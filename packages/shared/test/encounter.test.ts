/**
 * Encounter engine tests.
 *
 * The engine's whole claim is that a run is recomputable: hand someone the
 * revealed seed and the list of actions a party submitted, and they get the same
 * monsters, the same turn order, the same dice, the same corpses. Most of what
 * follows is that claim, stated in several different ways so that a regression
 * has to survive all of them.
 *
 * The other thing being pinned here is that combat *has no other entropy*. If a
 * future change reaches for `Math.random()` or a timestamp, the "same inputs
 * twice" tests below stop passing — which is the point of writing them as
 * repeated calls rather than as snapshots.
 */

import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_ALGO_VERSION,
  EncounterError,
  GUARD_DEFENSE_BONUS,
  GUARD_POWER_ID,
  MAX_DAMAGE_DICE,
  MAX_EQUIPPED_POWER_UPS,
  MAX_TURNS,
  applyPowerUps,
  classPowerIds,
  drawMonsters,
  getEncounterTable,
  getMonster,
  getPower,
  parseDiceFormula,
  runEncounter,
  statModifier,
  type EncounterSetup,
  type PlayerAction,
} from '../src/index.js';

const SEED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_SEED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const HERO: EncounterSetup['party'][number] = {
  id: 'p0',
  address: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
  name: 'Ashvane',
  charClass: 'warrior',
  // Deliberately hand-written rather than derived: these tests are about the
  // engine, and a change to stat derivation shouldn't be able to quietly
  // re-tune every assertion below.
  stats: { hp: 120, str: 18, agi: 14, int: 8, vit: 16 },
  powerUpTiers: [],
};

const setup = (overrides: Partial<EncounterSetup> = {}): EncounterSetup => ({
  monsterTableId: 'forsaken-crypt',
  party: [HERO],
  ...overrides,
});

/** Attack the first living monster with the party member's basic attack. */
function autoplay(
  seed: string,
  base: EncounterSetup = setup(),
  maxActions = MAX_TURNS,
): { actions: PlayerAction[]; result: ReturnType<typeof runEncounter> } {
  const actions: PlayerAction[] = [];
  let result = runEncounter(seed, base, actions);
  const attackId = classPowerIds(base.party[0].charClass)[0];

  while (!result.view.outcome && actions.length < maxActions) {
    const target = result.view.combatants.find((c) => c.side === 'monsters' && c.hp > 0);
    if (!target) break;
    actions.push({ powerId: attackId, targetId: target.id });
    result = runEncounter(seed, base, actions);
  }
  return { actions, result };
}

/**
 * The party's first turn is not necessarily turn 1 — monsters that roll higher
 * initiative act first, and several tests below would otherwise be asserting
 * about a monster's swing while claiming to test the player's.
 */
const firstPartyTurn = (turns: ReturnType<typeof runEncounter>['turns']) => {
  const turn = turns.find((t) => t.actorId === 'p0');
  if (!turn) throw new Error('the party never got a turn');
  return turn;
};

describe('monster composition', () => {
  it('draws the same roster from the same seed, every time', () => {
    const a = drawMonsters(SEED, 'forsaken-crypt').map((m) => m.id);
    const b = drawMonsters(SEED, 'forsaken-crypt').map((m) => m.id);
    expect(a).toEqual(b);
  });

  it('draws a different roster from a different seed', () => {
    // Not a guarantee for any two arbitrary seeds, but these two specific ones
    // must differ — if they stop differing, composition has stopped depending
    // on the seed at all.
    const a = drawMonsters(SEED, 'forsaken-crypt').map((m) => m.id);
    const b = drawMonsters(OTHER_SEED, 'forsaken-crypt').map((m) => m.id);
    expect(a).not.toEqual(b);
  });

  it('stays inside the table’s declared size range', () => {
    for (const table of ['forsaken-crypt', 'ashwood-thicket', 'echoing-cavern']) {
      const declared = getEncounterTable(table)!;
      for (let i = 0; i < 24; i++) {
        const roster = drawMonsters(`${'0'.repeat(62)}${i.toString(16).padStart(2, '0')}`, table);
        expect(roster.length).toBeGreaterThanOrEqual(declared.minMonsters);
        expect(roster.length).toBeLessThanOrEqual(declared.maxMonsters);
      }
    }
  });

  it('only ever draws monsters from that table’s own pool', () => {
    const declared = getEncounterTable('bloodfall-ruins')!;
    for (let i = 0; i < 24; i++) {
      const roster = drawMonsters(`${'ff'.repeat(31)}${i.toString(16).padStart(2, '0')}`, 'bloodfall-ruins');
      for (const m of roster) expect(declared.pool).toContain(m.id);
    }
  });

  it('rejects a table id it has no encounter for', () => {
    // A spawn whose table this build doesn't know about must fail loudly, not
    // fall back to some default fight the player never agreed to.
    const err = (() => {
      try {
        drawMonsters(SEED, 'not-a-table');
      } catch (e) {
        return e as EncounterError;
      }
    })();
    expect(err).toBeInstanceOf(EncounterError);
    expect(err?.code).toBe('UNKNOWN_MONSTER_TABLE');
  });
});

describe('determinism', () => {
  it('produces identical turns for identical inputs', () => {
    const { actions } = autoplay(SEED);
    const first = runEncounter(SEED, setup(), actions);
    const second = runEncounter(SEED, setup(), actions);
    expect(second.turns).toEqual(first.turns);
    expect(second.view).toEqual(first.view);
  });

  it('produces different dice under a different seed', () => {
    const actions: PlayerAction[] = [{ powerId: 'warrior-strike', targetId: 'm0' }];
    const a = runEncounter(SEED, setup(), actions);
    const b = runEncounter(OTHER_SEED, setup(), actions);
    expect(a.turns[0].rolls.attackDice).not.toEqual(b.turns[0].rolls.attackDice);
  });

  it('is a pure replay: a prefix of the actions replays as a prefix of the turns', () => {
    // This is the property the API depends on. It stores actions, not state,
    // and recomputes; if replaying fewer actions produced a *different* early
    // turn, every stored run would be unverifiable.
    const { actions } = autoplay(SEED);
    expect(actions.length).toBeGreaterThan(1);

    const full = runEncounter(SEED, setup(), actions);
    const partial = runEncounter(SEED, setup(), actions.slice(0, 1));

    expect(partial.turns).toEqual(full.turns.slice(0, partial.turns.length));
  });

  it('reports the algorithm version it ran', () => {
    // Verification tooling has to know which rules produced a log; a run
    // recomputed under different rules is not the same run.
    expect(runEncounter(SEED, setup()).view.algoVersion).toBe(ENCOUNTER_ALGO_VERSION);
  });
});

describe('initiative', () => {
  it('rolls d20 + AGI modifier for every combatant', () => {
    const { view } = runEncounter(SEED, setup());
    for (const c of view.combatants) {
      const mod = statModifier(c.stats.agi);
      expect(c.initiative).toBeGreaterThanOrEqual(1 + mod);
      expect(c.initiative).toBeLessThanOrEqual(20 + mod);
    }
  });

  it('orders combatants by initiative, highest first', () => {
    const { view } = runEncounter(SEED, setup({ monsterTableId: 'echoing-cavern' }));
    const rolls = view.order.map((id) => view.combatants.find((c) => c.id === id)!.initiative);
    expect(rolls).toEqual([...rolls].sort((a, b) => b - a));
  });

  it('includes every combatant exactly once', () => {
    const { view } = runEncounter(SEED, setup({ monsterTableId: 'hollowed-grounds' }));
    expect([...view.order].sort()).toEqual(view.combatants.map((c) => c.id).sort());
  });

  it('breaks ties without consulting anything ambient', () => {
    // Two identical fighters can roll identical initiative. The tiebreak has to
    // be a function of the inputs, so the same encounter replayed a second time
    // can't swap who goes first.
    const twins = setup({
      party: [
        { ...HERO, id: 'p0', name: 'Twin A' },
        { ...HERO, id: 'p1', name: 'Twin B', address: 'ST2' },
      ],
    });
    const a = runEncounter(SEED, twins).view.order;
    const b = runEncounter(SEED, twins).view.order;
    expect(a).toEqual(b);
  });
});

describe('attacks', () => {
  const attack = (targetId = 'm0'): PlayerAction[] => [
    { powerId: 'warrior-strike', targetId },
  ];

  it('rolls a real d20 and reports the face, not just the total', () => {
    const turn = firstPartyTurn(runEncounter(SEED, setup(), attack()).turns);
    expect(turn.rolls.attackDice).toHaveLength(1);
    expect(turn.rolls.attackDice![0]).toBeGreaterThanOrEqual(1);
    expect(turn.rolls.attackDice![0]).toBeLessThanOrEqual(20);
    expect(turn.rolls.attackRoll).toBe(
      turn.rolls.attackDice![0] + statModifier(HERO.stats.str),
    );
  });

  it('compares the attack roll against 10 + VIT/2', () => {
    const { turns, view } = runEncounter(SEED, setup(), attack());
    const turn = firstPartyTurn(turns);
    const target = view.combatants.find((c) => c.id === turn.targetId)!;
    expect(turn.rolls.targetDc).toBe(10 + Math.floor(target.stats.vit / 2));
    expect(turn.rolls.hit).toBe(turn.rolls.attackRoll! >= turn.rolls.targetDc!);
  });

  it('rolls damage only on a hit', () => {
    // A miss with a damage roll attached would be a number the player can see
    // and the engine ignored — legible dice means every die shown mattered.
    const { actions } = autoplay(SEED);
    const { turns } = runEncounter(SEED, setup(), actions);
    for (const turn of turns.filter((t) => t.action === 'attack')) {
      if (turn.rolls.hit) {
        expect(turn.rolls.damageDice?.length).toBeGreaterThan(0);
        expect(turn.damageDealt).toBeGreaterThan(0);
      } else {
        expect(turn.rolls.damageDice).toBeUndefined();
        expect(turn.damageDealt).toBe(0);
      }
    }
  });

  it('rolls the power’s own dice formula', () => {
    const cleave = getPower('warrior-cleave')!;
    expect(cleave.diceFormula).toBe('2d6');

    // Search seeds for one where the opening Cleave lands, so the damage dice
    // actually exist to be counted.
    for (let i = 0; i < 64; i++) {
      const seed = `${'ab'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      const { turns } = runEncounter(seed, setup(), [
        { powerId: 'warrior-cleave', targetId: 'm0' },
      ]);
      const turn = firstPartyTurn(turns);
      if (!turn.rolls.hit) continue;
      expect(turn.rolls.damageDice).toHaveLength(2);
      for (const die of turn.rolls.damageDice!) {
        expect(die).toBeGreaterThanOrEqual(1);
        expect(die).toBeLessThanOrEqual(6);
      }
      return;
    }
    throw new Error('no seed in range produced a hit — the search, not the rule, is wrong');
  });

  it('never drives HP below zero', () => {
    const { actions } = autoplay(SEED);
    const { view, turns } = runEncounter(SEED, setup(), actions);
    for (const c of view.combatants) expect(c.hp).toBeGreaterThanOrEqual(0);
    for (const t of turns) {
      if (t.targetHpAfter !== null) expect(t.targetHpAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks a defeated target exactly once', () => {
    const { actions } = autoplay(SEED);
    const { turns } = runEncounter(SEED, setup(), actions);
    const kills = turns.filter((t) => t.defeated).map((t) => t.targetId);
    expect(new Set(kills).size).toBe(kills.length);
  });
});

describe('guard', () => {
  it('raises the guarding combatant’s Defense DC', () => {
    const guard: PlayerAction[] = [{ powerId: GUARD_POWER_ID, targetId: null }];
    const plain = runEncounter(SEED, setup(), []);
    const guarded = runEncounter(SEED, setup(), guard);

    const before = plain.view.combatants.find((c) => c.id === 'p0')!;
    const after = guarded.view.combatants.find((c) => c.id === 'p0')!;
    // Only meaningful while the guard is still up, i.e. before p0 acts again.
    if (after.guarding) {
      expect(after.defenseDc).toBe(before.defenseDc + GUARD_DEFENSE_BONUS);
    }
  });

  it('logs a turn with no attack dice at all', () => {
    const turn = firstPartyTurn(
      runEncounter(SEED, setup(), [{ powerId: GUARD_POWER_ID, targetId: null }]).turns,
    );
    expect(turn.action).toBe('guard');
    expect(turn.rolls.attackDice).toBeUndefined();
    expect(turn.rolls.damageDice).toBeUndefined();
    expect(turn.damageDealt).toBe(0);
    // Initiative is still reported: it belongs to the combatant, not the swing.
    expect(turn.rolls.initiative).toBeGreaterThan(0);
  });

  it('lapses once the guarding combatant takes their next turn', () => {
    const actions: PlayerAction[] = [
      { powerId: GUARD_POWER_ID, targetId: null },
      { powerId: 'warrior-strike', targetId: 'm0' },
    ];
    const { view } = runEncounter(SEED, setup(), actions);
    expect(view.combatants.find((c) => c.id === 'p0')!.guarding).toBe(false);
  });
});

describe('cooldowns', () => {
  it('refuses a power used again too soon', () => {
    const cleave = getPower('warrior-cleave')!;
    expect(cleave.cooldown).toBeGreaterThan(0);

    expect(() =>
      runEncounter(SEED, setup(), [
        { powerId: 'warrior-cleave', targetId: 'm0' },
        { powerId: 'warrior-cleave', targetId: 'm0' },
      ]),
    ).toThrow(EncounterError);
  });

  it('reports the remaining cooldown in the view', () => {
    const { view } = runEncounter(SEED, setup(), [
      { powerId: 'warrior-cleave', targetId: 'm0' },
    ]);
    expect(view.combatants.find((c) => c.id === 'p0')!.cooldowns['warrior-cleave']).toBe(
      getPower('warrior-cleave')!.cooldown,
    );
  });

  it('ticks per the combatant’s own turns, not per global turn', () => {
    // With N monsters, a global tick would expire a 3-turn cooldown after a
    // single round. Guarding three times must still not be enough.
    const guard = { powerId: GUARD_POWER_ID, targetId: null } as const;
    expect(() =>
      runEncounter(SEED, setup(), [
        { powerId: 'warrior-cleave', targetId: 'm0' },
        guard,
        guard,
        { powerId: 'warrior-cleave', targetId: 'm0' },
      ]),
    ).toThrow(EncounterError);
  });

  it('allows the power again once the cooldown has run out', () => {
    const guard = { powerId: GUARD_POWER_ID, targetId: null } as const;
    const { turns } = runEncounter(SEED, setup(), [
      { powerId: 'warrior-cleave', targetId: 'm0' },
      guard,
      guard,
      guard,
      { powerId: 'warrior-cleave', targetId: 'm0' },
    ]);
    expect(turns.filter((t) => t.powerId === 'warrior-cleave')).toHaveLength(2);
  });
});

describe('rejected actions', () => {
  const reject = (actions: PlayerAction[]): EncounterError => {
    try {
      runEncounter(SEED, setup(), actions);
    } catch (e) {
      return e as EncounterError;
    }
    throw new Error('expected the action to be rejected');
  };

  it('rejects a power the character does not have', () => {
    // A warrior submitting Firestorm is a client that has been edited, and the
    // server is the only place that decision is actually enforced.
    expect(reject([{ powerId: 'mage-firestorm', targetId: 'm0' }]).code).toBe(
      'POWER_NOT_IN_KIT',
    );
  });

  it('rejects a power that does not exist', () => {
    expect(reject([{ powerId: 'excalibur', targetId: 'm0' }]).code).toBe('UNKNOWN_POWER');
  });

  it('rejects an attack with no target', () => {
    expect(reject([{ powerId: 'warrior-strike', targetId: null }]).code).toBe('INVALID_TARGET');
  });

  it('rejects a target that is not in this encounter', () => {
    expect(reject([{ powerId: 'warrior-strike', targetId: 'm99' }]).code).toBe('INVALID_TARGET');
  });

  it('rejects attacking a party member', () => {
    expect(reject([{ powerId: 'warrior-strike', targetId: 'p0' }]).code).toBe('INVALID_TARGET');
  });

  it('rejects attacking something already dead', () => {
    const { actions, result } = autoplay(SEED);
    const corpse = result.view.combatants.find((c) => c.side === 'monsters' && c.hp === 0);
    expect(corpse).toBeDefined();
    expect(
      reject([...actions.slice(0, actions.length - 1), {
        powerId: 'warrior-strike',
        targetId: corpse!.id,
      }]).code,
    ).toBe('INVALID_TARGET');
  });

  it('rejects an empty party', () => {
    expect(() => runEncounter(SEED, setup({ party: [] }))).toThrow(EncounterError);
  });
});

describe('flow and outcome', () => {
  it('waits for input on a party member’s turn', () => {
    const { view } = runEncounter(SEED, setup());
    const active = view.combatants.find((c) => c.id === view.activeCombatantId);
    expect(active?.side).toBe('party');
    expect(view.outcome).toBeNull();
  });

  it('plays monster turns automatically, and only ever one party turn per action', () => {
    // The party submits one action and gets back a whole exchange: their turn
    // plus every monster turn that happens before control returns to them.
    const { turns } = runEncounter(SEED, setup(), [
      { powerId: 'warrior-strike', targetId: 'm0' },
    ]);
    expect(turns.filter((t) => t.actorId === 'p0')).toHaveLength(1);
    expect(turns.filter((t) => t.actorId !== 'p0').every((t) => /^m\d+$/.test(t.actorId))).toBe(
      true,
    );
    // The last turn is a monster's unless the fight ended on the player's.
    expect(turns.length).toBeGreaterThan(1);
  });

  it('numbers turns consecutively from 1', () => {
    const { actions } = autoplay(SEED);
    const { turns } = runEncounter(SEED, setup(), actions);
    expect(turns.map((t) => t.turnNumber)).toEqual(turns.map((_, i) => i + 1));
  });

  it('gives every turn its own derivation index', () => {
    // Two turns sharing an index would produce identical dice, which is both a
    // fairness bug and an obvious tell.
    const { actions } = autoplay(SEED);
    const { turns } = runEncounter(SEED, setup(), actions);
    expect(new Set(turns.map((t) => t.derivationIndex)).size).toBe(turns.length);
  });

  it('ends in a win once every monster is down', () => {
    const { result } = autoplay(SEED);
    if (result.view.outcome === 'win') {
      expect(result.view.combatants.filter((c) => c.side === 'monsters').every((c) => c.hp === 0))
        .toBe(true);
      expect(result.view.activeCombatantId).toBeNull();
    }
  });

  it('stops taking turns once the encounter is over', () => {
    const { actions, result } = autoplay(SEED);
    expect(result.view.outcome).not.toBeNull();

    // Extra actions submitted after the end change nothing — there is no turn
    // left for them to attach to.
    const padded = runEncounter(SEED, setup(), [
      ...actions,
      { powerId: 'warrior-strike', targetId: 'm0' },
    ]);
    expect(padded.turns).toEqual(result.turns);
  });

  it('resolves a stalemate as a loss rather than looping forever', () => {
    // A party that only ever Guards can never win. The cap is what stops this
    // pure function from running unbounded inside a request handler.
    const guards: PlayerAction[] = Array.from({ length: MAX_TURNS + 10 }, () => ({
      powerId: GUARD_POWER_ID,
      targetId: null,
    }));
    const { turns, view } = runEncounter(SEED, setup(), guards);
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(view.outcome).toBe('loss');
  });
});

describe('equipped power-ups', () => {
  /**
   * A loadout must not move the attack roll.
   *
   * Damage dice and the attack die are drawn from different fixed slots within a
   * turn's stride, so equipping something changes what a hit is worth without
   * changing whether it landed. Several tests below rely on that: they compare a
   * geared run against a bare one on the same seed and expect the same hit.
   */
  const equipped = (tiers: readonly number[]): EncounterSetup =>
    setup({ party: [{ ...HERO, powerUpTiers: tiers }] });

  /** A seed whose opening Strike lands, so there are damage dice to compare. */
  const seedThatHits = (): string => {
    for (let i = 0; i < 64; i++) {
      const seed = `${'ab'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      const turn = firstPartyTurn(runEncounter(seed, setup(), STRIKE).turns);
      if (turn.rolls.hit) return seed;
    }
    throw new Error('no seed in range produced a hit — the search, not the rule, is wrong');
  };

  const STRIKE: PlayerAction[] = [{ powerId: 'warrior-strike', targetId: 'm0' }];

  it('changes nothing at all when nothing is equipped', () => {
    // The compatibility claim that lets `encounter-v1` keep its name: every run
    // logged before loadouts existed had an empty list, and an empty list must
    // replay to the byte. If this fails, historical runs stopped verifying.
    const { actions } = autoplay(SEED);
    const bare = runEncounter(SEED, setup(), actions);
    const explicit = runEncounter(SEED, equipped([]), actions);
    expect(explicit.turns).toEqual(bare.turns);
    expect(explicit.view).toEqual(bare.view);
  });

  it('rolls the upgraded die, not the base one', () => {
    // Strike is 1d8. Tier 4 steps the die twice (d8→d12) and adds one, so the
    // roll becomes 2d12+3 — a count and a range the base formula cannot produce.
    const seed = seedThatHits();
    const base = firstPartyTurn(runEncounter(seed, setup(), STRIKE).turns);
    const geared = firstPartyTurn(runEncounter(seed, equipped([4]), STRIKE).turns);

    expect(getPower('warrior-strike')!.diceFormula).toBe('1d8');
    expect(base.rolls.damageDice).toHaveLength(1);
    expect(geared.rolls.damageDice).toHaveLength(2);
    for (const die of geared.rolls.damageDice!) {
      expect(die).toBeGreaterThanOrEqual(1);
      expect(die).toBeLessThanOrEqual(12);
    }
    // Same seed, same swing: the loadout paid off on the damage, not on the
    // chance of connecting.
    expect(geared.rolls.hit).toBe(true);
    expect(geared.rolls.attackDice).toEqual(base.rolls.attackDice);
  });

  it('hits harder with a loadout than without one', () => {
    const seed = seedThatHits();
    const base = firstPartyTurn(runEncounter(seed, setup(), STRIKE).turns);
    const geared = firstPartyTurn(runEncounter(seed, equipped([4]), STRIKE).turns);
    // 2d12+3 has a floor of 5 against 1d8's ceiling of 8 + STR mod, so this is
    // not guaranteed by arithmetic alone — but it is the point of the feature,
    // and on this seed it must hold.
    expect(geared.damageDealt).toBeGreaterThan(base.damageDealt);
  });

  it('raises the holder’s Defense DC by the summed bonus', () => {
    // Tiers 2, 3 and 4 grant +1, +2 and +3. A monster swinging at this party
    // member now needs six more on the die.
    const bare = runEncounter(SEED, setup()).view.combatants.find((c) => c.id === 'p0')!;
    const geared = runEncounter(SEED, equipped([2, 3, 4])).view.combatants.find(
      (c) => c.id === 'p0',
    )!;
    expect(geared.defenseDc).toBe(bare.defenseDc + 6);
  });

  it('grants monsters nothing', () => {
    // Monsters carry an empty list by construction. A roster that inherited the
    // party's loadout would scale the fight with the gear meant to beat it.
    const { view } = runEncounter(SEED, equipped([4]));
    const bare = runEncounter(SEED, setup()).view;
    for (const m of view.combatants.filter((c) => c.side === 'monsters')) {
      const same = bare.combatants.find((c) => c.id === m.id)!;
      expect(m.defenseDc).toBe(same.defenseDc);
    }
  });

  it('does not care what order the loadout was listed in', () => {
    // Bonuses are summed before being applied. A verifier recomputing a run has
    // no way to know what order a UI happened to render an inventory in, so two
    // orderings must produce the same fight.
    const { actions } = autoplay(SEED, equipped([1, 4]));
    const a = runEncounter(SEED, equipped([1, 4]), actions);
    const b = runEncounter(SEED, equipped([4, 1]), actions);
    expect(b.turns).toEqual(a.turns);
    expect(b.view).toEqual(a.view);
  });

  it('replays the same fight from the same loadout, every time', () => {
    const { actions } = autoplay(SEED, equipped([2, 2, 3]));
    const first = runEncounter(SEED, equipped([2, 2, 3]), actions);
    const second = runEncounter(SEED, equipped([2, 2, 3]), actions);
    expect(second.turns).toEqual(first.turns);
  });

  it('rejects a tier the chain could never have minted', () => {
    // Loud rather than silently unarmed: a run resolved with a bonus that
    // quietly evaluated to nothing would charge the player for gear that did
    // not apply.
    expect(() => runEncounter(SEED, equipped([9]), STRIKE)).toThrow();
  });

  it('keeps a full legal loadout inside the turn’s dice budget', () => {
    // MAX_EQUIPPED_POWER_UPS legendaries on the widest-rolling power in the kit
    // is the worst case a player can legally build. If it overruns the stride,
    // combat aborts mid-run — so the cap and the stride are checked against each
    // other here rather than trusted to stay in sync by comment.
    const worst = Array.from({ length: MAX_EQUIPPED_POWER_UPS }, () => 4);
    const widest = Math.max(
      ...classPowerIds('warrior')
        .map((id) => getPower(id)!.diceFormula)
        .filter((f): f is string => !!f)
        .map((f) => parseDiceFormula(applyPowerUps(f, worst)!).count),
    );
    expect(widest).toBeLessThanOrEqual(MAX_DAMAGE_DICE);
  });
});

describe('the view handed to the client', () => {
  it('names duplicate monsters distinguishably', () => {
    // Search for a roster that actually contains a duplicate; several tables
    // weight one monster twice specifically so this happens.
    for (let i = 0; i < 64; i++) {
      const seed = `${'3c'.repeat(31)}${i.toString(16).padStart(2, '0')}`;
      const { view } = runEncounter(seed, setup());
      const monsters = view.combatants.filter((c) => c.side === 'monsters');
      const names = monsters.map((m) => m.name);
      if (new Set(names).size === names.length && names.length > 1) {
        // No duplicates in this roster — but names must still be unique.
        expect(new Set(names).size).toBe(names.length);
        continue;
      }
      expect(new Set(names).size).toBe(names.length);
      return;
    }
  });

  it('gives each party member their class kit, in kit order', () => {
    const { view } = runEncounter(SEED, setup());
    const hero = view.combatants.find((c) => c.id === 'p0')!;
    expect(hero.powers.map((p) => p.id)).toEqual([...classPowerIds('warrior')]);
  });

  it('starts everyone at full HP', () => {
    const { view } = runEncounter(SEED, setup());
    for (const c of view.combatants) expect(c.hp).toBe(c.maxHp);
    expect(view.combatants.find((c) => c.id === 'p0')!.maxHp).toBe(HERO.stats.hp);
  });

  it('uses the monster stat blocks as written', () => {
    const roster = drawMonsters(SEED, 'forsaken-crypt');
    const { view } = runEncounter(SEED, setup());
    const monsters = view.combatants.filter((c) => c.side === 'monsters');
    monsters.forEach((m, i) => {
      expect(m.stats).toEqual(getMonster(roster[i].id)!.stats);
    });
  });

  it('gives monsters no address to attribute a turn to', () => {
    const { view } = runEncounter(SEED, setup());
    for (const m of view.combatants.filter((c) => c.side === 'monsters')) {
      expect(m.address).toBeNull();
    }
    expect(view.combatants.find((c) => c.id === 'p0')!.address).toBe(HERO.address);
  });
});
