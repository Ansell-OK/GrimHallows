/**
 * Screen 9 — inventory.
 *
 * Every item here is a power-up NFT the connected wallet holds on chain. There
 * is no local inventory and nothing is cached across reloads: ownership is a
 * chain fact, and an item that has been sold, or burned in the forge, must stop
 * appearing immediately.
 *
 * WHAT AN ITEM DOES COMES FROM ITS ON-CHAIN TIER. The bonus text on every card
 * is derived from `tier` — read from `get-token-tier` — by the same shared table
 * the combat resolver uses. The metadata URI is displayed as a link and is never
 * read for a number (01-game-design.md#6): rewriting a JSON file must not change
 * a single die, and the only way to guarantee that is to never consult one.
 *
 * There is no Equip button here and no Discard. Equipping is a decision made at
 * the mouth of a dungeon, not in a bag: the chosen set is frozen into that run's
 * committed setup, so it belongs to the entry screen and lives on the map. The
 * only way to destroy a power-up is the forge, which is a signed burn on its own
 * screen. Buttons that did nothing would be worse than no buttons.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import {
  errorMessage,
  explorerAddressLink,
  getConfig,
  getPowerUps,
  type ConfigResponse,
  type EquippablePowerUp,
} from '@/lib/api';
import { loadActiveCharacter } from '@/lib/session';
import { useWallet } from '@/lib/wallet';
import { MAX_POWER_UP_TIER, powerUpBonus } from '@grimhallow/shared';

/** Tier filters, built from the shared bound so a new tier appears here too. */
const TIER_FILTERS: readonly (number | 'all')[] = [
  'all',
  ...Array.from({ length: MAX_POWER_UP_TIER }, (_, i) => i + 1),
];

function tierAccent(tier: number): string {
  if (tier >= 4) return 'text-gold';
  if (tier === 3) return 'text-blood';
  if (tier === 2) return 'text-void';
  return 'text-blue-400';
}

function tierDot(tier: number): string {
  if (tier >= 4) return 'bg-gold';
  if (tier === 3) return 'bg-blood';
  if (tier === 2) return 'bg-void';
  return 'bg-blue-400';
}

export default function Inventory() {
  const navigate = useNavigate();
  const { address, status } = useWallet();

  const [items, setItems] = useState<readonly EquippablePowerUp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [filter, setFilter] = useState<number | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const character = useMemo(() => loadActiveCharacter(), []);

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!address || !character) {
        setItems([]);
        return;
      }
      setLoading(true);
      setError(null);
      getPowerUps(character, address, signal)
        .then((res) => {
          if (signal?.aborted) return;
          setItems(res.powerUps);
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
          // An empty grid would read as "you own nothing", which is a very
          // different — and alarming — message than "we couldn't check".
          setError(errorMessage(err));
          setItems([]);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [address, character],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((res) => !controller.signal.aborted && setConfig(res))
      .catch(() => undefined); // Explorer links are a nicety, not a blocker.
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.tier === filter)),
    [items, filter],
  );

  const selected = useMemo(
    () => filtered.find((i) => i.tokenId === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const connected = status === 'connected' && address;

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian">
      <TopBar />

      <div className="flex-1 pt-24 px-12 pb-12 flex space-x-8 max-w-7xl mx-auto w-full">
        <div className="flex-1 flex flex-col">
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="text-2xl font-display text-gray-200 uppercase tracking-widest">
                Power-Ups
              </h2>
              {connected && !loading && !error && (
                <p className="mt-1 font-ui text-[10px] text-gray-500 tracking-widest">
                  {items.length} held on chain
                </p>
              )}
            </div>

            <div className="flex space-x-2 bg-stone/50 border border-stone p-1">
              {TIER_FILTERS.map((option) => (
                <button
                  key={option}
                  onClick={() => setFilter(option)}
                  className={`px-4 py-1 text-xs font-ui capitalize ${
                    filter === option
                      ? 'text-gray-200 bg-stone'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {option === 'all' ? 'All' : powerUpBonus(option).tierName}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pr-4">
            {!connected ? (
              <EmptyState
                title="Wallet not connected"
                body="Connect a Stacks wallet to see the power-ups it holds."
                action={
                  <Button variant="stx" size="md" onClick={() => navigate('/')}>
                    Connect Wallet
                  </Button>
                }
              />
            ) : !character ? (
              <EmptyState
                title="No active character"
                body="A power-up's bonus is described against the character that would equip it, so pick one first."
                action={
                  <Button variant="secondary" size="md" onClick={() => navigate('/characters')}>
                    Choose a Character
                  </Button>
                }
              />
            ) : loading ? (
              <EmptyState title="Reading the chain…" body="Fetching your power-up holdings." />
            ) : error ? (
              <EmptyState
                title="Couldn't read your holdings"
                body={error}
                action={
                  <Button variant="secondary" size="md" onClick={() => load()}>
                    Retry
                  </Button>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={items.length === 0 ? 'No power-ups yet' : 'None of that tier'}
                body={
                  items.length === 0
                    ? 'Power-ups drop from dungeon runs. Clear a dungeon to earn one, then forge them together for something stronger.'
                    : 'You hold no power-ups of this tier.'
                }
              />
            ) : (
              <div className="grid grid-cols-5 gap-4 content-start">
                {filtered.map((item) => (
                  <button
                    key={item.tokenId}
                    onClick={() => setSelectedId(item.tokenId)}
                    className={`aspect-square border cursor-pointer hover:border-void transition-colors p-2 flex flex-col items-center justify-center relative overflow-hidden bg-stone/30 ${
                      selected?.tokenId === item.tokenId ? 'border-void' : 'border-stone'
                    }`}
                  >
                    <div className={`font-display text-lg ${tierAccent(item.tier)}`}>
                      T{item.tier}
                    </div>
                    <div className="font-ui text-[10px] text-gray-500 mt-1">#{item.tokenId}</div>
                    <div className={`absolute top-0 right-0 w-2 h-2 ${tierDot(item.tier)}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Item Detail Panel */}
        <div className="w-80 bg-obsidian/80 border border-stone p-6 flex flex-col">
          {selected ? (
            <ItemDetail
              item={selected}
              explorerHref={config ? explorerAddressLink(config, selected.contractId) : null}
              onForge={() => navigate('/forge')}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600 font-ui text-sm text-center">
              {connected && character ? 'Select an item' : 'Nothing to show yet'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ItemDetail({
  item,
  explorerHref,
  onForge,
}: {
  item: EquippablePowerUp;
  explorerHref: string | null;
  onForge: () => void;
}) {
  return (
    <>
      <div className="w-full aspect-square bg-stone/20 border border-stone mb-6 flex flex-col items-center justify-center p-4">
        <div className={`font-display text-5xl ${tierAccent(item.tier)}`}>T{item.tier}</div>
        <div className="font-ui text-[10px] text-gray-500 tracking-widest mt-2 uppercase">
          {item.tierName}
        </div>
      </div>

      <div
        className={`text-xs font-ui uppercase tracking-widest mb-1 ${tierAccent(item.tier)}`}
      >
        {item.tierName} Power-Up
      </div>
      <h3 className="text-xl font-display text-gray-200 mb-4">Token #{item.tokenId}</h3>

      {/* Everything in this block is derived from the on-chain tier, not from
          the metadata URI below it. */}
      <div className="space-y-2 font-ui text-sm mb-4 border-b border-stone pb-4">
        <p className="text-gray-300 leading-relaxed">{item.summary}</p>
        {item.diceFormulaBonus && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Your basic attack</span>
            <span className="text-gray-200">{item.diceFormulaBonus}</span>
          </div>
        )}
        {item.defenseBonus > 0 && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Defense</span>
            <span className="text-gray-200">+{item.defenseBonus}</span>
          </div>
        )}
      </div>

      <div className="space-y-2 font-ui text-[10px] text-gray-500 mb-6">
        <div className="flex justify-between">
          <span>On-chain tier</span>
          <span className="text-gray-400">{item.tier}</span>
        </div>
        <div className="flex justify-between">
          <span>Source</span>
          <span className="text-gray-400">
            {item.mintedVia === 'forge' ? 'Forged' : 'Dungeon reward'}
          </span>
        </div>
        {/* Shown as a link, never read for a stat. */}
        {item.metadataUri && (
          <div className="pt-2 border-t border-stone/50">
            <span className="block mb-1">Metadata (flavour only)</span>
            <span className="text-gray-600 break-all">{item.metadataUri}</span>
          </div>
        )}
      </div>

      <div className="mt-auto space-y-3">
        {/* The only action that changes anything. Equipping happens at the
            dungeon gate, where a loadout is bound to a run; discarding does not
            exist, because destroying a power-up is a signed burn and it happens
            in the forge. */}
        <Button variant="void" className="w-full" onClick={onForge}>
          Take to the Forge
        </Button>
        {explorerHref && (
          <a
            href={explorerHref}
            target="_blank"
            rel="noreferrer"
            className="block text-center text-xs font-ui text-gray-500 hover:text-gray-300"
          >
            View collection on Hiro Explorer ↗
          </a>
        )}
      </div>
    </>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 px-8">
      <h3 className="font-display text-lg text-gray-300 uppercase tracking-widest mb-2">{title}</h3>
      <p className="font-ui text-xs text-gray-500 max-w-md mb-6 leading-relaxed">{body}</p>
      {action}
    </div>
  );
}
