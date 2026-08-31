import { describe, expect, it } from "vitest";
import {
  accrueInterest,
  borrow,
  emptyMarketAccounting,
  repay,
  supply,
  withdraw,
} from "./shares.js";
import { SECONDS_PER_YEAR } from "./units.js";

describe("supply / withdraw round trip", () => {
  it("first depositor gets a 1:1-ish share price and can withdraw everything back", () => {
    let m = emptyMarketAccounting(0n);
    const { state: s1, sharesMinted } = supply(m, 1_000_000n);
    m = s1;
    expect(sharesMinted).toBeGreaterThan(0n);

    const { state: s2 } = withdraw(m, 1_000_000n);
    m = s2;
    expect(m.totalSupplyAssets).toBe(0n);
  });

  it("never lets a withdrawal exceed what was ever supplied (no value from nothing)", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 500_000n));
    expect(() => withdraw(m, 500_001n)).toThrow();
  });

  it("rejects withdrawing borrowed-out liquidity", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    ({ state: m } = borrow(m, 900_000n));
    expect(() => withdraw(m, 200_000n)).toThrow(/insufficient liquidity/);
  });
});

describe("borrow / repay round trip", () => {
  it("fully repaying zeroes out borrow accounting", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    ({ state: m } = borrow(m, 400_000n));
    ({ state: m } = repay(m, 400_000n));
    expect(m.totalBorrowAssets).toBe(0n);
    expect(m.totalBorrowShares).toBe(0n);
  });

  it("rejects borrowing more than available liquidity", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    expect(() => borrow(m, 1_000_001n)).toThrow(/insufficient liquidity/);
  });
});

describe("rounding never lets a user extract more than they put in", () => {
  it("multiple suppliers with interest accrued between deposits still can't collectively over-withdraw", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n)); // supplier A
    ({ state: m } = borrow(m, 900_000n)); // drive utilization up so interest accrues
    m = accrueInterest(m, SECONDS_PER_YEAR); // one full year passes

    const { state: afterB, sharesMinted: bShares } = supply(m, 1_000_000n); // supplier B joins post-accrual
    m = afterB;

    // Supplier B should not be able to withdraw more assets than they put in
    // merely because interest accrued before they joined.
    const bClaim = (bShares * m.totalSupplyAssets) / m.totalSupplyShares;
    expect(bClaim).toBeLessThanOrEqual(1_000_000n);
  });

  it("many small supply/withdraw cycles never mint value", () => {
    let m = emptyMarketAccounting(0n);
    let totalDeposited = 0n;
    let totalWithdrawn = 0n;

    for (let i = 0; i < 20; i++) {
      const amount = BigInt(1000 + i * 37);
      const { state } = supply(m, amount);
      m = state;
      totalDeposited += amount;
    }

    // Withdraw everything back out via the max liquidity available.
    const maxOut = m.totalSupplyAssets - m.totalBorrowAssets;
    const { state } = withdraw(m, maxOut);
    m = state;
    totalWithdrawn += maxOut;

    expect(totalWithdrawn).toBeLessThanOrEqual(totalDeposited);
    expect(m.totalSupplyShares).toBe(0n);
  });
});

describe("accrueInterest", () => {
  it("is a no-op when there is nothing borrowed", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    const after = accrueInterest(m, SECONDS_PER_YEAR);
    expect(after.totalSupplyAssets).toBe(m.totalSupplyAssets);
    expect(after.lastUpdate).toBe(SECONDS_PER_YEAR);
  });

  it("is a no-op when no time has elapsed", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    ({ state: m } = borrow(m, 500_000n));
    const after = accrueInterest(m, 0n);
    expect(after).toEqual(m);
  });

  it("increases both totalBorrowAssets and totalSupplyAssets symmetrically", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    ({ state: m } = borrow(m, 900_000n)); // 90% utilization -> at the kink
    const before = m;
    m = accrueInterest(m, SECONDS_PER_YEAR);

    const borrowIncrease = m.totalBorrowAssets - before.totalBorrowAssets;
    const supplyIncrease = m.totalSupplyAssets - before.totalSupplyAssets;
    expect(borrowIncrease).toBe(supplyIncrease);
    expect(borrowIncrease).toBeGreaterThan(0n);
  });

  it("rejects time moving backwards", () => {
    const m = emptyMarketAccounting(100n);
    expect(() => accrueInterest(m, 50n)).toThrow(/backwards/);
  });

  it("does not accrue per-position — share counts are untouched by accrual", () => {
    let m = emptyMarketAccounting(0n);
    ({ state: m } = supply(m, 1_000_000n));
    ({ state: m } = borrow(m, 500_000n));
    const sharesBefore = { supply: m.totalSupplyShares, borrow: m.totalBorrowShares };
    m = accrueInterest(m, SECONDS_PER_YEAR);
    expect(m.totalSupplyShares).toBe(sharesBefore.supply);
    expect(m.totalBorrowShares).toBe(sharesBefore.borrow);
  });
});
