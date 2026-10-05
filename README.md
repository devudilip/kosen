# Kōsen

**An isolated-market lending protocol for native Bitcoin collateral, where an AI
credit agent underwrites borrowers from their on-chain Bitcoin history — and a
deterministic engine, never the AI, decides liquidations.**

> OP_Freedom Hackathon · Institutional Bitcoin + AI tracks · Bounty #4

No wrapped BTC. No bridge. No custodian. Borrowers' collateral is a Taproot output on
Bitcoin that **they can always sweep with their own key alone** — even if this
protocol disappears entirely.

---

## Honest architecture statement

Tachi markets **SatVM** as a multi-runtime execution environment (Script, EVM, WASM,
SVM, ABCI). As of 2026-08-31, **there is no developer-facing SatVM or EVM.** The
entire public developer surface is Bitcoin Taproot vaults plus the Tachi VTXO ledger,
and Tachi's own tutorial states the architecture contains no smart contracts, EVM, or
SatVM. Full evidence in [`docs/BACKGROUND.md`](docs/BACKGROUND.md).

So Kōsen is built the way the platform actually supports today:

```
Lenders ──deposit──►  Market (supply side)  ──►  utilization ──►  IRM (kinked curve)
                            │                                          │
Borrowers ──BTC──► TAURUS vault ──► locked VTXO ──► position ◄─────────┘
                            │
                  AI credit agent ──► score ──► LLTV tier + rate premium
                            │
              deterministic risk engine ──► liquidation (never the AI)
```

- **Custody is on Bitcoin** — P2TR with a NUMS-disabled key path, a cooperative 5-of-7
  validator leaf, and an exit leaf spendable by the borrower's key alone after 1008 blocks.
- **Settlement is on the Tachi ledger** — collateral is VTXOs with `locked: true`.
- **Protocol logic runs off-chain**, deterministically, in an append-only hash-chained
  ledger whose state roots are anchored to the Tachi ledger.

## Why isolated markets

A market is a tuple: `(collateral, loan asset, LLTV, oracle, IRM)`. Each is
independent, so a bad oracle or an aggressive LLTV cannot contaminate the rest. It
maps cleanly onto Tachi's per-vault isolation, and it is far less code than a
shared-pool design with cross-asset risk.

Launch markets:

| Market | LLTV | Notes |
|---|---|---|
| BTC → satUSD | 86% | reuses the sibling stablecoin (or a mock stable) |
| BTC → BTC | 91.5% | leveraged |

| Parameter | Value |
|---|---|
| IRM | kinked curve — 90% target utilization, base 2%, slope1 4%, slope2 60% |
| Liquidation | `LTV > LLTV` → liquidator repays debt, seizes collateral + incentive |
| Interest | accrued per block via a share index |

---

## The AI layer

Real, not a chatbot bolted on. **Deterministic code owns every money decision. The AI
advises; the AI never signs.**

### 1. Credit-scoring agent
Claude (`claude-opus-5`) over features extracted from public Bitcoin and Tachi data:

- vault age, deposit/withdraw cadence, historical peak drawdown survived
- prior positions in the protocol: repayment history, times entered the liquidation
  band, times self-cured
- collateral concentration, whether a unilateral exit was ever attempted
- counterparty graph from `getAddressTransactions`

Output is **structured and tool-forced**:
`{score 0-1000, tier, maxLLTV, ratePremiumBps, reasons[], redFlags[]}`.

Two properties make this credible rather than decorative:

- **Replayable.** Every score is stored with its full feature vector and the model's
  reasoning. Click any score and see exactly what the model saw and said.
- **Hard-clamped.** The agent can only move LLTV within a hardcoded band (70–86%). It
  cannot exceed it, and it has no liquidation authority whatsoever.

### 2. Risk copilot
A chat panel grounded strictly in that user's live position data — no free browsing.
*"What happens if BTC drops 20%?"* · *"Cheapest way back above 80% LTV?"* · *"Why did
my rate go up?"* Answers are pulled from the deterministic engine, so it cannot
hallucinate a health factor.

### 3. Liquidation monitor
Each block, Claude summarizes the at-risk queue for lenders: positions near the band,
aggregate exposure, a plain-language stress-test narrative. Advisory only.

---

## Quick start

```bash
# Tachi's hosted regtest has no bitcoind attached — run one locally
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001

pnpm install
pnpm sync-kit         # vendor packages/tachi-kit from ../satusd
pnpm bootstrap
pnpm spike            # prove vault + deposit + VTXO transfer against live regtest
pnpm dev              # engine + web app
```

| Command | What it does |
|---|---|
| `pnpm test` | Vitest over the pure math — IRM curve, shares, health factors. No network. |
| `pnpm score <addr>` | Run the credit agent on an address and print the full feature vector |
| `pnpm demo:liquidate` | Scripted price drop → deterministic liquidation → lender made whole |
| `pnpm demo:exit` | **Engine stopped**, mine 1008 blocks, borrower sweeps their own BTC |

Set `ANTHROPIC_API_KEY` for the AI layer. Flip to signet with `TACHI_NETWORK=signet`.
**Demo on regtest, prove on signet.**

---

## Demo

**[▶ Watch the 2.5-minute demo](https://github.com/devudilip/kosen/blob/main/demo/kosen-demo.mp4)** · **[▶ 39-second pitch](https://github.com/devudilip/kosen/blob/main/demo/kosen-pitch-39s.mp4)** · [screenshots](demo/README.md)

[![position](demo/03-position.png)](demo/README.md)

## Docs

| Doc | Contents |
|---|---|
| [`docs/AGENT-BRIEF.md`](docs/AGENT-BRIEF.md) | **Start here.** Orientation for whoever picks this up |
| [`docs/BACKGROUND.md`](docs/BACKGROUND.md) | Tachi research, verified live-infra probes, open questions |
| [`docs/TACHI-API.md`](docs/TACHI-API.md) | SDK + RPC cheat sheet, only what's confirmed to exist |
| [`docs/PLAN.md`](docs/PLAN.md) | Phased build plan, file by file |
| [`docs/DEMO.md`](docs/DEMO.md) | The 5-minute demo script |

Sibling project: [`../satusd`](../satusd) — BTC-backed stablecoin (Bounty #2), and the
source of `packages/tachi-kit`.
Shared conventions: [`../SHARED-CONTEXT.md`](../SHARED-CONTEXT.md).
