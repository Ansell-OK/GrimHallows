/**
 * Screen 4 — the world map.
 *
 * Everything positioned on this map now comes from `GET /map`: free-dungeon
 * spawns with server-set expiries, and the standing paid dungeon with its gate
 * fee and sponsor pool read live from the contract.
 *
 * Two rules this screen is built around:
 *
 *   1. The sponsor pool is the owner-funded prize budget. It is NOT entry-fee
 *      revenue, and the two are never added or presented as one number
 *      (02-architecture.md#3). The label says where the money comes from.
 *   2. When the backend can't read the chain, `paidDungeon` is null, and the
 *      spire renders as *unavailable* rather than as a pool of zero. A player
 *      deciding whether to spend 1 STX deserves "we don't know" over a
 *      confident wrong number.
 *
 * Free entry costs nothing and signs nothing: it's a POST with a session token,
 * which is the whole point of a free dungeon (06-mvp-roadmap.md Phase 3).
 *
 * Both entries carry a *loadout*: the power-ups the player chose to equip, up to
 * `MAX_EQUIPPED_POWER_UPS`. Only token ids are sent. The backend re-reads every
 * tier from chain after confirming the wallet holds the token, so a selection
 * made here can be rejected there, and that is the point — this screen picks,
 * the chain decides.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Minus, Target, X, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import mapBg from '@/assets/images/world_map_bg_1785807757183.jpg';
import imgObsidianSpire from '@/assets/images/map_obsidian_spire_1785808914307.jpg';
import imgFreeDungeon from '@/assets/images/map_marker_free_dungeon_1785809355965.jpg';
import imgExpiringSoon from '@/assets/images/map_marker_expiring_soon_1785809371230.jpg';
import { Button } from '@/components/ui/Button';
import { LoadoutPicker } from '@/components/ui/LoadoutPicker';
import { TransactionOverlay, type TxState } from '@/components/ui/TransactionOverlay';
import {
  ApiRequestError,
  NetworkError,
  claimPaidRun,
  enterFreeDungeon,
  enterPaidDungeon,
  getCurrentParty,
  errorMessage,
  explorerTxLink,
  getConfig,
  getMap,
  getPowerUps,
  type ConfigResponse,
  type EquippablePowerUp,
} from '@/lib/api';
import { signingErrorMessage, signAndSubmit } from '@/lib/tx';
import { FairnessNote } from '@/components/ui/FairnessNote';
import { formatCountdown, isExpiringSoon, msRemaining } from '@/lib/countdown';
import { loadActiveCharacter, loadSession, saveActiveRun } from '@/lib/session';
import { useWallet } from '@/lib/wallet';
import {
  MAX_EQUIPPED_POWER_UPS,
  formatStx,
  getMonsterTable,
  monsterTableName,
  type CharacterRef,
  type FreeDungeonSpawn,
  type MapResponse,
  type PaidDungeonSummary,
  type PaidEntryResponse,
  type PaidRunReadyResponse,
} from '@grimhallow/shared';

/** How often countdowns re-render. One second, because they show seconds. */
const TICK_MS = 1000;
/** How often the map is re-fetched for new and departed spawns. */
const REFRESH_MS = 30_000;

/**
 * Poll for confirmation and claim the run once it mines.
 *
 * A transaction starts unconfirmed; the claim route refuses it with
 * `TX_NOT_CONFIRMED`. This polls until it does confirm, then claims, retrying
 * both the check and the claim on transient failures. A paid entry that gave up
 * would be the worst outcome: the player paid, the run exists on chain, and this
 * app abandoned it.
 *
 * The claim is idempotent, so retries are safe: the same txid always produces
 * the same run, and a concurrent claim (from a retry or from the indexer) just
 * returns the existing row.
 *
 * `powerUpTokenIds` is the loadout chosen before signing. It is sent here rather
 * than with the quote because the quote produced no run to attach it to — see
 * `enterPaidDungeon` in lib/api.ts. A loadout the backend refuses does not cost
 * the entry twice: the claim is idempotent, so it can be retried.
 */
async function claimWhenConfirmed(
  dungeonId: number,
  enterTxId: string,
  character: CharacterRef,
  powerUpTokenIds: readonly string[],
): Promise<PaidRunReadyResponse> {
  const POLL_INTERVAL_MS = 3000;
  const MAX_ATTEMPTS = 60; // 3 minutes, since the overlay stays up

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await claimPaidRun(dungeonId, enterTxId, character, powerUpTokenIds);
    } catch (err) {
      // The two expected transient states, matched on the documented `code`
      // rather than the prose: the transaction is still in the mempool, or it
      // mined but the oracle's commit-seed has not landed yet. Both resolve by
      // waiting, and both are also what a NetworkError means here — a dropped
      // request while the chain catches up is not a failed entry.
      const retryable =
        (err instanceof ApiRequestError &&
          (err.code === 'TX_NOT_CONFIRMED' || err.code === 'RUN_NOT_COMMITTED')) ||
        err instanceof NetworkError;

      // Every other error is permanent: the transaction failed, was malformed,
      // or the claim was refused for a reason waiting will not change.
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(
    'The transaction did not confirm within the expected time. ' +
      'This is unusual but does not mean your payment failed — reload the page to retry.',
  );
}

type Selection =
  | { readonly kind: 'free'; readonly spawn: FreeDungeonSpawn }
  | { readonly kind: 'paid'; readonly dungeon: PaidDungeonSummary };

export default function Map() {
  const [scale, setScale] = useState(0.4);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const navigate = useNavigate();
  const { address } = useWallet();

  const [map, setMap] = useState<MapResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);
  const [partyId, setPartyId] = useState<string | null>(null);
  const [partySize, setPartySize] = useState(0);

  // The loadout. `equipped` is token ids only — see the header. It survives the
  // popup closing on the paid path, because the selection is made before the
  // wallet prompt but only sent after the transaction confirms, which can be
  // minutes later.
  const [powerUps, setPowerUps] = useState<readonly EquippablePowerUp[]>([]);
  const [powerUpsLoading, setPowerUpsLoading] = useState(false);
  const [powerUpsError, setPowerUpsError] = useState<string | null>(null);
  const [equipped, setEquipped] = useState<readonly string[]>([]);

  // Paid entry. `quote` is the server's freshly-built payload for exactly this
  // click; it is never reused across clicks, because the fee and the
  // post-condition inside it are a snapshot of the chain at quote time.
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [txState, setTxState] = useState<TxState>('idle');
  const [quote, setQuote] = useState<PaidEntryResponse | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    getMap(signal)
      .then((res) => {
        if (signal?.aborted) return;
        setMap(res);
        setLoadError(null);
      })
      .catch((err) => {
        if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
        setLoadError(errorMessage(err));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const refresh = window.setInterval(() => load(), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [load]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  /**
   * Read the power-ups this wallet holds, described against the active character.
   *
   * Re-read on every mount rather than cached: one of these may have been burned
   * in the forge or sold since the last visit, and offering a token the wallet no
   * longer holds would produce a rejected entry at the worst possible moment on
   * the paid path — after the fee is gone.
   *
   * A failure leaves the list empty *and* sets an error, and the picker
   * distinguishes the two. Entry is never blocked by it: an unequipped run is a
   * legitimate run.
   */
  const loadPowerUps = useCallback(
    (signal?: AbortSignal) => {
      const character = loadActiveCharacter();
      if (!address || !character) {
        setPowerUps([]);
        setPowerUpsError(null);
        return;
      }
      setPowerUpsLoading(true);
      getPowerUps(character, address, signal)
        .then((res) => {
          if (signal?.aborted) return;
          setPowerUps(res.powerUps);
          setPowerUpsError(null);
          // Drop anything from the selection the wallet no longer holds, so a
          // stale pick cannot be submitted after a forge burned it.
          const held = new Set(res.powerUps.map((p) => p.tokenId));
          setEquipped((current) => current.filter((id) => held.has(id)));
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
          setPowerUps([]);
          setPowerUpsError(errorMessage(err));
          // Nothing can be vouched for, so nothing stays equipped. Sending an
          // unverified selection would just be rejected by the backend anyway.
          setEquipped([]);
        })
        .finally(() => {
          if (!signal?.aborted) setPowerUpsLoading(false);
        });
    },
    [address],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadPowerUps(controller.signal);
    return () => controller.abort();
  }, [loadPowerUps]);

  useEffect(() => {
    if (!address) { setPartyId(null); setPartySize(0); return; }
    getCurrentParty()
      .then(({ party }) => { setPartyId(party?.id ?? null); setPartySize(party?.members.length ?? 0); })
      .catch(() => { setPartyId(null); setPartySize(0); });
  }, [address]);

  const toggleEquipped = (tokenId: string) => {
    setEquipped((current) =>
      current.includes(tokenId)
        ? current.filter((id) => id !== tokenId)
        : current.length >= MAX_EQUIPPED_POWER_UPS
          ? current // The picker greys these out; this is the belt to its braces.
          : [...current, tokenId],
    );
  };

  // Only used to build an explorer link for a broadcast txid. A missing config
  // costs the player the link, not the entry.
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((res) => !controller.signal.aborted && setConfig(res))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // A spawn whose timer has run out is dropped from the map immediately rather
  // than waiting for the next refresh — the server would refuse entry anyway,
  // and a marker you can't use is a marker that shouldn't be there.
  const liveSpawns = useMemo(
    () => (map?.spawns ?? []).filter((s) => msRemaining(s.expiresAt, now) > 0),
    [map, now],
  );

  // Keep the popup honest if its spawn closes while it's open.
  const selectedSpawnClosed =
    selected?.kind === 'free' && msRemaining(selected.spawn.expiresAt, now) <= 0;

  const handleZoom = (delta: number) => {
    setScale((s) => Math.min(Math.max(0.3, s + delta), 2.5));
  };

  const resetView = () => {
    setScale(0.4);
    setPos({ x: 0, y: 0 });
  };

  const openSpawn = (spawn: FreeDungeonSpawn) => {
    setEnterError(null);
    setSelected({ kind: 'free', spawn });
  };

  const handleEnterFree = async (spawn: FreeDungeonSpawn) => {
    if (!loadSession()) {
      setEnterError('Connect your wallet to enter a dungeon.');
      return;
    }

    // The dungeon needs to know who is walking into it: the backend derives
    // stats from the NFT, so entry without a chosen character has nothing to
    // build a fight from. Caught here so the player is sent to pick one rather
    // than shown the server's INVALID_CHARACTER.
    const character = loadActiveCharacter();
    if (!character) {
      setEnterError('Choose a character before entering a dungeon.');
      return;
    }

    if (partyId && partySize < 4 && !window.confirm(`Enter with ${partySize} of 4 party members?`)) return;
    setEntering(true);
    setEnterError(null);
    try {
      const run = await enterFreeDungeon(spawn.id, character, equipped, partyId);
      saveActiveRun({
        runId: run.runId,
        dungeonType: run.dungeonType,
        runToken: run.runToken,
        monsterTableId: run.monsterTableId,
        spawnId: run.spawnId,
        expiresAt: run.expiresAt,
      });
      setSelected(null);
      navigate('/combat');
    } catch (err) {
      // Includes SPAWN_EXPIRED, which is the server telling us our clock was
      // optimistic. Refresh so the stale marker goes away.
      setEnterError(errorMessage(err));
      load();
      // Also re-read holdings: a refused loadout usually means one of these
      // tokens left the wallet since the list was fetched, and the player needs
      // to see the selection they can actually make.
      loadPowerUps();
    } finally {
      setEntering(false);
    }
  };

  /**
   * Step 1 of a paid entry: ask the server what this costs, right now.
   *
   * The quote is requested on the click that opens the confirmation, never
   * earlier and never from a cache. What comes back includes a post-condition
   * pinned to the fee the chain reported at that instant; a fee read a minute
   * ago and signed now is a transaction that aborts on chain and costs the
   * player a network fee for our stale copy.
   */
  const handleQuotePaid = async (dungeon: PaidDungeonSummary) => {
    if (!loadSession()) {
      setEnterError('Connect your wallet to enter a dungeon.');
      return;
    }
    const character = loadActiveCharacter();
    if (!character) {
      setEnterError('Choose a character before entering a dungeon.');
      return;
    }

    setEntering(true);
    setEnterError(null);
    setTxError(null);
    setTxId(null);
    try {
      const response = await enterPaidDungeon(dungeon.dungeonId, character);
      setQuote(response);
      setSelected(null);
      setTxState('about_to_sign');
    } catch (err) {
      setEnterError(errorMessage(err));
    } finally {
      setEntering(false);
    }
  };

  /**
   * Step 2: hand the payload to the wallet.
   *
   * Nothing about it is rebuilt here — `signAndSubmit` passes the server's
   * arguments and post-conditions through byte-for-byte. A txid means the
   * transaction was *submitted*, not that it succeeded, so the overlay goes to
   * `pending` and says so.
   */
  const handleSignPaid = async () => {
    if (!quote) return;
    const character = loadActiveCharacter();
    if (!character) {
      // Re-checked here, not just at quote time: the payload is about to cost
      // real STX, and a run with no character is one the server cannot build a
      // fight from. Better to refuse before signing than to strand a paid entry.
      setTxError('Choose a character before entering a dungeon.');
      setTxState('failed');
      return;
    }

    setTxError(null);
    let id: string;
    try {
      id = await signAndSubmit(quote.tx);
    } catch (err) {
      setTxError(
        signingErrorMessage(err, errorMessage(err), 'Nothing was sent and nothing was charged.'),
      );
      setTxState('failed');
      return;
    }

    setTxId(id);
    setTxState('pending');
    // The fee is irreversible from here, and the figures behind the overlay are
    // stale the moment it mines. Re-read them.
    load();

    // The money has left the wallet. From this point the only question is when
    // the transaction confirms, so the claim is retried until it does rather
    // than surfaced as a failure the player has to act on — an entry that paid
    // and then gave up would be the worst outcome in the app.
    try {
      const ready = await claimWhenConfirmed(quote.dungeonId, id, character, equipped);
      saveActiveRun({
        runId: ready.runId,
        dungeonType: 'paid',
        runToken: ready.runToken,
        monsterTableId: ready.monsterTableId,
        // Paid runs are not spawns; they are entered against a permanent
        // on-chain dungeon, so there is no spawn id and no expiry countdown.
        spawnId: null,
        expiresAt: ready.expiresAt,
      });
      setTxState('confirmed');
      navigate('/combat');
    } catch (err) {
      // The payment stands regardless — say so plainly rather than implying the
      // STX might come back, and point at the txid so the claim can be retried
      // from the run list once the chain catches up.
      setTxError(
        `${errorMessage(err)} Your entry fee was paid and the run exists on chain; ` +
          `reload this page to pick it up once the transaction confirms.`,
      );
      setTxState('failed');
    }
  };

  const closeTxOverlay = () => {
    setTxState('idle');
    setQuote(null);
    setTxId(null);
    setTxError(null);
  };

  // One picker, shared by both popups. Built here rather than inside each detail
  // component so the two cannot drift into offering different selections — the
  // loadout is one piece of state, and there is only one of it.
  const loadout = (
    <LoadoutPicker
      items={powerUps}
      selected={equipped}
      onToggle={toggleEquipped}
      loading={powerUpsLoading}
      error={powerUpsError}
      onRetry={() => loadPowerUps()}
      disabled={entering}
    />
  );

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />

      {/* Draggable/Zoomable Map Container */}
      <motion.div
        className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing"
        drag
        dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
        dragElastic={0.1}
        animate={{ scale, x: pos.x, y: pos.y }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        onDragEnd={(_, info) => setPos({ x: pos.x + info.offset.x, y: pos.y + info.offset.y })}
      >
        <div
          className="absolute inset-[-100%] bg-cover bg-center opacity-60"
          style={{ backgroundImage: `url(${mapBg})` }}
        />

        {/* Paid Dungeon Landmark — live gate fee and sponsor pool, or nothing. */}
        {map?.paidDungeon && (
          <div
            className="absolute flex flex-col items-center cursor-pointer group"
            style={{
              top: `${map.paidDungeon.location.y}%`,
              left: `${map.paidDungeon.location.x}%`,
            }}
            onClick={() => {
              setEnterError(null);
              setSelected({ kind: 'paid', dungeon: map.paidDungeon! });
            }}
          >
            <motion.div
              animate={{ opacity: [0.8, 1, 0.8], scale: [1, 1.02, 1] }}
              transition={{ repeat: Infinity, duration: 4 }}
              className="w-48 h-60 mb-2 relative flex items-end justify-center group-hover:drop-shadow-[0_0_25px_rgba(107,47,160,0.8)]"
            >
              <div className="absolute bottom-0 w-32 h-6 bg-void/50 blur-xl rounded-full" />
              <img
                src={imgObsidianSpire}
                alt={map.paidDungeon.name}
                className="w-full h-full object-contain drop-shadow-[0_0_15px_rgba(107,47,160,0.5)] relative z-10"
              />
            </motion.div>

            <div className="text-center bg-obsidian/80 px-4 py-2 border border-stone group-hover:border-void transition-colors">
              <h3 className="font-display text-gray-200">{map.paidDungeon.name}</h3>
              <p className="text-xs font-ui text-gray-400 mb-1">PAID DUNGEON</p>
              <p className="text-sm font-ui text-stx-accent font-semibold">
                Sponsored Pool: {formatStx(BigInt(map.paidDungeon.sponsorPoolUstx))} STX
              </p>
            </div>
          </div>
        )}

        {/* Free Dungeon Markers */}
        {liveSpawns.map((spawn) => (
          <FreeDungeon
            key={spawn.id}
            spawn={spawn}
            remainingMs={msRemaining(spawn.expiresAt, now)}
            onClick={() => openSpawn(spawn)}
          />
        ))}
      </motion.div>

      {/* Static UI Layer */}
      <div className="relative z-20 pointer-events-none w-full h-full p-8 pt-24 flex flex-col justify-between">
        <div className="flex-1 flex flex-col items-center">
          {loadError && (
            <div className="pointer-events-auto bg-obsidian/95 border border-blood px-6 py-3 font-ui text-xs text-gray-300">
              <span className="text-blood mr-2">Map unavailable.</span>
              {loadError}
              <button className="ml-3 underline hover:text-white" onClick={() => load()}>
                Retry
              </button>
            </div>
          )}
          {!loadError && map && liveSpawns.length === 0 && (
            <div className="pointer-events-auto bg-obsidian/90 border border-stone px-6 py-3 font-ui text-xs text-gray-400">
              No free dungeons are open right now. New ones appear every few minutes.
            </div>
          )}
          {!loadError && map && !map.paidDungeon && (
            <div className="mt-3 pointer-events-auto bg-obsidian/90 border border-stone px-6 py-3 font-ui text-xs text-gray-400">
              The Obsidian Spire is unavailable — its gate fee and sponsored pool
              could not be read from the chain.
            </div>
          )}
        </div>

        {/* Bottom UI Area */}
        <div className="flex justify-between items-end pointer-events-auto">
          {/* Legend */}
          <div className="flex items-center space-x-6 bg-obsidian/90 border border-stone px-6 py-3 font-ui text-xs">
            <div className="flex items-center">
              <div className="w-3 h-3 bg-blue-500 rounded-full mr-2" />{' '}
              <span className="text-gray-400">YOU</span>
            </div>
            <div className="flex items-center">
              <img src={imgFreeDungeon} className="w-4 h-4 mr-2" alt="" />{' '}
              <span className="text-gray-400">FREE DUNGEON</span>
            </div>
            <div className="flex items-center">
              <img src={imgExpiringSoon} className="w-4 h-4 mr-2" alt="" />{' '}
              <span className="text-gray-400">EXPIRES SOON</span>
            </div>
            <div className="flex items-center">
              <div className="w-3 h-3 bg-void rounded-sm rotate-45 mr-2" />{' '}
              <span className="text-gray-400">PAID DUNGEON</span>
            </div>
          </div>

          <div className="flex space-x-4">
            {/* World Chat Toggle */}
            <button
              onClick={() => setChatOpen(!chatOpen)}
              className="bg-obsidian/90 border border-stone text-gray-400 px-4 py-3 font-ui text-sm hover:bg-stone hover:text-white flex items-center"
            >
              World Chat
            </button>

            {/* Zoom Controls */}
            <div className="flex bg-obsidian/90 border border-stone text-gray-400">
              <button
                className="p-3 hover:bg-stone hover:text-white border-r border-stone"
                onClick={() => handleZoom(0.25)}
              >
                <Plus size={18} />
              </button>
              <button
                className="p-3 hover:bg-stone hover:text-white border-r border-stone"
                onClick={() => handleZoom(-0.25)}
              >
                <Minus size={18} />
              </button>
              <button className="p-3 hover:bg-stone hover:text-white" onClick={resetView}>
                <Target size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* World Chat Module — not built. Shown as empty rather than populated
          with invented messages, so nobody types into a box that goes nowhere
          believing others can see it. */}
      <AnimatePresence>
        {chatOpen && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="absolute bottom-24 right-8 w-80 h-96 bg-obsidian/95 border border-stone z-30 flex flex-col font-ui"
          >
            <div className="flex justify-between items-center p-3 border-b border-stone text-xs tracking-widest text-gray-400 uppercase bg-stone/20">
              <span>World Chat</span>
              <button onClick={() => setChatOpen(false)} className="hover:text-white">
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <p className="text-xs text-gray-500">
                World chat isn&apos;t live yet. Nothing you type here is sent anywhere.
              </p>
            </div>
            <div className="p-3 border-t border-stone flex bg-black/40 opacity-40">
              <input
                type="text"
                disabled
                placeholder="Chat is not available"
                className="bg-transparent text-sm text-gray-200 outline-none flex-1 cursor-not-allowed"
              />
              <button disabled className="text-gray-600 cursor-not-allowed">
                <Send size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dungeon Detail Popup */}
      <AnimatePresence>
        {selected && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-obsidian border border-stone p-8 max-w-md w-full relative"
            >
              <button
                onClick={() => setSelected(null)}
                className="absolute top-4 right-4 text-gray-500 hover:text-white"
              >
                <X size={20} />
              </button>

              {selected.kind === 'free' ? (
                <FreeDungeonDetail
                  spawn={selected.spawn}
                  remainingMs={msRemaining(selected.spawn.expiresAt, now)}
                  closed={selectedSpawnClosed}
                  entering={entering}
                  error={enterError}
                  loadout={loadout}
                  onEnter={() => handleEnterFree(selected.spawn)}
                  onCancel={() => setSelected(null)}
                />
              ) : (
                <PaidDungeonDetail
                  dungeon={selected.dungeon}
                  entering={entering}
                  error={enterError}
                  loadout={loadout}
                  onEnter={() => handleQuotePaid(selected.dungeon)}
                  onCancel={() => setSelected(null)}
                />
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/*
        Paid entry. Everything shown here comes from the quote the server just
        built — the fee, the terms, and the payload that gets signed are one
        object, so the number on screen cannot drift from the number the chain
        will enforce. `formatStx` is display only; `quote.tx.postConditions` is
        what binds.
      */}
      <TransactionOverlay
        txState={txState}
        title={`Enter ${map?.paidDungeon?.name ?? 'the paid dungeon'}`}
        amountStx={quote ? formatStx(BigInt(quote.feeUstx)) : '—'}
        disclosure={quote?.disclosure}
        error={txError}
        txId={txId}
        explorerUrl={config && txId ? explorerTxLink(config, txId) : null}
        pendingNote={
          'Your entry fee is on its way to the operator and cannot be recalled. ' +
          'Your run starts once the transaction is mined.'
        }
        onCancel={closeTxOverlay}
        onSign={handleSignPaid}
        onRetry={() => setTxState(quote ? 'about_to_sign' : 'idle')}
      />
    </div>
  );
}

function FreeDungeonDetail({
  spawn,
  remainingMs,
  closed,
  entering,
  error,
  loadout,
  onEnter,
  onCancel,
}: {
  spawn: FreeDungeonSpawn;
  remainingMs: number;
  closed: boolean;
  entering: boolean;
  error: string | null;
  loadout: React.ReactNode;
  onEnter: () => void;
  onCancel: () => void;
}) {
  const table = getMonsterTable(spawn.monsterTableId);

  return (
    <>
      <div className="text-xs font-ui text-gray-400 uppercase tracking-widest mb-2">
        Free Dungeon
      </div>
      <h2 className="text-3xl font-display text-gray-200 mb-6">
        {monsterTableName(spawn.monsterTableId)}
      </h2>

      <div className="space-y-4 font-ui text-sm mb-8">
        <div className="flex justify-between border-b border-stone/50 pb-2">
          <span className="text-gray-400">Closes in</span>
          <span className={isExpiringSoon(remainingMs) ? 'text-blood' : 'text-gray-200'}>
            {formatCountdown(remainingMs)}
          </span>
        </div>
        {table && (
          <div className="flex justify-between border-b border-stone/50 pb-2">
            <span className="text-gray-400">Recommended Level</span>
            <span className="text-gray-200">
              {table.recommendedLevel.min}–{table.recommendedLevel.max}
            </span>
          </div>
        )}
        <div className="flex justify-between border-b border-stone/50 pb-2">
          <span className="text-gray-400">Entry Cost</span>
          <span className="text-gray-200">Free — no transaction</span>
        </div>
        <div className="flex justify-between border-b border-stone/50 pb-2">
          <span className="text-gray-400">Party Size</span>
          <span className="text-gray-200">Solo</span>
        </div>
      </div>

      {loadout}

      {error && <p className="font-ui text-xs text-blood mb-4">{error}</p>}

      <div className="flex space-x-4">
        <Button
          variant="primary"
          className="flex-1"
          disabled={entering || closed}
          onClick={onEnter}
        >
          {closed ? 'Closed' : entering ? 'Entering…' : 'Enter Dungeon'}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function PaidDungeonDetail({
  dungeon,
  entering,
  error,
  loadout,
  onEnter,
  onCancel,
}: {
  dungeon: PaidDungeonSummary;
  entering: boolean;
  error: string | null;
  loadout: React.ReactNode;
  onEnter: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="text-xs font-ui text-gray-400 uppercase tracking-widest mb-2">
        Paid Dungeon
      </div>
      <h2 className="text-3xl font-display text-gray-200 mb-6">{dungeon.name}</h2>

      <div className="space-y-4 font-ui text-sm mb-8">
        <div className="flex justify-between border-b border-stone/50 pb-2">
          {/* Named for what it is. This is the operator's funded prize budget,
              not a share of the fees players have paid in. */}
          <span className="text-gray-400">Sponsored Prize Pool</span>
          <span className="text-stx-accent font-bold">
            {formatStx(BigInt(dungeon.sponsorPoolUstx))} STX
          </span>
        </div>
        <div className="flex justify-between border-b border-stone/50 pb-2">
          <span className="text-gray-400">Gate Fee</span>
          <span className="text-gray-200">
            {formatStx(BigInt(dungeon.gateFeeUstx))} STX
          </span>
        </div>
      </div>

      <p className="font-ui text-xs text-gray-500 mb-6">
        The gate fee is a non-refundable entry fee paid to the game operator. It does
        not go into the prize pool, and it is not returned if your run fails.
      </p>

      {/* Both questions land here at once: this is the only screen where a
          player pays STX for an outcome dice will decide. */}
      <FairnessNote className="mb-6" />

      {/* Chosen now, applied after the payment confirms — there is no run to
          attach a loadout to until the transaction is mined. */}
      {loadout}

      {error && <p className="font-ui text-xs text-blood mb-4">{error}</p>}

      <div className="flex space-x-4">
        {/* The figures above are from the last map refresh and are for reading.
            Pressing this re-quotes the fee from chain before anything is signed,
            so a fee that changed since the map loaded is caught there, not in
            the wallet. */}
        <Button variant="stx" className="flex-1" disabled={entering} onClick={onEnter}>
          {entering ? 'Quoting…' : 'Enter Dungeon'}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={onCancel}>
          Close
        </Button>
      </div>
    </>
  );
}

function FreeDungeon({
  spawn,
  remainingMs,
  onClick,
}: {
  spawn: FreeDungeonSpawn;
  remainingMs: number;
  onClick: () => void;
}) {
  const expiring = isExpiringSoon(remainingMs);
  const image = expiring ? imgExpiringSoon : imgFreeDungeon;

  return (
    <div
      className="absolute flex flex-col items-center cursor-pointer group hover:z-10"
      style={{ top: `${spawn.location.y}%`, left: `${spawn.location.x}%` }}
      onClick={onClick}
    >
      <motion.div
        animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ repeat: Infinity, duration: expiring ? 1.5 : 3 }}
        className="w-16 h-16 mb-2 group-hover:scale-125 transition-transform"
      >
        <img
          src={image}
          className="w-full h-full object-contain"
          alt={monsterTableName(spawn.monsterTableId)}
        />
      </motion.div>
      <div className="bg-obsidian/80 border border-stone px-2 py-1 rounded-sm text-xs font-ui font-medium text-gray-300 group-hover:border-gray-400 transition-colors">
        {formatCountdown(remainingMs)}
      </div>
    </div>
  );
}
