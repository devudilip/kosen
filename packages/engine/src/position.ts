import type { MarketId } from "./market.js";
import { borrow as borrowShares, repay as repayShares, type MarketAccounting } from "./shares.js";
import { isLiquidatable } from "./health.js";

// Collateral custody lives on Bitcoin via a TAURUS vault + locked VTXO
// (docs/BACKGROUND.md, docs/TACHI-API.md). This port is the only seam
// between position lifecycle logic and that network layer, so all of the
// logic below is pure and unit-testable today; scripts/sync-kit.sh will
// let engine/server.ts implement CollateralPort against the real
// @kosen/tachi-kit once satusd publishes it (docs/PLAN.md Phase 3, open
// question #2). The interface is stable either way: self-locking or the
// 2-of-2 fallback both satisfy this shape.
export interface CollateralPort {
  lock(vaultId: string, amountSats: bigint): Promise<void>;
  unlock(vaultId: string, amountSats: bigint): Promise<void>;
  seize(vaultId: string, amountSats: bigint, to: string): Promise<void>;
}

export type PositionStatus = "open" | "closed" | "liquidated";

export interface Position {
  id: string;
  marketId: MarketId;
  borrower: string; // x-only pubkey, the single user identity (docs/TACHI-API.md)
  vaultId: string;
  collateralSats: bigint;
  borrowShares: bigint;
  status: PositionStatus;
  openedAt: bigint;
  closedAt: bigint | null;
}

export function openPosition(
  id: string,
  marketId: MarketId,
  borrower: string,
  vaultId: string,
  collateralSats: bigint,
  now: bigint,
): Position {
  if (collateralSats <= 0n) throw new Error("openPosition: collateral must be positive");
  return {
    id,
    marketId,
    borrower,
    vaultId,
    collateralSats,
    borrowShares: 0n,
    status: "open",
    openedAt: now,
    closedAt: null,
  };
}

function requireOpen(position: Position): void {
  if (position.status !== "open") throw new Error(`position ${position.id} is not open (status: ${position.status})`);
}

export interface DrawResult {
  position: Position;
  market: MarketAccounting;
  borrowedAssets: bigint;
}

// Borrow more against existing collateral. Caller must have already checked
// the AI-assigned maxLLTV tier (ai/score.ts) and priced the loan; this
// function only enforces that the position remains healthy under `lltv` —
// it does not know or care where lltv came from, deterministic or AI-advised.
export function addCollateral(position: Position, amountSats: bigint): Position {
  requireOpen(position);
  if (amountSats <= 0n) throw new Error("addCollateral: amount must be positive");
  return { ...position, collateralSats: position.collateralSats + amountSats };
}

export function draw(
  position: Position,
  market: MarketAccounting,
  assets: bigint,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
): DrawResult {
  requireOpen(position);
  if (assets <= 0n) throw new Error("draw: amount must be positive");

  const { state: nextMarket, sharesMinted } = borrowShares(market, assets);
  const nextPosition: Position = { ...position, borrowShares: position.borrowShares + sharesMinted };

  const projectedDebt = debtOwed(nextPosition, nextMarket);
  if (isLiquidatable(projectedDebt, nextPosition.collateralSats, priceLoanUnitsPerBtc, lltv)) {
    throw new Error("draw: would push the position above its LLTV");
  }

  return { position: nextPosition, market: nextMarket, borrowedAssets: assets };
}

export interface RepayResult {
  position: Position;
  market: MarketAccounting;
  repaidAssets: bigint;
}

export function repay(position: Position, market: MarketAccounting, assets: bigint): RepayResult {
  requireOpen(position);
  if (assets <= 0n) throw new Error("repay: amount must be positive");

  const { state: nextMarket, sharesBurned } = repayShares(market, assets);
  if (sharesBurned > position.borrowShares) throw new Error("repay: exceeds this position's debt");

  const nextPosition: Position = { ...position, borrowShares: position.borrowShares - sharesBurned };
  return { position: nextPosition, market: nextMarket, repaidAssets: assets };
}

// Debt currently owed by a position, in loan-asset base units, read off the
// market's interest index. Never accrued per-position — see shares.ts.
export function debtOwed(position: Position, market: MarketAccounting): bigint {
  if (position.borrowShares === 0n || market.totalBorrowShares === 0n) return 0n;
  return (position.borrowShares * market.totalBorrowAssets) / market.totalBorrowShares;
}

// Close a fully repaid position and release its collateral. The caller is
// responsible for calling CollateralPort.unlock — this function only
// validates that debt is actually zero before flipping status, so collateral
// can never be released while debt remains.
export function close(position: Position, market: MarketAccounting, now: bigint): Position {
  requireOpen(position);
  if (debtOwed(position, market) !== 0n) throw new Error("close: outstanding debt must be repaid first");
  return { ...position, status: "closed", closedAt: now };
}
