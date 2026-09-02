import { describe, expect, it } from "vitest";
import { findLiquidatablePositions, runLiquidationSweep } from "./liquidator.js";
import { draw, openPosition } from "./position.js";
import { emptyMarketAccounting, supply } from "./shares.js";
import { SATS_PER_BTC } from "./health.js";
import { pct } from "./units.js";

const LLTV_86 = pct(86);

function openAt(id: string, borrowAssets: bigint, market: ReturnType<typeof emptyMarketAccounting>) {
  const position = openPosition(id, "m1", `borrower-${id}`, `vault-${id}`, SATS_PER_BTC, 0n);
  return draw(position, market, borrowAssets, 100_000n, LLTV_86);
}

function twoPositionsOneUnderwater() {
  let market = supply(emptyMarketAccounting(0n), 10_000_000n).state;

  const a = openAt("a", 40_000n, market); // conservative, stays healthy after a price drop
  market = a.market;
  const b = openAt("b", 80_000n, market); // aggressive, underwater after the same drop
  market = b.market;

  return { positions: [a.position, b.position], market };
}

describe("findLiquidatablePositions", () => {
  it("finds only the underwater position after a price drop, leaving the healthy one alone", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const droppedPrice = 90_000n; // a: 40k/90k=44% fine; b: 80k/90k=88.9% underwater
    const found = findLiquidatablePositions(positions, market, droppedPrice, LLTV_86);
    expect(found.map((p) => p.id)).toEqual(["b"]);
  });

  it("finds nothing when all positions are healthy", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const found = findLiquidatablePositions(positions, market, 100_000n, LLTV_86);
    expect(found).toEqual([]);
  });
});

describe("runLiquidationSweep", () => {
  it("liquidates only the underwater position and leaves the healthy one untouched", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const { liquidated, market: finalMarket } = runLiquidationSweep(positions, market, 90_000n, LLTV_86, 500n);

    expect(liquidated).toHaveLength(1);
    expect(liquidated[0].position.id).toBe("b");
    expect(liquidated[0].position.status).toBe("liquidated");
    // position a's 40,000 debt is still outstanding in market accounting
    expect(finalMarket.totalBorrowAssets).toBe(40_000n);
  });

  it("makes the lender whole: seized collateral plus surviving debt covers what was lent", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const { liquidated } = runLiquidationSweep(positions, market, 90_000n, LLTV_86, 500n);
    expect(liquidated[0].debtRepaid).toBe(80_000n);
    expect(liquidated[0].badDebt).toBe(false);
  });

  it("is a no-op when nothing is liquidatable", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const { liquidated, market: finalMarket } = runLiquidationSweep(positions, market, 100_000n, LLTV_86, 500n);
    expect(liquidated).toEqual([]);
    expect(finalMarket).toEqual(market);
  });

  it("skips already-closed/liquidated positions", () => {
    const { positions, market } = twoPositionsOneUnderwater();
    const first = runLiquidationSweep(positions, market, 90_000n, LLTV_86, 500n);
    const second = runLiquidationSweep(
      [first.liquidated[0].position, positions[0]],
      first.market,
      90_000n,
      LLTV_86,
      600n,
    );
    expect(second.liquidated).toEqual([]);
  });
});
