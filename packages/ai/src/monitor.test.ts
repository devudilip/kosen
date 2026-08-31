import { describe, expect, it } from "vitest";
import { summarizeRiskOffline, type RiskSummaryInput } from "./monitor.js";

const HEALTHY_INPUT: RiskSummaryInput = {
  loanAssetSymbol: "satUSD",
  buckets: [
    { label: "0-50%", count: 2, exposureLoanUnits: 40_000n },
    { label: "50-70%", count: 0, exposureLoanUnits: 0n },
    { label: "70-80%", count: 0, exposureLoanUnits: 0n },
    { label: "80-86%", count: 1, exposureLoanUnits: 53_000n },
    { label: "86%+", count: 0, exposureLoanUnits: 0n },
  ],
  atRiskCount: 0,
  totalOpenPositions: 3,
};

const AT_RISK_INPUT: RiskSummaryInput = {
  ...HEALTHY_INPUT,
  buckets: [
    { label: "0-50%", count: 2, exposureLoanUnits: 40_000n },
    { label: "50-70%", count: 0, exposureLoanUnits: 0n },
    { label: "70-80%", count: 0, exposureLoanUnits: 0n },
    { label: "80-86%", count: 0, exposureLoanUnits: 0n },
    { label: "86%+", count: 1, exposureLoanUnits: 53_000n },
  ],
  atRiskCount: 1,
};

describe("summarizeRiskOffline", () => {
  it("reports 'no liquidations pending' when nothing is at risk", () => {
    const summary = summarizeRiskOffline(HEALTHY_INPUT);
    expect(summary.narrative).toMatch(/No liquidations pending/);
    expect(summary.isReplay).toBe(true);
  });

  it("names the worst bucket and total exposure using only the numbers given", () => {
    const summary = summarizeRiskOffline(AT_RISK_INPUT);
    expect(summary.narrative).toContain("1 of 3");
    expect(summary.narrative).toContain("86%+");
    expect(summary.narrative).toContain("53000");
  });

  it("total exposure is a plain sum of the buckets, not an independently invented figure", () => {
    const summary = summarizeRiskOffline(AT_RISK_INPUT);
    const totalExposure = AT_RISK_INPUT.buckets.reduce((sum, b) => sum + b.exposureLoanUnits, 0n);
    expect(summary.narrative).toContain(`Total exposure across all buckets is ${totalExposure.toString()}`);
  });
});
