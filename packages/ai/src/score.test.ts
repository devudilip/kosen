import { describe, expect, it } from "vitest";
import {
  applyHardClamps,
  MAX_LLTV_CEILING,
  MAX_LLTV_FLOOR,
  RATE_PREMIUM_CEILING_BPS,
  RATE_PREMIUM_FLOOR_BPS,
  SCORE_CEILING,
  SCORE_FLOOR,
} from "./score.js";
import type { RawCreditScore } from "./schema.js";

function raw(overrides: Partial<RawCreditScore> = {}): RawCreditScore {
  return {
    score: 500,
    tier: "B",
    maxLLTV: 0.8,
    ratePremiumBps: 100,
    reasons: ["stable history"],
    redFlags: [],
    ...overrides,
  };
}

describe("applyHardClamps — the AI cannot escape the band", () => {
  it("passes through values already inside the band unchanged", () => {
    const result = applyHardClamps(raw({ maxLLTV: 0.8, ratePremiumBps: 150 }));
    expect(result.maxLLTV).toBe(0.8);
    expect(result.ratePremiumBps).toBe(150);
    expect(result.clamped.maxLLTV).toBe(false);
    expect(result.clamped.ratePremiumBps).toBe(false);
  });

  it("clamps a maxLLTV above the ceiling (model trying to be generous) down to the ceiling", () => {
    const result = applyHardClamps(raw({ maxLLTV: 0.99 }));
    expect(result.maxLLTV).toBe(MAX_LLTV_CEILING);
    expect(result.clamped.maxLLTV).toBe(true);
  });

  it("clamps a maxLLTV of 1.0 (100% — no haircut at all) down to the ceiling", () => {
    const result = applyHardClamps(raw({ maxLLTV: 1.0 }));
    expect(result.maxLLTV).toBe(MAX_LLTV_CEILING);
  });

  it("clamps a maxLLTV below the floor up to the floor", () => {
    const result = applyHardClamps(raw({ maxLLTV: 0.1 }));
    expect(result.maxLLTV).toBe(MAX_LLTV_FLOOR);
    expect(result.clamped.maxLLTV).toBe(true);
  });

  it("clamps a negative maxLLTV up to the floor", () => {
    const result = applyHardClamps(raw({ maxLLTV: -5 }));
    expect(result.maxLLTV).toBe(MAX_LLTV_FLOOR);
  });

  it("clamps an absurd ratePremiumBps (e.g. a hallucinated 999999) down to the ceiling", () => {
    const result = applyHardClamps(raw({ ratePremiumBps: 999_999 }));
    expect(result.ratePremiumBps).toBe(RATE_PREMIUM_CEILING_BPS);
    expect(result.clamped.ratePremiumBps).toBe(true);
  });

  it("clamps a negative ratePremiumBps up to the floor", () => {
    const result = applyHardClamps(raw({ ratePremiumBps: -50 })).ratePremiumBps;
    expect(result).toBe(RATE_PREMIUM_FLOOR_BPS);
  });

  it("clamps score outside [0, 1000]", () => {
    expect(applyHardClamps(raw({ score: 5000 })).score).toBe(SCORE_CEILING);
    expect(applyHardClamps(raw({ score: -100 })).score).toBe(SCORE_FLOOR);
  });

  it("never throws on non-finite or malformed numeric fields — clamps to the floor instead", () => {
    expect(() => applyHardClamps(raw({ maxLLTV: Number.NaN }))).not.toThrow();
    expect(applyHardClamps(raw({ maxLLTV: Number.NaN })).maxLLTV).toBe(MAX_LLTV_FLOOR);
    expect(applyHardClamps(raw({ maxLLTV: Number.POSITIVE_INFINITY })).maxLLTV).toBe(MAX_LLTV_FLOOR);
    expect(applyHardClamps(raw({ ratePremiumBps: Number.NEGATIVE_INFINITY })).ratePremiumBps).toBe(
      RATE_PREMIUM_FLOOR_BPS,
    );
  });

  it("property: for any numeric input, output always lands inside the band", () => {
    const probes = [-1e9, -1, 0, 0.0001, 0.5, 0.86, 0.860001, 1, 2, 1e9, Number.NaN, Infinity, -Infinity];
    for (const v of probes) {
      const result = applyHardClamps(raw({ maxLLTV: v }));
      expect(result.maxLLTV).toBeGreaterThanOrEqual(MAX_LLTV_FLOOR);
      expect(result.maxLLTV).toBeLessThanOrEqual(MAX_LLTV_CEILING);
    }
    for (const v of probes) {
      const result = applyHardClamps(raw({ ratePremiumBps: v }));
      expect(result.ratePremiumBps).toBeGreaterThanOrEqual(RATE_PREMIUM_FLOOR_BPS);
      expect(result.ratePremiumBps).toBeLessThanOrEqual(RATE_PREMIUM_CEILING_BPS);
    }
  });

  it("passes through reasons and redFlags without modification (advisory content is not clamped)", () => {
    const result = applyHardClamps(raw({ reasons: ["a", "b"], redFlags: ["c"] }));
    expect(result.reasons).toEqual(["a", "b"]);
    expect(result.redFlags).toEqual(["c"]);
  });
});
