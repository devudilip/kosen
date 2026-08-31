import { describe, expect, it } from "vitest";
import {
  createWorld,
  listPositions,
  marketView,
  riskView,
  setPrice,
  sweepLiquidations,
} from "./demo-world.js";

describe("createWorld", () => {
  it("seeds a market with two open positions, neither liquidatable at the seed price", () => {
    const world = createWorld();
    const positions = listPositions(world);
    expect(positions).toHaveLength(2);
    expect(positions.every((p) => p.status === "open")).toBe(true);
    expect(positions.every((p) => !p.isLiquidatable)).toBe(true);
  });

  it("produces a sane market view", () => {
    const world = createWorld();
    const view = marketView(world);
    expect(view.collateralAsset).toBe("BTC");
    expect(view.loanAsset).toBe("satUSD");
    expect(Number(view.utilization)).toBeGreaterThan(0);
    expect(Number(view.utilization)).toBeLessThan(1);
  });
});

describe("price shock -> risk view -> liquidation sweep", () => {
  it("a 25% price drop makes the aggressive position liquidatable and shows up in the risk view", () => {
    let world = createWorld();
    const before = riskView(world);
    expect(before.atRiskPositionIds).toEqual([]);

    world = setPrice(world, (world.priceLoanUnitsPerBtc * 75n) / 100n);
    const after = riskView(world);
    expect(after.atRiskPositionIds).toContain("pos-aggressive");
    expect(after.atRiskPositionIds).not.toContain("pos-conservative");
  });

  it("sweepLiquidations closes out the underwater position and records history", () => {
    let world = createWorld();
    world = setPrice(world, (world.priceLoanUnitsPerBtc * 75n) / 100n);
    world = sweepLiquidations(world);

    const positions = listPositions(world);
    const aggressive = positions.find((p) => p.id === "pos-aggressive")!;
    const conservative = positions.find((p) => p.id === "pos-conservative")!;
    expect(aggressive.status).toBe("liquidated");
    expect(conservative.status).toBe("open");
    expect(world.liquidationHistory).toHaveLength(1);
  });
});
