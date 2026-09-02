// Position-grounded risk copilot. The model is NOT allowed to compute a
// hypothetical LTV, health factor, or repay amount itself — every numeric
// claim must come from a tool call into @kosen/engine's pure scenario math
// (docs/AGENT-BRIEF.md: "It can't hallucinate your health factor because it
// isn't the thing calculating it."). No free browsing, no tool access to
// money operations — the tools below are read-only projections, nothing
// executes a trade or a repay.
import Anthropic from "@anthropic-ai/sdk";
import { repayNeededForTargetLtv, scenarioAtPrice, scenarioAtPriceChangeBps, type Scenario } from "@kosen/engine";

export interface CopilotContext {
  positionId: string;
  debtAssets: bigint;
  collateralSats: bigint;
  lltv: bigint;
  currentPriceLoanUnitsPerBtc: bigint;
}

const SCENARIO_TOOL_NAME = "compute_price_scenario";
const REPAY_TOOL_NAME = "compute_repay_to_target_ltv";

const TOOLS: Anthropic.Tool[] = [
  {
    name: SCENARIO_TOOL_NAME,
    description:
      "Compute the exact LTV, health factor, and liquidation status if BTC's price changes by a given percentage from its current value. Use this for any 'what if the price drops/rises X%' question — never estimate this yourself.",
    input_schema: {
      type: "object",
      properties: {
        percentChange: {
          type: "number",
          description: "Signed percent change, e.g. -30 for a 30% drop, 10 for a 10% rise.",
        },
      },
      required: ["percentChange"],
      additionalProperties: false,
    },
  },
  {
    name: REPAY_TOOL_NAME,
    description:
      "Compute the exact loan-asset amount that must be repaid, at the current price, to bring this position's LTV down to a target percentage. Use this for any 'cheapest way back above X% LTV' question.",
    input_schema: {
      type: "object",
      properties: {
        targetLtvPercent: { type: "number", description: "Target LTV as a percent, e.g. 80 for 80%." },
      },
      required: ["targetLtvPercent"],
      additionalProperties: false,
    },
  },
];

function toPct(wad: bigint): number {
  return Number(wad) / 1e16; // WAD (1e18) -> percent
}

function scenarioSummary(s: Scenario): Record<string, unknown> {
  return {
    priceLoanUnitsPerBtc: s.priceLoanUnitsPerBtc.toString(),
    ltvPercent: toPct(s.ltv),
    healthFactor: Number(s.healthFactor) / 1e18,
    liquidatable: s.liquidatable,
  };
}

function runTool(context: CopilotContext, name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name === SCENARIO_TOOL_NAME) {
    const percentChange = Number(input.percentChange);
    const changeBps = BigInt(Math.round(percentChange * 100));
    const scenario = scenarioAtPriceChangeBps(
      context.debtAssets,
      context.collateralSats,
      context.lltv,
      context.currentPriceLoanUnitsPerBtc,
      changeBps,
    );
    return scenarioSummary(scenario);
  }
  if (name === REPAY_TOOL_NAME) {
    const targetLtv = BigInt(Math.round(Number(input.targetLtvPercent) * 1e16));
    const repayAssets = repayNeededForTargetLtv(
      context.debtAssets,
      context.collateralSats,
      context.currentPriceLoanUnitsPerBtc,
      targetLtv,
    );
    return { repayAssets: repayAssets.toString() };
  }
  throw new Error(`copilot: unknown tool ${name}`);
}

function systemPrompt(context: CopilotContext): string {
  const current = scenarioAtPrice(
    context.debtAssets,
    context.collateralSats,
    context.lltv,
    context.currentPriceLoanUnitsPerBtc,
  );
  return [
    "You are a risk copilot for one Bitcoin-collateralized lending position on Kōsen.",
    "You may discuss ONLY this position's risk — no general advice, no other markets.",
    "For any numeric claim about a hypothetical price or repay amount, you MUST call the",
    "matching tool rather than compute it yourself. Never state a health factor,",
    "liquidation price, or repay amount you did not get from a tool result or the context below.",
    "",
    `Current state: debt=${context.debtAssets.toString()}, collateral=${context.collateralSats.toString()} sats,`,
    `price=${context.currentPriceLoanUnitsPerBtc.toString()}, LTV=${toPct(current.ltv).toFixed(2)}%,`,
    `health factor=${(Number(current.healthFactor) / 1e18).toFixed(2)}.`,
  ].join("\n");
}

const MODEL = "claude-opus-5";
const MAX_TOOL_TURNS = 4;

export interface CopilotToolCall {
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface CopilotAnswer {
  answer: string;
  toolCalls: CopilotToolCall[];
  isReplay: boolean;
}

export async function askCopilotLive(
  client: Anthropic,
  context: CopilotContext,
  question: string,
): Promise<CopilotAnswer> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const toolCalls: CopilotToolCall[] = [];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(context),
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return { answer: text, toolCalls, isReplay: false };
    }

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const output = runTool(context, use.name, use.input as Record<string, unknown>);
      toolCalls.push({ name: use.name, input: use.input as Record<string, unknown>, output });
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`copilot: exceeded ${MAX_TOOL_TURNS} tool-use turns without a final answer`);
}

// Offline fallback (no ANTHROPIC_API_KEY): pattern-matches the two question
// shapes docs/DEMO.md rehearses and answers with the same grounded engine
// math, no LLM involved. Anything else gets the current position summary.
export function askCopilotOffline(context: CopilotContext, question: string): CopilotAnswer {
  const dropMatch = question.match(/(drop|fall|crash|down)[^0-9-]*(-?\d+(?:\.\d+)?)\s*%/i);
  const riseMatch = question.match(/(rise|up|gain)[^0-9-]*(-?\d+(?:\.\d+)?)\s*%/i);
  const targetMatch = question.match(/(\d+(?:\.\d+)?)\s*%\s*(ltv)?/i);

  if (dropMatch || riseMatch) {
    const raw = Number((dropMatch ?? riseMatch)![2]);
    const percentChange = dropMatch ? -Math.abs(raw) : Math.abs(raw);
    const output = runTool(context, SCENARIO_TOOL_NAME, { percentChange });
    const answer = output.liquidatable
      ? `A ${Math.abs(percentChange)}% ${percentChange < 0 ? "drop" : "rise"} would push the price to ${output.priceLoanUnitsPerBtc}, putting LTV at ${(output.ltvPercent as number).toFixed(1)}% — above the liquidation threshold. This position would be liquidatable.`
      : `A ${Math.abs(percentChange)}% ${percentChange < 0 ? "drop" : "rise"} would push the price to ${output.priceLoanUnitsPerBtc}, putting LTV at ${(output.ltvPercent as number).toFixed(1)}% with a health factor of ${(output.healthFactor as number).toFixed(2)}. Still healthy.`;
    return {
      answer,
      toolCalls: [{ name: SCENARIO_TOOL_NAME, input: { percentChange }, output }],
      isReplay: true,
    };
  }

  if (/repay|back above|cheapest/i.test(question) && targetMatch) {
    const targetLtvPercent = Number(targetMatch[1]);
    const output = runTool(context, REPAY_TOOL_NAME, { targetLtvPercent });
    const answer =
      output.repayAssets === "0"
        ? `You're already at or below ${targetLtvPercent}% LTV — no repayment needed.`
        : `Repaying ${output.repayAssets} would bring you to exactly ${targetLtvPercent}% LTV at the current price.`;
    return {
      answer,
      toolCalls: [{ name: REPAY_TOOL_NAME, input: { targetLtvPercent }, output }],
      isReplay: true,
    };
  }

  const current = scenarioAtPrice(context.debtAssets, context.collateralSats, context.lltv, context.currentPriceLoanUnitsPerBtc);
  return {
    answer: `Current LTV is ${toPct(current.ltv).toFixed(1)}%, health factor ${(Number(current.healthFactor) / 1e18).toFixed(2)}. Ask about a specific price move (e.g. "what if BTC drops 20%?") or a target LTV (e.g. "cheapest way back above 80%?") for a grounded projection.`,
    toolCalls: [],
    isReplay: true,
  };
}

export async function askCopilot(context: CopilotContext, question: string): Promise<CopilotAnswer> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    return askCopilotLive(client, context, question);
  }
  return askCopilotOffline(context, question);
}
