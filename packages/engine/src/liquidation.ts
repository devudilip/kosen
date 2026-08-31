// Deterministic liquidation. THIS FILE HAS NO IMPORT PATH TO ai/, AND NEVER
// SHOULD — the AI advises on underwriting (ai/score.ts) and narrates risk
// (ai/monitor.ts), but has zero authority here. `LTV > LLTV` is the entire
// rule; a liquidator repays the debt and seizes collateral plus an
// incentive. That is the whole file. (docs/AGENT-BRIEF.md, "The AI rule".)
import { SATS_PER_BTC, isLiquidatable } from "./health.js";
import { debtOwed, type Position } from "./position.js";
import { repay as repayShares, type MarketAccounting } from "./shares.js";

export const DEFAULT_LIQUIDATION_INCENTIVE_BPS = 500n; // 5% bonus collateral to the liquidator

export interface LiquidationResult {
  position: Position; // status "liquidated", collateral fully disbursed
  market: MarketAccounting;
  debtRepaid: bigint;
  collateralSeized: bigint; // sats paid to the liquidator (includes incentive)
  collateralToBorrower: bigint; // sats returned to the borrower, if any survives the seizure
  badDebt: boolean; // true if the seized collateral could not fully cover debt + incentive
}

// Liquidate a single underwater position. The liquidator repays the full
// outstanding debt and receives collateral worth that debt plus an
// incentive, in sats, priced at `priceLoanUnitsPerBtc`. Throws if the
// position is not actually liquidatable — this function does not decide
// *whether* to liquidate, only *how*, given that the LTV check already
// passed.
export function liquidate(
  position: Position,
  market: MarketAccounting,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
  incentiveBps: bigint = DEFAULT_LIQUIDATION_INCENTIVE_BPS,
  now: bigint,
): LiquidationResult {
  if (position.status !== "open") throw new Error(`liquidate: position ${position.id} is not open`);

  const debt = debtOwed(position, market);
  if (!isLiquidatable(debt, position.collateralSats, priceLoanUnitsPerBtc, lltv)) {
    throw new Error(`liquidate: position ${position.id} is healthy (LTV <= LLTV)`);
  }

  const { state: nextMarket, sharesBurned } = repayShares(market, debt);
  if (sharesBurned !== position.borrowShares) {
    throw new Error("liquidate: share accounting mismatch — full debt repay must burn all of this position's shares");
  }

  const debtWithIncentive = (debt * (10_000n + incentiveBps)) / 10_000n;
  const seizeRaw = (debtWithIncentive * SATS_PER_BTC) / priceLoanUnitsPerBtc;
  const badDebt = seizeRaw > position.collateralSats;
  const collateralSeized = badDebt ? position.collateralSats : seizeRaw;
  const collateralToBorrower = position.collateralSats - collateralSeized;

  const nextPosition: Position = {
    ...position,
    borrowShares: 0n,
    collateralSats: 0n,
    status: "liquidated",
    closedAt: now,
  };

  return {
    position: nextPosition,
    market: nextMarket,
    debtRepaid: debt,
    collateralSeized,
    collateralToBorrower,
    badDebt,
  };
}
