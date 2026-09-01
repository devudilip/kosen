import { describe, expect, it } from "vitest";
import { SimCollateralPort } from "./collateral-sim.js";
import { shareForLiquidation } from "./health.js";
import { pct } from "./units.js";

describe("SimCollateralPort", () => {
  it("open() returns a channel with fabricated but well-shaped identifiers", async () => {
    const port = new SimCollateralPort();
    const result = await port.open({ borrowerPub: "borrower-x", amountSats: 100_000n, termBlocks: 1008 });
    expect(result.channelId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.vaultAddress).toMatch(/^sim1/);
    expect(result.fundingTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.exitTxHex.length).toBeGreaterThan(0);
  });

  it("commit() computes the share using the same formula as collateral-tachi.ts", async () => {
    const port = new SimCollateralPort();
    const { channelId } = await port.open({ borrowerPub: "borrower-x", amountSats: 300_000n, termBlocks: 1008 });
    const result = await port.commit(channelId, {
      collateralSats: 300_000n,
      debtSats: 200_000n,
      lltvWad: pct(86),
      penaltyBps: 500n,
      priceWad: 65_000n,
    });
    expect(result.n).toBe(1n);
    expect(result.shareSats).toBe(shareForLiquidation(300_000n, pct(86), 500n));
    expect(result.refundTxid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("commit() increments n on repeated calls for the same channel", async () => {
    const port = new SimCollateralPort();
    const { channelId } = await port.open({ borrowerPub: "borrower-x", amountSats: 300_000n, termBlocks: 1008 });
    const args = { collateralSats: 300_000n, debtSats: 100_000n, lltvWad: pct(86), penaltyBps: 500n, priceWad: 65_000n };
    const first = await port.commit(channelId, args);
    const second = await port.commit(channelId, args);
    expect(first.n).toBe(1n);
    expect(second.n).toBe(2n);
  });

  it("liquidate() marks the channel closed to further commits", async () => {
    const port = new SimCollateralPort();
    const { channelId } = await port.open({ borrowerPub: "borrower-x", amountSats: 300_000n, termBlocks: 1008 });
    const { txid } = await port.liquidate(channelId);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      port.commit(channelId, { collateralSats: 300_000n, debtSats: 1n, lltvWad: pct(86), penaltyBps: 500n, priceWad: 65_000n }),
    ).rejects.toThrow(/not open/);
  });

  it("close() marks the channel closed to further commits", async () => {
    const port = new SimCollateralPort();
    const { channelId } = await port.open({ borrowerPub: "borrower-x", amountSats: 300_000n, termBlocks: 1008 });
    const { txid } = await port.close(channelId, "sim1borroweraddress");
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects operations on an unknown channel", async () => {
    const port = new SimCollateralPort();
    await expect(port.liquidate("nonexistent")).rejects.toThrow(/unknown channel/);
    await expect(port.close("nonexistent", "addr")).rejects.toThrow(/unknown channel/);
    expect(() => port.watch("nonexistent", () => {})).toThrow(/unknown channel/);
  });

  it("watch() delivers commit/liquidate/close events and unsubscribes cleanly", async () => {
    const port = new SimCollateralPort();
    const { channelId } = await port.open({ borrowerPub: "borrower-x", amountSats: 300_000n, termBlocks: 1008 });

    const events: unknown[] = [];
    const unsubscribe = port.watch(channelId, (e) => events.push(e));

    await port.commit(channelId, { collateralSats: 300_000n, debtSats: 100_000n, lltvWad: pct(86), penaltyBps: 500n, priceWad: 65_000n });
    await port.liquidate(channelId);

    expect(events).toHaveLength(2);
    expect((events[0] as { event: string }).event).toBe("state-committed");
    expect((events[1] as { event: string }).event).toBe("liquidated");

    unsubscribe();
    // A second port instance/channel to confirm no further delivery after unsubscribe.
    const { channelId: channelId2 } = await port.open({ borrowerPub: "borrower-y", amountSats: 300_000n, termBlocks: 1008 });
    await port.commit(channelId2, { collateralSats: 300_000n, debtSats: 100_000n, lltvWad: pct(86), penaltyBps: 500n, priceWad: 65_000n });
    expect(events).toHaveLength(2); // unchanged — that event went to a different channel entirely
  });
});
