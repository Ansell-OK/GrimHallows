/**
 * The starter power kit — Attack, Guard, and one class special
 * (06-mvp-roadmap.md Phase 4).
 *
 * Content, not money. It lives in `shared` because a turn's log records only a
 * `powerId` (05-data-model.md `combat_turns.power_id`), so the API, the web app
 * and any verification tool have to agree on what that id rolls. A second copy
 * of this table would let a replay compute `2d6` where the server rolled `1d8`
 * and still call itself a verification.
 *
 * Power ids are permanent. A logged turn references one forever, so renaming an
 * id silently rewrites history — add a new power instead.
 *
 * `cost` is present on every power and null on all of them: the STX-for-powers
 * mechanic is deferred, and 07 open question #8 recommends keeping the field so
 * that it stays additive.
 */

import type { CharClass, Power } from './types.js';

/** Defense DC bonus a Guard grants until the guarding combatant's next turn. */
export const GUARD_DEFENSE_BONUS = 4;

/**
 * Guard is deliberately class-agnostic and rolls no dice at all.
 *
 * It exists so a turn can be spent on something other than damage, and so the
 * turn log has at least one shape with no attack roll in it — the UI has to
 * handle "a turn happened and no dice were thrown" rather than assuming every
 * entry animates.
 */
export const GUARD_POWER_ID = 'guard';

const POWER_LIST: readonly Power[] = [
  {
    id: GUARD_POWER_ID,
    name: 'Guard',
    description: `Brace. +${GUARD_DEFENSE_BONUS} Defense until your next turn.`,
    kind: 'guard',
    diceFormula: null,
    cost: null,
    cooldown: 0,
    stat: 'vit',
    defenseBonus: GUARD_DEFENSE_BONUS,
  },

  // --- Warrior ------------------------------------------------------------
  {
    id: 'warrior-strike',
    name: 'Strike',
    description: 'A heavy swing. 1d8 + STR.',
    kind: 'attack',
    diceFormula: '1d8',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
  {
    id: 'warrior-cleave',
    name: 'Cleave',
    description: 'A wide, committed arc. 2d6 + STR.',
    kind: 'attack',
    diceFormula: '2d6',
    cost: null,
    cooldown: 3,
    stat: 'str',
    defenseBonus: 0,
  },

  // --- Paladin ------------------------------------------------------------
  {
    id: 'paladin-strike',
    name: 'Mace Blow',
    description: 'A disciplined strike. 1d6 + STR.',
    kind: 'attack',
    diceFormula: '1d6',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
  {
    id: 'paladin-smite',
    name: 'Smite',
    description: 'Call down judgement. 2d6 + INT.',
    kind: 'attack',
    diceFormula: '2d6',
    cost: null,
    cooldown: 3,
    stat: 'int',
    defenseBonus: 0,
  },

  // --- Rogue --------------------------------------------------------------
  {
    id: 'rogue-strike',
    name: 'Quick Cut',
    description: 'Fast and low. 1d6 + AGI.',
    kind: 'attack',
    diceFormula: '1d6',
    cost: null,
    cooldown: 0,
    stat: 'agi',
    defenseBonus: 0,
  },
  {
    id: 'rogue-backstab',
    name: 'Backstab',
    description: 'Find the gap. 3d4 + AGI.',
    kind: 'attack',
    diceFormula: '3d4',
    cost: null,
    cooldown: 3,
    stat: 'agi',
    defenseBonus: 0,
  },

  // --- Mage ---------------------------------------------------------------
  {
    id: 'mage-bolt',
    name: 'Arcane Bolt',
    description: 'A thrown mote of force. 1d6 + INT.',
    kind: 'attack',
    diceFormula: '1d6',
    cost: null,
    cooldown: 0,
    stat: 'int',
    defenseBonus: 0,
  },
  {
    id: 'mage-firestorm',
    name: 'Firestorm',
    description: 'Everything burns. 2d8 + INT.',
    kind: 'attack',
    diceFormula: '2d8',
    cost: null,
    cooldown: 4,
    stat: 'int',
    defenseBonus: 0,
  },

  // --- Monster powers -----------------------------------------------------
  // Monsters use the same Power shape as players so the turn resolver has one
  // code path. A monster turn and a player turn differ in who chose it, not in
  // how it is rolled.
  {
    id: 'beast-claw',
    name: 'Claw',
    description: 'Tooth and nail. 1d6 + STR.',
    kind: 'attack',
    diceFormula: '1d6',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
  {
    id: 'undead-grasp',
    name: 'Grasp',
    description: 'Cold hands. 1d6 + STR.',
    kind: 'attack',
    diceFormula: '1d6',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
  {
    id: 'venom-bite',
    name: 'Venomous Bite',
    description: 'Quick and foul. 1d8 + AGI.',
    kind: 'attack',
    diceFormula: '1d8',
    cost: null,
    cooldown: 0,
    stat: 'agi',
    defenseBonus: 0,
  },
  {
    id: 'arcane-lash',
    name: 'Arcane Lash',
    description: 'A whip of raw magic. 1d8 + INT.',
    kind: 'attack',
    diceFormula: '1d8',
    cost: null,
    cooldown: 0,
    stat: 'int',
    defenseBonus: 0,
  },
  {
    id: 'rusted-blade',
    name: 'Rusted Blade',
    description: 'Notched, but heavy. 1d8 + STR.',
    kind: 'attack',
    diceFormula: '1d8',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
  {
    id: 'heavy-slam',
    name: 'Slam',
    description: 'All of its weight at once. 1d10 + STR.',
    kind: 'attack',
    diceFormula: '1d10',
    cost: null,
    cooldown: 0,
    stat: 'str',
    defenseBonus: 0,
  },
];

const POWERS_BY_ID = new Map(POWER_LIST.map((p) => [p.id, p]));

export const POWERS: readonly Power[] = POWER_LIST;

/** Look up a power, or null for an id this build doesn't know about. */
export function getPower(id: string): Power | null {
  return POWERS_BY_ID.get(id) ?? null;
}

/**
 * The three powers a class brings into a dungeon: basic attack, Guard, special.
 *
 * Order is fixed because the combat UI lays the buttons out in it, and a player
 * who has learned that the middle button is Guard should not find it moving
 * between runs.
 */
const CLASS_KITS: Record<CharClass, readonly [string, string, string]> = {
  warrior: ['warrior-strike', GUARD_POWER_ID, 'warrior-cleave'],
  paladin: ['paladin-strike', GUARD_POWER_ID, 'paladin-smite'],
  rogue: ['rogue-strike', GUARD_POWER_ID, 'rogue-backstab'],
  mage: ['mage-bolt', GUARD_POWER_ID, 'mage-firestorm'],
};

export function classPowerIds(charClass: CharClass): readonly string[] {
  return CLASS_KITS[charClass];
}

export function classPowers(charClass: CharClass): readonly Power[] {
  return classPowerIds(charClass).map((id) => {
    const power = getPower(id);
    // Unreachable unless a kit references a deleted power; failing loudly here
    // beats a combatant silently entering a dungeon with two powers.
    if (!power) throw new Error(`Class kit for "${charClass}" references unknown power "${id}"`);
    return power;
  });
}
