# Kōsen — Build Plan

**Prerequisite:** read [`BACKGROUND.md`](BACKGROUND.md) first. It contains the
architecture-defining finding (no SatVM/EVM) and every verified fact about Tachi's
live infrastructure.

## Guiding principle

Two things carry this bounty: **an AI layer that is provably real** (replayable
scores, hard-clamped authority) and **the 1008-block unilateral exit** that proves the
borrower's BTC was never ours. Deterministic code owns every money decision — the AI
never signs anything.

## Dependency on `../satusd`

`packages/tachi-kit` is authored in `satusd` and **vendored here verbatim** by
`scripts/sync-kit.sh` (with a checksum check). Do not edit it locally — if you need a
change, make it in `satusd` and re-sync. Contract in
[`../../SHARED-CONTEXT.md`](../../SHARED-CONTEXT.md).

**If `satusd` is not ready yet, start with Phases 2, 5 and 6** — market math, the IRM,
and the feature-extraction pipeline need nothing from the kit.

---

## Repo layout

```
kosen/
  packages/
    tachi-kit/          # VENDORED from ../satusd — do not edit here
    engine/
      src/{server,market,irm,shares,position,liquidation,liquidator,ledger,anchor}.ts
    ai/
      src/{features,score,copilot,monitor,schema,store}.ts
    web/
      app/{markets,borrow,position,lend,risk,score}/
  scripts/
    sync-kit.sh
    00-bootstrap-regtest.ts
    01-spike-vault.ts
    score-address.ts
    unilateral-exit.ts
    demo-liquidate.ts
```

---

## Phase 1 — Scaffold + vendor the kit

- pnpm workspaces, TypeScript, Vitest
- `scripts/sync-kit.sh` — copy `../satusd/packages/tachi-kit` here, write a checksum,
  and fail loudly if the local copy has drifted
- `scripts/00-bootstrap-regtest.ts`, `scripts/01-spike-vault.ts` (mirror `satusd`)
- Startup assertion on `getHealth()` + `chain_id`

**Exit criteria:** `pnpm spike` moves BTC on live regtest.

## Phase 2 — Market core (no Tachi dependency — start here if blocked)

Pure math, fully unit-tested, no network.

- `engine/market.ts` — market registry. A market is
  `(collateral, loanAsset, LLTV, oracle, IRM)`. Isolated: no cross-market risk.
- `engine/irm.ts` — kinked curve: 90% target utilization, base 2%, slope1 4%,
  slope2 60%. Test the kink, both extremes, and utilization = 0 and 1.
- `engine/shares.ts` — supply and borrow share accounting with an interest index
  accrued per block. **Standard index accounting — never accrue per-position.**
  Test rounding: shares must never let a user withdraw more than they put in.
- `engine/ledger.ts` — append-only, hash-chained `{prev_hash, seq, payload}`. State is
  a fold over the log; never mutate.

**Exit criteria:** `pnpm test` green on IRM, shares, and index accrual. Round-trip
property tests: supply → accrue → withdraw never mints value from nothing.

## Phase 3 — Borrow / repay lifecycle

- `engine/position.ts` — open, add collateral, borrow, repay, close, over locked VTXOs
- Collateral via `tachi-kit/collateral.ts`; health via `tachi-kit/health.ts`
- **Confirm OPEN QUESTION #2 status with the `satusd` agent** before building deep on
  third-party locking. If the fallback (2-of-2 protocol/user vault) is in play, the
  `collateral.ts` interface is unchanged — only its internals differ.
- Serialize per-account nonces; they are sequential and will collide under concurrency.
- Fastify routes + a typed client for the web app

**Exit criteria:** borrow → accrue → repay round-trips; collateral VTXOs unlock.

## Phase 4 — Deterministic liquidation

- `engine/liquidation.ts` — `LTV > LLTV` → liquidator repays debt, seizes collateral
  plus the liquidation incentive. **Purely deterministic. The AI has no input here** —
  this must be true in the code, not just in the pitch, because a judge will ask.
- `engine/liquidator.ts` — standalone bot using only the public API, exactly as a
  third party would run it
- `tachi-kit/events.ts` → `watch({vault})` for live position updates
- `scripts/demo-liquidate.ts` — scripted price drop; asserts the lender is made whole

**Exit criteria:** `pnpm demo:liquidate` closes an underwater position end to end.

## Phase 5 — Feature extraction (the real work behind the AI)

This is where credit scoring earns credibility. **No LLM in this phase** — it is a
deterministic pipeline over public data.

`ai/features.ts` extracts, per borrower x-only pubkey:

- **Vault history** — age, deposit/withdraw cadence, total lifetime volume
- **Drawdown survived** — the largest BTC price drop endured without liquidation,
  reconstructed from position history against the price series
- **Protocol history** — prior positions, repayments, times entered the liquidation
  band, times self-cured before liquidation
- **Collateral concentration** — number of vaults, distribution of size
- **Exit behavior** — any unilateral exit attempts, via `getWatchtowerReceipts`
- **Counterparty graph** — degree and clustering from `getAddressTransactions`

Every feature is a plain number with a documented derivation. Snapshot-test the
extractor against fixed ledger fixtures so scores are reproducible.

**Exit criteria:** `pnpm score <addr>` prints a complete, deterministic feature vector.

## Phase 6 — The AI layer

- `ai/schema.ts` — the output JSON Schema:
  `{score: 0-1000, tier, maxLLTV, ratePremiumBps, reasons[], redFlags[]}`
- `ai/score.ts` — Claude (`claude-opus-5`) with **tool-forced structured output**.
  **Hard clamps after the call**: `maxLLTV` is clamped into `[0.70, 0.86]` and
  `ratePremiumBps` into a fixed band, in code, unconditionally. The model cannot
  escape the band, and a test asserts it.
- `ai/store.ts` — persist every score with its full feature vector, the prompt, and
  the model's reasoning. **Replayable** — this is what makes it credible.
- `ai/copilot.ts` — position-grounded chat. Context is only that user's live position
  data plus engine-computed figures. **No free browsing, no tool access to money
  operations.** Numbers come from the engine so it cannot hallucinate a health factor.
- `ai/monitor.ts` — per-block summary of the at-risk queue for lenders. Advisory only.

**Design rule:** the AI is *underwriting input* and *explanation*. It never triggers a
liquidation, never signs a transaction, never moves a VTXO. Make that legible in the
code layout, not just the README.

**Exit criteria:** a score is produced, clamped, stored, and fully replayable from
its stored inputs.

## Phase 7 — Web app

Next.js 15 App Router + Tailwind + shadcn/ui.

1. **Markets** — list, supply/borrow APY, utilization, TVL
2. **Borrow** — deposit BTC, see the AI credit score **with reasons expanded**, borrow
   to your tier
3. **Position** — health factor, liquidation price, interest accrued, manage
4. **Lend** — supply, earn, withdraw, per-market risk breakdown
5. **Risk dashboard** — utilization curves, at-risk histogram by LTV bucket, oracle
   status, AI stress narrative, liquidation history
6. **Credit score detail** — feature vector, model reasoning, score history, and the
   clamping band shown explicitly

Every money number links to a HAT/RIP proof or a Bitcoin txid.

## Phase 8 — Unilateral exit ⭐

Same as `satusd` Phase 7. `scripts/unilateral-exit.ts`: stop the engine, print
`exitLeaf.csvBlocks` (1008), assert the exit key is the borrower's own key, mine 1008
blocks, sweep with the borrower's key alone.

**Exit criteria:** passes with the engine process killed.

## Phase 9 — Ship

README, demo video, `TACHI_NETWORK=signet` boot check, submission writeup.

---

## Testing

| Command | Scope |
|---|---|
| `pnpm test` | IRM curve, share accounting, index accrual, health factors, **AI clamp bounds**. No network. |
| `pnpm spike` | Live regtest: vault, deposit, VTXO transfer |
| `pnpm score <addr>` | Full feature vector + score + stored reasoning |
| `pnpm demo:liquidate` | Price drop → liquidation → lender whole |
| `pnpm demo:exit` | Engine stopped → 1008 blocks → borrower sweeps own BTC |

---

## Risks

| Risk | Mitigation |
|---|---|
| Blocked on `satusd`'s `tachi-kit` | Phases 2, 5, 6 need nothing from it — start there |
| AI reads as a gimmick | Replayable scores with stored feature vectors + hard clamps + provably no liquidation authority |
| LLM returns malformed output | Tool-forced JSON Schema, plus clamps applied unconditionally in code afterwards |
| Third-party VTXO locking unsupported | `collateral.ts` interface is unchanged under the 2-of-2 fallback; coordinate with the `satusd` agent |
| Share-accounting rounding bugs | Property tests: no sequence of operations may create value |
| Judges expect on-chain contracts | Lead with the honest architecture section and the exit demo |
