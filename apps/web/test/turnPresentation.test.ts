/**
 * The combat screen's turn presentation — the branches that could not be tested
 * while they lived in `Combat.tsx`.
 *
 * This module exists because of a specific failure shape. Before potions there
 * were two kinds of turn, attack and guard, so every question the UI asked about
 * a turn was written as "is it a guard?" — and the negation of a two-case check
 * is silently wrong the moment a third case arrives. Phase 6 added exactly that
 * third case. `needsTarget` is the sharp end: as `kind !== 'guard'` it would
 * have demanded a monster for a self-only heal, sent that monster's id to a
 * server that rejects it, AND disabled the button whenever no monster was alive
 * — so a potion would have been unusable at precisely the moment a player wanted
 * one, with no test in the repo able to notice.
 *
 * `apps/web`'s vitest is `environment: 'node'` with `include:
 * ['test/**\/*.test.ts']`. A `.test.tsx` matches nothing and is silently
 * ignored, so logic inside a component is untestable here by construction. That
 * is the whole argument for the module these tests cover: the branches moved out
 * so they could be pinned, and `Combat.tsx` kept only the JSX.
 *
 * The recurring theme below is the CLAMP. The engine caps a heal at `maxHp`,
 * which makes "what the flask rolled" and "what the drinker kept" two different
 * numbers. Every test that distinguishes them is guarding the same bug: a player
 * at full health being told they gained 7 HP while their health bar does not
 * move.
 */

import { describe, expect, it } from 'vitest';
import {
  describeTurn,
  firstPhase,
  healGain,
  needsTarget,
  nextPhase,
  powerBadge,
} from '../src/lib/turnPresentation';
import type { CombatTurn } from '@grimhallow/shared';

/**
 * A turn with every field a `CombatTurn` requires, overridable per test.
 *
 * Built as a full object rather than a `Partial` cast so that a field added to
 * `CombatTurn` in `shared` breaks these tests at compile time instead of
 * arriving as `undefined` at runtime — the fixture is a consumer of that type
 * and should be held to it.
 */
const turn = (overrides: Partial<CombatTurn> = {}): CombatTurn => ({
  turnNumber: 1,
  actorId: 'p0',
  actorName: 'Void Revenant',
  actorAddress: 'SP000',
  action: 'attack',
  powerId: 'warrior-strike',
  powerName: 'Strike',
  targetId: 'm0',
  targetName: 'Abyssal Hound',
  damageDealt: 5,
  targetHpAfter: 10,
  defeated: false,
  rolls: { initiative: 12 },
  derivationIndex: 1000,
  ...overrides,
});

const healTurn = (overrides: Partial<CombatTurn> = {}): CombatTurn =>
  turn({
    action: 'heal',
    powerId: 'potion-heal-1',
    powerName: 'Draught of Mending',
    targetId: 'p0',
    targetName: 'Void Revenant',
    damageDealt: 0,
    targetHpAfter: 30,
    rolls: { initiative: 12, healRoll: 6, healDice: [3, 3] },
    ...overrides,
  });

describe('needsTarget', () => {
  it('demands a target for an attack and nothing else', () => {
    // The whole point of the module. Written as `=== 'attack'` rather than
    // `!== 'guard' && !== 'heal'` so that a future fourth kind defaults to
    // needing no target — the safe direction, since a power wrongly given a
    // target gets a server error the screen can show, while a power wrongly
    // denied one is a button that cannot be pressed and gives no clue why.
    expect(needsTarget('attack')).toBe(true);
    expect(needsTarget('guard')).toBe(false);
    expect(needsTarget('heal')).toBe(false);
  });

  it('treats an unknown power as needing nothing', () => {
    // Reached when `me.powers` has not loaded, or when a run references a power
    // id this build does not know. Neither is a state in which the screen should
    // be attaching a monster id to a submission.
    expect(needsTarget(undefined)).toBe(false);
  });
});

describe('firstPhase', () => {
  it('opens on the attack roll when there is one', () => {
    expect(firstPhase(turn({ rolls: { initiative: 1, attackDice: [14], damageDice: [3] } }))).toBe(
      'attack',
    );
  });

  it('opens on damage when a turn rolled damage without a to-hit', () => {
    expect(firstPhase(turn({ rolls: { initiative: 1, damageDice: [3, 4] } }))).toBe('damage');
  });

  it('opens on the heal roll for a potion', () => {
    expect(firstPhase(healTurn())).toBe('heal');
  });

  it('falls through to quiet for a guard', () => {
    // A guard throws no dice at all and still gets time on screen, so `quiet` is
    // a real phase rather than the absence of one — skipping it would flash the
    // turn past before a player could read what happened.
    expect(firstPhase(turn({ action: 'guard', rolls: { initiative: 9 } }))).toBe('quiet');
  });

  it('keyed off the dice rolled, not off the action', () => {
    // A miss is an `attack` action with an attack roll and no damage dice. If
    // this keyed off `turn.action` it would queue a damage phase that has
    // nothing to render, and the animation would sit on an empty screen for the
    // full damage delay before advancing.
    const miss = turn({ rolls: { initiative: 1, attackDice: [2], hit: false } });
    expect(firstPhase(miss)).toBe('attack');
    expect(nextPhase(miss, 'attack')).toBeNull();
  });
});

describe('nextPhase', () => {
  it('follows an attack roll with its damage roll', () => {
    const hit = turn({ rolls: { initiative: 1, attackDice: [18], damageDice: [5] } });
    expect(nextPhase(hit, 'attack')).toBe('damage');
  });

  it('ends after a heal — a potion has no second step', () => {
    // A heal rolls once and resolves. There is no to-hit phase because a potion
    // cannot miss, so this must not fall into the attack→damage chain.
    expect(nextPhase(healTurn(), 'heal')).toBeNull();
  });

  it('ends after damage and after quiet', () => {
    expect(nextPhase(turn({ rolls: { initiative: 1, damageDice: [4] } }), 'damage')).toBeNull();
    expect(nextPhase(turn({ action: 'guard', rolls: { initiative: 1 } }), 'quiet')).toBeNull();
  });
});

describe('healGain', () => {
  it('reports the HP kept, not the HP rolled', () => {
    // The headline case. A 6-point draught taken at 27/30 restores 3, because
    // the engine clamps at maxHp. Floating the roll instead would print +6 above
    // a bar that moved by 3.
    const clamped = healTurn({ targetHpAfter: 30, rolls: { initiative: 1, healRoll: 6 } });
    expect(healGain(clamped, 27)).toBe(3);
  });

  it('is zero when the drink was entirely wasted', () => {
    // Drinking at full health. The caller skips the float on zero, because "+0"
    // floating over a full bar reads as a bug rather than as an overheal.
    expect(healGain(healTurn({ targetHpAfter: 30 }), 30)).toBe(0);
  });

  it('never goes negative', () => {
    // `targetHpAfter` on a heal cannot fall below the prior HP, so this should
    // be unreachable — but the two values arrive from separate places (the turn
    // vs. the animation's mirror of the bar), and a float reading "+-3" would be
    // a worse failure than a missing one.
    expect(healGain(healTurn({ targetHpAfter: 20 }), 30)).toBe(0);
  });

  it('ignores a turn that was not a heal', () => {
    // `damageDealt` and `targetHpAfter` are populated on an attack too. Without
    // the action check, an attack that dropped a monster from 10 to 4 would
    // compute a "gain" and float a green +6 over the monster it just hurt.
    expect(healGain(turn({ targetHpAfter: 4 }), 10)).toBe(0);
  });
});

describe('describeTurn', () => {
  it('reports a heal by the total it reached, not the roll', () => {
    // Same clamp reasoning as `healGain`: the number a player can check against
    // their own health bar is the total, and it is the only one that stays true
    // after an overheal.
    const line = describeTurn(healTurn({ targetHpAfter: 30, rolls: { initiative: 1, healRoll: 9 } }));
    expect(line).toContain('restored to 30 HP');
    expect(line).not.toContain('9');
  });

  it('still describes guards, hits and misses as it always did', () => {
    // These three lines predate the module and are unchanged by the move. Pinned
    // because the extraction is only safe if it was behaviour-preserving.
    expect(describeTurn(turn({ action: 'guard' }))).toBe('Void Revenant braces.');
    expect(
      describeTurn(turn({ rolls: { initiative: 1, hit: false, attackRoll: 7, targetDc: 14 } })),
    ).toBe('Void Revenant attacks Abyssal Hound — 7 vs DC 14. Miss.');
    expect(describeTurn(turn({ damageDealt: 5, defeated: true }))).toBe(
      'Void Revenant hits Abyssal Hound for 5. Abyssal Hound falls.',
    );
  });
});

describe('powerBadge', () => {
  const potion = { id: 'potion-heal-1', diceFormula: '2d4' };
  const strike = { id: 'warrior-strike', diceFormula: '1d8' };

  it('shows the formula for an ordinary power', () => {
    expect(powerBadge(strike, 0, null)).toBe('1d8');
  });

  it('shows remaining uses for a limited one', () => {
    expect(powerBadge(potion, 0, 1)).toBe('1 left');
  });

  it('says drained rather than showing a cooldown timer', () => {
    // The precedence that matters, and the reverse of the order the two states
    // were added in. A cooldown says "not yet" and a drained potion says "not
    // again this dungeon" — showing "3t" on something that will never come back
    // promises a refill that does not exist. Passing a live cooldown here proves
    // the spent charge wins.
    expect(powerBadge(potion, 3, 0)).toBe('Drained');
  });

  it('distinguishes an unlimited power from a spent one', () => {
    // `charges` omits every unlimited power, so `null` means no limit and `0`
    // means empty. Collapsing them is how every class attack in the game ends up
    // greyed out as "Drained".
    expect(powerBadge(strike, 0, null)).toBe('1d8');
    expect(powerBadge(strike, 0, 0)).toBe('Drained');
  });

  it('falls back to a dash for a power with no formula', () => {
    // Guard rolls nothing, so its `diceFormula` is null.
    expect(powerBadge({ id: 'guard', diceFormula: null }, 0, null)).toBe('—');
  });
});
