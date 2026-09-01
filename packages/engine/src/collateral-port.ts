// The seam between position lifecycle logic (position.ts) and Bitcoin
// custody. Supersedes the earlier lock/unlock/seize sketch: docs/
// COLLATERAL-MODEL.md §1 found that a single-key vault can't secure a
// lender, so custody is a MuSig2 joint vault with a pre-signed exit and a
// pre-signed liquidation refund per open position (a "channel"), not a bare
// lock flag (docs/DIRECTIVE-02.md, Task 2-3).
//
// Two implementations satisfy this interface:
//   collateral-tachi.ts  — real, against @kosen/tachi-kit's commitment.ts
//                           primitives (KOSEN_MODE=tachi, the default)
//   collateral-sim.ts    — wraps engine/demo-world.ts, no network
//                           (KOSEN_MODE=sim, for offline dev and tests)
export interface OpenChannelArgs {
  readonly borrowerPub: string; // x-only pubkey, hex — the single user identity
  readonly amountSats: bigint;
  readonly termBlocks: number; // also the exit leaf's CSV delay — "term = CSV" (COLLATERAL-MODEL.md §3)
}

export interface OpenChannelResult {
  readonly channelId: string;
  readonly vaultAddress: string;
  readonly fundingTxid: string;
  /** Fully signed, ready to broadcast unilaterally once termBlocks matures. Hand this to the borrower before releasing any loan asset. */
  readonly exitTxHex: string;
}

export interface CommitStateArgs {
  readonly collateralSats: bigint;
  readonly debtSats: bigint; // loan-asset units currently owed
  readonly lltvWad: bigint; // WAD fraction (see engine/units.ts), e.g. pct(86)
  readonly penaltyBps: bigint;
  readonly priceWad: bigint; // loan-asset units per BTC, engine/health.ts's priceLoanUnitsPerBtc convention
}

export interface CommitStateResult {
  readonly n: bigint; // monotonically increasing per channel
  readonly shareSats: bigint; // what the protocol's refund output would pay out
  readonly refundTxid: string; // the (unbroadcast) refund transaction's own txid — an audit trail, not a confirmation
}

export interface CollateralPort {
  open(args: OpenChannelArgs): Promise<OpenChannelResult>;
  /** Every borrow/repay/add-collateral/accrual checkpoint. Held, never broadcast unless liquidate() is actually called. */
  commit(channelId: string, args: CommitStateArgs): Promise<CommitStateResult>;
  /** Broadcast the latest committed refund. Deterministic, keeper-callable — engine/liquidator.ts is the only caller. */
  liquidate(channelId: string): Promise<{ txid: string }>;
  close(channelId: string, toAddress: string): Promise<{ txid: string }>;
  /** Returns an unsubscribe function. */
  watch(channelId: string, onEvent: (event: unknown) => void): () => void;
}
