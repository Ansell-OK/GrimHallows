/**
 * How a logged turn becomes something on screen — the decisions, without the JSX.
 *
 * `Combat.tsx` is a `.tsx` file, and this app's vitest is configured
 * `environment: 'node'` with `include: ['test/**\/*.test.ts']`. A `.test.tsx`
 * matches nothing and is silently ignored, which means anything living in the
 * component is, in practice, untested. Phase 6 added a third kind of turn to a
 * screen that had assumed there were two, and every one of those assumptions was
 * expressed as `!== 'guard'` — the exact shape that silently does the wrong thing
 * when a third case arrives. So the branching moved here, where it can be
 * asserted.
 *
 * The rule that decides what belongs in this module: anything that reads a turn
 * and answers a question about it. Anything that reads a turn and produces an
 * element stays in the component.
 *
 * Nothing here computes a game outcome. Every number these functions handle was
 * derived server-side from a committed seed — see the header of `Combat.tsx` for
 * why the client must never hold a second opinion about the rules. The one piece
 * of arithmetic below (`healGain`) is a subtraction of two server-reported HP
 * values, not a re-derivation of either.
 */

import type { CombatTurn, PowerKind } from '@grimhallow/shared';

/**
 * Which roll a turn shows, in order.
 *
 * `quiet` is not "no phase" — it is the phase for a turn that threw no dice at
 * all, and it still gets time on screen so a Guard does not flash past.
 */
export type Phase = 'attack' | 'damage' | 'heal' | 'quiet';

/**
 * The first phase of a turn's animation.
 *
 * Ordered by what the turn actually rolled rather than by `turn.action`, because
 * the two can disagree in a way that matters: an attack that missed has an
 * attack roll and no damage dice, and keying off the action would leave the
 * screen waiting on a damage phase that never comes.
 */
export function firstPhase(turn: CombatTurn): Phase {
  if (turn.rolls.attackDice?.length) return 'attack';
  if (turn.rolls.damageDice?.length) return 'damage';
  if (turn.rolls.healDice?.length) return 'heal';
  return 'quiet';
}

/**
 * The phase after this one, or null when the turn is done.
 *
 * Only an attack has a second phase. A heal rolls once and resolves — it has no
 * to-hit step, because a potion cannot miss.
 */
export function nextPhase(turn: CombatTurn, phase: Phase): Phase | null {
  return phase === 'attack' && turn.rolls.damageDice?.length ? 'damage' : null;
}

/**
 * Whether a power needs something to point at.
 *
 * Guard braces and a heal is self-only, so both resolve without a target. This
 * was `kind !== 'guard'` before heals existed, and that spelling fails twice
 * over once a potion is equipable: `act` would send a monster id the server
 * rejects for a self-only power, and the button would sit disabled whenever no
 * monster was alive to select — so a player could not drink after the last
 * monster fell, which is precisely when they would want to.
 *
 * Stated as "attack" rather than "not guard and not heal" so that a future
 * fourth kind defaults to needing no target, which is the safe direction: a
 * power wrongly sent a target gets a server error, while a power wrongly denied
 * one is a button that cannot be pressed.
 */
export function needsTarget(kind: PowerKind | undefined): boolean {
  return kind === 'attack';
}

/**
 * HP actually gained by a heal, given what the bar was showing before it.
 *
 * NOT `rolls.healRoll`. The engine clamps a heal at `maxHp`, so the roll is what
 * the flask offered and this is what the drinker kept — a player at full health
 * who sees `+7` float above a bar that did not move has been told the game is
 * broken. Zero when the heal was entirely wasted, which the caller uses to skip
 * the float rather than render `+0`.
 *
 * Never negative: `targetHpAfter` on a heal turn cannot fall below the prior HP,
 * but this is a subtraction of two values that arrived separately, and a float
 * reading `+-3` would be a worse failure than a missing one.
 */
export function healGain(turn: CombatTurn, hpBefore: number): number {
  if (turn.action !== 'heal' || turn.targetHpAfter === null) return 0;
  return Math.max(0, turn.targetHpAfter - hpBefore);
}

/**
 * One line of combat log.
 *
 * The heal line reports `targetHpAfter` rather than the roll for the same reason
 * `healGain` does — after a clamp they are different numbers, and the one the
 * player can verify against their own health bar is the total.
 */
export function describeTurn(turn: CombatTurn): string {
  if (turn.action === 'guard') {
    return `${turn.actorName} braces.`;
  }
  if (turn.action === 'heal') {
    return `${turn.actorName} drinks — restored to ${turn.targetHpAfter} HP.`;
  }
  const target = turn.targetName ?? 'nothing';
  if (turn.rolls.hit === false) {
    return `${turn.actorName} attacks ${target} — ${turn.rolls.attackRoll} vs DC ${turn.rolls.targetDc}. Miss.`;
  }
  const defeated = turn.defeated ? ` ${target} falls.` : '';
  return `${turn.actorName} hits ${target} for ${turn.damageDealt}.${defeated}`;
}

/**
 * What a power button shows on its right edge.
 *
 * Precedence is deliberate and is the reverse of how the states were added. A
 * spent charge outranks a cooldown because it is the more final answer: a
 * cooldown says "not yet" and a drained potion says "not again this dungeon",
 * and showing a wait timer for something that is never coming back promises a
 * refill that does not exist. `charges` is absent for every unlimited power, so
 * a class attack falls through to its formula exactly as before.
 */
export function powerBadge(
  power: { readonly id: string; readonly diceFormula: string | null },
  cooldownLeft: number,
  chargesLeft: number | null,
): string {
  if (chargesLeft === 0) return 'Drained';
  if (cooldownLeft > 0) return `${cooldownLeft}t`;
  if (chargesLeft !== null) return `${chargesLeft} left`;
  return power.diceFormula ?? '—';
}
