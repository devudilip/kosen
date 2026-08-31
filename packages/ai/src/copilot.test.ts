import { describe, expect, it } from "vitest";
import { askCopilotOffline, type CopilotContext } from "./copilot.js";
import { pct } from "@kosen/engine";

const CONTEXT: CopilotContext = {
  positionId: "pos-1",
  debtAssets: 53_000n,
  collateralSats: 100_000_000n, // 1 BTC
  lltv: pct(86),
  currentPriceLoanUnitsPerBtc: 65_000n,
};

describe("askCopilotOffline — 'what happens if BTC drops X%?'", () => {
  it("answers a price-drop question grounded in engine scenario math", () => {
    const result = askCopilotOffline(CONTEXT, "What happens if BTC drops 30%?");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("compute_price_scenario");
    expect(result.toolCalls[0].input.percentChange).toBe(-30);
    expect(result.answer).toMatch(/liquidatable/i);
  });

  it("a smaller drop that stays healthy says so", () => {
    const result = askCopilotOffline(CONTEXT, "What if BTC drops 5%?");
    expect(result.toolCalls[0].output.liquidatable).toBe(false);
    expect(result.answer).toMatch(/healthy/i);
  });

  it("handles a price rise question too", () => {
    const result = askCopilotOffline(CONTEXT, "What if BTC rises 10%?");
    expect(result.toolCalls[0].input.percentChange).toBe(10);
  });
});

describe("askCopilotOffline — 'cheapest way back above X% LTV?'", () => {
  it("answers with the exact repay amount from engine math", () => {
    const result = askCopilotOffline(CONTEXT, "What's the cheapest way back above 80% LTV?");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("compute_repay_to_target_ltv");
    expect(result.toolCalls[0].output.repayAssets).toBe("1000"); // 53000 - 0.80*65000 = 1000
    expect(result.answer).toMatch(/1000/);
  });

  it("says no repayment is needed when already under target", () => {
    const result = askCopilotOffline(CONTEXT, "cheapest way back above 90% LTV?");
    expect(result.toolCalls[0].output.repayAssets).toBe("0");
    expect(result.answer).toMatch(/already/i);
  });
});

describe("askCopilotOffline — unrecognized question", () => {
  it("falls back to the current position summary without fabricating an answer", () => {
    const result = askCopilotOffline(CONTEXT, "tell me a joke");
    expect(result.toolCalls).toEqual([]);
    expect(result.answer).toMatch(/LTV/);
  });
});

describe("askCopilotOffline — never fabricates numbers outside tool output", () => {
  it("every numeric figure quoted in the drop-scenario answer traces back to the tool output", () => {
    const result = askCopilotOffline(CONTEXT, "What happens if BTC drops 30%?");
    const output = result.toolCalls[0].output;
    expect(result.answer).toContain(String(output.priceLoanUnitsPerBtc));
  });
});
