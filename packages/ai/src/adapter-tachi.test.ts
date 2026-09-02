import { describe, expect, it } from "vitest";
import { positionLedgerToFeatureSources, type PositionLedgerEventLike } from "./adapter-tachi.js";

const BORROWER = "borrower-xonly-abc";

describe("positionLedgerToFeatureSources", () => {
  it("returns empty arrays for a borrower with no ledger history", () => {
    const { vaultEvents, positions } = positionLedgerToFeatureSources([], BORROWER, 1000n);
    expect(vaultEvents).toEqual([]);
    expect(positions).toEqual([]);
  });

  it("ignores events belonging to a different borrower", () => {
    const events: PositionLedgerEventLike[] = [
      {
        type: "position-opened",
        positionId: "p-other",
        borrower: "someone-else",
        vaultAddress: "vault-other",
        collateralSats: "100000",
        timestamp: "0",
      },
    ];
    const { vaultEvents, positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);
    expect(vaultEvents).toEqual([]);
    expect(positions).toEqual([]);
  });

  it("maps a position-opened event into a deposit vaultEvent and an 'open' position record", () => {
    const events: PositionLedgerEventLike[] = [
      {
        type: "position-opened",
        positionId: "p1",
        borrower: BORROWER,
        vaultAddress: "bcrt1pvault1",
        collateralSats: "100000000",
        timestamp: "500",
      },
    ];
    const { vaultEvents, positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);

    expect(vaultEvents).toEqual([{ type: "deposit", vaultId: "bcrt1pvault1", amountSats: 100_000_000n, timestamp: 500n }]);
    expect(positions).toEqual([
      { vaultId: "bcrt1pvault1", openedAt: 500n, closedAt: null, outcome: "open", enteredLiquidationBandCount: 0, selfCured: false },
    ]);
  });

  it("marks a position 'repaid' when it closes without ever being liquidated", () => {
    const events: PositionLedgerEventLike[] = [
      { type: "position-opened", positionId: "p1", borrower: BORROWER, vaultAddress: "v1", collateralSats: "100000", timestamp: "0" },
      { type: "drawn", positionId: "p1" },
      { type: "repaid", positionId: "p1" },
      { type: "closed", positionId: "p1", timestamp: "100" },
    ];
    const { positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);
    expect(positions).toEqual([
      { vaultId: "v1", openedAt: 0n, closedAt: 100n, outcome: "repaid", enteredLiquidationBandCount: 0, selfCured: false },
    ]);
  });

  it("marks a position 'liquidated', not 'repaid', once a liquidated event has occurred", () => {
    const events: PositionLedgerEventLike[] = [
      { type: "position-opened", positionId: "p1", borrower: BORROWER, vaultAddress: "v1", collateralSats: "100000", timestamp: "0" },
      { type: "drawn", positionId: "p1" },
      { type: "liquidated", positionId: "p1", timestamp: "50" },
    ];
    const { positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);
    expect(positions[0].outcome).toBe("liquidated");
    expect(positions[0].closedAt).toBe(50n);
  });

  it("a still-open position has outcome 'open' and closedAt null", () => {
    const events: PositionLedgerEventLike[] = [
      { type: "position-opened", positionId: "p1", borrower: BORROWER, vaultAddress: "v1", collateralSats: "100000", timestamp: "0" },
      { type: "drawn", positionId: "p1" },
    ];
    const { positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);
    expect(positions[0].outcome).toBe("open");
    expect(positions[0].closedAt).toBeNull();
  });

  it("handles multiple positions for the same borrower independently", () => {
    const events: PositionLedgerEventLike[] = [
      { type: "position-opened", positionId: "p1", borrower: BORROWER, vaultAddress: "v1", collateralSats: "100000", timestamp: "0" },
      { type: "repaid", positionId: "p1" },
      { type: "closed", positionId: "p1", timestamp: "10" },
      { type: "position-opened", positionId: "p2", borrower: BORROWER, vaultAddress: "v2", collateralSats: "200000", timestamp: "20" },
    ];
    const { vaultEvents, positions } = positionLedgerToFeatureSources(events, BORROWER, 1000n);
    expect(vaultEvents).toHaveLength(2);
    expect(positions.map((p) => p.vaultId).sort()).toEqual(["v1", "v2"]);
    expect(positions.find((p) => p.vaultId === "v1")!.outcome).toBe("repaid");
    expect(positions.find((p) => p.vaultId === "v2")!.outcome).toBe("open");
  });
});
