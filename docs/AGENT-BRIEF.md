# Agent Brief — Kōsen

You are building **Kōsen**, an isolated-market lending protocol for native BTC
collateral with an AI credit layer, for the Tachi OP_Freedom Hackathon
(Institutional Bitcoin + AI tracks, **Bounty #4**).

This repo is **self-contained**. A second agent is independently building
[`../satusd`](../../satusd) (Bounty #2, stablecoin). One dependency links you: they own
`packages/tachi-kit`, which you **vendor** via `pnpm sync-kit`. Do not edit your local
copy — request changes upstream. Contract in
[`../../SHARED-CONTEXT.md`](../../SHARED-CONTEXT.md).

## Read in this order

1. [`BACKGROUND.md`](BACKGROUND.md) — **mandatory.** Tachi research and verified
   live-infrastructure probes. Contains the finding that dictates the architecture.
2. [`TACHI-API.md`](TACHI-API.md) — SDK/RPC cheat sheet. Only what is confirmed to exist.
3. [`PLAN.md`](PLAN.md) — phased build plan.
4. [`DEMO.md`](DEMO.md) — read early; it tells you what actually matters.
5. [`../README.md`](../README.md) — the product framing, already written.

## The one thing to internalize

**Tachi has no developer-facing SatVM or EVM.** Do not look for a chain ID, a Solidity
path, or an asset-issuance call — none exist, and the docs confirm it. Protocol logic
runs **off-chain and deterministically**; custody stays on Bitcoin in TAURUS Taproot
vaults; VTXOs with `locked: true` are the collateral primitive; HAT/RIP proofs make it
verifiable. The README states this plainly, deliberately.

## If `../satusd` isn't ready yet

**Start with Phases 2, 5 and 6** — market math, the IRM, share accounting, and the
feature-extraction pipeline need nothing from `tachi-kit`. That is a lot of the
highest-value work. Vendor the kit when `satusd` reaches its Phase 2.

## The AI rule — the thing judges will probe

**Deterministic code owns every money decision. The AI advises; the AI never signs.**

Three properties must be true *in the code*, not just in the pitch:

1. **Replayable** — every score is stored with its full feature vector, the prompt,
   and the model's reasoning. A judge can click a score and see exactly what the model
   saw and said.
2. **Hard-clamped** — after the model returns, `maxLLTV` is clamped into `[0.70, 0.86]`
   and the rate premium into a fixed band, unconditionally, in code. A unit test
   asserts the model cannot escape it.
3. **Powerless over liquidations** — `engine/liquidation.ts` has no import path to
   `ai/`. Make that legible in the file layout; someone will check.

The feature extractor (Phase 5) is deterministic and LLM-free. It is where the
credibility actually comes from — the model is reasoning over real numbers derived
from public Bitcoin and Tachi data, not vibes.

## Rules

- No wrapped BTC, no bridge, no custodian. Ever.
- Every money number in the UI links to a HAT/RIP proof or a Bitcoin txid.
- Money math is `bigint` sats. No floats anywhere near a balance.
- Share accounting uses a per-block interest **index** — never accrue per-position.
  Property-test that no sequence of operations creates value from nothing.
- The liquidator bot uses only the public API — no privileged access.
- Report honestly. If something does not work, say so in the README.

## Two open questions

Ask the Tachi team early: Telegram `@tachi_btc` / `team@tachibtc.com`.

**Q1 — Is there an unpublished SatVM/EVM endpoint for hackathon participants?**
If yes, stop and escalate.

**Q2 — Does VTXO `locked` allow *third-party* escrow, or only self-locking?**
The `satusd` agent resolves this in their Phase 2 — **check with them before building
deep on it.** Under the fallback (2-of-2 protocol/user vault) the `collateral.ts`
interface is unchanged, only its internals differ, so you are not blocked either way.

## First commands

```bash
bitcoind -regtest -daemon -rpcuser=tachi -rpcpassword=tachi \
  -rpcport=18443 -fallbackfee=0.0001
pnpm install
pnpm sync-kit     # vendor tachi-kit from ../satusd (skip if not ready — see above)
pnpm bootstrap
pnpm spike
```

Set `ANTHROPIC_API_KEY` before Phase 6. Use `claude-opus-5` with tool-forced
structured output.

## If you get stuck

- SDK behaves unexpectedly → read `node_modules/@tachibtc/*/dist/index.d.ts`. The npm
  packages are the real spec; the docs site is thinner.
- Route 404s → camelCase with a `tachi_` prefix (`tachi_listVtxos`, not `tachi_vtxos`).
- Regtest bitcoind proxy 404s → expected; use your local node.
- Nonce errors → nonces are sequential per account; serialize them.
- Thin credit scores → seed the demo borrower with real history (prior positions, a
  self-cure, a survived drawdown). A borrower with no history makes a boring demo.
