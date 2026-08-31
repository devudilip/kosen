#!/usr/bin/env -S npx tsx
// pnpm score <addr> — run the credit agent on an address and print the full
// feature vector, prompt, raw model output, and hard-clamped result.
//
// Today this always scores the seeded demo borrower (ai/demo-score.ts) since
// the real feature source — tachi-kit's getAddressVtxos/getAddressTransactions
// /getWatchtowerReceipts — isn't vendored yet. Once it is, this script's only
// change is swapping demoFeatureInput() for a live extraction; extractFeatures
// and everything downstream of it is already the real pipeline.
//
// Live-scores via Claude if ANTHROPIC_API_KEY is set; otherwise prints a
// clearly-labeled stored replay (see docs/DEMO.md's degradation path).
import { demoScoreForAddress } from "@kosen/ai";

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address) {
    console.error("usage: pnpm score <address>");
    process.exit(1);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const { result, features, isReplay } = await demoScoreForAddress(address, now);

  console.log(`Kōsen — credit score for ${address}`);
  console.log("-".repeat(60));
  if (isReplay) {
    console.log("[REPLAY] No ANTHROPIC_API_KEY set — showing a stored replay, not a live call.\n");
  }

  console.log("Feature vector (deterministic, no LLM):");
  console.log(JSON.stringify(features, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log("\nRaw model output:");
  console.log(JSON.stringify(result.raw, null, 2));

  console.log("\nClamped output (what the protocol actually uses):");
  console.log(JSON.stringify(result.clamped, null, 2));

  if (result.clamped.clamped.maxLLTV || result.clamped.clamped.ratePremiumBps || result.clamped.clamped.score) {
    console.log("\n[CLAMPED] The model's raw opinion was outside the hard band and was corrected in code.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
