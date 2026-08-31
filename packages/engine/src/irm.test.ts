import { describe, expect, it } from "vitest";
import { borrowRate, KINKED_IRM, supplyRate, utilization } from "./irm.js";
import { pct, WAD } from "./units.js";

describe("utilization", () => {
  it("is 0 with no supply", () => {
    expect(utilization(0n, 0n)).toBe(0n);
  });

  it("is 0 with no borrow", () => {
    expect(utilization(0n, 1_000_000n)).toBe(0n);
  });

  it("caps at 100% even if borrow exceeds supply bookkeeping", () => {
    expect(utilization(2_000_000n, 1_000_000n)).toBe(WAD);
  });

  it("computes the exact ratio", () => {
    expect(utilization(500_000n, 1_000_000n)).toBe(pct(50));
  });
});

describe("borrowRate — kinked curve", () => {
  it("equals base rate at 0% utilization", () => {
    expect(borrowRate(0n)).toBe(KINKED_IRM.baseRate);
  });

  it("equals base + slope1 exactly at the kink (target utilization)", () => {
    const atKink = borrowRate(KINKED_IRM.targetUtilization);
    expect(atKink).toBe(KINKED_IRM.baseRate + KINKED_IRM.slope1);
  });

  it("equals base + slope1 + slope2 at 100% utilization", () => {
    const atMax = borrowRate(WAD);
    expect(atMax).toBe(KINKED_IRM.baseRate + KINKED_IRM.slope1 + KINKED_IRM.slope2);
  });

  it("rises much faster above the kink than below it", () => {
    const belowKinkSlope = borrowRate(pct(45)) - borrowRate(0n); // half of [0, 90]
    const aboveKinkSlope = borrowRate(WAD) - borrowRate(pct(95)); // half of [90, 100]
    // slope2 (60%) is 15x slope1 (4%), so an equal-sized step above the kink
    // moves the rate far more than the same-sized step below it.
    expect(aboveKinkSlope).toBeGreaterThan(belowKinkSlope);
  });

  it("rejects utilization outside [0, WAD]", () => {
    expect(() => borrowRate(-1n)).toThrow();
    expect(() => borrowRate(WAD + 1n)).toThrow();
  });

  it("is monotonically non-decreasing across the full range", () => {
    let prev = -1n;
    for (let i = 0; i <= 100; i++) {
      const u = (WAD * BigInt(i)) / 100n;
      const rate = borrowRate(u);
      expect(rate).toBeGreaterThanOrEqual(prev);
      prev = rate;
    }
  });
});

describe("supplyRate", () => {
  it("is 0 at 0% utilization (nothing borrowed to pay interest)", () => {
    expect(supplyRate(0n)).toBe(0n);
  });

  it("is less than the borrow rate at partial utilization", () => {
    const u = pct(50);
    expect(supplyRate(u)).toBeLessThan(borrowRate(u));
  });

  it("converges toward the borrow rate as utilization approaches 100%", () => {
    expect(supplyRate(WAD)).toBe(borrowRate(WAD));
  });
});
