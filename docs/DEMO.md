# Kōsen — 5-Minute Demo Script

Run on **regtest** so blocks can be mined on demand. Keep a signet terminal ready.

**Two things to land:** the AI is *real* (replayable, clamped, powerless over money),
and the borrower's Bitcoin was never ours.

---

### 0:00 — Frame it (20s)

> "Kōsen is a lending market for native Bitcoin collateral. An AI agent underwrites
> borrowers from their on-chain history — but the AI never decides a liquidation, and
> I'll show you why that distinction matters."

### 0:20 — Supply side (30s)

- Lender supplies stable liquidity to the **BTC → satUSD** market
- Show APY moving with utilization along the kinked IRM curve
- Point out that markets are **isolated** — a bad oracle in one cannot touch another

### 0:50 — Native BTC collateral (40s)

- Borrower deposits 1 BTC into their TAURUS vault → show the **P2TR address on
  Bitcoin regtest**
- VTXO appears with **`locked: true`**

> "Nothing wrapped, nothing bridged. That's a Taproot output on Bitcoin, and the
> borrower holds an exit leaf against it the entire time."

### 1:30 — ⭐ AI credit agent, live on stage (80s)

This is the AI-track beat. Run it live; do not show a cached result.

- Show the **feature vector** first — vault age, deposit cadence, largest drawdown
  survived, prior repayments, times self-cured, counterparty degree. All derived
  deterministically from public Bitcoin and Tachi RPC.
- Run the agent → structured output: `score`, `tier`, `maxLLTV`, `ratePremiumBps`,
  `reasons[]`, `redFlags[]`
- Open the **score detail** page: the exact features the model saw, its reasoning,
  and **the hardcoded clamp band (70–86%)** it was constrained into

> "Two things make this real rather than decorative. Every score is replayable — you
> can see exactly what the model saw and what it said. And it's hard-clamped: it can
> move the LLTV inside a band and nothing else. It cannot liquidate anyone. It cannot
> sign anything."

### 2:50 — Borrow (30s)

- Borrow at the assigned LLTV → position opens
- Health factor, liquidation price, and the rate with its AI premium broken out

### 3:20 — Risk copilot (40s)

- Ask: **"What happens if BTC drops 30%?"** → it answers with the exact liquidation
  price computed by the deterministic engine
- Ask: **"Cheapest way back above 80% LTV?"** → a concrete number

> "It's grounded in engine-computed figures, not free-form generation. It can't
> hallucinate your health factor because it isn't the thing calculating it."

### 4:00 — Liquidation (50s)

- Drop the price → **risk dashboard** lights up: at-risk histogram by LTV bucket,
  aggregate exposure, the AI's plain-language stress narrative for lenders
- The **deterministic** liquidator fires — a separate process on the public API
- Lender is made whole; show the accounting

> "Notice the AI narrated this. It didn't decide it. The liquidation rule is
> deterministic and auditable, and that's deliberate."

### 4:50 — ⭐ Unilateral exit (50s) — *the closer*

1. Repay a healthy position → collateral VTXOs unlock
2. **Kill the engine process on stage**
3. `pnpm demo:exit`: prints `exitLeaf.csvBlocks` → **1008**; asserts the exit key is
   the **borrower's own key**; mine 1008 blocks; sweep with that key alone
4. BTC lands in the borrower's own wallet

> "The lending protocol is dead and the borrower still has their Bitcoin. No custodian
> ever held it."

### 5:40 — Close (20s)

- Flip to `TACHI_NETWORK=signet` against `tachi-signet-1`
- State the architecture honestly: no developer-facing SatVM or EVM exists on Tachi
  today, so protocol logic runs off-chain and deterministically with Bitcoin-anchored
  proofs — while custody stays on Bitcoin throughout.

---

## Pre-flight

- [ ] `bitcoind -regtest` running; wallet funded; 101+ blocks mined
- [ ] `pnpm spike` passes
- [ ] `pnpm test` green — **including the AI clamp-bound tests**
- [ ] `ANTHROPIC_API_KEY` set; `pnpm score <addr>` rehearsed on the demo borrower
- [ ] A borrower address with *interesting* history seeded — a thin score is a boring
      demo. Seed prior positions, a self-cure, and a survived drawdown in advance.
- [ ] `pnpm demo:liquidate` rehearsed
- [ ] `pnpm demo:exit` **rehearsed with the engine actually killed**
- [ ] 1008 blocks pre-mined to ~1000; mine the last few live
- [ ] Copilot questions rehearsed with known-good answers

## If something breaks

- **Anthropic API down or slow** → show a stored replay from `ai/store.ts`. Say
  plainly that it is a replay. The replayability *is* the feature, so this degrades
  gracefully.
- **Validators down / cooperative path fails** → pivot to the exit demo; it needs no
  validators.
- **Never** claim a component works if it does not. The honest-architecture framing is
  the pitch; one overstatement costs more than any missing feature.
