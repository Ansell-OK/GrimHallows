/**
 * The two things a player has to understand before they spend STX here.
 *
 * Phase 8 of the roadmap asks for both by name: an explainer of the
 * commit-reveal fairness mechanism, and — "importantly" — of the fact that a
 * gate fee is an entry cost rather than a wager, with rewards coming from a pool
 * the game sponsors. They live in one component because they answer one
 * question: "am I being played?"
 *
 * WHY THE WORDING IS CENTRALISED HERE
 *
 * These are claims about money and fairness, and both are checkable, so a
 * second copy that drifted would eventually be a false statement rather than a
 * stale one. Every screen that needs to say this imports it and says the same
 * words. The `disclosure` string the mint endpoint serves
 * (04-backend-api-spec.md#6) follows the same rule from the server side.
 *
 * WHAT THIS MUST NOT SAY
 *
 * It must never present the sponsor pool as fed by fees, never imply the entry
 * fee is refundable or at stake, and never describe a run as a bet against
 * other players. All three are false (02-architecture.md#3), and this component
 * exists precisely because a player who assumed any of them would have assumed
 * something we would rather they didn't have to guess at.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

/**
 * `dice` — how a roll is made honestly. Shown wherever dice decide something.
 * `money` — where the fee goes and where prizes come from. Shown wherever STX
 * is about to leave a wallet.
 *
 * A screen can ask for both; the paid-dungeon panel does, since it is the one
 * place a player commits money to an outcome dice will decide.
 */
export type FairnessTopic = 'dice' | 'money';

const SUMMARY: Record<FairnessTopic, string> = {
  dice: 'How do I know the dice are fair?',
  money: 'Where does my STX go?',
};

export function FairnessNote({
  topics = ['dice', 'money'],
  className = '',
}: {
  topics?: readonly FairnessTopic[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`font-ui ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-4 decoration-stone transition-colors"
      >
        {open ? 'Hide' : topics.map((t) => SUMMARY[t]).join('  ·  ')}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-4 border-l-2 border-stone pl-4 text-xs leading-relaxed text-gray-400">
              {topics.includes('dice') && (
                <section>
                  <h4 className="mb-1 font-display text-sm tracking-wide text-gray-300">
                    The dice are committed before you play
                  </h4>
                  <p>
                    Before your run starts, the game picks one random seed and publishes
                    its <span className="text-gray-300">hash</span> on chain — a
                    fingerprint that can't be worked backwards, and can't be changed
                    afterwards without every player noticing.
                  </p>
                  <p className="mt-2">
                    Every die you'll roll — initiative, attacks, damage, and the reward
                    draw — is derived from that one seed. When the run ends, the seed
                    itself is published. Anyone can check it against the hash, then
                    recompute every roll from it and confirm the game got the same
                    answers it showed you.
                  </p>
                  <p className="mt-2">
                    So the outcome was fixed before your first move, and neither we nor
                    you could see it. That's the point:{' '}
                    <span className="text-gray-300">
                      we can't change a roll after the fact, and we can't hide it if we
                      tried.
                    </span>
                  </p>
                </section>
              )}

              {topics.includes('money') && (
                <section>
                  <h4 className="mb-1 font-display text-sm tracking-wide text-gray-300">
                    An entry cost, not a wager
                  </h4>
                  <p>
                    A gate fee is a{' '}
                    <span className="text-gray-300">purchase, not a bet</span>. It pays
                    the operator for the run, in one hop, and it isn't refundable — the
                    same as the character mint price and the forge fee. You aren't
                    staking it against an outcome, and you aren't playing against other
                    players' money.
                  </p>
                  <p className="mt-2">
                    Prizes come from a separate{' '}
                    <span className="text-gray-300">sponsored pool</span> the operator
                    funds themselves. No fee is ever added to it. That's why several
                    parties can raid the same dungeon and most find nothing: the pool
                    isn't a pot of everyone's entry fees waiting to be split, so what's
                    in it doesn't depend on how many people paid to get in.
                  </p>
                  <p className="mt-2">
                    Nothing you pay is held in escrow pending a result. It's paid, and
                    it's spent.
                  </p>
                </section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
