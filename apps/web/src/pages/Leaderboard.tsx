/**
 * Screen 10 — leaderboard.
 *
 * 01-game-design.md#8 calls this "a verifiable index over chain history, not a
 * trusted database claim". That is a promise about this screen as much as about
 * the backend, so it is built to be argued with:
 *
 *   - Every count that fed a score is shown next to the score.
 *   - The score displayed is `leaderboardScore()` — the shared, versioned
 *     function — run locally on those counts. The number the API sent is checked
 *     against it, and a disagreement is shown rather than hidden. If this app is
 *     ever pointed at a backend that has been tampered with, the row says so.
 *   - Every row expands into the individual events behind it, each one a link to
 *     the transaction on the explorer, or to the signed run for a free dungeon
 *     (which has no transaction — 07-glossary #2).
 *
 * NO MONEY IS SHOWN HERE, and none is sent: `jackpotsWon` is a count of jackpots
 * paid, never a sum of STX. Ranking by payout would put entry-fee revenue and the
 * sponsor pool within one addition of each other, and those two flows never meet
 * (02-architecture.md#3).
 *
 * `computedAt` is displayed because the all-time table is materialized by a
 * background indexer. A player who just finished a run and does not see it yet is
 * looking at a staleness figure, not at a lost run.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import {
  errorMessage,
  explorerAddressLink,
  explorerTxLink,
  getConfig,
  getLeaderboard,
  type ConfigResponse,
} from '@/lib/api';
import { useWallet } from '@/lib/wallet';
import {
  isValidPowerUpTier,
  leaderboardScore,
  lootTierName,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardSource,
  type LeaderboardWindow,
} from '@grimhallow/shared';
import leaderboardBg from '@/assets/images/leaderboard_bg_1785807985086.jpg';

const WINDOWS: readonly { value: LeaderboardWindow; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: '30d', label: '30 Days' },
  { value: '7d', label: '7 Days' },
];

const SOURCE_LABELS: Record<LeaderboardSource['kind'], string> = {
  paid_dungeon: 'Paid dungeon cleared',
  free_dungeon: 'Free dungeon cleared',
  forge: 'Forged a power-up',
};

/** Enough of an address to recognise, short enough for a table row. */
function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}

/**
 * A forge tier as its name.
 *
 * Zero means "never forged" rather than a tier, so it renders as an em dash. A
 * tier outside the ladder is shown as a raw number instead of throwing: an
 * unexpected value is a thing to display honestly, not a reason to blank a row.
 */
function forgeTierLabel(tier: number): string {
  if (tier <= 0) return '—';
  if (!isValidPowerUpTier(tier)) return `Tier ${tier}`;
  const name = lootTierName(tier);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export default function Leaderboard() {
  const { address } = useWallet();

  const [tab, setTab] = useState<'ranked' | 'my'>('ranked');
  const [window, setWindow] = useState<LeaderboardWindow>('all');
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      getLeaderboard(window, signal)
        .then((res) => {
          if (signal?.aborted) return;
          setData(res);
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
          // An empty table would read as "nobody has played", which is a very
          // different claim than "we couldn't load the rankings".
          setError(errorMessage(err));
          setData(null);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [window],
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

  const entries = data?.entries ?? [];

  /** The connected wallet's row and its position in the full table. */
  const myRank = useMemo(() => {
    if (!address) return null;
    const index = entries.findIndex((e) => e.address === address);
    return index === -1 ? null : { rank: index + 1, entry: entries[index] };
  }, [entries, address]);

  const rows = useMemo(
    () =>
      entries
        .map((entry, i) => ({ rank: i + 1, entry }))
        .filter((row) => tab === 'ranked' || row.entry.address === address),
    [entries, tab, address],
  );

  const sourceLink = (source: LeaderboardSource): string | null => {
    if (source.txId && config) return explorerTxLink(config, source.txId);
    return null;
  };

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />

      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${leaderboardBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/60 to-transparent" />
      </div>

      <div className="relative z-10 flex-1 pt-24 px-12 pb-12 flex flex-col items-center overflow-y-auto">
        <div className="w-full max-w-5xl">
          <div className="flex justify-between items-end mb-8">
            <h1 className="text-3xl font-display text-gray-200 tracking-widest uppercase">
              Leaderboard
            </h1>

            <div className="flex space-x-1">
              {WINDOWS.map((w) => (
                <button
                  key={w.value}
                  onClick={() => setWindow(w.value)}
                  className={`px-4 py-2 text-[10px] font-ui tracking-widest uppercase border transition-colors ${
                    window === w.value
                      ? 'border-void text-gray-200 bg-void/10'
                      : 'border-stone text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex space-x-2 border-b border-stone mb-8">
            <button
              onClick={() => setTab('ranked')}
              className={`px-8 py-3 text-xs font-ui tracking-widest uppercase transition-colors ${tab === 'ranked' ? 'text-gray-200 border-b-2 border-void' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Ranked Players
            </button>
            <button
              onClick={() => setTab('my')}
              className={`px-8 py-3 text-xs font-ui tracking-widest uppercase transition-colors ${tab === 'my' ? 'text-gray-200 border-b-2 border-void' : 'text-gray-500 hover:text-gray-300'}`}
            >
              My Rank
              {myRank ? <span className="ml-2 text-gold">#{myRank.rank}</span> : null}
            </button>
          </div>

          {error ? (
            <div className="bg-blood/10 border border-blood/40 p-6 mb-8 flex items-center justify-between">
              <div>
                <p className="text-sm font-ui text-blood uppercase tracking-widest mb-1">
                  Rankings unavailable
                </p>
                <p className="text-xs font-ui text-gray-400">{error}</p>
              </div>
              <Button variant="secondary" onClick={() => load()}>
                Retry
              </Button>
            </div>
          ) : null}

          <div className="bg-obsidian/80 border border-stone backdrop-blur-sm w-full">
            <table className="w-full text-left font-ui">
              <thead>
                <tr className="text-[10px] text-gray-500 uppercase tracking-widest border-b border-stone">
                  <th className="px-6 py-4 font-normal">Rank</th>
                  <th className="px-6 py-4 font-normal">Player</th>
                  <th className="px-6 py-4 font-normal">Score</th>
                  <th className="px-6 py-4 font-normal">Dungeons</th>
                  <th className="px-6 py-4 font-normal">Jackpots</th>
                  <th className="px-6 py-4 font-normal">Max Forge</th>
                  <th className="px-6 py-4 font-normal text-right">View On-Chain</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ rank, entry }) => (
                  <LeaderboardRow
                    key={entry.address}
                    rank={rank}
                    entry={entry}
                    isSelf={entry.address === address}
                    expanded={expanded === entry.address}
                    onToggle={() =>
                      setExpanded(expanded === entry.address ? null : entry.address)
                    }
                    addressLink={config ? explorerAddressLink(config, entry.address) : null}
                    sourceLink={sourceLink}
                  />
                ))}

                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-sm text-gray-500">
                      {loading
                        ? 'Reading the ledger…'
                        : error
                          ? 'Nothing to show while the rankings are unavailable.'
                          : tab === 'my'
                            ? address
                              ? 'No ranked activity for this wallet in this window. Clear a dungeon to appear here.'
                              : 'Connect a wallet to find your rank.'
                            : 'No ranked activity in this window yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="mt-8 bg-stone/50 border border-stone p-6">
            <p className="text-sm font-ui text-gray-400 mb-2">
              Scores are computed from on-chain activity — dungeons completed, jackpots won and
              highest forge tier. A lost run is not a completion, and no reward amount enters the
              score.
            </p>
            <p className="text-xs font-ui text-gray-500">
              Expand any row to see the individual events behind it and check them on the explorer.
              Every score on this page was recomputed in your browser from the counts beside it
              using the published{' '}
              <span className="text-gray-400">{data?.algoVersion ?? 'scoring algorithm'}</span>.
              {data ? ` Last indexed ${formatTimestamp(data.computedAt)}.` : ''}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  readonly rank: number;
  readonly entry: LeaderboardEntry;
  readonly isSelf: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly addressLink: string | null;
  readonly sourceLink: (source: LeaderboardSource) => string | null;
}

function LeaderboardRow({
  rank,
  entry,
  isSelf,
  expanded,
  onToggle,
  addressLink,
  sourceLink,
}: RowProps) {
  // The check that makes "verifiable" mean something here rather than in a doc:
  // the score is recomputed locally and the server's number is compared to it.
  const computed = leaderboardScore(entry);
  const disputed = computed !== entry.score;

  const tone = isSelf ? 'text-gold bg-gold/5' : rank === 1 ? 'text-gold' : 'text-gray-300';

  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-stone/50 hover:bg-stone/30 transition-colors cursor-pointer ${tone}`}
      >
        <td className="px-6 py-4 font-display text-lg">
          <span className="inline-flex items-center">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="ml-2">{rank}</span>
          </span>
        </td>
        <td className="px-6 py-4">
          <span className="flex items-center space-x-3">
            <span className="w-8 h-8 bg-stone rounded-full border border-gray-700" />
            <span className="font-mono text-sm" title={entry.address}>
              {shortAddress(entry.address)}
            </span>
            {isSelf ? (
              <span className="text-[10px] uppercase tracking-widest text-gold">You</span>
            ) : null}
          </span>
        </td>
        <td className="px-6 py-4 font-medium">
          {computed.toLocaleString()}
          {disputed ? (
            <span
              className="ml-2 text-[10px] uppercase tracking-widest text-blood"
              title={`The server reported ${entry.score.toLocaleString()}, which does not match its own published counts.`}
            >
              Mismatch
            </span>
          ) : null}
        </td>
        <td className="px-6 py-4">
          {entry.dungeonsCompleted}
          <span className="ml-2 text-[10px] text-gray-500">
            {entry.paidDungeonsCompleted} paid / {entry.freeDungeonsCompleted} free
          </span>
        </td>
        <td className="px-6 py-4">{entry.jackpotsWon}</td>
        <td className="px-6 py-4 text-void">{forgeTierLabel(entry.highestForgeTier)}</td>
        <td className="px-6 py-4 text-right">
          {addressLink ? (
            <a
              href={addressLink}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex text-gray-500 hover:text-stx-accent transition-colors"
              title="View this address on the explorer"
            >
              <ExternalLink size={16} />
            </a>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </td>
      </tr>

      {expanded ? (
        <tr className="border-b border-stone/50 bg-obsidian/60">
          <td colSpan={7} className="px-6 py-5">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-3">
              Contributing events
              {entry.sources.length ? ` — most recent ${entry.sources.length}` : ''}
            </p>

            {entry.sources.length === 0 ? (
              <p className="text-xs text-gray-500">
                No individual events cited for this entry.
              </p>
            ) : (
              <ul className="space-y-2">
                {entry.sources.map((source, i) => {
                  const link = sourceLink(source);
                  return (
                    <li
                      key={`${source.kind}-${source.txId ?? source.runId ?? i}`}
                      className="flex items-center justify-between text-xs font-ui text-gray-400 border-b border-stone/30 pb-2 last:border-0"
                    >
                      <span className="flex items-center space-x-3">
                        <span className="text-gray-300">{SOURCE_LABELS[source.kind]}</span>
                        <span className="text-gray-600">{formatTimestamp(source.at)}</span>
                      </span>

                      {link ? (
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center space-x-1 text-gray-500 hover:text-stx-accent transition-colors font-mono"
                        >
                          <span>{shortAddress(source.txId ?? '')}</span>
                          <ExternalLink size={12} />
                        </a>
                      ) : (
                        // A free dungeon settles off chain under an oracle
                        // signature, so there is no transaction to link. Citing
                        // the run id keeps it checkable via GET /runs/:id rather
                        // than leaving the reader with nothing to pull on.
                        <span className="font-mono text-gray-600" title="Free runs settle off chain under an oracle signature">
                          run {source.runId ?? 'unknown'}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
