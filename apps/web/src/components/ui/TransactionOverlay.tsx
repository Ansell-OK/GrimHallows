import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from './Button';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

export type TxState = 'idle' | 'about_to_sign' | 'pending' | 'confirmed' | 'failed';

interface TransactionOverlayProps {
  txState: TxState;
  /** What signing does, in the player's words. e.g. "Enter The Obsidian Spire". */
  title: string;
  /**
   * The exact amount leaving the wallet, already formatted, as quoted by the
   * server for THIS payload.
   *
   * Required and passed in rather than hardcoded: the number on this screen is
   * the last thing a player reads before signing, and a constant here would go
   * on being confidently right while the real fee changed underneath it.
   *
   * Omit it for a transaction that moves no STX at all (a forge burns NFTs and
   * transfers nothing). Showing a placeholder where an amount goes would invite
   * the player to wonder what it stood for; showing nothing says it plainly.
   */
  amountStx?: string;
  /**
   * Short red badge under the title, e.g. "Non-refundable".
   *
   * Defaults to "Non-refundable", which is right for a fee. A burn is
   * irreversible in a different way and should say so in its own words.
   */
  badge?: string;
  /** Plain-language terms from the server, shown before the wallet opens. */
  disclosure?: string;
  /** Why it failed. Distinguishes "you cancelled" from "the chain refused". */
  error?: string | null;
  /** Broadcast txid, once there is one. */
  txId?: string | null;
  /** Explorer link for `txId`, so the player can verify independently. */
  explorerUrl?: string | null;
  /**
   * What happens next while the transaction is being mined.
   *
   * Passed in because "pending" means different things to different flows, and
   * the honest answer is usually longer than a spinner: an entry fee is already
   * irreversible at this point even though the run has not started yet.
   */
  pendingNote?: string;
  /** Headline on the success card. Defaults to the paid-entry wording. */
  confirmedTitle?: string;
  /** One line under it saying what now exists. */
  confirmedNote?: string;
  onCancel: () => void;
  onSign: () => void;
  onRetry: () => void;
}

export function TransactionOverlay({
  txState,
  title,
  amountStx,
  badge = 'Non-refundable',
  disclosure,
  error,
  txId,
  explorerUrl,
  pendingNote,
  confirmedTitle = 'Payment Confirmed',
  confirmedNote = 'You have entered the dungeon.',
  onCancel,
  onSign,
  onRetry,
}: TransactionOverlayProps) {
  if (txState === 'idle') return null;

  const amount =
    amountStx === undefined ? null : (
      <div className="text-3xl font-ui text-stx-accent font-medium">
        {amountStx} <span className="text-lg text-stx-accent/70">STX</span>
      </div>
    );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Modal Backdrop with arcane pattern - simulated with radial gradient */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-obsidian/90 backdrop-blur-sm bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-void/10 via-obsidian/90 to-obsidian"
      />

      <div className="relative z-10 w-[500px]">
        <AnimatePresence mode="wait">
          {txState === 'about_to_sign' && (
            <motion.div
              key="sign"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="bg-stone border border-stone-700 p-8 shadow-2xl"
            >
              <h2 className="text-sm font-ui tracking-[0.2em] text-gray-400 uppercase mb-6">About To Sign</h2>

              <div className="flex justify-between items-end mb-8 border-b border-gray-800 pb-6">
                <div>
                  <div className="text-xl font-display text-gray-200 mb-2">{title}</div>
                  <div className="text-xs font-ui text-blood bg-blood/10 px-2 py-1 inline-block border border-blood/20">
                    {badge}
                  </div>
                </div>
                {amount}
              </div>

              {/* The terms come from the server alongside the payload, so what a
                  player agrees to and what they sign cannot drift apart. */}
              {disclosure && (
                <p className="font-ui text-xs text-gray-400 mb-8 leading-relaxed">{disclosure}</p>
              )}

              <div className="flex justify-between space-x-4">
                <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
                <Button variant="stx" className="flex-1" onClick={onSign}>Sign in Wallet</Button>
              </div>
            </motion.div>
          )}

          {txState === 'pending' && (
            <motion.div
              key="pending"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="bg-stone border border-stone-700 p-8 shadow-2xl"
            >
              <h2 className="text-sm font-ui tracking-[0.2em] text-gray-400 uppercase mb-6">Pending / Broadcasting</h2>

              <div className="flex justify-between items-center py-4">
                <div>
                  <div className="text-xl font-display text-gray-200 mb-2">Transaction Sent</div>
                  <div className="text-sm font-ui text-gray-400">
                    {pendingNote ?? 'Awaiting confirmation...'}
                  </div>
                  {txId && explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-ui text-stx-accent hover:underline"
                    >
                      Track it on the explorer
                    </a>
                  )}
                </div>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                  className="text-stx-accent"
                >
                  <Loader2 size={32} />
                </motion.div>
              </div>
            </motion.div>
          )}

          {txState === 'confirmed' && (
            <motion.div
              key="confirmed"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="bg-stone border border-rot/30 p-8 shadow-2xl shadow-rot/10"
            >
              <h2 className="text-sm font-ui tracking-[0.2em] text-gray-400 uppercase mb-6">Confirmed</h2>

              <div className="flex justify-between items-end pb-6">
                <div>
                  <div className="text-xl font-display text-gray-200 mb-2">{confirmedTitle}</div>
                  <div className="text-sm font-ui text-gray-400">{confirmedNote}</div>
                  {txId && explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-ui text-stx-accent hover:underline"
                    >
                      View on the explorer
                    </a>
                  )}
                </div>
                <div className="flex items-center space-x-4">
                  {amount}
                  <CheckCircle2 size={32} className="text-rot" />
                </div>
              </div>
            </motion.div>
          )}

          {txState === 'failed' && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              className="bg-stone border border-blood/30 p-8 shadow-2xl shadow-blood/10"
            >
              <h2 className="text-sm font-ui tracking-[0.2em] text-blood uppercase mb-6">Failed / Rejected</h2>

              <div className="flex justify-between items-center mb-8 border-b border-gray-800 pb-6">
                <div>
                  <div className="text-xl font-display text-blood mb-2">Transaction Failed</div>
                  {/* The real reason, not an assumed one: "you rejected it" and
                      "the chain refused it" are very different news. */}
                  <div className="text-sm font-ui text-gray-400">
                    {error ?? 'The transaction did not go through.'}
                  </div>
                </div>
                <XCircle size={32} className="text-blood" />
              </div>

              <div className="flex justify-end space-x-4">
                <Button variant="secondary" onClick={onCancel}>Close</Button>
                <Button variant="secondary" onClick={onRetry}>Try Again</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
