import { describe, expect, it } from "vitest";
import { repayNeededForTargetLtv, scenarioAtPrice, scenarioAtPriceChangeBps } from "./scenario.js";
import { SATS_PER_BTC } from "./health.js";
import { pct, WAD } from "./units.js";

const LLTV_86 = pct(86);
const ONE_BTC = SATS_PER_BTC;
const PRICE = 65_000n; // loan units per BTC

describe("scenarioAtPrice", () => {
  it("reports the same numbers health.ts would for the given price", () => {
    const s = scenarioAtPrice(50_000n, ONE_BTC, LLTV_86, PRICE);
    expect(s.priceLoanUnitsPerBtc).toBe(PRICE);
    expect(s.ltv).toBeGreaterThan(0n);
    expect(s.liquidatable).toBe(false);
  });

  it("flags liquidatable once LTV exceeds LLTV", () => {
    const s = scenarioAtPrice(60_000n, ONE_BTC, LLTV_86, 65_000n);
    // 60,000/65,000 = 92.3% > 86%
    expect(s.liquidatable).toBe(true);
    expect(s.healthFactor).toBeLessThan(WAD);
  });
});

describe("scenarioAtPriceChangeBps — 'what if BTC drops 30%?'", () => {
  it("computes the exact liquidation outcome for a 30% drop, matching the demo script's framing", () => {
    // debt 53,000 at 65,000/BTC -> ~81.5% LTV, healthy; -30% -> price 45,500
    const s = scenarioAtPriceChangeBps(53_000n, ONE_BTC, LLTV_86, PRICE, -3000n);
    expect(s.priceLoanUnitsPerBtc).toBe(45_500n);
    // 53,000 / 45,500 = 116.5% > 86% -> liquidatable
    expect(s.liquidatable).toBe(true);
  });

  it("a positive changeBps models a price increase", () => {
    const s = scenarioAtPriceChangeBps(53_000n, ONE_BTC, LLTV_86, PRICE, 1000n);
    expect(s.priceLoanUnitsPerBtc).toBe(71_500n);
    expect(s.liquidatable).toBe(false);
  });

  it("never produces a negative price even for a >100% crash", () => {
    const s = scenarioAtPriceChangeBps(53_000n, ONE_BTC, LLTV_86, PRICE, -15_000n);
    expect(s.priceLoanUnitsPerBtc).toBe(0n);
    expect(s.liquidatable).toBe(true);
  });
});

describe("repayNeededForTargetLtv — 'cheapest way back above 80% LTV?'", () => {
  it("computes the exact repay amount to reach the target LTV", () => {
    // collateral value = 65,000; target 80% -> target debt 52,000; currently 60,000 debt -> repay 8,000
    const repay = repayNeededForTargetLtv(60_000n, ONE_BTC, PRICE, pct(80));
    expect(repay).toBe(8_000n);
  });

  it("is 0 when already at or below the target", () => {
    expect(repayNeededForTargetLtv(40_000n, ONE_BTC, PRICE, pct(80))).toBe(0n);
    expect(repayNeededForTargetLtv(52_000n, ONE_BTC, PRICE, pct(80))).toBe(0n);
  });

  it("round-trips: repaying the suggested amount lands exactly on the target LTV", () => {
    const debt = 60_000n;
    const target = pct(80);
    const repay = repayNeededForTargetLtv(debt, ONE_BTC, PRICE, target);
    const afterDebt = debt - repay;
    const ltvAfter = (afterDebt * WAD) / PRICE; // collateral value == PRICE for 1 BTC
    expect(ltvAfter).toBe(target);
  });
});
