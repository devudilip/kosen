import { describe, expect, it } from "vitest";
import { DEFAULT_LIQUIDATION_INCENTIVE_BPS, liquidate } from "./liquidation.js";
import { draw, openPosition } from "./position.js";
import { emptyMarketAccounting, supply } from "./shares.js";
import { SATS_PER_BTC } from "./health.js";
import { pct } from "./units.js";

const LLTV_86 = pct(86);

function setup(borrowAssets: bigint, priceAtOpen = 100_000n) {
  let market = supply(emptyMarketAccounting(0n), 1_000_000n).state;
  let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
  const d = draw(position, market, borrowAssets, priceAtOpen, LLTV_86);
  return { position: d.position, market: d.market };
}

describe("liquidate", () => {
  it("rejects liquidating a healthy position", () => {
    const { position, market } = setup(50_000n);
    expect(() => liquidate(position, market, 100_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n)).toThrow(
      /healthy/,
    );
  });

  it("liquidates an underwater position after a price drop, repaying debt in full", () => {
    const { position, market } = setup(80_000n, 100_000n);
    // price drops from 100,000 to 90,000 -> LTV = 80,000/90,000 = 88.9% > 86% LLTV
    const result = liquidate(position, market, 90_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n);

    expect(result.position.status).toBe("liquidated");
    expect(result.position.borrowShares).toBe(0n);
    expect(result.debtRepaid).toBe(80_000n);
    expect(result.market.totalBorrowAssets).toBe(0n);
  });

  it("pays the liquidator collateral worth debt + incentive, and returns the rest to the borrower", () => {
    const { position, market } = setup(80_000n, 100_000n);
    const result = liquidate(position, market, 90_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n);

    // debtWithIncentive = 80,000 * 1.05 = 84,000; at price 90,000/BTC that's
    // 84,000/90,000 BTC = 0.9333... BTC in sats.
    const expectedSeize = (84_000n * SATS_PER_BTC) / 90_000n;
    expect(result.collateralSeized).toBe(expectedSeize);
    expect(result.collateralToBorrower).toBe(SATS_PER_BTC - expectedSeize);
    expect(result.badDebt).toBe(false);
  });

  it("caps seizure at available collateral and flags bad debt when the shortfall is severe", () => {
    const { position, market } = setup(80_000n, 100_000n);
    // catastrophic crash: price falls to 60,000 -> LTV way past LLTV, and
    // debt + incentive in sats now exceeds the 1 BTC of collateral.
    const result = liquidate(position, market, 60_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n);

    expect(result.collateralSeized).toBe(SATS_PER_BTC);
    expect(result.collateralToBorrower).toBe(0n);
    expect(result.badDebt).toBe(true);
  });

  it("leaves collateral fully disbursed — nothing lingers on the liquidated position", () => {
    const { position, market } = setup(80_000n, 100_000n);
    const result = liquidate(position, market, 90_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n);
    expect(result.position.collateralSats).toBe(0n);
  });

  it("rejects liquidating an already-liquidated position", () => {
    const { position, market } = setup(80_000n, 100_000n);
    const result = liquidate(position, market, 90_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 10n);
    expect(() =>
      liquidate(result.position, result.market, 90_000n, LLTV_86, DEFAULT_LIQUIDATION_INCENTIVE_BPS, 20n),
    ).toThrow(/not open/);
  });
});

describe("liquidation.ts has no import path to ai/", () => {
  it("the module source contains no reference to @kosen/ai or ../ai", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("./liquidation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@kosen\/ai/);
    expect(source).not.toMatch(/from ["'].*\/ai\//);
  });
});
