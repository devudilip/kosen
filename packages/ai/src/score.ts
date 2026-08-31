import Anthropic from "@anthropic-ai/sdk";
import type { FeatureVector } from "./features.js";
import { CREDIT_SCORE_TOOL, CREDIT_SCORE_TOOL_NAME, type CreditTier, type RawCreditScore } from "./schema.js";

// Hard clamp band. This is the property judges will probe: the model can move
// maxLLTV and ratePremiumBps within these bounds and nowhere else. The clamp
// is applied unconditionally in code below, never trusted to the prompt —
// score.test.ts asserts the model literally cannot escape it, including with
// adversarial/malformed inputs.
export const MAX_LLTV_FLOOR = 0.7;
export const MAX_LLTV_CEILING = 0.86;
export const RATE_PREMIUM_FLOOR_BPS = 0;
export const RATE_PREMIUM_CEILING_BPS = 300;
export const SCORE_FLOOR = 0;
export const SCORE_CEILING = 1000;

export interface ClampedCreditScore {
  score: number;
  tier: CreditTier;
  maxLLTV: number;
  ratePremiumBps: number;
  reasons: string[];
  redFlags: string[];
  clamped: {
    maxLLTV: boolean; // true if the model's raw value was outside the band and got clamped
    ratePremiumBps: boolean;
    score: boolean;
  };
}

function clampNumber(value: number, floor: number, ceiling: number): { value: number; clamped: boolean } {
  if (!Number.isFinite(value)) return { value: floor, clamped: true };
  if (value < floor) return { value: floor, clamped: true };
  if (value > ceiling) return { value: ceiling, clamped: true };
  return { value, clamped: false };
}

// The ONLY function permitted to turn a model's raw opinion into an
// authoritative credit score. Deterministic, synchronous, and total — never
// throws, no matter how malformed the input. This is what makes the clamp a
// property of the code rather than a suggestion in the prompt.
export function applyHardClamps(raw: RawCreditScore): ClampedCreditScore {
  const score = clampNumber(raw.score, SCORE_FLOOR, SCORE_CEILING);
  const maxLLTV = clampNumber(raw.maxLLTV, MAX_LLTV_FLOOR, MAX_LLTV_CEILING);
  const ratePremiumBps = clampNumber(raw.ratePremiumBps, RATE_PREMIUM_FLOOR_BPS, RATE_PREMIUM_CEILING_BPS);

  return {
    score: Math.round(score.value),
    tier: raw.tier,
    maxLLTV: maxLLTV.value,
    ratePremiumBps: Math.round(ratePremiumBps.value),
    reasons: raw.reasons,
    redFlags: raw.redFlags,
    clamped: {
      score: score.clamped,
      maxLLTV: maxLLTV.clamped,
      ratePremiumBps: ratePremiumBps.clamped,
    },
  };
}

export function buildScorePrompt(address: string, features: FeatureVector): string {
  const serializable = JSON.parse(
    JSON.stringify(features, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  return [
    `Underwrite a Bitcoin-collateralized loan for borrower ${address}.`,
    "",
    "Every number below is derived deterministically from public Bitcoin and Tachi",
    "ledger data — vault history, prior protocol positions, and the borrower's",
    "counterparty graph. Assess creditworthiness from this feature vector alone.",
    "",
    "Feature vector:",
    JSON.stringify(serializable, null, 2),
    "",
    "Note: your maxLLTV and ratePremiumBps are advisory. The protocol clamps",
    `maxLLTV into [${MAX_LLTV_FLOOR}, ${MAX_LLTV_CEILING}] and ratePremiumBps into`,
    `[${RATE_PREMIUM_FLOOR_BPS}, ${RATE_PREMIUM_CEILING_BPS}] unconditionally after you respond —`,
    "reason as if that band is the real constraint, since it is.",
  ].join("\n");
}

export interface ScoreResult {
  address: string;
  prompt: string;
  raw: RawCreditScore;
  clamped: ClampedCreditScore;
  model: string;
}

const MODEL = "claude-opus-5";

// Calls Claude with tool-forced structured output, then applies the hard
// clamp. The AI has no other authority here: it cannot retry into a
// different shape, cannot free-text its way around the tool, and its output
// is clamped in code regardless of what it returns.
export async function scoreCreditRisk(
  client: Anthropic,
  address: string,
  features: FeatureVector,
): Promise<ScoreResult> {
  const prompt = buildScorePrompt(address, features);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [CREDIT_SCORE_TOOL],
    tool_choice: { type: "tool", name: CREDIT_SCORE_TOOL_NAME },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === CREDIT_SCORE_TOOL_NAME,
  );
  if (!toolUse) throw new Error("model did not call the credit score tool");

  const raw = toolUse.input as RawCreditScore;
  const clamped = applyHardClamps(raw);

  return { address, prompt, raw, clamped, model: MODEL };
}
