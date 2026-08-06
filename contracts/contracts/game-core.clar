;; game-core.clar - dungeon runs, gate-fee revenue, and sponsor-funded rewards.
;;
;; THE CENTRAL INVARIANT OF THIS SYSTEM: there are two STX flows and they never
;; touch each other.
;;
;;   Flow A  gate fee -> CONTRACT-OWNER          (operator revenue)
;;           Paid by the entrant in `enter-dungeon`. Sent straight to the owner
;;           principal. Never held by this contract, never added to
;;           `sponsor-pool`, never refundable. Once paid it is spent, whatever
;;           the run's outcome, and it does not affect the party's odds.
;;
;;   Flow B  owner -> sponsor-pool -> jackpot winners
;;           Credited ONLY by `fund-pool`, which only the owner can call.
;;           Debited ONLY by a jackpot payout in `reveal-and-resolve`.
;;
;; If you are editing this file and find yourself writing a line that increases
;; `sponsor-pool` anywhere other than `fund-pool`, stop: that is a critical bug,
;; not a refactor. See docs/02-architecture.md section 3 and
;; docs/03-smart-contracts-spec.md sections 2-3.
;;
;; There is no escrow and no refund path anywhere in this contract, by design.
;;
;; Randomness comes exclusively from commit-reveal: the oracle posts
;; sha256(seed) before any outcome is known and reveals `seed` at resolve time,
;; where this contract re-derives the hash and rejects a mismatch. Every dice
;; roll and the reward draw are computed off-chain from that one seed as
;; hash(seed || i) % range, so anyone can recompute them from the public reveal.

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER (err u200))
(define-constant ERR-NOT-ORACLE (err u201))
(define-constant ERR-DUNGEON-NOT-FOUND (err u202))
(define-constant ERR-DUNGEON-INACTIVE (err u203))
(define-constant ERR-EMPTY-PARTY (err u204))
(define-constant ERR-RUN-NOT-FOUND (err u205))
(define-constant ERR-WRONG-STATE (err u206))
(define-constant ERR-SEED-MISMATCH (err u207))
(define-constant ERR-INSUFFICIENT-POOL (err u208))
(define-constant ERR-BAD-OUTCOME (err u209))
(define-constant ERR-BAD-REWARD (err u210))
(define-constant ERR-PAYOUT-FAILED (err u211))
(define-constant ERR-AMOUNT-ZERO (err u212))
(define-constant ERR-BAD-GATE-FEE (err u213))

;; --- storage ---

(define-data-var oracle principal tx-sender)

(define-data-var dungeon-nonce uint u0)
(define-data-var run-nonce uint u0)

;; Owner-funded prize budget, in uSTX. The contract's actual STX balance can
;; exceed this if someone transfers in directly; that surplus is deliberately
;; untracked and unspendable. This var, never the balance, bounds a payout.
(define-data-var sponsor-pool uint u0)

(define-map dungeons uint {gate-fee: uint, is-paid: bool, active: bool})

;; `seed-hash` is empty (0x) until the oracle commits; `state` is the real
;; guard, the sentinel just avoids an extra optional wrapper.
;;
;; `combat-outcome` is not in the spec's storage tuple but section 2 requires
;; reveal-and-resolve to "set combat-outcome on the run", so it lives here.
(define-map runs uint {
  dungeon-id: uint,
  party: (list 4 principal),
  state: (string-ascii 16),
  seed-hash: (buff 32),
  seed-reveal: (optional (buff 32)),
  combat-outcome: (optional (string-ascii 8))
})

;; --- owner administration ---

;; `new-oracle` cannot be validated against anything; the owner is trusted to
;; name their own oracle wallet. Deliberately separate from the owner key: the
;; oracle can move sponsor-pool funds, the owner key can fund it.
;; #[allow(unchecked_data)]
(define-public (set-oracle (new-oracle principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (var-set oracle new-oracle)
    (print {event: "oracle-set", oracle: new-oracle})
    (ok true)
  )
)

;; `gate-fee` and `is-paid` are cross-checked against each other below; there is
;; no further validation to do, and only the owner reaches this.
;; #[allow(unchecked_data)]
(define-public (create-dungeon (gate-fee uint) (is-paid bool))
  (let
    (
      (dungeon-id (+ (var-get dungeon-nonce) u1))
    )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    ;; A paid dungeon with a zero fee, or a free dungeon with a nonzero one,
    ;; is a configuration mistake that would be confusing rather than harmful.
    ;; Reject it here so the two flags can never disagree.
    (asserts! (if is-paid (> gate-fee u0) (is-eq gate-fee u0)) ERR-BAD-GATE-FEE)
    (map-set dungeons dungeon-id {gate-fee: gate-fee, is-paid: is-paid, active: true})
    (var-set dungeon-nonce dungeon-id)
    (print {event: "dungeon-created", dungeon-id: dungeon-id, gate-fee: gate-fee, is-paid: is-paid})
    (ok dungeon-id)
  )
)

;; Owner-only; `unwrap!` above already rejects a nonexistent dungeon-id.
;; #[allow(unchecked_data)]
(define-public (set-dungeon-active (dungeon-id uint) (active bool))
  (let
    (
      (dungeon (unwrap! (map-get? dungeons dungeon-id) ERR-DUNGEON-NOT-FOUND))
    )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (map-set dungeons dungeon-id (merge dungeon {active: active}))
    (print {event: "dungeon-active-set", dungeon-id: dungeon-id, active: active})
    (ok true)
  )
)

;; FLOW B, and the only credit side of it.
;;
;; The pool does not replenish itself from entry fees - it grows only when the
;; owner tops it up here. That is the whole point of the model: this is a
;; sponsored prize budget, not a pari-mutuel pot.
;; #[allow(unchecked_data)]
(define-public (fund-pool (amount uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (> amount u0) ERR-AMOUNT-ZERO)
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (var-set sponsor-pool (+ (var-get sponsor-pool) amount))
    (print {event: "pool-funded", amount: amount, balance: (var-get sponsor-pool)})
    (ok true)
  )
)

;; --- entering a dungeon ---

;; FLOW A. Straight to the owner: not into `sponsor-pool`, not into this
;; contract's balance, not into any escrow map. Nothing here creates refundable
;; state, and nothing here reads or writes `sponsor-pool`.
;;
;; The amount is taken from the dungeon record rather than from a caller-supplied
;; parameter, so paying anything other than exactly `gate-fee` is not
;; representable. Callers still set a post-condition on the transfer.
;;
;; The owner entering their own dungeon is a no-op transfer (paying yourself),
;; which `stx-transfer?` would reject outright, so it is skipped. Economically
;; identical, and it keeps the operator able to test on a live deployment.
(define-private (transfer-gate-fee
    (dungeon {gate-fee: uint, is-paid: bool, active: bool})
    (entrant principal))
  (if (and (get is-paid dungeon) (not (is-eq entrant CONTRACT-OWNER)))
    (stx-transfer? (get gate-fee dungeon) entrant CONTRACT-OWNER)
    (ok true)
  )
)

;; `party` needs no membership validation: entering a party you are not in means
;; paying a fee so that other people can win, which is not an attack. Ownership
;; of the character NFTs behind those principals is checked at selection time
;; (docs/03-smart-contracts-spec.md section 6).
;; #[allow(unchecked_data)]
(define-public (enter-dungeon (dungeon-id uint) (party (list 4 principal)))
  (let
    (
      (dungeon (unwrap! (map-get? dungeons dungeon-id) ERR-DUNGEON-NOT-FOUND))
      (run-id (+ (var-get run-nonce) u1))
      (entrant tx-sender)
      (pool-before (var-get sponsor-pool))
    )
    (asserts! (get active dungeon) ERR-DUNGEON-INACTIVE)
    (asserts! (> (len party) u0) ERR-EMPTY-PARTY)

    (try! (transfer-gate-fee dungeon entrant))

    (map-set runs run-id {
      dungeon-id: dungeon-id,
      party: party,
      state: "pending",
      seed-hash: 0x,
      seed-reveal: none,
      combat-outcome: none
    })
    (var-set run-nonce run-id)

    ;; Belt and braces. This function must not be able to move the pool, and if
    ;; a future edit makes it able to, this assert turns a silent economic
    ;; change into a failed transaction.
    (asserts! (is-eq (var-get sponsor-pool) pool-before) ERR-INSUFFICIENT-POOL)

    (print {
      event: "run-entered",
      run-id: run-id,
      dungeon-id: dungeon-id,
      entrant: entrant,
      party: party,
      gate-fee: (get gate-fee dungeon),
      is-paid: (get is-paid dungeon)
    })
    (ok run-id)
  )
)

;; --- commit / reveal ---

;; `seed-hash` is opaque by construction - the point of a commitment is that the
;; chain cannot inspect it. It is checked at reveal time against sha256(seed).
;; #[allow(unchecked_data)]
(define-public (commit-seed (run-id uint) (seed-hash (buff 32)))
  (let
    (
      (run (unwrap! (map-get? runs run-id) ERR-RUN-NOT-FOUND))
    )
    (asserts! (is-eq tx-sender (var-get oracle)) ERR-NOT-ORACLE)
    (asserts! (is-eq (get state run) "pending") ERR-WRONG-STATE)
    (map-set runs run-id (merge run {state: "committed", seed-hash: seed-hash}))
    (print {event: "seed-committed", run-id: run-id, seed-hash: seed-hash})
    (ok true)
  )
)

;; Equal split of a jackpot across the party, with any indivisible remainder
;; going to the first party member.
;;
;; DEVIATION FLAG: docs/03-smart-contracts-spec.md section 2 says a jackpot
;; "pays `amount` STX from `sponsor-pool` to party members" but never specifies
;; the split. Equal-with-dust-to-first is the least surprising reading and is
;; recorded in the README's open questions; change it here if that is wrong.
(define-private (pay-share (member principal) (acc {share: uint, extra: uint, ok: bool}))
  (let
    (
      (amount (+ (get share acc) (get extra acc)))
    )
    (if (not (get ok acc))
      acc
      ;; A share can round to zero when the jackpot is smaller than the party.
      ;; `stx-transfer?` rejects a zero amount, so skip rather than fail.
      (if (is-eq amount u0)
        (merge acc {extra: u0})
        (match (as-contract (stx-transfer? amount tx-sender member))
          paid (merge acc {extra: u0})
          transfer-err (merge acc {ok: false})
        )
      )
    )
  )
)

(define-private (pay-jackpot (run-id uint) (party (list 4 principal)) (amount uint))
  (begin
    (asserts! (> amount u0) ERR-AMOUNT-ZERO)
    ;; The hard backstop. The backend is expected to check `get-sponsor-pool`
    ;; first and degrade a jackpot to loot rather than reach this (see
    ;; docs/03-smart-contracts-spec.md section 3), but off-chain logic is never
    ;; allowed to be the only thing preventing an over-payout.
    (asserts! (<= amount (var-get sponsor-pool)) ERR-INSUFFICIENT-POOL)
    (var-set sponsor-pool (- (var-get sponsor-pool) amount))
    (let
      (
        (share (/ amount (len party)))
        (result (fold pay-share party {
          share: (/ amount (len party)),
          extra: (- amount (* (/ amount (len party)) (len party))),
          ok: true
        }))
      )
      (asserts! (get ok result) ERR-PAYOUT-FAILED)
      (print {
        event: "jackpot-paid",
        run-id: run-id,
        amount: amount,
        share: share,
        party: party,
        pool-balance: (var-get sponsor-pool)
      })
      (ok true)
    )
  )
)

;; Loot goes to the first party member. Same deviation flag as the jackpot
;; split: the spec does not say which party member receives a loot NFT.
(define-private (mint-loot
    (run-id uint)
    (party (list 4 principal))
    (loot-uri (string-ascii 256))
    (tier uint))
  (let
    (
      (recipient (unwrap! (element-at? party u0) ERR-EMPTY-PARTY))
      (token-id (try! (contract-call? .character-loot-nft mint recipient loot-uri tier)))
    )
    (print {
      event: "loot-minted",
      run-id: run-id,
      recipient: recipient,
      token-id: token-id,
      tier: tier,
      uri: loot-uri
    })
    (ok true)
  )
)

(define-private (settle-reward
    (run-id uint)
    (party (list 4 principal))
    (reward-roll (optional {
      kind: (string-ascii 12),
      amount: (optional uint),
      loot-uri: (optional (string-ascii 256)),
      tier: (optional uint)
    })))
  (match reward-roll
    roll
      (if (is-eq (get kind roll) "jackpot")
        (pay-jackpot run-id party (unwrap! (get amount roll) ERR-BAD-REWARD))
        (if (is-eq (get kind roll) "loot")
          (mint-loot
            run-id
            party
            (unwrap! (get loot-uri roll) ERR-BAD-REWARD)
            (unwrap! (get tier roll) ERR-BAD-REWARD))
          ;; "none" is an expected outcome, not an error: the run still resolves
          ;; and still credits the leaderboard.
          (if (is-eq (get kind roll) "none")
            (ok true)
            ERR-BAD-REWARD)))
    (ok true)
  )
)

;; `seed` is validated against the stored commitment, `combat-outcome` against
;; the two legal values, and `reward-roll` by `settle-reward`, which rejects any
;; kind other than the three legal ones and any missing field those require.
;; Only the oracle reaches this at all.
;; #[allow(unchecked_data)]
(define-public (reveal-and-resolve
    (run-id uint)
    (seed (buff 32))
    (combat-outcome (string-ascii 8))
    (reward-roll (optional {
      kind: (string-ascii 12),
      amount: (optional uint),
      loot-uri: (optional (string-ascii 256)),
      tier: (optional uint)
    })))
  (let
    (
      (run (unwrap! (map-get? runs run-id) ERR-RUN-NOT-FOUND))
    )
    (asserts! (is-eq tx-sender (var-get oracle)) ERR-NOT-ORACLE)
    ;; Also the double-resolve guard: a resolved run is no longer "committed".
    (asserts! (is-eq (get state run) "committed") ERR-WRONG-STATE)
    ;; The trust-minimizing check. Anyone can re-run this against the tx.
    (asserts! (is-eq (sha256 seed) (get seed-hash run)) ERR-SEED-MISMATCH)
    (asserts!
      (or (is-eq combat-outcome "win") (is-eq combat-outcome "loss"))
      ERR-BAD-OUTCOME
    )

    ;; State advances before any value moves, so a payout cannot re-enter and
    ;; resolve the same run twice.
    (map-set runs run-id (merge run {
      state: "resolved",
      seed-reveal: (some seed),
      combat-outcome: (some combat-outcome)
    }))

    (try! (settle-reward run-id (get party run) reward-roll))

    ;; Emitted for every run regardless of dungeon type or reward outcome; the
    ;; indexer builds player_stats from these.
    (print {
      event: "leaderboard-credit",
      run-id: run-id,
      dungeon-id: (get dungeon-id run),
      party: (get party run),
      combat-outcome: combat-outcome
    })
    (print {
      event: "run-resolved",
      run-id: run-id,
      dungeon-id: (get dungeon-id run),
      party: (get party run),
      combat-outcome: combat-outcome,
      seed: seed,
      reward: reward-roll
    })
    (ok true)
  )
)

;; --- read-only ---

(define-read-only (get-run (run-id uint))
  (map-get? runs run-id)
)

(define-read-only (get-dungeon (dungeon-id uint))
  (map-get? dungeons dungeon-id)
)

;; Surfaced in the UI as "here is what is actually up for grabs, verifiably",
;; and as the operational signal for when to call `fund-pool` again.
(define-read-only (get-sponsor-pool)
  (var-get sponsor-pool)
)

(define-read-only (get-oracle)
  (var-get oracle)
)

(define-read-only (get-contract-owner)
  CONTRACT-OWNER
)

(define-read-only (get-last-run-id)
  (var-get run-nonce)
)

(define-read-only (get-last-dungeon-id)
  (var-get dungeon-nonce)
)
