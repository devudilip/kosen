// Standalone liquidator bot logic. Deliberately uses nothing but what's
// exported from this package's public API and health.ts's math — the same
// surface a third party running their own liquidator would have. No
// privileged access to positions or markets beyond what liquidate() itself
// needs (docs/AGENT-BRIEF.md: "The liquidator bot uses only the public API").
//
// The live version (scripts/demo-liquidate.ts) wraps runLiquidationSweep with
// tachi-kit/events.ts's watch({vault}) to react to price/position updates
// instead of polling; that wiring waits on the vendored kit, but the
// decision logic below does not.
import { isLiquidatable } from "./health.js";
import { DEFAULT_LIQUIDATION_INCENTIVE_BPS, liquidate, type LiquidationResult } from "./liquidation.js";
import { debtOwed, type Position } from "./position.js";
import type { MarketAccounting } from "./shares.js";

export function findLiquidatablePositions(
  positions: Position[],
  market: MarketAccounting,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
): Position[] {
  return positions.filter(
    (p) => p.status === "open" && isLiquidatable(debtOwed(p, market), p.collateralSats, priceLoanUnitsPerBtc, lltv),
  );
}

export interface SweepResult {
  liquidated: LiquidationResult[];
  market: MarketAccounting;
}

// Liquidate every currently-underwater position in one market, in the order
// given. Each liquidation's resulting market state feeds into the next, so
// the sweep is deterministic regardless of how many positions are underwater
// at once.
export function runLiquidationSweep(
  positions: Position[],
  market: MarketAccounting,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
  now: bigint,
  incentiveBps: bigint = DEFAULT_LIQUIDATION_INCENTIVE_BPS,
): SweepResult {
  let currentMarket = market;
  const liquidated: LiquidationResult[] = [];

  for (const position of positions) {
    if (position.status !== "open") continue;
    const debt = debtOwed(position, currentMarket);
    if (!isLiquidatable(debt, position.collateralSats, priceLoanUnitsPerBtc, lltv)) continue;

    const result = liquidate(position, currentMarket, priceLoanUnitsPerBtc, lltv, incentiveBps, now);
    liquidated.push(result);
    currentMarket = result.market;
  }

  return { liquidated, market: currentMarket };
}
