import { describe, expect, it } from "vitest";
import { addCollateral, close, debtOwed, draw, openPosition, repay } from "./position.js";
import { emptyMarketAccounting, supply } from "./shares.js";
import { SATS_PER_BTC } from "./health.js";
import { pct } from "./units.js";

const PRICE_100K = 100_000n; // loan units per BTC
const LLTV_86 = pct(86);

function fundedMarket() {
  const { state } = supply(emptyMarketAccounting(0n), 1_000_000n);
  return state;
}

describe("openPosition", () => {
  it("opens with zero debt", () => {
    const p = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    expect(p.status).toBe("open");
    expect(p.borrowShares).toBe(0n);
  });

  it("rejects non-positive collateral", () => {
    expect(() => openPosition("p1", "m1", "borrower-x", "vault-1", 0n, 0n)).toThrow();
  });
});

describe("borrow -> accrue -> repay round-trip", () => {
  it("fully repaying returns debt to exactly zero", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);

    const drawResult = draw(position, market, 50_000n, PRICE_100K, LLTV_86);
    position = drawResult.position;
    market = drawResult.market;
    expect(debtOwed(position, market)).toBe(50_000n);

    const repayResult = repay(position, market, 50_000n);
    position = repayResult.position;
    market = repayResult.market;
    expect(debtOwed(position, market)).toBe(0n);
  });

  it("close() succeeds once debt is zero and collateral remains untouched (unlock is the caller's job)", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    const d = draw(position, market, 10_000n, PRICE_100K, LLTV_86);
    position = d.position;
    market = d.market;
    const r = repay(position, market, 10_000n);
    position = r.position;
    market = r.market;

    const closed = close(position, market, 500n);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe(500n);
    expect(closed.collateralSats).toBe(SATS_PER_BTC);
  });

  it("close() rejects while debt remains outstanding", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    const d = draw(position, market, 10_000n, PRICE_100K, LLTV_86);
    position = d.position;
    market = d.market;

    expect(() => close(position, market, 500n)).toThrow(/outstanding debt/);
  });
});

describe("draw — LLTV enforcement", () => {
  it("allows drawing up to just under the LLTV", () => {
    const market = fundedMarket();
    const position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    // value = 100,000; 86% LLTV -> max debt 86,000
    expect(() => draw(position, market, 85_000n, PRICE_100K, LLTV_86)).not.toThrow();
  });

  it("rejects a draw that would push LTV past the LLTV", () => {
    const market = fundedMarket();
    const position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    expect(() => draw(position, market, 90_000n, PRICE_100K, LLTV_86)).toThrow(/LLTV/);
  });

  it("rejects drawing on a closed position", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    position = close(position, market, 1n);
    expect(() => draw(position, market, 1_000n, PRICE_100K, LLTV_86)).toThrow(/not open/);
  });
});

describe("repay — cannot repay more than owed", () => {
  it("rejects repaying more than the market's total debt", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    const d = draw(position, market, 10_000n, PRICE_100K, LLTV_86);
    position = d.position;
    market = d.market;

    expect(() => repay(position, market, 10_001n)).toThrow(/exceeds total borrow shares/);
  });

  it("rejects a position repaying more than its own share of a multi-borrower market's debt", () => {
    let market = fundedMarket();
    let positionA = openPosition("a", "m1", "borrower-a", "vault-a", SATS_PER_BTC, 0n);
    let positionB = openPosition("b", "m1", "borrower-b", "vault-b", SATS_PER_BTC, 0n);

    const drawA = draw(positionA, market, 10_000n, PRICE_100K, LLTV_86);
    positionA = drawA.position;
    market = drawA.market;
    const drawB = draw(positionB, market, 50_000n, PRICE_100K, LLTV_86);
    positionB = drawB.position;
    market = drawB.market;

    // Market has 60,000 total debt, so this amount doesn't trip the
    // market-wide share check — but it's more than position A's own 10,000.
    expect(() => repay(positionA, market, 15_000n)).toThrow(/exceeds this position's debt/);
  });
});

describe("addCollateral", () => {
  it("increases collateralSats and improves headroom for further borrowing", () => {
    let market = fundedMarket();
    let position = openPosition("p1", "m1", "borrower-x", "vault-1", SATS_PER_BTC, 0n);
    const d = draw(position, market, 85_000n, PRICE_100K, LLTV_86); // near max at 1 BTC
    position = d.position;
    market = d.market;

    position = addCollateral(position, SATS_PER_BTC); // now 2 BTC, way under LLTV
    expect(() => draw(position, market, 1_000n, PRICE_100K, LLTV_86)).not.toThrow();
  });
});
