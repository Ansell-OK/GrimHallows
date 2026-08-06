;; SIP-009 NFT trait.
;;
;; Defined locally so devnet/simnet don't depend on a deployed trait contract.
;; On testnet/mainnet this is the same shape as the canonical SIP-009 trait, so
;; wallets and explorers recognise tokens implementing it.
(define-trait nft-trait
  (
    (get-last-token-id () (response uint uint))
    (get-token-uri (uint) (response (optional (string-ascii 256)) uint))
    (get-owner (uint) (response (optional principal) uint))
    (transfer (uint principal principal) (response bool uint))
  )
)
