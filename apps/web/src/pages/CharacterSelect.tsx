/**
 * Screen 3 — character selection.
 *
 * Every card here is a SIP-009 token the connected wallet actually holds, with
 * stats produced by the shared `deriveStats` on the server. The roster is not
 * cached client-side across reloads: ownership is a chain fact, and a token
 * that has been sold must stop being playable immediately.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '@/components/layout/TopBar';
import { CharacterCard, Rarity, CharClass } from '@/components/ui/CharacterCard';
import { Button } from '@/components/ui/Button';
import { useWallet } from '@/lib/wallet';
import {
  errorMessage,
  explorerAddressLink,
  getCharacters,
  getConfig,
  type ConfigResponse,
} from '@/lib/api';
import {
  characterKey,
  loadActiveCharacter,
  saveActiveCharacter,
} from '@/lib/session';
import type { DerivedCharacter } from '@grimhallow/shared';

const CLASS_FILTERS: readonly (CharClass | 'all')[] = [
  'all',
  'warrior',
  'paladin',
  'rogue',
  'mage',
];

/** Adapts the API's derived character to the card component's prop shape. */
function toCardCharacter(c: DerivedCharacter) {
  return {
    id: characterKey(c),
    name: c.name,
    tokenId: c.tokenId,
    image: c.imageUrl ?? undefined,
    rarity: c.rarity as Rarity,
    charClass: c.charClass as CharClass,
    stats: c.stats,
  };
}

export default function CharacterSelect() {
  const navigate = useNavigate();
  const { address, status } = useWallet();

  const [characters, setCharacters] = useState<readonly DerivedCharacter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    const active = loadActiveCharacter();
    return active ? characterKey(active) : null;
  });
  const [filterClass, setFilterClass] = useState<CharClass | 'all'>('all');

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!address) {
        setCharacters([]);
        return;
      }
      setLoading(true);
      setError(null);
      getCharacters(address, signal)
        .then((res) => {
          if (signal?.aborted) return;
          setCharacters(res.characters);
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
          // An empty grid would read as "you own nothing", which is a very
          // different — and alarming — message than "we couldn't check".
          setError(errorMessage(err));
          setCharacters([]);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [address],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then(setConfig)
      .catch(() => setConfig(null)); // Explorer links are a nicety, not a blocker.
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () =>
      filterClass === 'all'
        ? characters
        : characters.filter((c) => c.charClass === filterClass),
    [characters, filterClass],
  );

  const selectedCharacter = useMemo(
    () => characters.find((c) => characterKey(c) === selected) ?? null,
    [characters, selected],
  );

  const handleSelectActive = () => {
    if (!selectedCharacter) return;
    saveActiveCharacter(selectedCharacter);
    navigate('/map');
  };

  const explorerHref =
    config && selectedCharacter
      ? explorerAddressLink(config, selectedCharacter.contractId)
      : null;

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian">
      <TopBar />

      <div className="flex-1 pt-24 px-12 flex flex-col items-center">
        <div className="w-full max-w-6xl flex justify-between items-end mb-8">
          <div>
            <h2 className="text-2xl font-display text-gray-200 uppercase tracking-widest">
              Your Characters (SIP-009)
            </h2>
            {address && (
              <p className="mt-1 font-ui text-[10px] text-gray-500 tracking-widest">
                {address.slice(0, 6)}…{address.slice(-4)}
                {!loading && !error && ` · ${characters.length} held`}
              </p>
            )}
          </div>

          <div className="flex space-x-2 bg-stone/50 border border-stone p-1">
            {CLASS_FILTERS.map((option) => (
              <button
                key={option}
                onClick={() => setFilterClass(option)}
                className={`px-4 py-1 text-xs font-ui capitalize ${
                  filterClass === option
                    ? 'text-gray-200 bg-stone'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 w-full max-w-7xl overflow-y-auto pb-24">
          {status !== 'connected' || !address ? (
            <EmptyState
              title="Wallet not connected"
              body="Connect a Stacks wallet to see the characters it holds."
              action={<Button variant="stx" size="md" onClick={() => navigate('/')}>Connect Wallet</Button>}
            />
          ) : loading ? (
            <EmptyState title="Reading the chain…" body="Fetching your SIP-009 holdings." />
          ) : error ? (
            <EmptyState
              title="Couldn't read your holdings"
              body={error}
              action={<Button variant="secondary" size="md" onClick={() => load()}>Retry</Button>}
            />
          ) : characters.length === 0 ? (
            <EmptyState
              title="No characters found"
              body="This wallet holds no SIP-009 NFTs. Any SIP-009 token works — its stats are derived from the token's identity — or you can mint one of ours and pick its class."
              action={
                <Button variant="stx" size="md" onClick={() => navigate('/shop')}>
                  Mint a Character
                </Button>
              }
            />
          ) : (
            <div className="flex justify-center gap-6 mb-12 flex-wrap">
              {filtered.map((char) => {
                const key = characterKey(char);
                return (
                  <CharacterCard
                    key={key}
                    character={toCardCharacter(char)}
                    selected={selected === key}
                    onClick={() => setSelected(key)}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="fixed bottom-0 left-0 right-0 py-6 bg-gradient-to-t from-obsidian via-obsidian/90 to-transparent flex flex-col items-center pointer-events-none">
          <Button
            variant="void"
            size="lg"
            className="mb-4 w-64 pointer-events-auto"
            disabled={!selectedCharacter}
            onClick={handleSelectActive}
          >
            Select as Active
          </Button>
          {explorerHref ? (
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-ui text-gray-500 hover:text-gray-300 flex items-center pointer-events-auto"
            >
              View on Hiro Explorer <span className="ml-1">↗</span>
            </a>
          ) : (
            <span className="text-xs font-ui text-gray-700">View on Hiro Explorer</span>
          )}
        </div>
      </div>
    </div>
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
      <h3 className="font-display text-lg text-gray-300 uppercase tracking-widest mb-2">
        {title}
      </h3>
      <p className="font-ui text-xs text-gray-500 max-w-md mb-6">{body}</p>
      {action}
    </div>
  );
}
