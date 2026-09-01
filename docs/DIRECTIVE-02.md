# Directive 02 — Kōsen (2026-09-01)

Supersedes `AGENT-BRIEF.md` where they conflict. Read `COLLATERAL-MODEL.md` first.

## What you built — reviewed

Checked on your branch `claude/analysis-and-build-6609a7` (4 commits, 129 tests green, engine+ai build clean):

**Good — keep all of it**
- Pure market core: `irm.ts`, `shares.ts` (index accounting), `health.ts`,
  `position.ts`, `liquidation.ts`, `ledger.ts`, `scenario.ts`. Solid and tested.
- `ai/`: deterministic `features.ts`, tool-forced `score.ts` with
  `applyHardClamps` as the *only* authority path, replayable `store.ts`, grounded
  `copilot.ts`. `liquidation.ts` has no import path to `ai/` — verified. This is
  exactly what the brief asked for.
- `position.ts`'s `CollateralPort` seam. Correct instinct; it is where Tachi plugs in.
- Fastify dev server + Next.js pages for all six views.

**The problem — it is a simulation**
- `packages/tachi-kit/src/index.ts` is a 12-line `throw`. `scripts/01-spike-vault.ts`
  and `scripts/unilateral-exit.ts` `exit(1)` with a comment. `server.ts` serves an
  in-memory `demo-world` with fake vault ids. **Not one byte of this touches Tachi
  or Bitcoin.** As-is it would demo as a spreadsheet with a chat panel. The bounty
  requires a BTC collateral deposit flow and on-chain verifiability.
- `demo-world.ts` positions can never be liquidated on-chain because nothing is on
  chain. Keep it as `KOSEN_MODE=sim` for offline dev; it must not be the demo.

## The new fact that changes your design

Pre-committed liquidation works on Tachi today (`COLLATERAL-MODEL.md` §0), and a
single-key borrower vault cannot secure a lender (§1). So the collateral leg of a
Kōsen position is a **joint-key (MuSig2) TAURUS vault with a pre-signed exit and a
pre-signed liquidation refund** (§3). Your `CollateralPort` maps onto it directly,
with one addition — state commits:

```ts
interface CollateralPort {
  open(args: { borrowerPub, amountSats, termBlocks }): Promise<{ channelId, vaultAddress, fundingTxid, exitTxHex }>;
  commit(channelId, { collateralSats, debtSats, lltvWad, penaltyBps, priceWad }): Promise<{ n, shareSats, refundTxid }>;
  liquidate(channelId): Promise<{ txid }>;     // broadcast latest refund — deterministic, keeper-callable
  close(channelId, toAddress): Promise<{ txid }>;
  watch(channelId, onEvent): () => void;       // subscribeVaultEvents({ vault })
}
```
`lock/unlock/seize` → `open/close/liquidate`. Every `draw`/`repay`/accrual
checkpoint calls `commit`. `liquidation.ts` stays pure; `liquidator.ts` calls
`port.liquidate` after the pure check says so.

## Next tasks, in order

1. **Get real Tachi bytes moving today.** Do not wait for satusd's `commitment.ts`.
   The satusd kit already exists (net/vault/vtxo/collateral/health) in
   `../satusd/.claude/worktrees/doc-analysis-planning-1a5f22/packages/tachi-kit`.
   Add a `KIT_SOURCE` override to `scripts/sync-kit.sh` (default stays
   `../satusd/packages/tachi-kit`), sync from that path, and make
   `scripts/01-spike-vault.ts` a real copy of satusd's `01` + `03` spikes
   (`scripts/03-spike-refund-cosign.ts` there is the reference; it imports
   `@tachibtc/*` directly plus `@satusd/tachi-kit` — alias to `@kosen/tachi-kit`).
   Acceptance: a Kōsen vault registered, a refund cosigned by 5-of-7, mined on regtest.
2. **Joint key.** `pnpm add @scure/btc-signer@2.4.1`. Coordinate with satusd on
   spike 04 (`COLLATERAL-MODEL.md` §4): whoever lands `musig.ts` first, the other
   vendors it. The §6 signatures are the contract — do not diverge names.
3. **`CollateralPort` implementation** (`engine/src/collateral-tachi.ts`) over
   `commitment.ts`; `collateral-sim.ts` wraps demo-world for `KOSEN_MODE=sim`.
4. **World → ledger.** Replace `demo-world` as the server's state with an
   append-only, hash-chained ledger of real positions (`ledger.ts` already exists —
   use it). Seed one *real* borrower on startup in dev (open a channel on regtest).
5. **Real `unilateral-exit.ts`**: engine killed → borrower broadcasts the pre-signed
   `exit_tx` after `termBlocks` (use 144 on regtest) → BTC at borrower's address.
6. **AI adapter** (`scripts/score-address.ts` → `ai/adapter-tachi.ts`): map live
   `listVaults`, `getAddressTransactions`, `subscribeVaultEvents` breach receipts, and
   the engine's position history onto `FeatureInput`. Seed the demo borrower with
   history (prior channel, one self-cure, one survived drawdown) so the score is interesting.
7. **Web**: each position shows vault address, L1 balance (via bitcoind proxy), state
   `n`, `share_n`, and the liquidation tx hash-to-be; every money number links to a
   txid or HAT proof. Add "What happens if I default" panel that literally renders
   the pre-signed refund's outputs. That is your transparency story.
8. **Stretch**: oracle-gated payout (§5). Only after 1–7 demo cleanly.

## Do not

- Do not demo `demo-world`. Sim mode is for tests and offline dev only.
- Do not implement Tachi calls inside `packages/tachi-kit` locally if satusd has
  shipped the same module — vendor. If they are behind, implement against the §6
  contract and hand it back to them.
- Do not give `ai/` any import path into `liquidation.ts`, `liquidator.ts`, or the
  collateral port. Judges will grep for it.
