/**
 * Content-integrity tests.
 *
 * The content tables reference each other by string id: a spawn names a monster
 * table, a table names monsters, a monster names a power, a class kit names three
 * powers. None of those links is type-checked, so this file is what stops a
 * rename from being discovered at runtime by a player halfway into a dungeon.
 *
 * It also pins the two invariants the combat UI is built on — that a kit is
 * exactly Attack / Guard / special, in that order — and the one that
 * 07 open question #8 asked for: `cost` exists everywhere and is used nowhere.
 */

import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_TABLES,
  GUARD_POWER_ID,
  MONSTERS,
  MONSTER_TABLES,
  POWERS,
  classPowerIds,
  classPowers,
  getEncounterTable,
  getMonster,
  getMonsterTable,
  getPower,
  parseDiceFormula,
  type CharClass,
} from '../src/index.js';

const CLASSES: readonly CharClass[] = ['warrior', 'paladin', 'rogue', 'mage'];

describe('cross-references', () => {
  it('gives every map-visible monster table an encounter to run', () => {
    // A spawn the map can show but the engine can't build is a dead end the
    // player only finds after committing to entering it.
    for (const table of MONSTER_TABLES) {
      expect(getEncounterTable(table.id), `no encounter table for ${table.id}`).not.toBeNull();
    }
  });

  it('does not define encounters for tables the map never spawns', () => {
    for (const encounter of ENCOUNTER_TABLES) {
      expect(
        getMonsterTable(encounter.monsterTableId),
        `${encounter.monsterTableId} has an encounter but no map entry`,
      ).not.toBeNull();
    }
  });

  it('draws only from monsters that exist', () => {
    for (const table of ENCOUNTER_TABLES) {
      for (const id of table.pool) {
        expect(getMonster(id), `${table.monsterTableId} references missing monster ${id}`)
          .not.toBeNull();
      }
    }
  });

  it('gives every monster a power that exists and can attack', () => {
    for (const monster of MONSTERS) {
      const power = getPower(monster.powerId);
      expect(power, `${monster.id} references missing power ${monster.powerId}`).not.toBeNull();
      // A monster whose only power were a Guard could never lose or win a fight.
      expect(power!.kind).toBe('attack');
    }
  });

  it('resolves every class kit', () => {
    for (const charClass of CLASSES) {
      expect(() => classPowers(charClass)).not.toThrow();
      expect(classPowers(charClass)).toHaveLength(3);
    }
  });
});

describe('the starter kit', () => {
  it('is Attack, Guard, special — in that order, for every class', () => {
    // Fixed because the combat screen lays the buttons out in kit order, and a
    // player who has learned the middle button is Guard shouldn't find it
    // moving between runs.
    for (const charClass of CLASSES) {
      const kit = classPowers(charClass);
      expect(kit[0].kind).toBe('attack');
      expect(kit[0].cooldown).toBe(0);
      expect(kit[1].id).toBe(GUARD_POWER_ID);
      expect(kit[2].kind).toBe('attack');
      expect(kit[2].cooldown).toBeGreaterThan(0);
    }
  });

  it('gives each class its own powers, not a shared pool', () => {
    const seen = new Set<string>();
    for (const charClass of CLASSES) {
      for (const id of classPowerIds(charClass)) {
        if (id === GUARD_POWER_ID) continue;
        expect(seen.has(id), `${id} appears in more than one class kit`).toBe(false);
        seen.add(id);
      }
    }
  });

  it('keys each power off a stat the character actually has', () => {
    for (const power of POWERS) {
      expect(['str', 'agi', 'int', 'vit']).toContain(power.stat);
    }
  });
});

describe('dice formulas', () => {
  it('parses every attack power’s formula', () => {
    for (const power of POWERS.filter((p) => p.kind === 'attack')) {
      expect(power.diceFormula, `${power.id} has no formula`).not.toBeNull();
      expect(() => parseDiceFormula(power.diceFormula!)).not.toThrow();
    }
  });

  it('leaves a Guard with no formula rather than a placeholder one', () => {
    // `0d0` would put a meaningless die in the turn log and in front of the
    // dice animation. Null says "this power rolls nothing" out loud.
    expect(getPower(GUARD_POWER_ID)!.diceFormula).toBeNull();
    expect(getPower(GUARD_POWER_ID)!.defenseBonus).toBeGreaterThan(0);
  });
});

describe('ids', () => {
  it('are unique across powers', () => {
    expect(new Set(POWERS.map((p) => p.id)).size).toBe(POWERS.length);
  });

  it('are unique across monsters', () => {
    expect(new Set(MONSTERS.map((m) => m.id)).size).toBe(MONSTERS.length);
  });

  it('are unique across encounter tables', () => {
    expect(new Set(ENCOUNTER_TABLES.map((t) => t.monsterTableId)).size).toBe(
      ENCOUNTER_TABLES.length,
    );
  });
});

describe('deferred mechanics', () => {
  it('carries a cost field on every power and charges nothing', () => {
    // 07 open question #8: keep the extension point, don't build the mechanic.
    // If a non-null cost ever appears here, a player is being asked to spend
    // STX mid-run — which is deferred, and would need a signed transaction.
    for (const power of POWERS) {
      expect(power).toHaveProperty('cost');
      expect(power.cost).toBeNull();
    }
  });
});
