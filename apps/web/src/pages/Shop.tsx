/**
 * The character shop — buying a character NFT from `character-nft.clar`.
 *
 * This is the third revenue line, and the only one where the player buys an
 * asset rather than access. It is built around four rules:
 *
 *   1. THE PRICE COMES FROM THE CHAIN, EVERY TIME. `priceUstx` is read from the
 *      contract when this screen loads and again when the payload is built. It
 *      is never `CHARACTER_MINT_PRICE_USTX` — that constant is what the owner
 *      seeded, not what the contract charges, and the owner can change the
 *      latter without redeploying. Showing a stale price would put a number on
 *      screen that the post-condition then contradicts, aborting a transaction
 *      the player already signed and paid a network fee for.
 *   2. IF THE PRICE CANNOT BE READ, NOTHING IS SOLD. No cached price, no
 *      fallback, no "approximately". An unreadable contract shows an error and
 *      no buy button.
 *   3. THE CLASS IS PERMANENT AND THIS SCREEN SAYS SO BEFORE THE WALLET OPENS.
 *      The class is written on chain in the same transaction that mints the
 *      token; there is no later edit and no re-roll. That is the one thing a
 *      buyer cannot undo, so it is stated in the confirm copy rather than in a
 *      footnote.
 *   4. THIS IS A PURCHASE, NOT A WAGER. The disclosure comes from the server
 *      alongside the price, and it says plainly that the money does not fund the
 *      prize pool and does not change anyone's odds. A shop that implied
 *      otherwise would be selling a different product under different rules.
 *
 * The mint is a user-signed transaction. Nothing here holds a key, and the
 * payload's arguments are passed to the wallet byte-for-byte (see `lib/tx.ts`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import { TransactionOverlay, type TxState } from '@/components/ui/TransactionOverlay';
import landingBg from '@/assets/images/landing_bg_1785807745179.jpg';
import imgWarrior from '@/assets/images/char_iron_templar_1785808812709.jpg';
import imgPaladin from '@/assets/images/char_warden_of_ash_1785808834991.jpg';
import imgRogue from '@/assets/images/char_shadow_lurker_1785808824826.jpg';
import imgMage from '@/assets/images/char_void_revenant_1785808799517.jpg';
import {
  buildMintCharacter,
  errorMessage,
  explorerTxLink,
  getCharacters,
  getConfig,
  getMintQuote,
  type ConfigResponse,
} from '@/lib/api';
import { signingErrorMessage, signAndSubmit } from '@/lib/tx';
import { loadSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';
import {
  formatStx,
  type CharClass,
  type CharacterClassOption,
  type CharacterMintQuoteResponse,
  type MintCharacterTxResponse,
} from '@grimhallow/shared';

/** How often the roster is re-read while waiting for a mint to land. */
const POLL_INTERVAL_MS = 4000;
/** Roughly three minutes. After this the overlay stops claiming to know. */
const MAX_POLLS = 45;

/**
 * Class artwork.
 *
 * Presentation only. The class a token *is* comes from the contract's own map,
 * read back by `GET /characters`; nothing on this screen — or in any metadata
 * file it points at — decides that.
 */
const CLASS_ART: Record<CharClass, string> = {
  warrior: imgWarrior,
  paladin: imgPaladin,
  rogue: imgRogue,
  mage: imgMage,
};

/** Full names for the stat abbreviations the API publishes as `emphasis`. */
const STAT_NAMES: Record<string, string> = {
  str: 'Strength',
  agi: 'Agility',
  int: 'Intellect',
  vit: 'Vitality',
};

export default function Shop() {
  const navigate = useNavigate();
  const { address, status } = useWallet();

  const [quote, setQuote] = useState<CharacterMintQuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);

  const [picked, setPicked] = useState<CharClass | null>(null);

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [txState, setTxState] = useState<TxState>('idle');
  const [txId, setTxId] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  /**
   * The payload from step 1, held only so the confirm screen can quote the price
   * it pins. It is never the thing that gets signed — step 2 builds a fresh one.
   */
  const [payload, setPayload] = useState<MintCharacterTxResponse | null>(null);

  const loadQuote = useCallback((signal?: AbortSignal) => {
    setLoadingQuote(true);
    getMintQuote(signal)
      .then((res) => {
        if (signal?.aborted) return;
        setQuote(res);
        setQuoteError(null);
      })
      .catch((err) => {
        if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
        // Deliberately leaves `quote` null. There is no local price to fall back
        // to, and a remembered one would be a number the chain has not agreed to.
        setQuote(null);
        setQuoteError(errorMessage(err));
      })
      .finally(() => {
        if (!signal?.aborted) setLoadingQuote(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadQuote(controller.signal);
    return () => controller.abort();
  }, [loadQuote]);

  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((res) => !controller.signal.aborted && setConfig(res))
      .catch(() => undefined); // Explorer links are a nicety, not a blocker.
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => quote?.classes.find((c) => c.classId === picked) ?? null,
    [quote, picked],
  );

  const connected = status === 'connected' && address;
  const canBuy = connected && quote !== null && !quote.paused && selected !== null;

  const choose = (classId: CharClass) => {
    setPicked(classId);
    setBuildError(null);
  };

  /**
   * Step 1: ask the server to build the payload.
   *
   * The server re-reads the price and the pause switch here, so a mint that
   * closed while this screen was open is refused before the wallet opens rather
   * than aborting on chain at the player's expense.
   */
  const handleBuild = async () => {
    if (!selected) return;
    if (!loadSession()) {
      setBuildError('Connect your wallet to mint a character.');
      return;
    }

    setBuilding(true);
    setBuildError(null);
    setTxError(null);
    setTxId(null);
    try {
      setPayload(await buildMintCharacter(selected.classId));
      setTxState('about_to_sign');
    } catch (err) {
      setPayload(null);
      setBuildError(errorMessage(err));
      // A price that moved or a mint that closed changes what this screen should
      // be offering, so re-read rather than leaving the old figure up.
      loadQuote();
    } finally {
      setBuilding(false);
    }
  };

  /**
   * Step 2: hand the payload to the wallet, then watch for the token.
   *
   * The payload is rebuilt immediately before signing rather than reusing the
   * one from step 1, so a price change or a paused mint is caught by the server
   * rather than by a stale blob.
   *
   * If the rebuilt payload carries a different price than the one on the confirm
   * screen, the wallet is not opened. The player agreed to a specific number of
   * STX leaving their account; a silently larger one is not the same agreement,
   * and the post-condition would make it binding.
   *
   * A txid means *submitted*. The character exists only once the transaction
   * mines, so the roster is polled until the count goes up — which is the chain
   * saying it happened, not this app assuming it did.
   */
  const handleSign = async () => {
    if (!selected) return;
    const agreedPrice = payload?.priceUstx ?? null;

    setTxError(null);
    let id: string;
    let before = 0;
    try {
      const fresh = await buildMintCharacter(selected.classId);
      if (agreedPrice !== null && fresh.priceUstx !== agreedPrice) {
        setPayload(fresh);
        setTxError(
          `The price changed to ${formatStx(BigInt(fresh.priceUstx))} STX while you were ` +
            `reading. Nothing was charged. Review the new amount and sign again if you ` +
            `still want to.`,
        );
        setTxState('failed');
        return;
      }
      setPayload(fresh);

      // Read the roster first so "one more than before" is a real comparison
      // rather than a guess about what the wallet held. A failed read here is
      // not a reason to block the purchase; it only costs us the count.
      if (address) {
        before = await getCharacters(address)
          .then((res) => res.characters.length)
          .catch(() => -1);
      }

      id = await signAndSubmit(fresh);
    } catch (err) {
      setTxError(signingErrorMessage(err, errorMessage(err)));
      setTxState('failed');
      return;
    }

    setTxId(id);
    setTxState('pending');

    for (let attempt = 0; attempt < MAX_POLLS && before >= 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!address) break;

      let count: number;
      try {
        count = (await getCharacters(address)).characters.length;
      } catch {
        continue; // A dropped read is not a failed mint. Keep waiting.
      }

      if (count > before) {
        setTxState('confirmed');
        return;
      }
    }

    // Out of patience, not out of hope. Say exactly that rather than reporting
    // a failure the chain has not actually reported.
    setTxError(
      'The transaction has not confirmed yet. That does not mean it failed — check it ' +
        'on the explorer, and your new character will appear once it mines.',
    );
    setTxState('failed');
  };

  const closeOverlay = () => {
    const minted = txState === 'confirmed';
    setTxState('idle');
    setTxId(null);
    setTxError(null);
    setPayload(null);
    loadQuote();
    if (minted) navigate('/characters');
  };

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />

      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${landingBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-transparent to-obsidian/80" />
      </div>

      <div className="relative z-10 flex-1 pt-24 px-12 pb-12 flex flex-col items-center overflow-y-auto">
        <h1 className="text-3xl font-display text-gray-200 mb-2 tracking-[0.1em]">
          Summon a Character
        </h1>
        <p className="font-ui text-xs text-gray-500 mb-8 max-w-xl text-center leading-relaxed">
          Mint a character NFT of the class you choose. The class is written on chain in
          the same transaction and cannot be changed afterwards. The price below is read
          from the contract, not from this app.
        </p>

        {loadingQuote && quote === null ? (
          <Notice title="Reading the shop…" body="Fetching the price from the contract." />
        ) : quoteError ? (
          <Notice
            title="Couldn't read the price"
            body={`${quoteError} Nothing is offered until the contract's mint price can be read — quoting a price we can't verify would put a number on screen that the chain then refuses.`}
            action={
              <Button variant="secondary" size="md" onClick={() => loadQuote()}>
                Retry
              </Button>
            }
          />
        ) : quote === null ? null : (
          <div className="w-full max-w-6xl">
            {quote.paused && (
              <div className="mb-8 border border-gold/30 bg-gold/5 px-6 py-4 text-center">
                <p className="font-ui text-xs text-gold uppercase tracking-widest mb-1">
                  Minting is paused
                </p>
                <p className="font-ui text-xs text-gray-400">
                  The contract owner has stopped sales. Nothing can be bought until they
                  resume — you can still look at what the classes do.
                </p>
              </div>
            )}

            <div className="flex justify-between items-end mb-4">
              <h2 className="text-xs font-ui tracking-widest text-gray-400 uppercase">
                Choose a class
              </h2>
              <span className="font-ui text-[10px] text-gray-500 tracking-widest">
                PRICE READ FROM CHAIN
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
              {quote.classes.map((option) => (
                <ClassCard
                  key={option.classId}
                  option={option}
                  selected={option.classId === picked}
                  onClick={() => choose(option.classId)}
                />
              ))}
            </div>

            {/* Price + action */}
            <div className="flex flex-col md:flex-row gap-8 items-stretch border-t border-stone pt-8">
              <div className="flex-1 max-w-lg">
                <p className="text-sm font-ui text-gray-400 mb-4">
                  {selected
                    ? `You are about to mint one ${selected.name} — a ${selected.blurb.toLowerCase()}.`
                    : 'Pick a class to continue.'}
                </p>
                {/* The one irreversible part of the purchase, said before the
                    wallet opens rather than after. */}
                <p className="text-xs font-ui text-blood mb-4 uppercase tracking-widest px-4 py-2 bg-blood/10 border border-blood/20">
                  The class is permanent and cannot be changed later.
                </p>
                <p className="font-ui text-[11px] text-gray-500 leading-relaxed">
                  {quote.disclosure}
                </p>
              </div>

              <div className="flex-1 flex flex-col justify-center max-w-sm">
                <div className="flex justify-between items-baseline mb-4 border-t border-b border-stone py-3">
                  <span className="text-[10px] font-ui text-gray-500 tracking-widest uppercase">
                    Mint price
                  </span>
                  <span className="text-2xl font-ui text-stx-accent">
                    {formatStx(BigInt(quote.priceUstx))}{' '}
                    <span className="text-sm text-stx-accent/70">STX</span>
                  </span>
                </div>

                {!connected && (
                  <p className="font-ui text-xs text-gray-500 mb-4">
                    Connect a Stacks wallet to mint.
                  </p>
                )}
                {buildError && <p className="font-ui text-xs text-blood mb-4">{buildError}</p>}

                <Button
                  variant="stx"
                  size="lg"
                  className="w-full flex flex-col"
                  onClick={connected ? handleBuild : () => navigate('/')}
                  disabled={connected ? !canBuy || building : false}
                >
                  <span className="mb-1">
                    {!connected ? 'Connect Wallet' : building ? 'Preparing…' : 'Mint Character'}
                  </span>
                  {connected && (
                    <span className="text-[10px] opacity-70 tracking-widest">
                      {formatStx(BigInt(quote.priceUstx))} STX · class is permanent
                    </span>
                  )}
                </Button>

                <button
                  className="font-ui text-[10px] text-gray-500 hover:text-gray-300 underline mt-4 tracking-widest"
                  onClick={() => navigate('/characters')}
                >
                  I ALREADY OWN CHARACTERS
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/*
        The amount is `payload.priceUstx` — the price the payload in hand
        actually pins — rather than the shop's copy, so what the player reads and
        what the post-condition enforces are the same number by construction.
        Until a payload exists there is no honest amount to show, so none is.
      */}
      <TransactionOverlay
        txState={txState}
        title={selected ? `Mint 1 ${selected.name}` : 'Mint a character'}
        amountStx={payload ? formatStx(BigInt(payload.priceUstx)) : undefined}
        badge="Class is permanent · non-refundable"
        disclosure={
          selected
            ? `Signing mints one character NFT to your wallet with the class ` +
              `"${selected.classId}" written on chain. The class cannot be changed ` +
              `afterwards — there is no re-roll and no later edit. ` +
              (payload
                ? `The ${formatStx(BigInt(payload.priceUstx))} STX price goes to the operator ` +
                  `and is not refundable. `
                : '') +
              `This is a purchase, not a wager: it does not fund the prize pool and does ` +
              `not affect your odds in any dungeon. Your wallet will quote its own network ` +
              `fee on top.`
            : undefined
        }
        error={txError}
        txId={txId}
        explorerUrl={config && txId ? explorerTxLink(config, txId) : null}
        pendingNote={
          'Waiting for the mint to be confirmed. Your character exists once the ' +
          'transaction is mined, not before.'
        }
        confirmedTitle="Character Minted"
        confirmedNote={
          selected
            ? `Your ${selected.name} is yours, and its class is recorded on chain.`
            : 'Your character was minted.'
        }
        onCancel={closeOverlay}
        onSign={handleSign}
        onRetry={() => setTxState(selected ? 'about_to_sign' : 'idle')}
      />
    </div>
  );
}

/**
 * One class on the picker.
 *
 * Shows what the class emphasises, which is a real property — `CLASS_EMPHASIS`
 * mirrors the weights `deriveStats` uses — rather than marketing. It is a skew,
 * not a guarantee: the individual spread still comes from the token's identity
 * hash, so two characters of the same class are not the same character.
 */
function ClassCard({
  option,
  selected,
  onClick,
}: {
  option: CharacterClassOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className={`text-left border bg-obsidian/80 overflow-hidden transition-colors hover:border-stx-accent/60 ${
        selected
          ? 'border-stx-accent shadow-[0_0_20px_rgba(33,212,184,0.25)]'
          : 'border-stone'
      }`}
    >
      <div className="relative h-40 overflow-hidden">
        <img
          src={CLASS_ART[option.classId]}
          alt=""
          className="w-full h-full object-cover opacity-80"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian to-transparent" />
        {selected && (
          <span className="absolute top-2 right-2 text-stx-accent text-xs font-ui">✓</span>
        )}
      </div>
      <div className="p-4">
        <div className="font-display text-sm text-gray-200 mb-1">{option.name}</div>
        <div className="font-ui text-[10px] text-gray-500 uppercase tracking-widest mb-3">
          {option.classId}
        </div>
        <p className="font-ui text-xs text-gray-400 leading-relaxed mb-3">{option.blurb}</p>
        <div className="font-ui text-[10px] text-gray-500 tracking-widest">
          FAVOURS {option.emphasis.map((s) => (STAT_NAMES[s] ?? s).toUpperCase()).join(' · ')}
        </div>
      </div>
    </motion.button>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-8">
      <h3 className="font-display text-lg text-gray-300 uppercase tracking-widest mb-2">{title}</h3>
      <p className="font-ui text-xs text-gray-500 max-w-md mb-6 leading-relaxed">{body}</p>
      {action}
    </div>
  );
}
