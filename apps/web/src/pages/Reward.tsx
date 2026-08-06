/**
 * Screen 6 — the settlement.
 *
 * Every figure on this screen comes from `GET /runs/:runId`: the outcome from the
 * replay the oracle signed, the reward from the row the resolve wrote, the tier
 * from the revealed seed, and the payment from a transaction id anyone can open.
 * Nothing is computed here and nothing is assumed.
 *
 * This screen replaced a design mock whose numbers were invented, so it is worth
 * naming the four claims that mock made and this one will not:
 *
 *   - **"Pool was N STX."** The sponsor-pool balance at the moment a run resolved
 *     is not recorded on the run — the oracle reads it live to decide whether a
 *     jackpot is affordable and does not keep it. The only balance available is
 *     the *current* one from `GET /map`, which is a different number, so no pool
 *     figure appears here at all.
 *   - **"+ N XP."** There is no XP system. What a run actually credits is rank,
 *     and only on a win — `player_stats` aggregates `combat_outcome = 'win'`
 *     rows only. The points shown come from `SCORE_WEIGHTS`, the same table the
 *     leaderboard scores with.
 *   - **A named item.** Loot is a tier, not a catalogue entry. The art below is
 *     decoration chosen by nothing; the tier and its metadata URI are the facts.
 *   - **"Rewards have been sent to your wallet."** True only for a paid win that
 *     drew something, and then only because a transaction says so — which is why
 *     that sentence is now attached to `resolveTxId` rather than printed
 *     unconditionally.
 *
 * The reward table is only drawn for a paid run that was **won** — `resolveReward`
 * returns `NO_REWARD` for a loss without rolling, and a free run never consults
 * the table. So "no prize" and "no draw" are two different outcomes and this
 * screen renders them differently: telling a wiped party the dice missed would be
 * describing a roll that never happened.
 */

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { FairnessNote } from '@/components/ui/FairnessNote';
import {
  errorMessage,
  explorerTxLink,
  getConfig,
  getRun,
  type ConfigResponse,
} from '@/lib/api';
import { clearActiveRun, loadActiveRun, type ActiveRun } from '@/lib/session';
import { drewRewardTable, rankCredit, settlementText } from '@/lib/settlement';
import { formatStx, lootTierName, type RunResponse } from '@grimhallow/shared';
import rewardBg from '@/assets/images/reward_bg_1785807973369.jpg';
import imgLoot from '@/assets/images/reward_shadowbound_mantle_1785808903796.jpg';
import imgChest from '@/assets/images/misc_chest_reward_1785809469861.jpg';

/** Chest closed → chest gone → the two roads not taken fade in beside it. */
type Stage = 'intro' | 'reveal' | 'settle';

const REVEAL_MS = 1500;
const SETTLE_MS = 3000;

export default function Reward() {
  const navigate = useNavigate();

  // Read once, the same way Combat does: this is the run the player just
  // finished, and re-reading per render could swap it mid-animation.
  const [run] = useState<ActiveRun | null>(() => loadActiveRun());

  const [data, setData] = useState<RunResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('intro');

  useEffect(() => {
    if (!run) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    getRun(run.runId, run.runToken, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setData(res);
      })
      .catch((err) => {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [run]);

  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((res) => !controller.signal.aborted && setConfig(res))
      .catch(() => undefined); // Explorer links are a nicety, not a blocker.
    return () => controller.abort();
  }, []);

  /** Whether the reward table was rolled at all. See the header note. */
  const drew = data ? drewRewardTable(data) : false;

  useEffect(() => {
    if (!data) return;
    // Nothing was drawn, so there is nothing to build suspense about.
    if (!drew) {
      setStage('settle');
      return;
    }
    const t1 = setTimeout(() => setStage('reveal'), REVEAL_MS);
    const t2 = setTimeout(() => setStage('settle'), SETTLE_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [data, drew]);

  /** Leaving is what ends the run locally — the token is no use afterwards. */
  const done = () => {
    clearActiveRun();
    navigate('/map');
  };

  if (!run) {
    return (
      <Shell>
        <Notice title="No run to settle">
          <p className="mb-6 text-sm text-gray-400">
            This screen reads a finished run. Enter a dungeon from the map and it
            will bring you back here when the dice are done.
          </p>
          <Button variant="primary" onClick={() => navigate('/map')}>
            To the map
          </Button>
        </Notice>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <Notice title="Settling up">
          <p className="text-sm text-gray-400">Reading the resolved run…</p>
        </Notice>
      </Shell>
    );
  }

  if (error || !data) {
    return (
      <Shell>
        <Notice title="This run could not be read">
          <p className="mb-6 text-sm text-blood">{error ?? 'The run was not found.'}</p>
          <Button variant="secondary" onClick={done}>
            Back to the map
          </Button>
        </Notice>
      </Shell>
    );
  }

  if (data.state !== 'resolved') {
    return (
      <Shell>
        <Notice title="This run has not resolved">
          <p className="mb-6 text-sm text-gray-400">
            Nothing has been decided yet — the seed is still sealed and no reward
            has been drawn. Finish the encounter and this screen will have
            something to show.
          </p>
          <Button variant="primary" onClick={() => navigate('/combat')}>
            Back to the fight
          </Button>
        </Notice>
      </Shell>
    );
  }

  const reward = data.reward;
  const won = data.combatOutcome === 'win';
  const resolveTxUrl =
    config && data.verification.resolveTxId
      ? explorerTxLink(config, data.verification.resolveTxId)
      : null;
  const points = rankCredit(data);

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden items-center justify-center">
      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-60"
          style={{ backgroundImage: `url(${rewardBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/50 to-transparent" />
      </div>

      <div className="relative z-10 flex flex-col items-center max-w-6xl w-full px-8 py-10 overflow-y-auto max-h-full">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: stage !== 'intro' ? 1 : 0, y: stage !== 'intro' ? 0 : -20 }}
          transition={{ duration: 1 }}
          className="text-center mb-12"
        >
          <h1 className="text-5xl font-display text-gold mb-4 tracking-[0.1em] drop-shadow-[0_0_15px_rgba(199,164,134,0.5)]">
            {won ? 'The Spoils of the Spire' : 'The Spire Keeps Its Own'}
          </h1>
          <p className="text-sm font-ui text-gray-400 uppercase tracking-widest">
            {data.dungeonType === 'paid' ? 'Paid run' : 'Free run'} ·{' '}
            {won ? 'Cleared' : 'Party wiped'}
          </p>
        </motion.div>

        {drew ? (
          <TableDraw stage={stage} reward={reward} />
        ) : (
          <NoDraw dungeonType={data.dungeonType} won={won} />
        )}

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: stage === 'settle' ? 1 : 0 }}
          transition={{ delay: drew ? 1 : 0 }}
          className="flex flex-col items-center w-full max-w-2xl"
        >
          <Settlement
            data={data}
            reward={reward}
            resolveTxUrl={resolveTxUrl}
          />

          <div className="mt-6 text-center">
            <div className="text-xs font-ui uppercase tracking-widest text-gray-500">
              Rank credit
            </div>
            <div className="mt-1 font-display text-2xl text-gray-200">
              {points > 0 ? `+${points}` : 'None'}
            </div>
            <p className="mt-1 text-xs font-ui text-gray-500">
              {points > 0
                ? 'Added to your leaderboard score, which anyone can recompute from the runs behind it.'
                : 'Only a won run counts toward rank. A wipe adds nothing.'}
            </p>
          </div>

          <FairnessNote
            topics={data.dungeonType === 'paid' ? ['dice', 'money'] : ['dice']}
            className="mt-8 text-center"
          />

          <Verification data={data} config={config} />

          <Button variant="stx" size="lg" className="w-64 mt-10" onClick={done}>
            Continue
          </Button>
        </motion.div>
      </div>
    </div>
  );
}

/**
 * The three outcomes the table can produce, with the one that happened lit.
 *
 * Deliberately shows all three rather than only the result: a player is entitled
 * to see the shape of the thing they were rolling against, and the two that
 * didn't happen are the honest context for the one that did.
 *
 * No odds are printed. They live in `rewards.ts` as the *current* table, and this
 * run resolved against whatever the table said at the time — a percentage shown
 * here would silently restate itself if those constants were ever retuned, which
 * is exactly the kind of quietly-wrong money claim this screen was rewritten to
 * stop making.
 */
function TableDraw({
  stage,
  reward,
}: {
  stage: Stage;
  reward: RunResponse['reward'];
}) {
  const kind = reward?.kind ?? 'none';
  // A degraded jackpot *was* rolled — it just could not be paid. Both cards are
  // part of that story, so both are lit.
  const jackpotLit = kind === 'jackpot' || reward?.degraded === true;
  const dim = (lit: boolean) =>
    lit ? '' : 'grayscale opacity-30';

  return (
    <div className="flex space-x-8 items-center justify-center mb-12">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: stage === 'settle' ? 1 : 0 }}
        className={`w-64 h-96 border-2 border-gold/30 bg-stone/50 p-6 flex flex-col justify-between items-center text-center ${dim(
          jackpotLit,
        )}`}
      >
        <div className="text-xl font-display text-gold uppercase tracking-widest mt-4">
          Jackpot
        </div>
        <div className="flex-1 flex items-center justify-center">
          {kind === 'jackpot' && reward?.amountUstx ? (
            <div className="text-4xl font-display text-stx-accent drop-shadow-[0_0_10px_rgba(33,212,184,0.5)]">
              {formatStx(BigInt(reward.amountUstx))} <span className="text-2xl">STX</span>
            </div>
          ) : reward?.degraded ? (
            <div className="text-sm font-ui text-gold/80 leading-relaxed">
              Rolled — but the sponsor pool could not cover it when this run
              resolved.
            </div>
          ) : (
            <div className="text-sm font-ui text-gray-400">Not this time.</div>
          )}
        </div>
        <div className="text-sm font-ui text-gray-400 uppercase tracking-widest mb-4">
          {kind === 'jackpot' ? 'Paid from the sponsor pool' : 'From the sponsor pool'}
        </div>
      </motion.div>

      <AnimatePresence>
        {stage === 'intro' && (
          <motion.div
            key="chest"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 1.2, opacity: 0, filter: 'brightness(2)' }}
            transition={{ duration: 0.5 }}
            className="w-80 h-[28rem] flex items-center justify-center absolute z-30"
          >
            <img
              src={imgChest}
              alt="Reward chest"
              className="w-64 h-64 object-contain drop-shadow-[0_0_30px_rgba(107,47,160,0.8)] animate-pulse"
            />
          </motion.div>
        )}

        {stage !== 'intro' && (
          <motion.div
            initial={{ scale: 0, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 20 }}
            className={`w-80 h-[28rem] border-2 border-void bg-obsidian p-6 flex flex-col justify-between items-center text-center shadow-[0_0_50px_rgba(107,47,160,0.4)] relative z-20 ${dim(
              kind === 'loot',
            )}`}
          >
            <div className="absolute inset-0 bg-gradient-to-b from-void/20 via-transparent to-transparent pointer-events-none" />

            <div className="text-2xl font-display text-gray-200 uppercase tracking-widest mt-4">
              Power-Up
            </div>

            {/* Cosmetic. Loot is a tier, not a named item — this picture is the
                same whichever tier dropped, and nothing reads a stat from it. */}
            <div className="w-48 h-48 bg-void/20 border border-void/50 my-6 flex items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 bg-void/10 animate-pulse" />
              <img
                src={imgLoot}
                alt=""
                className="w-full h-full object-cover relative z-10 p-2"
              />
            </div>

            <div>
              {kind === 'loot' && reward?.tier ? (
                <>
                  <div className="text-xl font-display text-gray-200 mb-2">
                    Tier {reward.tier} · {lootTierName(reward.tier)}
                  </div>
                  <div className="text-[10px] font-ui text-gray-500 break-all mb-4">
                    {reward.lootUri}
                  </div>
                </>
              ) : (
                <div className="text-sm font-ui text-gray-400 mb-4">Not this time.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: stage === 'settle' ? 1 : 0 }}
        className={`w-64 h-96 border border-gray-600 bg-stone/50 p-6 flex flex-col items-center text-center justify-between ${dim(
          kind === 'none',
        )}`}
      >
        <div className="text-xl font-display text-gray-400 uppercase tracking-widest mt-4">
          No Big Prize
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 text-sm font-ui space-y-2">
          {kind === 'none' ? (
            <>
              <p>The draw came up empty.</p>
              <p>The run still counts toward your rank.</p>
            </>
          ) : (
            <p>Not this time.</p>
          )}
        </div>
        <div className="text-xs font-ui text-gray-500 uppercase tracking-widest mb-4">
          Most runs land here
        </div>
      </motion.div>
    </div>
  );
}

/**
 * What to say when no draw happened.
 *
 * Two distinct cases, kept distinct: a free run never touches the reward table,
 * and a lost paid run reaches `resolveReward` but returns before rolling. Neither
 * is "you rolled and missed", and collapsing them into the empty-handed card
 * would invent a roll.
 */
function NoDraw({
  dungeonType,
  won,
}: {
  dungeonType: RunResponse['dungeonType'];
  won: boolean;
}) {
  return (
    <div className="mb-12 max-w-lg border border-stone bg-obsidian/80 p-8 text-center">
      <img
        src={imgChest}
        alt=""
        className="w-32 h-32 object-contain mx-auto mb-6 grayscale opacity-40"
      />
      <h2 className="font-display text-2xl text-gray-200 mb-3">
        {dungeonType === 'free' ? 'No reward draw' : 'The table was not rolled'}
      </h2>
      <p className="text-sm font-ui text-gray-400 leading-relaxed">
        {dungeonType === 'free'
          ? 'Free dungeons don’t draw the reward table at all — there is no gate fee and no sponsor payout attached to them. Nothing was drawn, and nothing missed.'
          : won
            ? 'This run resolved without a reward draw.'
            : 'The reward table is rolled on a completed paid run. The party was wiped, so no draw was made — this is not a roll that came up empty.'}
      </p>
    </div>
  );
}

/**
 * The one sentence about whether anything actually moved.
 *
 * Every branch that claims a payout is tied to `resolveTxId`, because that
 * transaction is the claim: the jackpot transfer and the loot mint both happen
 * inside `reveal-and-resolve`. Without it there is nothing to assert, so nothing
 * is asserted.
 */
function Settlement({
  data,
  reward,
  resolveTxUrl,
}: {
  data: RunResponse;
  reward: RunResponse['reward'];
  resolveTxUrl: string | null;
}) {
  return (
    <div className="text-center">
      {reward?.degraded && (
        <p className="mb-3 text-xs font-ui text-gold/90 leading-relaxed max-w-lg mx-auto">
          Your draw hit the jackpot, but the sponsor pool could not cover it at
          the moment this run resolved, so the table paid its power-up tier
          instead. Nothing was withheld and nothing is owed — the pool is a prize
          budget the operator funds, not a balance built from entry fees.
        </p>
      )}
      <p className="text-sm font-ui text-gray-400">{settlementText(data)}</p>
      {resolveTxUrl && (
        <a
          href={resolveTxUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs font-ui text-stx-accent hover:underline underline-offset-4"
        >
          View the resolve transaction ↗
        </a>
      )}
    </div>
  );
}

/**
 * The evidence, in one collapsible block.
 *
 * A paid run points at two transactions; a free one points at two oracle
 * signatures over statements the player can rebuild. Either way the seed and its
 * hash are here, because "verifiable" means the player leaves this screen holding
 * the inputs rather than our word.
 */
function Verification({
  data,
  config,
}: {
  data: RunResponse;
  config: ConfigResponse | null;
}) {
  const [open, setOpen] = useState(false);
  const v = data.verification;

  const rows: Array<{ label: string; value: string | null; href?: string | null }> = [
    { label: 'Run', value: data.runId },
    { label: 'Seed hash (committed before play)', value: v.seedHash || null },
    { label: 'Seed (revealed on resolve)', value: v.seed },
    {
      label: 'Commit tx',
      value: v.commitTxId,
      href: config && v.commitTxId ? explorerTxLink(config, v.commitTxId) : null,
    },
    {
      label: 'Resolve tx',
      value: v.resolveTxId,
      href: config && v.resolveTxId ? explorerTxLink(config, v.resolveTxId) : null,
    },
    { label: 'Oracle', value: v.oracleAddress },
    { label: 'Commit signature', value: v.commitSignature },
    { label: 'Resolve signature', value: v.resolveSignature },
    { label: 'Transcript hash', value: v.transcriptHash },
    { label: 'Resolved at', value: v.resolvedAt },
    {
      label: 'Algorithm versions',
      value: `dice ${v.diceAlgoVersion} · encounter ${v.encounterAlgoVersion} · stats ${v.statsAlgoVersion}`,
    },
  ];

  return (
    <div className="mt-4 w-full font-ui">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mx-auto block text-xs text-gray-500 hover:text-gray-300 underline underline-offset-4 decoration-stone transition-colors"
      >
        {open ? 'Hide the receipts' : 'Check this run yourself'}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="verification"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <dl className="mt-4 space-y-2 border-l-2 border-stone pl-4 text-left text-[11px] leading-relaxed">
              {rows
                .filter((r) => r.value)
                .map((r) => (
                  <div key={r.label}>
                    <dt className="text-gray-500 uppercase tracking-widest text-[10px]">
                      {r.label}
                    </dt>
                    <dd className="text-gray-300 break-all">
                      {r.href ? (
                        <a
                          href={r.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-stx-accent hover:underline underline-offset-4"
                        >
                          {r.value}
                        </a>
                      ) : (
                        r.value
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
            <p className="mt-3 pl-4 text-[11px] text-gray-500 leading-relaxed">
              Every roll in this run — initiative, attacks, damage, and the reward
              draw — is <span className="text-gray-400">hash(seed, index)</span>.
              With the seed above and the open-source shared package, the whole
              fight recomputes to the same answers, or we are caught.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden items-center justify-center">
      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-30"
          style={{ backgroundImage: `url(${rewardBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-obsidian/60 to-transparent" />
      </div>
      <div className="relative z-10 flex-1 flex items-center justify-center px-8">
        {children}
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-md text-center">
      <h2 className="font-display text-2xl text-gray-200 mb-3">{title}</h2>
      {children}
    </div>
  );
}
