import { describe, expect, it } from "vitest";
import { extractFeatures, type FeatureInput } from "./features.js";

const EMPTY_INPUT: FeatureInput = {
  vaultEvents: [],
  positions: [],
  priceSeries: [],
  watchtowerReceipts: [],
  counterpartyEdges: [],
};

describe("extractFeatures — empty history", () => {
  it("returns an all-zero vector for a borrower with no history", () => {
    const features = extractFeatures(EMPTY_INPUT, 1_000n);
    expect(features).toEqual({
      vaultAgeSeconds: 0n,
      vaultCount: 0,
      depositCount: 0,
      withdrawCount: 0,
      lifetimeVolumeSats: 0n,
      avgDepositIntervalSeconds: null,
      largestDrawdownSurvivedBps: 0,
      priorPositions: 0,
      repayments: 0,
      liquidations: 0,
      timesEnteredLiquidationBand: 0,
      timesSelfCured: 0,
      collateralConcentrationHhi: 0,
      unilateralExitAttempts: 0,
      counterpartyDegree: 0,
      counterpartyClusteringBps: 0,
    });
  });
});

describe("extractFeatures — vault history", () => {
  it("computes vault age from the earliest event to now", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      vaultEvents: [{ type: "deposit", vaultId: "v1", amountSats: 100_000n, timestamp: 1_000n }],
    };
    expect(extractFeatures(input, 1_000_000n).vaultAgeSeconds).toBe(999_000n);
  });

  it("computes average deposit interval across evenly spaced deposits", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      vaultEvents: [
        { type: "deposit", vaultId: "v1", amountSats: 10_000n, timestamp: 0n },
        { type: "deposit", vaultId: "v1", amountSats: 10_000n, timestamp: 100n },
        { type: "deposit", vaultId: "v1", amountSats: 10_000n, timestamp: 200n },
      ],
    };
    const features = extractFeatures(input, 1_000n);
    expect(features.avgDepositIntervalSeconds).toBe(100n);
    expect(features.depositCount).toBe(3);
    expect(features.lifetimeVolumeSats).toBe(30_000n);
  });

  it("is null for a single deposit (no interval to measure)", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      vaultEvents: [{ type: "deposit", vaultId: "v1", amountSats: 10_000n, timestamp: 0n }],
    };
    expect(extractFeatures(input, 1_000n).avgDepositIntervalSeconds).toBeNull();
  });
});

describe("extractFeatures — drawdown survived", () => {
  it("ignores liquidated positions — they weren't survived", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      positions: [
        { vaultId: "v1", openedAt: 0n, closedAt: 100n, outcome: "liquidated", enteredLiquidationBandCount: 1, selfCured: false },
      ],
      priceSeries: [
        { timestamp: 0n, priceUsdCents: 10_000_00n },
        { timestamp: 100n, priceUsdCents: 5_000_00n },
      ],
    };
    expect(extractFeatures(input, 1_000n).largestDrawdownSurvivedBps).toBe(0);
  });

  it("measures peak-to-trough drop for an open (non-liquidated) position", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      positions: [
        { vaultId: "v1", openedAt: 0n, closedAt: null, outcome: "open", enteredLiquidationBandCount: 0, selfCured: false },
      ],
      priceSeries: [
        { timestamp: 0n, priceUsdCents: 10_000_00n },
        { timestamp: 50n, priceUsdCents: 12_000_00n }, // peak
        { timestamp: 100n, priceUsdCents: 8_400_00n }, // -30% from peak
      ],
    };
    expect(extractFeatures(input, 100n).largestDrawdownSurvivedBps).toBe(3000);
  });

  it("takes the max drawdown across multiple positions", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      positions: [
        { vaultId: "v1", openedAt: 0n, closedAt: 50n, outcome: "repaid", enteredLiquidationBandCount: 0, selfCured: false },
        { vaultId: "v2", openedAt: 50n, closedAt: 100n, outcome: "repaid", enteredLiquidationBandCount: 0, selfCured: false },
      ],
      priceSeries: [
        { timestamp: 0n, priceUsdCents: 100_00n },
        { timestamp: 50n, priceUsdCents: 90_00n }, // -10% within position 1's window
        { timestamp: 100n, priceUsdCents: 45_00n }, // -50% within position 2's window (peak resets at 50)
      ],
    };
    expect(extractFeatures(input, 100n).largestDrawdownSurvivedBps).toBe(5000);
  });
});

describe("extractFeatures — protocol history", () => {
  it("counts repayments, liquidations, band entries, and self-cures independently", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      positions: [
        { vaultId: "v1", openedAt: 0n, closedAt: 10n, outcome: "repaid", enteredLiquidationBandCount: 2, selfCured: true },
        { vaultId: "v2", openedAt: 10n, closedAt: 20n, outcome: "liquidated", enteredLiquidationBandCount: 1, selfCured: false },
        { vaultId: "v3", openedAt: 20n, closedAt: null, outcome: "open", enteredLiquidationBandCount: 0, selfCured: false },
      ],
    };
    const features = extractFeatures(input, 100n);
    expect(features.priorPositions).toBe(3);
    expect(features.repayments).toBe(1);
    expect(features.liquidations).toBe(1);
    expect(features.timesEnteredLiquidationBand).toBe(3);
    expect(features.timesSelfCured).toBe(1);
  });
});

describe("extractFeatures — collateral concentration", () => {
  it("is 10000 (max) when all deposits are in a single vault", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      vaultEvents: [
        { type: "deposit", vaultId: "v1", amountSats: 100_000n, timestamp: 0n },
        { type: "deposit", vaultId: "v1", amountSats: 50_000n, timestamp: 10n },
      ],
    };
    expect(extractFeatures(input, 100n).collateralConcentrationHhi).toBe(10_000);
  });

  it("is 5000 for an even split across two vaults", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      vaultEvents: [
        { type: "deposit", vaultId: "v1", amountSats: 50_000n, timestamp: 0n },
        { type: "deposit", vaultId: "v2", amountSats: 50_000n, timestamp: 10n },
      ],
    };
    expect(extractFeatures(input, 100n).collateralConcentrationHhi).toBe(5000);
  });
});

describe("extractFeatures — exit behavior and counterparty graph", () => {
  it("counts unilateral exit attempts from watchtower receipts", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      watchtowerReceipts: [
        { vaultId: "v1", type: "exitAttempt", timestamp: 10n },
        { vaultId: "v1", type: "exitAttempt", timestamp: 20n },
      ],
    };
    expect(extractFeatures(input, 100n).unilateralExitAttempts).toBe(2);
  });

  it("computes counterparty degree and clustering", () => {
    const input: FeatureInput = {
      ...EMPTY_INPUT,
      counterpartyEdges: [
        { counterparty: "a", txCount: 90 },
        { counterparty: "b", txCount: 10 },
      ],
    };
    const features = extractFeatures(input, 100n);
    expect(features.counterpartyDegree).toBe(2);
    expect(features.counterpartyClusteringBps).toBe(9000);
  });

  it("clustering is 0 with no counterparties", () => {
    expect(extractFeatures(EMPTY_INPUT, 100n).counterpartyClusteringBps).toBe(0);
  });
});
