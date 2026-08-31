// Deterministic "what if" math for the risk copilot (ai/copilot.ts). The
// copilot is grounded strictly in these functions — it is never allowed to
// compute a hypothetical LTV or repay amount itself, so it cannot
// hallucinate a health factor (docs/AGENT-BRIEF.md, docs/DEMO.md). This file
// has no AI dependency; it's the same health.ts math, just phrased as
// scenarios instead of as the live position state.
import { healthFactor, isLiquidatable, loanToValue, SATS_PER_BTC } from "./health.js";
import { wadMul } from "./units.js";

export interface Scenario {
  priceLoanUnitsPerBtc: bigint;
  ltv: bigint; // WAD
  healthFactor: bigint; // WAD
  liquidatable: boolean;
}

export function scenarioAtPrice(
  debtAssets: bigint,
  collateralSats: bigint,
  lltv: bigint,
  priceLoanUnitsPerBtc: bigint,
): Scenario {
  return {
    priceLoanUnitsPerBtc,
    ltv: loanToValue(debtAssets, collateralSats, priceLoanUnitsPerBtc),
    healthFactor: healthFactor(debtAssets, collateralSats, priceLoanUnitsPerBtc, lltv),
    liquidatable: isLiquidatable(debtAssets, collateralSats, priceLoanUnitsPerBtc, lltv),
  };
}

// changeBps is signed: -2000 means "BTC drops 20%".
export function scenarioAtPriceChangeBps(
  debtAssets: bigint,
  collateralSats: bigint,
  lltv: bigint,
  currentPriceLoanUnitsPerBtc: bigint,
  changeBps: bigint,
): Scenario {
  const newPrice = currentPriceLoanUnitsPerBtc + (currentPriceLoanUnitsPerBtc * changeBps) / 10_000n;
  const flooredPrice = newPrice < 0n ? 0n : newPrice;
  return scenarioAtPrice(debtAssets, collateralSats, lltv, flooredPrice);
}

// Loan-asset amount that must be repaid, at the current price, to bring LTV
// down to exactly targetLtv. Returns 0 if the position is already at or
// below the target (never suggests "borrowing more" as a negative repay).
export function repayNeededForTargetLtv(
  debtAssets: bigint,
  collateralSats: bigint,
  priceLoanUnitsPerBtc: bigint,
  targetLtv: bigint,
): bigint {
  const collateralValue = (collateralSats * priceLoanUnitsPerBtc) / SATS_PER_BTC;
  const targetDebt = wadMul(targetLtv, collateralValue);
  const needed = debtAssets - targetDebt;
  return needed < 0n ? 0n : needed;
}
