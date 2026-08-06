;; forge-v2.clar - forge.clar plus an STX fee. The second revenue line.
;;
;; WHY A NEW CONTRACT: forge.clar is deployed on mainnet and Clarity contracts
;; are immutable. Adding a fee to the existing one is not possible, so this is a
;; copy with the fee path added, deployed alongside it. The operator points the
;; UI at this one and revokes the old one's minter authorization
;; (character-loot-nft.set-minter) - the old contract keeps existing, but with no
;; minting rights it can do nothing.
;;
;; WHAT CHANGED FROM forge.clar, in full:
;;   1. `recipes` gains an `stx-fee` field, set by the owner at create-recipe.
;;   2. `forge` transfers that fee from the forger to CONTRACT-OWNER before it
;;      burns anything.
;;   3. `create-recipe` takes the fee as an argument.
;; Nothing else differs. The burn/mint logic is byte-identical on purpose: this
;; is the audited path and a rewrite would be a new one.
;;
;; WHERE THE MONEY GOES: forger -> CONTRACT-OWNER, in one hop, same as the gate
;; fee and the mint price. This contract never holds a balance and has no code
;; path that reads or writes game-core's sponsor-pool (02-architecture.md#3).
;;
;; NO REFUNDS. If the fee transfers and a later step fails, the whole
;; transaction reverts and the fee never happened - Clarity gives us that for
;; free and it is the only "refund" in this system. Once the transaction
;; succeeds the STX is gone regardless of how the player feels about the result.
;;
;; THE FEE IS PER-RECIPE, NOT A HARDCODED LADDER. The launch values are 0.5 /
;; 1 / 2 STX for output tiers 2 / 3 / 4, but they are set when the owner creates
;; each recipe rather than baked in here. An economic ladder that cannot be
;; retuned without redeploying is how this contract came to need a v2 in the
;; first place.

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER (err u300))
(define-constant ERR-RECIPE-NOT-FOUND (err u301))
(define-constant ERR-WRONG-INPUT-COUNT (err u302))
(define-constant ERR-BAD-INPUT (err u303))
(define-constant ERR-BAD-RECIPE (err u304))
(define-constant ERR-FEE-TRANSFER-FAILED (err u305))

(define-map recipes uint {
  input-tier: uint,
  input-count: uint,
  output-tier: uint,
  output-uri: (string-ascii 256),
  stx-fee: uint
})

(define-data-var recipe-nonce uint u0)

;; --- owner administration ---

;; The recipe list is owner-set but publicly readable, so a player can price a
;; forge from chain state rather than trusting what a UI tells them. The fee is
;; part of that: a player can read exactly what they will be charged before
;; signing, and a UI that displays a different number is provably wrong.
;; #[allow(unchecked_data)]
(define-public (create-recipe
    (input-tier uint)
    (input-count uint)
    (output-tier uint)
    (output-uri (string-ascii 256))
    (stx-fee uint))
  (let
    (
      (recipe-id (+ (var-get recipe-nonce) u1))
    )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    ;; Config sanity: tier 0 does not exist, the input list caps at 5, and a
    ;; forge that did not raise the tier would just destroy value.
    (asserts! (> input-tier u0) ERR-BAD-RECIPE)
    (asserts! (and (> input-count u0) (<= input-count u5)) ERR-BAD-RECIPE)
    (asserts! (> output-tier input-tier) ERR-BAD-RECIPE)
    ;; A zero fee is rejected rather than allowed as "free": stx-transfer? fails
    ;; on a zero amount, so a zero-fee recipe would be uncallable rather than
    ;; free, and would look like a working recipe until the first player tried
    ;; it. If a free forge is ever wanted, that is a v3 with the transfer made
    ;; conditional, not a config value that silently bricks a recipe.
    (asserts! (> stx-fee u0) ERR-BAD-RECIPE)
    (map-set recipes recipe-id {
      input-tier: input-tier,
      input-count: input-count,
      output-tier: output-tier,
      output-uri: output-uri,
      stx-fee: stx-fee
    })
    (var-set recipe-nonce recipe-id)
    (print {
      event: "recipe-created",
      recipe-id: recipe-id,
      input-tier: input-tier,
      input-count: input-count,
      output-tier: output-tier,
      stx-fee: stx-fee
    })
    (ok recipe-id)
  )
)

;; --- forging ---

;; Validates one input token and burns it, short-circuiting the whole fold if
;; anything is wrong.
;;
;; Ownership is checked explicitly here rather than left to the NFT contract's
;; own check inside `burn`, so a mismatch surfaces as forge's ERR-BAD-INPUT
;; instead of a lower-level error the UI would have to translate.
;;
;; A repeated token id is handled by the same check: the first pass burns it, so
;; the second finds no owner and fails.
(define-private (burn-input (token-id uint) (acc {owner: principal, tier: uint, ok: bool}))
  (if (not (get ok acc))
    acc
    (let
      (
        (token-owner (unwrap! (contract-call? .character-loot-nft get-owner token-id)
                              (merge acc {ok: false})))
        (token-tier (unwrap! (contract-call? .character-loot-nft get-token-tier token-id)
                              (merge acc {ok: false})))
      )
      (if (and
            (is-eq token-owner (some (get owner acc)))
            (is-eq token-tier (some (get tier acc))))
        (match (contract-call? .character-loot-nft burn token-id (get owner acc))
          burned acc
          burn-err (merge acc {ok: false})
        )
        (merge acc {ok: false})
      )
    )
  )
)

;; #[allow(unchecked_data)]
;; `token-ids` is fully validated by the fold below - ownership, tier, and count
;; are all checked against the recipe before anything is burned or minted.
(define-public (forge (recipe-id uint) (token-ids (list 5 uint)))
  (let
    (
      (recipe (unwrap! (map-get? recipes recipe-id) ERR-RECIPE-NOT-FOUND))
      (forger tx-sender)
      (fee (get stx-fee recipe))
    )
    (asserts! (is-eq (len token-ids) (get input-count recipe)) ERR-WRONG-INPUT-COUNT)

    ;; REVENUE, NOT POOL. Charged before the burn so a player who cannot afford
    ;; the fee keeps their tokens: the transaction aborts here, and nothing has
    ;; been destroyed yet. Charging after the burn would be equivalent on chain
    ;; (the revert undoes both) but this ordering is the one that stays correct
    ;; if anyone ever adds a step between them.
    ;;
    ;; The owner forging is the one case that skips the transfer: Clarity's
    ;; stx-transfer? rejects sender == recipient with (err u2), and paying
    ;; yourself is a no-op either way.
    (if (is-eq forger CONTRACT-OWNER)
      true
      (unwrap! (stx-transfer? fee forger CONTRACT-OWNER) ERR-FEE-TRANSFER-FAILED)
    )

    (asserts!
      (get ok (fold burn-input token-ids {
        owner: forger,
        tier: (get input-tier recipe),
        ok: true
      }))
      ERR-BAD-INPUT
    )

    (let
      (
        (minted (try! (contract-call? .character-loot-nft mint
                        forger
                        (get output-uri recipe)
                        (get output-tier recipe))))
      )
      (print {
        event: "forged",
        recipe-id: recipe-id,
        forger: forger,
        burned: token-ids,
        token-id: minted,
        output-tier: (get output-tier recipe),
        stx-fee: fee
      })
      (ok minted)
    )
  )
)

;; --- read-only ---

(define-read-only (get-recipe (recipe-id uint))
  (map-get? recipes recipe-id)
)

;; What this recipe will cost, for a UI that wants the price without the rest.
(define-read-only (get-recipe-fee (recipe-id uint))
  (get stx-fee (map-get? recipes recipe-id))
)

(define-read-only (get-last-recipe-id)
  (var-get recipe-nonce)
)

(define-read-only (get-contract-owner)
  CONTRACT-OWNER
)
