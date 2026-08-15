/**
 * Screen 5 — the dungeon encounter (06-mvp-roadmap.md Phase 4).
 *
 * Nothing on this screen is decided here. Every number rendered — initiative
 * order, each die face, whether an attack hit, how much damage landed, who is
 * still standing, and the outcome — arrives from `POST /runs/:runId/actions`,
 * where it was derived from a seed committed before the player could act. This
 * component sends an intent and animates the answer.
 *
 * That is not a stylistic preference. If the client could compute a roll, the
 * client could compute a *better* roll, and the commit-reveal scheme that makes
 * a run independently verifiable would be decoration. So there is no dice logic
 * in this file, no hit calculation, and no local HP arithmetic: HP shown after a
 * turn is the server's `targetHpAfter` for that turn, not this screen's
 * subtraction.
 *
 * The one place a random number is generated is the tumble animation inside
 * `Dice`, which discards it and lands on the server's value.
 *
 * The run is read from localStorage rather than the route, so a refresh
 * mid-fight resumes instead of stranding the player outside their own run.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import { Dice } from '@/components/ui/Dice';
import { FairnessNote } from '@/components/ui/FairnessNote';
import { errorMessage, getRun, submitAction } from '@/lib/api';
import { clearActiveRun, loadActiveRun, type ActiveRun } from '@/lib/session';
import {
  GUARD_POWER_ID,
  type CombatTurn,
  type CombatantView,
  type EncounterView,
} from '@grimhallow/shared';
import {
  describeTurn,
  firstPhase,
  healGain,
  needsTarget,
  nextPhase,
  powerBadge,
  type Phase,
} from '@/lib/turnPresentation';
import combatBg from '@/assets/images/combat_bg_1785807769665.jpg';

import imgVoidRevenant from '@/assets/images/char_void_revenant_1785808799517.jpg';
import imgIronTemplar from '@/assets/images/char_iron_templar_1785808812709.jpg';
import imgShadowLurker from '@/assets/images/char_shadow_lurker_1785808824826.jpg';
import imgWardenOfAsh from '@/assets/images/char_warden_of_ash_1785808834991.jpg';
import imgAbyssalHound from '@/assets/images/char_abyssal_hound_1785808846747.jpg';
import imgVoidRevenantFull from '@/assets/images/combat_void_revenant_full_1785809298479.jpg';
import imgAbyssalHoundFull from '@/assets/images/combat_abyssal_hound_full_1785809313662.jpg';
import imgCombatLogIcon from '@/assets/images/misc_combat_log_icon_1785809454006.jpg';

/** How long an attack roll stays on screen before the damage roll replaces it. */
const ATTACK_MS = 1600;
/** How long a damage roll stays up before the turn is committed to the log. */
const DAMAGE_MS = 1600;
/** A turn with no dice at all — a Guard, or an attack that had nothing to roll. */
const QUIET_MS = 700;
/** How long a heal's restored HP stays up before the turn is committed to the log. */
const HEAL_MS = 1600;

/**
 * Portraits, chosen by position purely so the same combatant keeps the same
 * face for the whole fight. Cosmetic: monsters are drawn from the seed and the
 * art has nothing to do with which one appeared.
 */
const MONSTER_ART = [imgAbyssalHound, imgShadowLurker, imgWardenOfAsh, imgIronTemplar];

function portrait(c: CombatantView, index: number): string {
  return c.side === 'party' ? imgVoidRevenant : MONSTER_ART[index % MONSTER_ART.length];
}


/**
 * The flat bonus that turned the die faces into the roll.
 *
 * Derived by subtraction rather than recomputed from stats: the server sent
 * both the faces and the total, and recomputing the modifier here would be this
 * screen quietly holding a second opinion about the rules.
 */
function modifier(faces: readonly number[] | undefined, total: number | undefined): number {
  if (!faces?.length || total === undefined) return 0;
  return total - faces.reduce((sum, f) => sum + f, 0);
}


/**
 * The HP a combatant's bar was showing before the turn now resolving.
 *
 * Read from the `shownHp` mirror rather than by walking the log, because the log
 * is not in the animation effect's dependency list and reading it there would
 * close over a stale copy. The mirror is exact for this purpose: `setShownHp` for
 * the current turn has been queued but not yet rendered when this runs, so the
 * ref still holds the previous value. Falls back to the post-turn HP, which
 * yields a gain of zero and no float — the right answer when there is no earlier
 * state to compare against.
 */
function hpBeforeTurn(
  shown: Readonly<Record<string, number>>,
  targetId: string,
  fallback: number,
): number {
  return shown[targetId] ?? fallback;
}

export default function Combat() {
  const navigate = useNavigate();

  // Read once. `loadActiveRun` drops an expired run, and re-reading on each
  // render would swap the run out from under an in-flight submission.
  const [run] = useState<ActiveRun | null>(() => loadActiveRun());

  const [encounter, setEncounter] = useState<EncounterView | null>(null);
  const [log, setLog] = useState<readonly CombatTurn[]>([]);
  const [outcome, setOutcome] = useState<'win' | 'loss' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** Turns returned by the last submission, waiting their turn to animate. */
  const [queue, setQueue] = useState<readonly CombatTurn[]>([]);
  const [showing, setShowing] = useState<{ turn: CombatTurn; phase: Phase } | null>(null);
  const [floating, setFloating] = useState<{
    id: number;
    amount: number;
    targetId: string;
    /** A heal float is green and prefixed `+`; a damage float is red `-`. */
    heal?: boolean;
  } | null>(null);
  const floatId = useRef(0);

  /**
   * HP as the animation has revealed it so far.
   *
   * The encounter view returned with a submission is the state *after* every
   * turn in that batch, so rendering it directly would empty a monster's health
   * bar before the die that emptied it had finished rolling. Each value here is
   * a `targetHpAfter` the server logged; when the queue drains, it resyncs to
   * the authoritative view.
   */
  const [shownHp, setShownHp] = useState<Readonly<Record<string, number>>>({});

  /**
   * `shownHp` as the animation currently has it, readable inside the turn timer.
   *
   * The timer effect depends on `showing` alone — adding `shownHp` to its deps
   * would restart the countdown every time a bar moved, so a turn would never
   * finish animating. A heal still needs the pre-turn HP to know how much was
   * actually gained after the clamp, so it is mirrored here and read before the
   * update rather than closed over.
   */
  const shownHpRef = useRef<Readonly<Record<string, number>>>({});
  useEffect(() => {
    shownHpRef.current = shownHp;
  }, [shownHp]);

  const [targetId, setTargetId] = useState<string | null>(null);

  const applyView = useCallback((view: EncounterView | null) => {
    setEncounter(view);
    if (view) {
      setShownHp(Object.fromEntries(view.combatants.map((c) => [c.id, c.hp])));
    }
  }, []);

  // Initial load / resume.
  useEffect(() => {
    if (!run) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    getRun(run.runId, run.runToken, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        applyView(res.encounter);
        setLog(res.turns);
        setOutcome(res.combatOutcome);
      })
      .catch((err) => {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [run, applyView]);

  // Pull the next turn off the queue once the previous one has finished.
  useEffect(() => {
    if (showing || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setShowing({ turn: next, phase: firstPhase(next) });
  }, [queue, showing]);

  // Advance the phases of the turn on screen, then commit it to the log.
  useEffect(() => {
    if (!showing) return;
    const { turn, phase } = showing;
    const after = nextPhase(turn, phase);
    const delay = phase === 'attack' ? ATTACK_MS : phase === 'damage' ? DAMAGE_MS : phase === 'heal' ? HEAL_MS : QUIET_MS;

    const timer = setTimeout(() => {
      if (after) {
        setShowing({ turn, phase: after });
        return;
      }
      setLog((prev) => [...prev, turn]);
      if (turn.targetId && turn.targetHpAfter !== null) {
        const { targetId: hit, targetHpAfter: hp } = turn;
        setShownHp((prev) => ({ ...prev, [hit]: hp }));
      }
      if (turn.damageDealt > 0 && turn.targetId) {
        floatId.current += 1;
        setFloating({ id: floatId.current, amount: turn.damageDealt, targetId: turn.targetId });
      }
      // The HP actually gained, not the roll — a clamped heal must float the
      // smaller number, or a player at full health sees +7 above a bar that did
      // not move. Suppressed entirely at zero, since a wasted sip floating "+0"
      // reads as a bug rather than as an overheal.
      if (turn.action === 'heal' && turn.targetId && turn.targetHpAfter !== null) {
        const { targetId: drinker, targetHpAfter: hp } = turn;
        const gained = healGain(turn, shownHpRef.current[drinker] ?? hp);
        if (gained > 0) {
          floatId.current += 1;
          setFloating({ id: floatId.current, amount: gained, targetId: drinker, heal: true });
        }
      }
      setShowing(null);
    }, delay);

    return () => clearTimeout(timer);
  }, [showing]);

  // Resync to the authoritative view once the whole batch has played out.
  useEffect(() => {
    if (showing || queue.length > 0 || !encounter) return;
    setShownHp(Object.fromEntries(encounter.combatants.map((c) => [c.id, c.hp])));
  }, [showing, queue, encounter]);

  const combatants = encounter?.combatants ?? [];
  const monsters = useMemo(() => combatants.filter((c) => c.side === 'monsters'), [combatants]);
  const living = useMemo(() => monsters.filter((m) => m.hp > 0), [monsters]);

  /** The party member this client is playing. Solo runs have exactly one. */
  const me = useMemo(
    () => combatants.find((c) => c.side === 'party') ?? null,
    [combatants],
  );

  /** Keep the crosshair on something alive without silently retargeting mid-turn. */
  const effectiveTarget = useMemo(() => {
    const chosen = living.find((m) => m.id === targetId);
    return chosen ?? living[0] ?? null;
  }, [living, targetId]);

  const animating = showing !== null || queue.length > 0;
  const myTurn = encounter?.activeCombatantId === me?.id && !outcome;
  const busy = animating || submitting || loading;

  const act = async (powerId: string) => {
    if (!run || !myTurn || busy) return;
    const power = me?.powers.find((p) => p.id === powerId);
    // Guard braces and a heal is self-only; only an attack needs something to
    // hit, and an attack with nothing living to hit would be refused by the
    // server — but this way the button is simply off.
    const target = needsTarget(power?.kind) ? effectiveTarget?.id ?? null : null;
    if (needsTarget(power?.kind) && !target) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitAction(run.runId, run.runToken, { powerId, targetId: target });
      // The view is stored now but the turns animate one at a time, so `shownHp`
      // keeps rendering the fight while `encounter` already knows how it ended.
      setEncounter(res.encounter);
      setOutcome(res.combatOutcome);
      setQueue((prev) => [...prev, ...res.turns]);
    } catch (err) {
      setError(errorMessage(err));
      // Whatever the disagreement was, the server is right about it. Re-read
      // rather than leaving the screen showing a state it has been told is wrong.
      getRun(run.runId, run.runToken)
        .then((res) => {
          applyView(res.encounter);
          setLog(res.turns);
          setOutcome(res.combatOutcome);
        })
        .catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Leave without settling — the error paths only.
   *
   * Clears the stored run, which is what makes it a dead end: the run token is
   * gone and `/reward` has nothing to read. That is correct here, since these
   * paths are reached when there is no encounter to have produced a result.
   */
  const leave = () => {
    clearActiveRun();
    navigate('/map');
  };

  /**
   * The end of a finished run.
   *
   * Deliberately does *not* clear the stored run: `/reward` reads the settlement
   * back through `GET /runs/:runId`, which needs the run token this would throw
   * away. Reward clears it once the player is done with it, which also means a
   * refresh on that screen still resolves instead of stranding them.
   */
  const settle = () => navigate('/reward');

  if (!run) {
    return (
      <Shell>
        <Notice title="No run in progress">
          <p className="mb-6 text-sm text-gray-400">
            Pick a dungeon from the map to start a run.
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
        <Notice title="Entering the dark">
          <p className="text-sm text-gray-400">Reading the encounter…</p>
        </Notice>
      </Shell>
    );
  }

  if (!encounter) {
    return (
      <Shell>
        <Notice title="This run has no encounter">
          <p className="mb-6 text-sm text-blood">{error ?? 'The run could not be loaded.'}</p>
          <Button variant="secondary" onClick={leave}>
            Leave the dungeon
          </Button>
        </Notice>
      </Shell>
    );
  }

  const orderedCombatants = encounter.order
    .map((id) => combatants.find((c) => c.id === id))
    .filter((c): c is CombatantView => Boolean(c));

  const turn = showing?.turn;
  const attackDice = turn?.rolls.attackDice ?? [];
  const damageDice = turn?.rolls.damageDice ?? [];
  const attackMod = modifier(attackDice, turn?.rolls.attackRoll);
  const damageMod = modifier(damageDice, turn?.rolls.damageRoll);
  const healDice = turn?.rolls.healDice ?? [];
  const healMod = modifier(healDice, turn?.rolls.healRoll);

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />

      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${combatBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-obsidian/50 to-obsidian" />
      </div>

      <div className="relative z-10 flex-1 pt-20 px-8 pb-8 flex flex-col">
        <div className="absolute inset-0 z-0 pointer-events-none flex justify-center items-center opacity-30 mix-blend-screen">
          <img src={outcome === 'loss' ? imgVoidRevenantFull : imgAbyssalHoundFull} className="h-[90%] object-contain" alt="" />
        </div>

        {/* Turn order — initiative from the seed, not a display choice. */}
        <div className="flex justify-center items-center space-x-2 mb-10">
          <span className="text-[10px] font-ui tracking-widest text-gray-500 uppercase mr-4">
            Turn Order
          </span>
          {orderedCombatants.map((c, i) => {
            const active = c.id === encounter.activeCombatantId;
            const down = (shownHp[c.id] ?? c.hp) <= 0;
            return (
              <motion.div
                key={c.id}
                layout
                title={`${c.name} — initiative ${c.initiative}`}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                className={`border relative overflow-hidden ${
                  active ? 'w-10 h-10 border-2 border-void' : 'w-8 h-8 border-stone opacity-50'
                } ${down ? 'grayscale opacity-30' : ''}`}
              >
                <img src={portrait(c, i)} className="w-full h-full object-cover" alt={c.name} />
                {active && (
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-void rounded-full animate-pulse" />
                )}
              </motion.div>
            );
          })}
        </div>

        <div className="flex-1 flex justify-between items-start max-w-[1400px] mx-auto w-full">
          {/* Player */}
          <div className="w-80">
            {me && (
              <div className="bg-obsidian/80 border border-stone p-4 mb-4 backdrop-blur-sm relative overflow-hidden">
                <AnimatePresence>
                  {floating?.targetId === me.id && (
                    <motion.div
                      key={floating.id}
                      initial={{ opacity: 0, y: 0, scale: 0.5 }}
                      animate={{ opacity: 1, y: -40, scale: 1.5 }}
                      exit={{ opacity: 0, y: -60 }}
                      onAnimationComplete={() => setFloating(null)}
                      className={`absolute inset-0 flex items-center justify-center z-50 pointer-events-none font-display text-4xl drop-shadow-[0_0_10px_rgba(255,0,0,1)] ${
                        floating.heal ? 'text-emerald-400' : 'text-blood'
                      }`}
                    >
                      {floating.heal ? `+${floating.amount}` : `-${floating.amount}`}
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="absolute right-0 top-0 bottom-0 w-32 opacity-30">
                  <img src={imgVoidRevenant} className="w-full h-full object-cover" alt="" />
                  <div className="absolute inset-0 bg-gradient-to-r from-obsidian to-transparent" />
                </div>
                <div className="relative z-10">
                  <h3 className="font-display text-xl text-gray-200 mb-2">{me.name}</h3>
                  <HealthBar current={shownHp[me.id] ?? me.hp} max={me.maxHp} />
                  <div className="mt-2 flex items-center justify-between text-[10px] font-ui uppercase tracking-widest text-gray-500">
                    <span>Defense {me.defenseDc}</span>
                    {me.guarding && <span className="text-void">Guarding</span>}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {(me?.powers ?? []).map((power) => {
                const cooling = me?.cooldowns[power.id] ?? 0;
                const uses = me?.charges[power.id] ?? null;
                // A drained potion is off for good, which is why this is `=== 0`
                // and not `<= 0`: `charges` omits every unlimited power, so
                // `null` here means "no limit" and must not read as empty.
                const disabled =
                  busy ||
                  !myTurn ||
                  cooling > 0 ||
                  uses === 0 ||
                  (needsTarget(power.kind) && !effectiveTarget);
                return (
                  <button
                    key={power.id}
                    onClick={() => act(power.id)}
                    disabled={disabled}
                    title={power.description}
                    className={`w-full bg-stone/50 hover:bg-stone border border-stone transition-colors p-3 flex items-center text-left disabled:opacity-40 disabled:cursor-not-allowed ${
                      power.id === GUARD_POWER_ID ? 'hover:border-blue-500' : 'hover:border-void'
                    }`}
                  >
                    <div
                      className={`w-6 h-6 mr-3 shrink-0 border ${
                        power.kind === 'heal'
                          ? 'bg-emerald-500/20 border-emerald-500/50'
                          : power.id === GUARD_POWER_ID
                            ? 'bg-blue-500/20 border-blue-500/50'
                            : 'bg-void/20 border-void/50'
                      }`}
                    />
                    <span className="text-sm font-ui text-gray-300 flex-1">{power.name}</span>
                    <span
                      className={`text-[10px] font-ui ${
                        uses === 0 ? 'text-gray-600' : uses !== null ? 'text-emerald-400/80' : 'text-gray-500'
                      }`}
                    >
                      {powerBadge(power, cooling, uses)}
                    </span>
                  </button>
                );
              })}
            </div>

            {error && <div className="mt-3 text-xs font-ui text-blood">{error}</div>}
          </div>

          {/* Centre stage — the dice the server rolled */}
          <div className="flex-1 flex flex-col items-center justify-start h-full px-8">
            <div className="h-64 flex flex-col items-center justify-center">
              <AnimatePresence mode="wait">
                {showing?.phase === 'attack' && turn && (
                  <motion.div
                    key={`attack-${turn.turnNumber}`}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="flex flex-col items-center"
                  >
                    <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-4">
                      {turn.actorName} — Attack Roll
                    </div>
                    <Dice type="d20" target={attackDice[0] ?? 0} isRolling className="w-32 h-32 mb-4" />
                    <div className="text-sm font-ui text-gray-300">
                      {attackMod >= 0 ? `+${attackMod}` : attackMod} to Hit
                    </div>
                    <div className="mt-2 text-xs font-ui tracking-widest text-gray-500 border-b border-gray-700 pb-1">
                      TARGET {turn.rolls.targetDc}
                    </div>
                    {turn.rolls.hit === false && (
                      <div className="mt-3 font-display text-lg text-gray-500">Miss</div>
                    )}
                  </motion.div>
                )}

                {showing?.phase === 'damage' && turn && (
                  <motion.div
                    key={`damage-${turn.turnNumber}`}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="flex flex-col items-center"
                  >
                    <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-4">
                      Damage Roll
                    </div>
                    <div className="flex items-center space-x-4 mb-4 text-gray-400 font-display text-xl">
                      {damageDice.map((face, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <span>+</span>}
                          <Dice
                            type="d6"
                            target={face}
                            sides={dieSize(combatants, turn.actorId, turn.powerId, damageDice)}
                            isRolling
                            className="w-16 h-16 text-blood"
                          />
                        </React.Fragment>
                      ))}
                      {damageMod !== 0 && (
                        <>
                          <span>+</span>
                          <span className="text-blood">{damageMod}</span>
                        </>
                      )}
                    </div>
                    <div className="text-xl font-display text-blood">
                      {turn.damageDealt} Damage
                    </div>
                  </motion.div>
                )}

                {showing?.phase === 'heal' && turn && (
                  <motion.div
                    key={`heal-${turn.turnNumber}`}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="flex flex-col items-center"
                  >
                    <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-4">
                      Healing Roll
                    </div>
                    <div className="flex items-center space-x-4 mb-4 text-gray-400 font-display text-xl">
                      {healDice.map((face, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <span>+</span>}
                          <Dice
                            type="d6"
                            target={face}
                            sides={dieSize(combatants, turn.actorId, turn.powerId, healDice)}
                            isRolling
                            className="w-16 h-16 text-emerald-400"
                          />
                        </React.Fragment>
                      ))}
                      {healMod !== 0 && (
                        <>
                          <span>+</span>
                          <span className="text-emerald-400">{healMod}</span>
                        </>
                      )}
                    </div>
                    <div className="text-xl font-display text-emerald-400">
                      {turn.rolls.healRoll} Restored
                    </div>
                  </motion.div>
                )}

                {showing?.phase === 'quiet' && turn && (
                  <motion.div
                    key={`quiet-${turn.turnNumber}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="font-display text-xl text-gray-400"
                  >
                    {describeTurn(turn)}
                  </motion.div>
                )}

                {!showing && outcome && (
                  <motion.div
                    key="outcome"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center"
                  >
                    <div
                      className={`font-display text-4xl mb-2 ${
                        outcome === 'win' ? 'text-void' : 'text-blood'
                      }`}
                    >
                      {outcome === 'win' ? 'The dungeon is cleared' : 'You have fallen'}
                    </div>
                    <div className="text-xs font-ui tracking-widest text-gray-500 uppercase mb-6">
                      Seed revealed — this run is now verifiable
                    </div>
                    {/* The line above is a claim. This is where it gets explained,
                        at the moment it becomes true rather than in a help menu. */}
                    <FairnessNote topics={['dice']} className="mb-6 max-w-md text-center" />
                    <Button variant="primary" onClick={settle}>
                      {outcome === 'win' ? 'Collect your spoils' : 'Settle up'}
                    </Button>
                  </motion.div>
                )}

                {!showing && !outcome && myTurn && (
                  <motion.div
                    key="await"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-xs font-ui tracking-widest text-gray-500 uppercase"
                  >
                    Turn {encounter.turnNumber} — choose a power
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Enemies — targets, live HP */}
          <div className="w-80 space-y-2">
            <div className="text-right text-[10px] font-ui tracking-widest text-gray-500 uppercase mb-2">
              Target
            </div>
            {monsters.map((m, i) => {
              const hp = shownHp[m.id] ?? m.hp;
              const dead = hp <= 0;
              const selected = effectiveTarget?.id === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setTargetId(m.id)}
                  disabled={dead}
                  className={`w-full bg-obsidian/80 border p-3 backdrop-blur-sm relative overflow-hidden text-left transition-colors ${
                    selected ? 'border-blood' : 'border-stone'
                  } ${dead ? 'opacity-30 grayscale cursor-not-allowed' : 'hover:border-blood/60'}`}
                >
                  <AnimatePresence>
                    {floating?.targetId === m.id && (
                      <motion.div
                        key={floating.id}
                        initial={{ opacity: 0, y: 0, scale: 0.5 }}
                        animate={{ opacity: 1, y: -40, scale: 1.5 }}
                        exit={{ opacity: 0, y: -60 }}
                        onAnimationComplete={() => setFloating(null)}
                        className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none text-blood font-display text-4xl drop-shadow-[0_0_10px_rgba(255,0,0,1)]"
                      >
                        -{floating.amount}
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="absolute left-0 top-0 bottom-0 w-32 opacity-30">
                    <img src={portrait(m, i)} className="w-full h-full object-cover" alt="" />
                    <div className="absolute inset-0 bg-gradient-to-l from-obsidian to-transparent" />
                  </div>
                  <div className="relative z-10">
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="font-display text-base text-gray-200">{m.name}</span>
                      <span className="text-[10px] font-ui text-gray-500">DC {m.defenseDc}</span>
                    </div>
                    <HealthBar current={hp} max={m.maxHp} align="right" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Combat log — the server's turn records, in order */}
        <div className="absolute bottom-8 left-8 w-96 h-48 bg-obsidian/90 border border-stone p-4 font-ui text-xs overflow-y-auto flex flex-col justify-end">
          <div className="text-[10px] tracking-widest text-gray-500 uppercase mb-2 border-b border-stone pb-2 flex items-center">
            <img src={imgCombatLogIcon} className="w-4 h-4 mr-2" alt="Log" />
            Combat Log
          </div>
          {log.map((entry, i) => (
            <div
              key={`${entry.turnNumber}-${i}`}
              className={`mb-1 ${entry.actorAddress ? 'text-gray-300' : 'text-gray-500'}`}
            >
              {describeTurn(entry)}
            </div>
          ))}
          {log.length === 0 && (
            <div className="text-gray-600">Combat initiated. Turn {encounter.turnNumber} begins.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * How many faces the damage dice have, read off the power as this combatant
 * rolls it.
 *
 * Purely so the tumble animation blurs through the right range — the faces
 * themselves came from the server. The formula is taken from the *combatant's*
 * power list rather than the shared content table, because an equipped power-up
 * changes the die: a holder of a tier-4 swings 2d12 where the base definition
 * still says 1d8, and animating 1–8 under a settled 11 would make the dice look
 * broken at the exact moment the player is checking them.
 *
 * The fallback only matters for a power this build doesn't know, or a turn whose
 * actor has left the encounter view.
 */
function dieSize(
  combatants: readonly CombatantView[],
  actorId: string,
  powerId: string | null,
  faces: readonly number[],
): number {
  const power = combatants
    .find((c) => c.id === actorId)
    ?.powers.find((p) => p.id === powerId);
  const match = power?.diceFormula ? /d(\d+)/.exec(power.diceFormula) : null;
  if (match) return Number(match[1]);
  return Math.max(6, ...faces);
}

function HealthBar({
  current,
  max,
  align = 'left',
}: {
  current: number;
  max: number;
  align?: 'left' | 'right';
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  return (
    <>
      <div
        className={`flex items-center text-xs font-ui text-gray-400 mb-1 ${
          align === 'right' ? 'justify-end space-x-2' : 'justify-between'
        }`}
      >
        {align === 'left' && <span>HP</span>}
        <span>
          {current} / {max}
        </span>
        {align === 'right' && <span>HP</span>}
      </div>
      <div
        className={`w-full h-2 bg-stone rounded-full overflow-hidden flex ${
          align === 'right' ? 'justify-end' : ''
        }`}
      >
        <motion.div
          className="h-full bg-blood"
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 200, damping: 30 }}
        />
      </div>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />
      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-20"
          style={{ backgroundImage: `url(${combatBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-obsidian/60 to-obsidian" />
      </div>
      <div className="relative z-10 flex-1 flex items-center justify-center px-8">{children}</div>
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
