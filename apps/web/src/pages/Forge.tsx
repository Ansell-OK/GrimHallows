/**
 * Screen 8 — the forge.
 *
 * Everything on this screen is chain state. The recipe ladder is mirrored from
 * the contract's `recipes` map, the burnable items are the power-up NFTs the
 * wallet actually holds, and what each item *does* comes from its on-chain tier
 * and archetype — the tier from `get-token-tier`, the archetype parsed out of
 * the uri string `get-token-uri` returns. The document that string addresses is
 * never fetched (01-game-design.md#6).
 *
 * Three rules this screen is built around:
 *
 *   1. WHEN THE RECIPES CANNOT BE READ, NOTHING IS OFFERED. There is no fallback
 *      ladder and no cached one. A player choosing which NFTs to destroy against
 *      a recipe we cannot vouch for would burn real tokens for nothing, so an
 *      unreadable chain shows an error and no Forge button.
 *   2. The preview describes the recipe's *output tier*, not an invented item. We
 *      do not know what the forged token will be called or look like until it is
 *      minted — the contract writes its metadata URI — so this screen names the
 *      tier and the bonus that tier grants, both of which are derived from the
 *      same shared table the combat resolver uses.
 *   3. THE FEE ON SCREEN IS THE FEE IN THE PAYLOAD. Since forge-v2 a burn also
 *      costs STX, quoted live from the contract per rung. Every figure rendered
 *      here is `stxFeeUstx` or `feeUstx` straight from the server — never
 *      `FORGE_FEE_BY_OUTPUT_TIER`, which is what the owner seeded rather than
 *      what the chain charges. If the fee moves between the confirm screen and
 *      the wallet prompt, the signature is not requested; the new number is shown
 *      instead. A player who signs must have read the amount they are sending.
 *
 * The burn is a user-signed transaction. Nothing here holds a key, and the
 * payload's arguments are passed to the wallet byte-for-byte (see `lib/tx.ts`).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import { TransactionOverlay, type TxState } from '@/components/ui/TransactionOverlay';
import forgeBg from '@/assets/images/forge_bg_1785807961458.jpg';
import imgLoot from '@/assets/images/reward_shadowbound_mantle_1785808903796.jpg';
import {
  buildForge,
  errorMessage,
  explorerTxLink,
  getConfig,
  getForgeRecipes,
  getPowerUps,
  type ConfigResponse,
  type EquippablePowerUp,
} from '@/lib/api';
import { signingErrorMessage, signAndSubmit } from '@/lib/tx';
import { loadActiveCharacter, loadSession } from '@/lib/session';
import { lootArtFor } from '@/lib/lootArt';
import { tierAccent, tierBorder } from '@/lib/tierStyle';
import { useWallet } from '@/lib/wallet';
import {
  formatStx,
  powerUpBonus,
  type ForgeRecipe,
  type ForgeTxResponse,
} from '@grimhallow/shared';

/** How often the holdings are re-read while waiting for a burn to mine. */
const POLL_INTERVAL_MS = 4000;
/** Roughly three minutes. After this the overlay stops claiming to know. */
const MAX_POLLS = 45;

export default function Forge() {
  const navigate = useNavigate();
  const { address, status } = useWallet();

  const [recipes, setRecipes] = useState<readonly ForgeRecipe[]>([]);
  const [recipesError, setRecipesError] = useState<string | null>(null);
  const [loadingRecipes, setLoadingRecipes] = useState(true);

  const [powerUps, setPowerUps] = useState<readonly EquippablePowerUp[]>([]);
  const [powerUpsError, setPowerUpsError] = useState<string | null>(null);
  const [loadingPowerUps, setLoadingPowerUps] = useState(false);

  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);
  const [selectedTokenIds, setSelectedTokenIds] = useState<readonly string[]>([]);

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [txState, setTxState] = useState<TxState>('idle');
  const [txId, setTxId] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  /**
   * The payload from step 1, held only so the confirm screen can show the fee it
   * pins. It is never the thing that gets signed — step 2 builds a fresh one.
   */
  const [quote, setQuote] = useState<ForgeTxResponse | null>(null);

  const character = useMemo(() => loadActiveCharacter(), []);

  const loadRecipes = useCallback((signal?: AbortSignal) => {
    setLoadingRecipes(true);
    getForgeRecipes(signal)
      .then((res) => {
        if (signal?.aborted) return;
        setRecipes(res.recipes);
        setRecipesError(null);
      })
      .catch((err) => {
        if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
        // Deliberately leaves `recipes` empty. There is no local ladder to fall
        // back to, and inventing one would put a player's NFTs at risk.
        setRecipes([]);
        setRecipesError(errorMessage(err));
      })
      .finally(() => {
        if (!signal?.aborted) setLoadingRecipes(false);
      });
  }, []);

  const loadPowerUps = useCallback(
    (signal?: AbortSignal) => {
      if (!address || !character) {
        setPowerUps([]);
        return;
      }
      setLoadingPowerUps(true);
      getPowerUps(character, address, signal)
        .then((res) => {
          if (signal?.aborted) return;
          setPowerUps(res.powerUps);
          setPowerUpsError(null);
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
          // An empty grid would read as "you hold nothing", which is a very
          // different message than "we couldn't check".
          setPowerUps([]);
          setPowerUpsError(errorMessage(err));
        })
        .finally(() => {
          if (!signal?.aborted) setLoadingPowerUps(false);
        });
    },
    [address, character],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadRecipes(controller.signal);
    return () => controller.abort();
  }, [loadRecipes]);

  useEffect(() => {
    const controller = new AbortController();
    loadPowerUps(controller.signal);
    return () => controller.abort();
  }, [loadPowerUps]);

  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then((res) => !controller.signal.aborted && setConfig(res))
      .catch(() => undefined); // Explorer links are a nicety, not a blocker.
    return () => controller.abort();
  }, []);

  const recipe = useMemo(
    () => recipes.find((r) => r.id === selectedRecipeId) ?? null,
    [recipes, selectedRecipeId],
  );

  /** Only items of the recipe's input tier can satisfy it — the contract checks. */
  const eligible = useMemo(
    () => (recipe ? powerUps.filter((p) => p.tier === recipe.inputTier) : []),
    [powerUps, recipe],
  );

  const selected = useMemo(
    () => selectedTokenIds.map((id) => powerUps.find((p) => p.tokenId === id)).filter(Boolean) as EquippablePowerUp[],
    [selectedTokenIds, powerUps],
  );

  const ready = recipe !== null && selectedTokenIds.length === recipe.inputCount;

  const chooseRecipe = (id: number) => {
    setSelectedRecipeId(id);
    // Selections are tier-specific, so switching recipes cannot carry them over.
    setSelectedTokenIds([]);
    setBuildError(null);
    // The quote priced a different rung. Keeping it would show one recipe's fee
    // on another recipe's confirm screen.
    setQuote(null);
  };

  const toggleToken = (tokenId: string) => {
    if (!recipe) return;
    setBuildError(null);
    setSelectedTokenIds((current) => {
      if (current.includes(tokenId)) return current.filter((id) => id !== tokenId);
      if (current.length >= recipe.inputCount) return current; // The recipe burns exactly N.
      return [...current, tokenId];
    });
  };

  /**
   * Step 1: ask the server to build the payload.
   *
   * The server validates shape and refuses nothing else — the contract decides
   * whether these inputs satisfy the recipe, so a payload that does not aborts
   * on chain rather than being silently "corrected" here.
   *
   * The response is kept so the confirm screen can quote the fee this payload
   * actually pins, rather than the fee the recipe list happened to carry.
   */
  const handleBuild = async () => {
    if (!recipe || !ready) return;
    if (!loadSession()) {
      setBuildError('Connect your wallet to forge.');
      return;
    }

    setBuilding(true);
    setBuildError(null);
    setTxError(null);
    setTxId(null);
    try {
      setQuote(await buildForge(recipe.id, selectedTokenIds));
      setTxState('about_to_sign');
    } catch (err) {
      setQuote(null);
      setBuildError(errorMessage(err));
    } finally {
      setBuilding(false);
    }
  };

  /**
   * Step 2: hand the payload to the wallet, then watch for the burn.
   *
   * The payload is rebuilt immediately before signing rather than reusing the
   * one from step 1, so a token sold or forged in the meantime is caught by the
   * server (and, failing that, by the contract) rather than by a stale blob.
   *
   * If the rebuilt payload carries a different fee than the one on the confirm
   * screen, the wallet is not opened. The player agreed to a specific number of
   * STX leaving their account; a silently larger one is not the same agreement,
   * and the post-condition would make it binding.
   *
   * A txid means *submitted*. The burn is real only once it mines, so the
   * holdings are polled until the burned tokens disappear from the wallet —
   * which is the chain saying it happened, not this app assuming it did.
   */
  const handleSign = async () => {
    if (!recipe) return;
    const burned = [...selectedTokenIds];
    const agreedFee = quote?.feeUstx ?? null;

    setTxError(null);
    let id: string;
    try {
      const payload = await buildForge(recipe.id, burned);
      if (agreedFee !== null && payload.feeUstx !== agreedFee) {
        setQuote(payload);
        setTxError(
          `The forge fee changed to ${formatStx(BigInt(payload.feeUstx))} STX while you ` +
            `were reading. Nothing was burned and nothing was charged. Review the new ` +
            `amount and sign again if you still want to.`,
        );
        setTxState('failed');
        return;
      }
      setQuote(payload);
      id = await signAndSubmit(payload);
    } catch (err) {
      setTxError(
        signingErrorMessage(
          err,
          errorMessage(err),
          'Nothing was burned and nothing was charged.',
        ),
      );
      setTxState('failed');
      return;
    }

    setTxId(id);
    setTxState('pending');

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!address || !character) break;

      let held: readonly EquippablePowerUp[];
      try {
        held = (await getPowerUps(character, address)).powerUps;
      } catch {
        continue; // A dropped read is not a failed burn. Keep waiting.
      }

      setPowerUps(held);
      const stillHeld = held.some((p) => burned.includes(p.tokenId));
      if (!stillHeld) {
        setSelectedTokenIds([]);
        setTxState('confirmed');
        return;
      }
    }

    // Out of patience, not out of hope. Say exactly that rather than reporting
    // a failure the chain has not actually reported.
    setTxError(
      'The transaction has not confirmed yet. That does not mean it failed — ' +
        'check it on the explorer, and reload this page once it mines.',
    );
    setTxState('failed');
  };

  const closeOverlay = () => {
    setTxState('idle');
    setTxId(null);
    setTxError(null);
    setQuote(null);
    loadPowerUps();
  };

  const connected = status === 'connected' && address;

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian overflow-hidden">
      <TopBar />

      <div className="absolute inset-0 z-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-50"
          style={{ backgroundImage: `url(${forgeBg})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-obsidian via-transparent to-obsidian/80" />
      </div>

      <div className="relative z-10 flex-1 pt-24 px-12 pb-12 flex flex-col items-center overflow-y-auto">
        <h1 className="text-3xl font-display text-gray-200 mb-2 tracking-[0.1em]">Forge Ritual</h1>
        <p className="font-ui text-xs text-gray-500 mb-10 max-w-xl text-center">
          Burn lower-tier power-ups to mint a higher-tier one. Every recipe below is
          read from the contract, and every item is one this wallet holds on chain.
          Each recipe charges an STX fee, quoted from the contract at the moment you
          forge.
        </p>

        {!connected ? (
          <Notice
            title="Wallet not connected"
            body="Connect a Stacks wallet to see the power-ups it holds."
            action={
              <Button variant="stx" size="md" onClick={() => navigate('/')}>
                Connect Wallet
              </Button>
            }
          />
        ) : !character ? (
          <Notice
            title="No active character"
            body="Power-up bonuses are described against the character that would equip them, so pick one first."
            action={
              <Button variant="secondary" size="md" onClick={() => navigate('/characters')}>
                Choose a Character
              </Button>
            }
          />
        ) : loadingRecipes ? (
          <Notice title="Reading the forge…" body="Fetching the recipe ladder from the contract." />
        ) : recipesError ? (
          <Notice
            title="Couldn't read the recipes"
            body={`${recipesError} Nothing can be forged until the contract's recipe map can be read — burning NFTs against a recipe we can't verify is not something this screen will offer.`}
            action={
              <Button variant="secondary" size="md" onClick={() => loadRecipes()}>
                Retry
              </Button>
            }
          />
        ) : recipes.length === 0 ? (
          <Notice
            title="The forge has no recipes yet"
            body="The contract is deployed but no recipes have been created on it. There is nothing to forge until one exists."
          />
        ) : (
          <div className="w-full max-w-6xl">
            {/* Recipe ladder */}
            <h2 className="text-xs font-ui tracking-widest text-gray-400 uppercase mb-4">
              Recipes ({recipes.length} on chain)
            </h2>
            <div className="flex flex-wrap gap-4 mb-10">
              {recipes.map((r) => (
                <RecipeCard
                  key={r.id}
                  recipe={r}
                  selected={r.id === selectedRecipeId}
                  held={powerUps.filter((p) => p.tier === r.inputTier).length}
                  onClick={() => chooseRecipe(r.id)}
                />
              ))}
            </div>

            {recipe && (
              <>
                <div className="flex justify-between items-end mb-4">
                  <h2 className="text-xs font-ui tracking-widest text-gray-400 uppercase">
                    Select Components ({selectedTokenIds.length}/{recipe.inputCount})
                  </h2>
                  <span className="font-ui text-[10px] text-gray-500 tracking-widest">
                    {recipe.inputTierName.toUpperCase()} POWER-UPS HELD: {eligible.length}
                  </span>
                </div>

                {loadingPowerUps ? (
                  <p className="font-ui text-xs text-gray-500 mb-10">Reading your holdings…</p>
                ) : powerUpsError ? (
                  <div className="mb-10 border border-blood/30 bg-blood/5 px-6 py-4">
                    <p className="font-ui text-xs text-blood mb-2">
                      Couldn&apos;t read your power-ups.
                    </p>
                    <p className="font-ui text-xs text-gray-400 mb-3">{powerUpsError}</p>
                    <button
                      className="font-ui text-xs text-gray-400 underline hover:text-white"
                      onClick={() => loadPowerUps()}
                    >
                      Retry
                    </button>
                  </div>
                ) : eligible.length === 0 ? (
                  <p className="font-ui text-xs text-gray-500 mb-10">
                    This wallet holds no {recipe.inputTierName} power-ups. They drop from
                    dungeon runs.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-4 mb-10">
                    <AnimatePresence>
                      {eligible.map((item) => (
                        <PowerUpCard
                          key={item.tokenId}
                          item={item}
                          selected={selectedTokenIds.includes(item.tokenId)}
                          onClick={() => toggleToken(item.tokenId)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                )}

                {/* Outcome + action */}
                <div className="flex flex-col md:flex-row gap-8 items-stretch border-t border-stone pt-8">
                  <OutputPreview recipe={recipe} />

                  <div className="flex-1 flex flex-col justify-center max-w-sm">
                    <p className="text-sm font-ui text-gray-400 mb-4">
                      {ready
                        ? `You are about to burn ${recipe.inputCount} ${recipe.inputTierName} power-ups to mint 1 ${recipe.outputTierName}.`
                        : `Select ${recipe.inputCount} ${recipe.inputTierName} power-ups to continue.`}
                    </p>
                    {selected.length > 0 && (
                      <p className="text-[10px] font-ui text-gray-500 mb-4 tracking-widest">
                        BURNING #{selected.map((s) => s.tokenId).join(', #')}
                      </p>
                    )}
                    {/* Two costs, said separately because they are separate: the
                        NFTs are destroyed, and the fee is paid. Re-quoted before
                        signing; this is the ladder's figure, not a guess. */}
                    <div className="flex justify-between items-baseline mb-4 border-t border-b border-stone py-3">
                      <span className="text-[10px] font-ui text-gray-500 tracking-widest uppercase">
                        Forge fee
                      </span>
                      <span className="text-lg font-ui text-stx-accent">
                        {formatStx(BigInt(recipe.stxFeeUstx))}{' '}
                        <span className="text-xs text-stx-accent/70">STX</span>
                      </span>
                    </div>
                    <p className="text-xs font-ui text-blood mb-6 uppercase tracking-widest px-4 py-2 bg-blood/10 border border-blood/20">
                      The burn is permanent and the fee is not refundable.
                    </p>

                    {buildError && (
                      <p className="font-ui text-xs text-blood mb-4">{buildError}</p>
                    )}

                    <Button
                      variant="void"
                      size="lg"
                      className="w-full flex flex-col"
                      onClick={handleBuild}
                      disabled={!ready || building}
                    >
                      <span className="mb-1 text-gold">{building ? 'Preparing…' : 'Forge'}</span>
                      <span className="text-[10px] text-gold/70 tracking-widest">
                        Burn {recipe.inputCount} Items · {formatStx(BigInt(recipe.stxFeeUstx))} STX
                      </span>
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/*
        Two irreversible things happen here, and the overlay names both. The
        amount is `quote.feeUstx` — the fee the payload in hand actually pins —
        rather than the recipe list's copy, so what the player reads and what the
        post-condition enforces are the same number by construction. Until a
        payload exists there is no honest amount to show, so none is shown.
      */}
      <TransactionOverlay
        txState={txState}
        title={recipe ? `Forge 1 ${recipe.outputTierName} power-up` : 'Forge'}
        amountStx={quote ? formatStx(BigInt(quote.feeUstx)) : undefined}
        badge="Permanent burn · non-refundable fee"
        disclosure={
          recipe
            ? `Signing burns ${recipe.inputCount} ${recipe.inputTierName} power-up NFTs ` +
              `(#${selectedTokenIds.join(', #')}) and mints one ${recipe.outputTierName} in ` +
              `their place. The burn is permanent and cannot be reversed. ` +
              (quote
                ? `The ${formatStx(BigInt(quote.feeUstx))} STX forge fee goes to the operator ` +
                  `and is not refundable — not if the forge fails, and not if you change your ` +
                  `mind afterwards. It does not fund the prize pool and does not affect your ` +
                  `odds in any dungeon. `
                : '') +
              `Your wallet will quote its own network fee on top.`
            : undefined
        }
        error={txError}
        txId={txId}
        explorerUrl={config && txId ? explorerTxLink(config, txId) : null}
        pendingNote={
          'Waiting for the burn to be mined. Your components and your STX are both ' +
          'still yours until it is — the transaction either does all of it or none of it.'
        }
        confirmedTitle="Forge Complete"
        confirmedNote={
          recipe
            ? `Your components were burned, the fee was paid, and a ${recipe.outputTierName} ` +
              `power-up was minted.`
            : 'The forge completed.'
        }
        onCancel={closeOverlay}
        onSign={handleSign}
        onRetry={() => setTxState(ready ? 'about_to_sign' : 'idle')}
      />
    </div>
  );
}

function RecipeCard({
  recipe,
  selected,
  held,
  onClick,
}: {
  recipe: ForgeRecipe;
  selected: boolean;
  held: number;
  onClick: () => void;
}) {
  const enough = held >= recipe.inputCount;

  return (
    <button
      onClick={onClick}
      className={`text-left w-56 border bg-obsidian/80 p-4 transition-colors hover:border-void ${
        selected ? 'border-void shadow-[0_0_15px_rgba(107,47,160,0.3)]' : 'border-stone'
      }`}
    >
      <div className="font-ui text-[10px] text-gray-500 tracking-widest mb-2">
        RECIPE #{recipe.id}
      </div>
      <div className="font-display text-sm text-gray-200 mb-2">
        {recipe.inputCount}× <span className={tierAccent(recipe.inputTier)}>{recipe.inputTierName}</span>
        <span className="text-gray-500 mx-2">→</span>
        <span className={tierAccent(recipe.outputTier)}>{recipe.outputTierName}</span>
      </div>
      {/* The contract's own `stx-fee` for this rung, not a table lookup. */}
      <div className="font-ui text-[10px] text-stx-accent tracking-widest mb-1">
        + {formatStx(BigInt(recipe.stxFeeUstx))} STX FEE
      </div>
      <div className={`font-ui text-[10px] ${enough ? 'text-gray-400' : 'text-gray-600'}`}>
        {held} held {enough ? '· ready' : `· need ${recipe.inputCount}`}
      </div>
    </button>
  );
}

/**
 * One held item, offered up for burning.
 *
 * The art sits *behind* the text rather than above it. On the other screens the
 * picture is the item; here the card is a destruction choice, and what decides
 * it is the stat block — burning three tier-3s to make a tier-4 means giving up
 * whatever those three were doing. So the archetype is shown, dimly, as
 * recognition, and never at the cost of a line of text.
 */
function PowerUpCard({
  item,
  selected,
  onClick,
}: {
  item: EquippablePowerUp;
  selected: boolean;
  onClick: () => void;
}) {
  const art = lootArtFor(item.archetype, item.tier) ?? imgLoot;
  return (
    <motion.button
      layout
      exit={{ scale: 0, opacity: 0 }}
      transition={{ duration: 0.4 }}
      onClick={onClick}
      className={`text-left w-40 border bg-obsidian/80 p-4 transition-colors hover:border-gray-400 relative overflow-hidden ${tierBorder(
        item.tier,
        selected,
      )} ${selected ? 'shadow-[0_0_15px_rgba(107,47,160,0.3)]' : ''}`}
    >
      <img src={art} alt="" className="absolute inset-0 w-full h-full object-cover opacity-20" />
      <div className="relative">
        <div className="flex justify-between items-start mb-2">
          <span className={`font-ui text-[10px] uppercase tracking-widest ${tierAccent(item.tier)}`}>
            {item.tierName}
          </span>
          {selected && <span className="text-gold text-xs">✓</span>}
        </div>
        <div className="font-display text-sm text-gray-200 mb-2">{item.name}</div>
        {/* Every line below is derived from the on-chain tier and archetype by the
            shared bonus table — never from the document the metadata URI addresses,
            which is not fetched. */}
        <div className="font-ui text-[10px] text-gray-400 leading-relaxed">{item.summary}</div>
        {item.diceFormulaBonus && (
          <div className="font-ui text-[10px] text-gray-500 mt-2 tracking-widest">
            {item.diceFormulaBonus}
          </div>
        )}
      </div>
    </motion.button>
  );
}

/**
 * What the recipe produces.
 *
 * The tier and the bonus that tier grants, and nothing else. We do not know the
 * forged token's name or artwork before it is minted, and inventing one here
 * would be a promise this screen cannot keep.
 */
function OutputPreview({ recipe }: { recipe: ForgeRecipe }) {
  const bonus = powerUpBonus(recipe.outputTier);

  return (
    <div className="w-64 border-2 border-void bg-obsidian/90 p-6 flex flex-col justify-between shadow-[0_0_30px_rgba(107,47,160,0.3)] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-t from-void/20 via-transparent to-transparent z-0" />
      <div className="relative z-10">
        <div className="font-ui text-[10px] text-gray-500 tracking-widest mb-4 uppercase">
          Preview Result
        </div>
        <div className={`text-xl font-display mb-1 ${tierAccent(recipe.outputTier)}`}>
          {recipe.outputTierName}
        </div>
        <div className="text-[10px] font-ui text-gray-500 uppercase tracking-widest mb-4">
          Tier {recipe.outputTier} power-up
        </div>
        <p className="text-sm font-ui text-gray-300 leading-relaxed mb-4">{bonus.summary}</p>
        <p className="text-[10px] font-ui text-gray-600 leading-relaxed">
          Name and artwork are written by the contract when the token is minted.
        </p>
      </div>
    </div>
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
