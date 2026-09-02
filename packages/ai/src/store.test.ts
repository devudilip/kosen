import { describe, expect, it } from "vitest";
import { extractFeatures, type FeatureInput } from "./features.js";
import { applyHardClamps } from "./score.js";
import { ScoreStore } from "./store.js";
import type { ScoreResult } from "./score.js";
import type { RawCreditScore } from "./schema.js";

const EMPTY_INPUT: FeatureInput = {
  vaultEvents: [],
  positions: [],
  priceSeries: [],
  watchtowerReceipts: [],
  counterpartyEdges: [],
};

function fakeScoreResult(address: string): ScoreResult {
  const raw: RawCreditScore = {
    score: 720,
    tier: "B",
    maxLLTV: 0.82,
    ratePremiumBps: 120,
    reasons: ["survived a 30% drawdown without liquidation"],
    redFlags: [],
  };
  return {
    address,
    prompt: "fake prompt for test",
    raw,
    clamped: applyHardClamps(raw),
    model: "claude-opus-5",
  };
}

describe("ScoreStore — replayability", () => {
  it("round-trips a stored score with its full feature vector, prompt, and outputs", () => {
    const store = new ScoreStore();
    const features = extractFeatures(EMPTY_INPUT, 1_000n);
    const result = fakeScoreResult("borrower-x-only-pubkey");

    const id = store.save("borrower-x-only-pubkey", 1_000, features, result);
    const stored = store.get(id);

    expect(stored).toBeDefined();
    expect(stored!.address).toBe("borrower-x-only-pubkey");
    expect(stored!.prompt).toBe(result.prompt);
    expect(stored!.rawOutput).toEqual(result.raw);
    expect(stored!.clampedOutput).toEqual(result.clamped);
    // bigints serialize through as strings — verify the round trip preserves value
    expect(stored!.featureVector.vaultAgeSeconds).toBe("0");

    store.close();
  });

  it("lists scores for an address newest-first", () => {
    const store = new ScoreStore();
    const features = extractFeatures(EMPTY_INPUT, 1_000n);

    store.save("addr", 100, features, fakeScoreResult("addr"));
    store.save("addr", 200, features, fakeScoreResult("addr"));

    const list = store.listForAddress("addr");
    expect(list).toHaveLength(2);
    expect(list[0].timestamp).toBe(200);
    expect(list[1].timestamp).toBe(100);

    store.close();
  });

  it("returns undefined for an unknown id", () => {
    const store = new ScoreStore();
    expect(store.get(999)).toBeUndefined();
    store.close();
  });
});
