/**
 * Choose which power-ups walk into a dungeon.
 *
 * Power-ups are *equipped*, not auto-applied. A wallet that holds twelve of them
 * does not field twelve — the player picks up to `MAX_EQUIPPED_POWER_UPS`, and
 * that chosen set is frozen into the run's committed `EncounterSetup` before the
 * first die is derived. Everything downstream (the dice, the replay, the
 * verification page) reads that frozen list, so this widget is where a run's
 * strength is decided.
 *
 * WHAT IS SENT IS TOKEN IDS, NEVER TIERS OR ARCHETYPES. Each card shows both
 * because the backend told us both, but the backend re-reads them at entry —
 * the tier from `get-token-tier`, the archetype from the uri `get-token-uri`
 * returns — after confirming the wallet still holds the token. If this component
 * sent either it would be sending a number the server must ignore, so it doesn't
 * send one. `dungeons.routes.test.ts` pins that: a request naming a token *and*
 * claiming a tier and archetype for it is rejected outright.
 *
 * Selection is allowed to be empty. Entering bare is a normal thing to do, and
 * the empty loadout is the exact case that replays byte-identically to a
 * pre-power-up run.
 */

import React from 'react';
import { MAX_EQUIPPED_POWER_UPS } from '@grimhallow/shared';
import type { EquippablePowerUp } from '@/lib/api';
import { tierAccent, tierBorder } from '@/lib/tierStyle';

export interface LoadoutPickerProps {
  readonly items: readonly EquippablePowerUp[];
  readonly selected: readonly string[];
  readonly onToggle: (tokenId: string) => void;
  readonly loading: boolean;
  /** Non-null when the holdings could not be read at all. */
  readonly error: string | null;
  readonly onRetry: () => void;
  /** Disabled once entry is under way, so a loadout can't change mid-request. */
  readonly disabled?: boolean;
}

export function LoadoutPicker({
  items,
  selected,
  onToggle,
  loading,
  error,
  onRetry,
  disabled = false,
}: LoadoutPickerProps) {
  const full = selected.length >= MAX_EQUIPPED_POWER_UPS;

  return (
    <div className="mb-6 border-t border-stone/50 pt-4">
      <div className="flex justify-between items-baseline mb-3">
        <span className="font-ui text-[10px] text-gray-400 uppercase tracking-widest">
          Equipped Power-Ups
        </span>
        <span className="font-ui text-[10px] text-gray-500">
          {selected.length}/{MAX_EQUIPPED_POWER_UPS}
        </span>
      </div>

      {loading ? (
        <p className="font-ui text-xs text-gray-500">Reading your holdings…</p>
      ) : error ? (
        /*
         * A failed read is reported, not swallowed into an empty grid. "You hold
         * nothing" and "we couldn't check" lead to different decisions, and a
         * player who owns a legendary should not be quietly offered a bare run.
         * Entry is still allowed — unequipped is a legitimate run, not a
         * consolation prize — but they get to see that they chose it.
         */
        <div className="font-ui text-xs">
          <p className="text-blood mb-1">Couldn&apos;t read your power-ups.</p>
          <p className="text-gray-500 mb-2">{error}</p>
          <button className="text-gray-400 underline hover:text-white" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="font-ui text-xs text-gray-500">
          You hold no power-ups yet. They drop from dungeon runs — you can enter without
          one.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {items.map((item) => {
              const isSelected = selected.includes(item.tokenId);
              // A full loadout greys out what isn't in it rather than silently
              // swapping something out: which three you field is the choice, and
              // a click that quietly dropped a legendary would make it for you.
              const blocked = disabled || (full && !isSelected);
              return (
                <button
                  key={item.tokenId}
                  type="button"
                  disabled={blocked}
                  onClick={() => onToggle(item.tokenId)}
                  title={`${item.name} — ${item.summary}`}
                  className={`px-3 py-2 border bg-stone/30 text-left transition-colors ${tierBorder(
                    item.tier,
                    isSelected,
                  )} ${
                    blocked
                      ? 'opacity-40 cursor-not-allowed'
                      : 'cursor-pointer hover:border-gray-400'
                  }`}
                >
                  {/* The item's name, not its tier name. Which three you field
                      is an archetype decision now — two tier-4s can be a +9
                      damage sword and a +30 HP chestplate — so a card reading
                      "T4 Legendary" twice would hide the only thing worth
                      choosing between. */}
                  <div className={`font-display text-sm ${tierAccent(item.tier)}`}>
                    {item.name}
                  </div>
                  <div className="font-ui text-[10px] text-gray-500">{item.summary}</div>
                </button>
              );
            })}
          </div>

          {/*
            The summary is per-item and comes from the shared bonus table, the
            same one the resolver uses. It is deliberately not totalled into a
            single "your damage" figure here: bonuses land on different parts of
            a roll, and one invented aggregate number would be the kind of
            unverifiable claim this UI is built to avoid.
          */}
          {selected.length > 0 && (
            <ul className="mt-3 space-y-1">
              {items
                .filter((i) => selected.includes(i.tokenId))
                .map((i) => (
                  <li key={i.tokenId} className="font-ui text-[10px] text-gray-500">
                    <span className={tierAccent(i.tier)}>{i.name}</span> — {i.summary}
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
