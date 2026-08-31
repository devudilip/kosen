// The credit agent's tool-forced output shape. Claude is required to call
// this tool — it cannot return free text instead — so the output always
// parses. The clamp band lives in score.ts, applied unconditionally in code
// AFTER the model returns; this schema alone does not constrain the model.
export const CREDIT_SCORE_TOOL_NAME = "emit_credit_score";

export type CreditTier = "A" | "B" | "C" | "D";

export interface RawCreditScore {
  score: number; // 0-1000, model's opinion, not yet clamped
  tier: CreditTier;
  maxLLTV: number; // fraction 0-1, model's opinion, not yet clamped
  ratePremiumBps: number; // model's opinion, not yet clamped
  reasons: string[];
  redFlags: string[];
}

export const CREDIT_SCORE_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 1000 },
    tier: { type: "string", enum: ["A", "B", "C", "D"] },
    maxLLTV: { type: "number", minimum: 0, maximum: 1 },
    ratePremiumBps: { type: "integer", minimum: 0 },
    reasons: { type: "array", items: { type: "string" } },
    redFlags: { type: "array", items: { type: "string" } },
  },
  required: ["score", "tier", "maxLLTV", "ratePremiumBps", "reasons", "redFlags"],
  additionalProperties: false,
} as const;

export const CREDIT_SCORE_TOOL = {
  name: CREDIT_SCORE_TOOL_NAME,
  description:
    "Emit the structured credit assessment for this borrower. You must call this tool — do not respond with plain text.",
  input_schema: CREDIT_SCORE_JSON_SCHEMA,
};
