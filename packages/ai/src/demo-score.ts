import Anthropic from "@anthropic-ai/sdk";
import { extractFeatures, type FeatureInput } from "./features.js";
import { applyHardClamps, buildScorePrompt, scoreCreditRisk, type ScoreResult } from "./score.js";
import type { RawCreditScore } from "./schema.js";

// Demo/seed data standing in for what would come from tachi-kit's
// getAddressVtxos / getAddressTransactions / getWatchtowerReceipts
// (docs/PLAN.md Phase 5) until that's vendored. The borrower has deliberately
// "interesting" history per docs/AGENT-BRIEF.md's troubleshooting note — a
// thin/empty history makes a boring demo.
export function demoFeatureInput(now: bigint): FeatureInput {
  return {
    vaultEvents: [
      { type: "deposit", vaultId: "vault-1", amountSats: 50_000_000n, timestamp: now - 200_000_000n },
      { type: "deposit", vaultId: "vault-1", amountSats: 30_000_000n, timestamp: now - 150_000_000n },
      { type: "withdraw", vaultId: "vault-1", amountSats: 10_000_000n, timestamp: now - 100_000_000n },
      { type: "deposit", vaultId: "vault-1", amountSats: 20_000_000n, timestamp: now - 50_000_000n },
    ],
    positions: [
      {
        vaultId: "vault-1",
        openedAt: now - 180_000_000n,
        closedAt: now - 120_000_000n,
        outcome: "repaid",
        enteredLiquidationBandCount: 1,
        selfCured: true,
      },
      {
        vaultId: "vault-1",
        openedAt: now - 100_000_000n,
        closedAt: now - 40_000_000n,
        outcome: "repaid",
        enteredLiquidationBandCount: 0,
        selfCured: false,
      },
    ],
    priceSeries: [
      { timestamp: now - 180_000_000n, priceUsdCents: 6_500_000n },
      { timestamp: now - 150_000_000n, priceUsdCents: 4_500_000n }, // ~31% drawdown, survived
      { timestamp: now - 120_000_000n, priceUsdCents: 6_000_000n },
      { timestamp: now - 40_000_000n, priceUsdCents: 6_200_000n },
    ],
    watchtowerReceipts: [],
    counterpartyEdges: [
      { counterparty: "cp-exchange-1", txCount: 12 },
      { counterparty: "cp-peer-1", txCount: 3 },
      { counterparty: "cp-peer-2", txCount: 2 },
    ],
  };
}

// A canned, clearly-labeled replay of what a live model call would return
// for the demo borrower above — used when ANTHROPIC_API_KEY isn't set, or
// the API is down mid-demo (docs/DEMO.md: "show a stored replay ... say
// plainly that it is a replay"). The reasoning references the exact feature
// vector demoFeatureInput produces.
const CANNED_REPLAY: RawCreditScore = {
  score: 760,
  tier: "B",
  maxLLTV: 0.83,
  ratePremiumBps: 90,
  reasons: [
    "Two prior positions, both fully repaid, one self-cured out of the liquidation band.",
    "Survived a ~31% peak-to-trough drawdown without liquidation.",
    "Vault history spans multiple deposit cycles with a moderate withdrawal, suggesting active but not erratic management.",
    "Counterparty graph is concentrated in one likely exchange counterparty — not a red flag on its own, but limits confidence beyond tier B.",
  ],
  redFlags: [],
};

export interface DemoScoreOutcome {
  result: ScoreResult;
  features: ReturnType<typeof extractFeatures>;
  isReplay: boolean;
}

// Runs the live agent if ANTHROPIC_API_KEY is set; otherwise falls back to
// the canned replay, exactly the degradation path docs/DEMO.md calls for.
export async function demoScoreForAddress(address: string, now: bigint): Promise<DemoScoreOutcome> {
  const input = demoFeatureInput(now);
  const features = extractFeatures(input, now);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    const result = await scoreCreditRisk(client, address, features);
    return { result, features, isReplay: false };
  }

  const prompt = buildScorePrompt(address, features);
  const clamped = applyHardClamps(CANNED_REPLAY);
  const result: ScoreResult = {
    address,
    prompt,
    raw: CANNED_REPLAY,
    clamped,
    model: "claude-opus-5 (replay — no ANTHROPIC_API_KEY set)",
  };
  return { result, features, isReplay: true };
}
