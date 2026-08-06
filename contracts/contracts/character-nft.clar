;; character-nft.clar - SIP-009 collection for GrimHallow's own character NFTs.
;;
;; The third and last thing a player can pay for, and the third independent
;; revenue line (01-game-design.md#4a, 03-smart-contracts-spec.md#5). A player
;; who owns no supported outside collection can buy a character here and choose
;; its class outright, instead of accepting a hash-assigned one.
;;
;; TWO COLLECTIONS, DIFFERENT JOBS. `character-loot-nft` holds power-up ITEMS,
;; minted only by game-core and forge, never bought. This holds CHARACTERS,
;; minted only by the player who pays for one. They share no state and neither
;; can mint into the other.
;;
;; CLASS IS STORED, NOT DERIVED. For every other collection the class is a
;; function of the contract principal (packages/shared/src/classes.ts). Here the
;; player picked it and this contract recorded it, so the backend reads a fact
;; rather than deriving one - that is what `classSource: "mint"` means, and why
;; it outranks every other path.
;;
;; RARITY IS NOT STORED. Hold duration is scoped to the current holder and resets
;; on transfer (01-game-design.md#4b), so it is a property of the ledger, not of
;; the token. Writing a rarity field here would create a second answer that goes
;; stale the moment the token sells.
;;
;; WHERE THE MONEY GOES: the mint price is transferred straight from the buyer to
;; CONTRACT-OWNER inside `mint-character`. This contract never holds a balance,
;; never calls game-core, and cannot reach the sponsor pool - there is no code
;; path here that touches it, which is the point (02-architecture.md#3).

(impl-trait .sip009-nft-trait.nft-trait)

(define-non-fungible-token grimhallow-character uint)

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER (err u400))
(define-constant ERR-BAD-CLASS (err u401))
(define-constant ERR-NOT-TOKEN-OWNER (err u402))
(define-constant ERR-PRICE-ZERO (err u403))
(define-constant ERR-MINT-PAUSED (err u404))

;; The four class ids, spelled exactly as packages/shared/src/classes.ts spells
;; them (CLASS_IDS). These are ids, not display names: the archetype names
;; ("Iron Templar" and the rest) are a UI concern and can be rewritten without a
;; contract that then disagrees with them.
(define-constant CLASS-WARRIOR "warrior")
(define-constant CLASS-PALADIN "paladin")
(define-constant CLASS-ROGUE "rogue")
(define-constant CLASS-MAGE "mage")

;; 1 STX, the operator's chosen launch price. A data-var rather than a constant
;; for the same reason the jackpot size is: pricing is expected to move, and a
;; deployed Clarity contract cannot be edited. Owner-only to change.
(define-data-var mint-price uint u1000000)

;; Lets the owner stop sales without abandoning the contract - needed because
;; there is no upgrade path once this is deployed.
(define-data-var mint-paused bool false)

(define-data-var token-id-nonce uint u0)

(define-map token-metadata uint {
  uri: (string-ascii 256),
  class-id: (string-ascii 16),
  minted-by: principal
})

;; --- class validation ---

;; Exactly four accepted values, compared exactly.
;;
;; An unknown class id is REJECTED, never coerced to a default. Silently
;; substituting warrior for a typo'd or malicious value would mint a token whose
;; on-chain class is not the one the buyer paid for and saw confirmed, and there
;; is no way to correct it afterwards - the mint is final and the STX is gone.
;; A failed transaction costs the buyer a fee; a wrong one costs them the price.
(define-read-only (is-valid-class (class-id (string-ascii 16)))
  (or
    (is-eq class-id CLASS-WARRIOR)
    (is-eq class-id CLASS-PALADIN)
    (is-eq class-id CLASS-ROGUE)
    (is-eq class-id CLASS-MAGE)
  )
)

;; --- owner administration ---

(define-public (set-mint-price (new-price uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    ;; A zero price would make `stx-transfer?` fail on every mint (Clarity
    ;; rejects a zero-amount transfer), so minting would break rather than
    ;; become free. Use `set-mint-paused` to stop sales.
    (asserts! (> new-price u0) ERR-PRICE-ZERO)
    (var-set mint-price new-price)
    (print {event: "mint-price-set", price: new-price})
    (ok new-price)
  )
)

(define-public (set-mint-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (var-set mint-paused paused)
    (print {event: "mint-paused-set", paused: paused})
    (ok paused)
  )
)

;; --- minting ---

;; Buy one character of a chosen class.
;;
;; `metadata-uri` is caller-supplied and deliberately unvalidated: it is flavour
;; only. Nothing in this system reads a stat, a class, or a tier from metadata
;; (01-game-design.md#4a), so the worst a crafted URI can do is make a token look
;; silly in a wallet. The two values that matter - the class and the owner - are
;; validated and written here.
;; #[allow(unchecked_data)]
(define-public (mint-character (class-id (string-ascii 16)) (metadata-uri (string-ascii 256)))
  (let
    (
      (token-id (+ (var-get token-id-nonce) u1))
      (price (var-get mint-price))
      (buyer tx-sender)
    )
    (asserts! (not (var-get mint-paused)) ERR-MINT-PAUSED)
    (asserts! (is-valid-class class-id) ERR-BAD-CLASS)

    ;; REVENUE, NOT POOL. Straight from the buyer to the owner, in one hop. The
    ;; contract is not the recipient at any point, so there is no balance here
    ;; for a later function to sweep anywhere, and no branch below can redirect
    ;; it. The owner minting to themselves is the one case that skips the
    ;; transfer: Clarity's stx-transfer? rejects sender == recipient with (err
    ;; u2), and paying yourself is a no-op regardless of which branch runs.
    (if (is-eq buyer CONTRACT-OWNER)
      true
      (unwrap! (stx-transfer? price buyer CONTRACT-OWNER) ERR-NOT-TOKEN-OWNER)
    )

    (try! (nft-mint? grimhallow-character token-id buyer))
    (map-set token-metadata token-id {
      uri: metadata-uri,
      class-id: class-id,
      minted-by: buyer
    })
    (var-set token-id-nonce token-id)
    (print {
      event: "character-minted",
      token-id: token-id,
      recipient: buyer,
      class-id: class-id,
      price: price,
      uri: metadata-uri
    })
    (ok token-id)
  )
)

;; --- SIP-009 ---

(define-read-only (get-last-token-id)
  (ok (var-get token-id-nonce))
)

(define-read-only (get-token-uri (token-id uint))
  (ok (get uri (map-get? token-metadata token-id)))
)

(define-read-only (get-owner (token-id uint))
  (ok (nft-get-owner? grimhallow-character token-id))
)

;; `sender` is checked against `tx-sender`; `nft-transfer?` rejects a token the
;; sender does not own, so neither other argument needs validating.
;;
;; A transfer resets the buyer's rarity clock to zero. That is not enforced here
;; because it needs no enforcing: nothing about tenure is stored on this token,
;; so it is read from the ledger - where this transfer has just become the new
;; acquisition event.
;; #[allow(unchecked_data)]
(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-TOKEN-OWNER)
    (nft-transfer? grimhallow-character token-id sender recipient)
  )
)

;; --- read-only ---

;; The backend's class lookup. Returns none for a token that was never minted,
;; which the shared deriveClass treats as "not one of ours" and falls through.
(define-read-only (get-character-class (token-id uint))
  (ok (get class-id (map-get? token-metadata token-id)))
)

(define-read-only (get-character (token-id uint))
  (ok (map-get? token-metadata token-id))
)

(define-read-only (get-mint-price)
  (var-get mint-price)
)

(define-read-only (is-mint-paused)
  (var-get mint-paused)
)

(define-read-only (get-contract-owner)
  CONTRACT-OWNER
)
