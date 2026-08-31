import { describe, expect, it } from "vitest";
import { collateralValue, healthFactor, isLiquidatable, liquidationPrice, loanToValue, SATS_PER_BTC } from "./health.js";
import { pct, WAD } from "./units.js";

// 1 BTC collateral, price 100,000 satUSD-cents-equivalent-units per BTC for
// round numbers in tests (treat "loan units per BTC" as $100k/BTC here).
const ONE_BTC = SATS_PER_BTC;
const PRICE_100K = 100_000n;

describe("collateralValue", () => {
  it("values 1 BTC at the quoted price", () => {
    expect(collateralValue(ONE_BTC, PRICE_100K)).toBe(100_000n);
  });

  it("values half a BTC at half the quoted price", () => {
    expect(collateralValue(ONE_BTC / 2n, PRICE_100K)).toBe(50_000n);
  });
});

describe("loanToValue", () => {
  it("is 0 with no debt", () => {
    expect(loanToValue(0n, ONE_BTC, PRICE_100K)).toBe(0n);
  });

  it("computes the exact ratio for a partially drawn position", () => {
    // 80,000 debt against 100,000 value = 80%
    expect(loanToValue(80_000n, ONE_BTC, PRICE_100K)).toBe(pct(80));
  });

  it("is maximally unhealthy (WAD) when collateral value is 0 but debt exists", () => {
    expect(loanToValue(1n, 0n, PRICE_100K)).toBe(WAD);
  });
});

describe("healthFactor", () => {
  it("is effectively infinite with no debt", () => {
    expect(healthFactor(0n, ONE_BTC, PRICE_100K, pct(86))).toBeGreaterThan(WAD);
  });

  it("is exactly 1 WAD when ltv equals lltv", () => {
    // ltv = 86%, lltv = 86% -> health factor 1.0
    const hf = healthFactor(86_000n, ONE_BTC, PRICE_100K, pct(86));
    expect(hf).toBe(WAD);
  });

  it("is above 1 WAD when healthy (ltv < lltv)", () => {
    const hf = healthFactor(50_000n, ONE_BTC, PRICE_100K, pct(86));
    expect(hf).toBeGreaterThan(WAD);
  });

  it("is below 1 WAD when underwater (ltv > lltv)", () => {
    const hf = healthFactor(90_000n, ONE_BTC, PRICE_100K, pct(86));
    expect(hf).toBeLessThan(WAD);
  });
});

describe("isLiquidatable", () => {
  it("is false exactly at the lltv boundary (LTV > LLTV is the liquidation rule, not >=)", () => {
    expect(isLiquidatable(86_000n, ONE_BTC, PRICE_100K, pct(86))).toBe(false);
  });

  it("is true one unit past the boundary", () => {
    expect(isLiquidatable(86_001n, ONE_BTC, PRICE_100K, pct(86))).toBe(true);
  });

  it("is false for a healthy position", () => {
    expect(isLiquidatable(50_000n, ONE_BTC, PRICE_100K, pct(86))).toBe(false);
  });
});

describe("liquidationPrice", () => {
  it("is null with no debt", () => {
    expect(liquidationPrice(0n, ONE_BTC, pct(86))).toBeNull();
  });

  it("round-trips: at the computed liquidation price, LTV lands right at LLTV", () => {
    const borrowAssets = 80_000n;
    const lltv = pct(80); // chosen so 80,000 / 0.80 = 100,000 divides evenly, no rounding
    const price = liquidationPrice(borrowAssets, ONE_BTC, lltv);
    expect(price).toBe(100_000n);

    const ltvAtThatPrice = loanToValue(borrowAssets, ONE_BTC, price!);
    expect(ltvAtThatPrice).toBe(lltv);
  });

  it("round-trips within integer-rounding tolerance for a non-evenly-divisible case", () => {
    const borrowAssets = 80_000n;
    const lltv = pct(86);
    const price = liquidationPrice(borrowAssets, ONE_BTC, lltv);
    expect(price).not.toBeNull();

    const ltvAtThatPrice = loanToValue(borrowAssets, ONE_BTC, price!);
    // Allow for integer-division rounding — a few parts in 10,000 of WAD.
    const diff = ltvAtThatPrice > lltv ? ltvAtThatPrice - lltv : lltv - ltvAtThatPrice;
    expect(diff).toBeLessThan(WAD / 10_000n);
  });

  it("a price drop below the liquidation price makes the position liquidatable", () => {
    const borrowAssets = 80_000n;
    const lltv = pct(86);
    const price = liquidationPrice(borrowAssets, ONE_BTC, lltv)!;
    expect(isLiquidatable(borrowAssets, ONE_BTC, price - 1n, lltv)).toBe(true);
    expect(isLiquidatable(borrowAssets, ONE_BTC, price + 1_000n, lltv)).toBe(false);
  });
});
