// Liquidation monitor: a per-block, plain-language summary of the at-risk
// queue for lenders. Advisory only — it narrates what the deterministic
// engine already computed (docs/AGENT-BRIEF.md: "the AI narrated this. It
// didn't decide it."). It has no tools and no authority to act; it just
// reads numbers the caller already computed with engine/liquidator.ts and
// turns them into a sentence a lender can skim.
import Anthropic from "@anthropic-ai/sdk";

export interface RiskBucketInput {
  label: string; // e.g. "80-86%"
  count: number;
  exposureLoanUnits: bigint;
}

export interface RiskSummaryInput {
  loanAssetSymbol: string; // e.g. "satUSD"
  buckets: RiskBucketInput[];
  atRiskCount: number; // positions currently liquidatable (LTV > LLTV)
  totalOpenPositions: number;
}

export interface RiskSummary {
  narrative: string;
  isReplay: boolean;
}

const MODEL = "claude-opus-5";

function serializeInput(input: RiskSummaryInput) {
  return {
    loanAssetSymbol: input.loanAssetSymbol,
    atRiskCount: input.atRiskCount,
    totalOpenPositions: input.totalOpenPositions,
    buckets: input.buckets.map((b) => ({ ...b, exposureLoanUnits: b.exposureLoanUnits.toString() })),
  };
}

function buildPrompt(input: RiskSummaryInput): string {
  return [
    "Summarize this lending market's liquidation risk for lenders in 2-3 sentences.",
    "Use ONLY the numbers given below — do not invent additional statistics, prices,",
    "or position counts. This is advisory narration of numbers the deterministic",
    "engine already computed; you are not deciding or predicting anything.",
    "",
    JSON.stringify(serializeInput(input), null, 2),
  ].join("\n");
}

export async function summarizeRiskLive(client: Anthropic, input: RiskSummaryInput): Promise<RiskSummary> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: buildPrompt(input) }],
  });
  const narrative = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { narrative, isReplay: false };
}

// Offline fallback: a template built directly from the same numbers, so the
// dashboard still says something concrete without ANTHROPIC_API_KEY set.
export function summarizeRiskOffline(input: RiskSummaryInput): RiskSummary {
  if (input.atRiskCount === 0) {
    return {
      narrative: `All ${input.totalOpenPositions} open positions are within their LLTV. No liquidations pending.`,
      isReplay: true,
    };
  }

  const worstBucket = [...input.buckets].reverse().find((b) => b.count > 0);
  const totalExposure = input.buckets.reduce((sum, b) => sum + b.exposureLoanUnits, 0n);

  return {
    narrative: [
      `${input.atRiskCount} of ${input.totalOpenPositions} open positions are currently above their LLTV and eligible for liquidation.`,
      worstBucket
        ? `The riskiest bucket (${worstBucket.label}) holds ${worstBucket.count} position(s) with ${worstBucket.exposureLoanUnits.toString()} ${input.loanAssetSymbol} of exposure.`
        : "",
      `Total exposure across all buckets is ${totalExposure.toString()} ${input.loanAssetSymbol}.`,
    ]
      .filter(Boolean)
      .join(" "),
    isReplay: true,
  };
}

export async function summarizeRisk(input: RiskSummaryInput): Promise<RiskSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    return summarizeRiskLive(client, input);
  }
  return summarizeRiskOffline(input);
}
