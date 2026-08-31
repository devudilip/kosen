import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { demoFeatureInput, demoScoreForAddress } from "./demo-score.js";
import { extractFeatures } from "./features.js";

describe("demoFeatureInput", () => {
  it("produces a borrower with non-trivial history (not the boring all-zero demo)", () => {
    const input = demoFeatureInput(1_000_000_000n);
    const features = extractFeatures(input, 1_000_000_000n);
    expect(features.priorPositions).toBeGreaterThan(0);
    expect(features.repayments).toBeGreaterThan(0);
    expect(features.timesSelfCured).toBeGreaterThan(0);
    expect(features.largestDrawdownSurvivedBps).toBeGreaterThan(0);
  });
});

describe("demoScoreForAddress", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("falls back to a labeled replay when no API key is set", async () => {
    const outcome = await demoScoreForAddress("demo-borrower", 1_000_000_000n);
    expect(outcome.isReplay).toBe(true);
    expect(outcome.result.model).toMatch(/replay/i);
  });

  it("the replay's clamped output still respects the hard clamp band", async () => {
    const outcome = await demoScoreForAddress("demo-borrower", 1_000_000_000n);
    expect(outcome.result.clamped.maxLLTV).toBeGreaterThanOrEqual(0.7);
    expect(outcome.result.clamped.maxLLTV).toBeLessThanOrEqual(0.86);
  });

  it("returns the same feature vector that extractFeatures produces for the demo input", async () => {
    const outcome = await demoScoreForAddress("demo-borrower", 1_000_000_000n);
    const expected = extractFeatures(demoFeatureInput(1_000_000_000n), 1_000_000_000n);
    expect(outcome.features).toEqual(expected);
  });
});
