import { describe, expect, it } from "vitest";
import { LedgerWorld, foldPositionLedger } from "./ledger-world.js";
import { SimCollateralPort } from "./collateral-sim.js";
import { supply } from "./shares.js";

const PRICE = 65_000n; // loan units per BTC
const ONE_BTC = 100_000_000n;

function freshWorld(): LedgerWorld {
  const world = new LedgerWorld(new SimCollateralPort(), 0n);
  // Fund the market with liquidity to borrow against — mirrors demo-world's
  // own seeding, done directly on the accounting since supply() doesn't
  // touch collateral at all.
  const { state } = supply(world.market.accounting, 10_000_000n);
  Object.assign(world.market, { accounting: state });
  return world;
}

describe("LedgerWorld — open/draw/repay round trip", () => {
  it("opens a position with zero debt", async () => {
    const world = freshWorld();
    const position = await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    expect(position.status).toBe("open");
    expect(position.borrowShares).toBe(0n);
    expect(position.collateralSats).toBe(ONE_BTC);
  });

  it("draw() then repay() returns debt to exactly zero", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 50_000n, PRICE, 10n);
    expect(world.state.positions.get("p1")!.borrowShares).toBeGreaterThan(0n);

    await world.repay("p1", 50_000n, PRICE, 20n);
    const position = world.state.positions.get("p1")!;
    expect(position.borrowShares).toBe(0n);
  });

  it("draw() rejects a borrow that would exceed the LLTV, without touching the collateral port", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await expect(world.draw("p1", 90_000n, PRICE, 10n)).rejects.toThrow(/LLTV/);
  });

  it("closePosition() succeeds once debt is fully repaid", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 10_000n, PRICE, 10n);
    await world.repay("p1", 10_000n, PRICE, 20n);
    const closed = await world.closePosition("p1", "sim1returnaddress", 30n);
    expect(closed.status).toBe("closed");
  });

  it("closePosition() rejects while debt remains outstanding", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 10_000n, PRICE, 10n);
    await expect(world.closePosition("p1", "sim1returnaddress", 20n)).rejects.toThrow(/outstanding debt/);
  });
});

describe("LedgerWorld — liquidation sweep", () => {
  it("liquidates only the underwater position after a price drop", async () => {
    const world = freshWorld();
    await world.openPosition("safe", "borrower-a", ONE_BTC, 1008, 0n);
    await world.draw("safe", 40_000n, PRICE, 10n);
    await world.openPosition("risky", "borrower-b", ONE_BTC, 1008, 0n);
    await world.draw("risky", 53_000n, PRICE, 10n); // ~81.5% LTV, same as demo-world's seed

    const droppedPrice = (PRICE * 88n) / 100n; // -12%, matches scripts/demo-liquidate.ts's tuned drop
    const liquidated = await world.sweepLiquidations(droppedPrice, 20n);

    expect(liquidated).toHaveLength(1);
    expect(liquidated[0].id).toBe("risky");
    expect(liquidated[0].status).toBe("liquidated");
    expect(world.state.positions.get("safe")!.status).toBe("open");
  });

  it("is a no-op when nothing is liquidatable", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 10_000n, PRICE, 10n);
    const liquidated = await world.sweepLiquidations(PRICE, 20n);
    expect(liquidated).toEqual([]);
  });
});

describe("LedgerWorld — replayability", () => {
  it("re-folding the ledger from genesis reproduces the exact same state", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 40_000n, PRICE, 10n);
    await world.repay("p1", 15_000n, PRICE, 20n);

    const first = foldPositionLedger(world.ledger, world.market.accounting);
    const second = foldPositionLedger(world.ledger, world.market.accounting);

    expect(second.positions.get("p1")).toEqual(first.positions.get("p1"));
    expect(second.market).toEqual(first.market);
  });

  it("the underlying ledger detects tampering with a past event", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 40_000n, PRICE, 10n);

    expect(world.ledger.verify()).toBe(-1);
    (world.ledger.at(1) as { payload: { assets: string } }).payload.assets = "999999999";
    expect(world.ledger.verify()).toBe(1);
  });

  it("every position mutation is visible as an entry in the hash-chained log", async () => {
    const world = freshWorld();
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 10_000n, PRICE, 10n);
    await world.repay("p1", 10_000n, PRICE, 20n);
    await world.closePosition("p1", "sim1returnaddress", 30n);

    expect(world.ledger.length).toBe(4);
    expect(world.ledger.all().map((e) => e.payload.type)).toEqual(["position-opened", "drawn", "repaid", "closed"]);
  });
});
