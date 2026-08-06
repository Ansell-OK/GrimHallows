;; character-loot-nft.clar - SIP-009 collection for in-game power-up NFTs.
;;
;; Distinct from the *character* NFTs players bring from outside: those are never
;; minted or held here, only read for ownership. This collection is the power-up
;; items minted as dungeon rewards (game-core) and forge upgrades (forge).
;;
;; `tier` is stored on-chain, not just in off-chain metadata, so forge recipes
;; can be validated by the contract rather than trusted from a UI claim.

(impl-trait .sip009-nft-trait.nft-trait)

(define-non-fungible-token character-loot uint)

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER (err u100))
(define-constant ERR-NOT-AUTHORIZED-MINTER (err u101))
(define-constant ERR-NOT-TOKEN-OWNER (err u103))
(define-constant ERR-TIER-ZERO (err u104))

(define-data-var token-id-nonce uint u0)

(define-map token-metadata uint {uri: (string-ascii 256), tier: uint})

;; Which principals may mint and burn. Only ever `.game-core` and `.forge`.
;;
;; This is a map set by the owner after deployment rather than hardcoded
;; constants, because the deploy order (character-loot-nft, then game-core, then
;; forge) means those principals don't exist when this contract is deployed, and
;; hardcoding `'<deployer>.game-core` would bake a network-specific address into
;; the source. Contract addresses have a single source of truth in
;; packages/shared/src/contracts.ts; this map is populated from it at deploy.
;;
;; There is deliberately no public mint entrypoint - minting is only reachable
;; through the two authorized contracts.
(define-map authorized-minters principal bool)

;; --- owner administration ---

;; `who` is unvalidated by design: the owner is trusted to name the two
;; authorized contracts, and there is no set of principals to validate against.
;; #[allow(unchecked_data)]
(define-public (set-minter (who principal) (allowed bool))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (map-set authorized-minters who allowed)
    (print {event: "set-minter", who: who, allowed: allowed})
    (ok true)
  )
)

(define-read-only (is-authorized-minter (who principal))
  (default-to false (map-get? authorized-minters who))
)

;; --- minting and burning (authorized contracts only) ---

;; `contract-caller` rather than `tx-sender`: the check must be that the
;; immediate caller is game-core/forge, not that some player initiated the tx.
;; Arguments reach `nft-mint?` unvalidated on purpose: the `contract-caller`
;; assert below already restricts callers to game-core/forge, which construct
;; these values themselves. A player cannot reach this function.
;; #[allow(unchecked_data)]
(define-public (mint (recipient principal) (metadata-uri (string-ascii 256)) (tier uint))
  (let
    (
      (token-id (+ (var-get token-id-nonce) u1))
    )
    (asserts! (is-authorized-minter contract-caller) ERR-NOT-AUTHORIZED-MINTER)
    (asserts! (> tier u0) ERR-TIER-ZERO)
    (try! (nft-mint? character-loot token-id recipient))
    (map-set token-metadata token-id {uri: metadata-uri, tier: tier})
    (var-set token-id-nonce token-id)
    (print {event: "mint", token-id: token-id, recipient: recipient, tier: tier, uri: metadata-uri})
    (ok token-id)
  )
)

;; Forge burns its inputs through this function rather than transferring to a
;; burn address - one consistent pattern, and it actually destroys the token so
;; supply stays honest.
(define-public (burn (token-id uint) (owner principal))
  (begin
    (asserts! (is-authorized-minter contract-caller) ERR-NOT-AUTHORIZED-MINTER)
    (asserts!
      (is-eq (some owner) (nft-get-owner? character-loot token-id))
      ERR-NOT-TOKEN-OWNER
    )
    (try! (nft-burn? character-loot token-id owner))
    (map-delete token-metadata token-id)
    (print {event: "burn", token-id: token-id, owner: owner})
    (ok true)
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
  (ok (nft-get-owner? character-loot token-id))
)

;; `sender` is checked against `tx-sender` below; `token-id` and `recipient`
;; need no validation because `nft-transfer?` itself rejects a token the sender
;; does not own.
;; #[allow(unchecked_data)]
(define-public (transfer (token-id uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) ERR-NOT-TOKEN-OWNER)
    (nft-transfer? character-loot token-id sender recipient)
  )
)

;; --- extra read-onlys used by forge validation and the indexer ---

(define-read-only (get-token-tier (token-id uint))
  (ok (get tier (map-get? token-metadata token-id)))
)

(define-read-only (get-token-metadata (token-id uint))
  (ok (map-get? token-metadata token-id))
)
