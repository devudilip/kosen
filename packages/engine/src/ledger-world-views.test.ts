import { describe, expect, it } from "vitest";
import { LedgerWorld } from "./ledger-world.js";
import { SimCollateralPort } from "./collateral-sim.js";
import { supply } from "./shares.js";
import { ledgerMarketView, ledgerPositionView, ledgerRiskView, listLedgerPositions } from "./ledger-world-views.js";

const PRICE = 65_000n;
const ONE_BTC = 100_000_000n;

async function freshWorld(): Promise<LedgerWorld> {
  const world = new LedgerWorld(new SimCollateralPort(), 0n);
  const { state } = supply(world.market.accounting, 10_000_000n);
  Object.assign(world.market, { accounting: state });
  return world;
}

describe("ledgerMarketView", () => {
  it("reflects live accounting, not the genesis snapshot", async () => {
    const world = await freshWorld();
    const view = ledgerMarketView(world);
    expect(view.totalSupplyAssets).toBe("10000000");
    expect(view.id).toBe(world.market.id);
  });
});

describe("ledgerPositionView", () => {
  it("returns undefined for an unknown position", async () => {
    const world = await freshWorld();
    const view = await ledgerPositionView(world, "nonexistent", PRICE, { collateralPort: new SimCollateralPort() });
    expect(view).toBeUndefined();
  });

  it("channel is null before any commit()", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);

    const view = await ledgerPositionView(world, "p1", PRICE, { collateralPort: port });
    expect(view?.channel?.latestState).toBeNull();
    expect(view?.channel?.termBlocks).toBe(1008);
  });

  it("channel.latestState carries the 'what happens if I default' figures after a draw", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);
    await world.draw("p1", 40_000n, PRICE, 10n);

    const view = await ledgerPositionView(world, "p1", PRICE, { collateralPort: port });
    expect(view?.channel?.latestState?.n).toBe("1");
    expect(view?.channel?.latestState?.refundTxid).toMatch(/^[0-9a-f]{64}$/);
    const share = BigInt(view!.channel!.latestState!.shareSats);
    const userValue = BigInt(view!.channel!.latestState!.userValueSats);
    expect(share + userValue).toBe(ONE_BTC); // the two payouts account for the full collateral
  });

  it("reads L1 balance via the supplied reader and degrades to null if it throws", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("p1", "borrower-x", ONE_BTC, 1008, 0n);

    const okView = await ledgerPositionView(world, "p1", PRICE, {
      collateralPort: port,
      readL1BalanceSats: async () => ONE_BTC,
    });
    expect(okView?.channel?.l1BalanceSats).toBe(ONE_BTC.toString());

    const failingView = await ledgerPositionView(world, "p1", PRICE, {
      collateralPort: port,
      readL1BalanceSats: async () => {
        throw new Error("rpc unreachable");
      },
    });
    expect(failingView?.channel?.l1BalanceSats).toBeNull();
  });
});

describe("listLedgerPositions", () => {
  it("lists every open position with its view", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("p1", "borrower-a", ONE_BTC, 1008, 0n);
    await world.openPosition("p2", "borrower-b", ONE_BTC, 1008, 0n);

    const views = await listLedgerPositions(world, PRICE, { collateralPort: port });
    expect(views.map((v) => v.id).sort()).toEqual(["p1", "p2"]);
  });
});

describe("ledgerRiskView", () => {
  it("flags only the underwater position after a price drop", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("safe", "borrower-a", ONE_BTC, 1008, 0n);
    await world.draw("safe", 40_000n, PRICE, 10n);
    await world.openPosition("risky", "borrower-b", ONE_BTC, 1008, 0n);
    await world.draw("risky", 53_000n, PRICE, 10n);

    const droppedPrice = (PRICE * 88n) / 100n;
    const view = ledgerRiskView(world, droppedPrice);
    expect(view.atRiskPositionIds).toEqual(["risky"]);
  });

  it("counts liquidations from the ledger itself", async () => {
    const port = new SimCollateralPort();
    const world = new LedgerWorld(port, 0n);
    Object.assign(world.market, { accounting: supply(world.market.accounting, 10_000_000n).state });
    await world.openPosition("risky", "borrower-b", ONE_BTC, 1008, 0n);
    await world.draw("risky", 53_000n, PRICE, 10n);
    await world.sweepLiquidations((PRICE * 88n) / 100n, 20n);

    const view = ledgerRiskView(world, (PRICE * 88n) / 100n);
    expect(view.liquidationHistoryCount).toBe(1);
  });
});
