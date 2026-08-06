;; forge.clar - burn N power-up NFTs of one tier, mint one of the next tier up.
;;
;; Deterministic and guaranteed: no randomness here, so no commit-reveal. A
;; forge either meets the recipe or it fails; it never rolls.
;;
;; Every condition is checked on-chain rather than trusted from the UI: a player
;; who bypasses the frontend and calls this directly still cannot forge with
;; mismatched-tier tokens, the wrong number of tokens, or tokens they do not own.
;;
;; No STX moves in this contract at all. It never reads or writes game-core's
;; sponsor-pool, and it charges no fee.

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER (err u300))
(define-constant ERR-RECIPE-NOT-FOUND (err u301))
(define-constant ERR-WRONG-INPUT-COUNT (err u302))
(define-constant ERR-BAD-INPUT (err u303))
(define-constant ERR-BAD-RECIPE (err u304))

;; `output-uri` is not in the spec's recipe tuple, but character-loot-nft.mint
;; requires a metadata uri and nothing else in the forge path can supply one.
;; Putting it on the recipe keeps it owner-controlled and publicly readable,
;; which is the same property the rest of the recipe has. Flagged in the README.
(define-map recipes uint {
  input-tier: uint,
  input-count: uint,
  output-tier: uint,
  output-uri: (string-ascii 256)
})

(define-data-var recipe-nonce uint u0)

;; --- owner administration ---

;; The recipe list is owner-set but publicly readable, so a player can plan a
;; forge from chain state rather than trusting what a UI tells them.
;; #[allow(unchecked_data)]
(define-public (create-recipe
    (input-tier uint)
    (input-count uint)
    (output-tier uint)
    (output-uri (string-ascii 256)))
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
    (map-set recipes recipe-id {
      input-tier: input-tier,
      input-count: input-count,
      output-tier: output-tier,
      output-uri: output-uri
    })
    (var-set recipe-nonce recipe-id)
    (print {
      event: "recipe-created",
      recipe-id: recipe-id,
      input-tier: input-tier,
      input-count: input-count,
      output-tier: output-tier
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
    )
    (asserts! (is-eq (len token-ids) (get input-count recipe)) ERR-WRONG-INPUT-COUNT)

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
        output-tier: (get output-tier recipe)
      })
      (ok minted)
    )
  )
)

;; --- read-only ---

(define-read-only (get-recipe (recipe-id uint))
  (map-get? recipes recipe-id)
)

(define-read-only (get-last-recipe-id)
  (var-get recipe-nonce)
)

(define-read-only (get-contract-owner)
  CONTRACT-OWNER
)
