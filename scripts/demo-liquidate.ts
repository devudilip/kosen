#!/usr/bin/env -S npx tsx
// pnpm demo:liquidate — scripted price drop -> deterministic liquidation ->
// lender made whole. Runs entirely against engine/demo-world.ts's in-memory
// seeded market, so it needs no bitcoind, no Tachi RPC, and no
// ANTHROPIC_API_KEY. Once @kosen/tachi-kit is vendored, the live version of
// this script swaps createWorld() for a real ledger read and drives the
// price drop through tachi-kit's oracle feed instead of setPrice(); the
// liquidation and accounting logic below does not change.
import {
  createWorld,
  listPositions,
  marketView,
  riskView,
  setPrice,
  sweepLiquidations,
} from "@kosen/engine";

function line(): void {
  console.log("-".repeat(60));
}

function main(): void {
  let world = createWorld();

  console.log("Kōsen — demo:liquidate");
  line();
  console.log(`Market: ${JSON.stringify(marketView(world), null, 2)}`);

  line();
  console.log("Positions before the price drop:");
  for (const p of listPositions(world)) {
    console.log(`  ${p.id}: LTV ${(Number(p.ltv) * 100).toFixed(1)}%, health factor ${Number(p.healthFactor).toFixed(2)}`);
  }

  // -12%: enough to push the aggressive position (~81.5% LTV) past the 86%
  // LLTV, but not so severe that the seized collateral can't cover debt +
  // incentive (a larger crash would produce bad debt — a real but separate
  // scenario from the "lender made whole" story this script demonstrates).
  const droppedPrice = (world.priceLoanUnitsPerBtc * 88n) / 100n;
  console.log(`\nDropping BTC price from ${world.priceLoanUnitsPerBtc} to ${droppedPrice} (-12%)...`);
  world = setPrice(world, droppedPrice);

  const risk = riskView(world);
  line();
  console.log(`At-risk positions after the drop: ${JSON.stringify(risk.atRiskPositionIds)}`);
  if (risk.atRiskPositionIds.length === 0) {
    console.error("FAIL: expected at least one position to become liquidatable after the drop.");
    process.exit(1);
  }

  const supplyBefore = world.market.accounting.totalSupplyAssets;

  console.log("\nRunning the deterministic liquidator sweep (engine/liquidator.ts)...");
  world = sweepLiquidations(world);

  line();
  console.log(`Liquidations processed: ${world.liquidationHistory.length}`);
  for (const result of world.liquidationHistory) {
    console.log(
      `  ${result.position.id}: repaid ${result.debtRepaid}, seized ${result.collateralSeized} sats` +
        `, returned ${result.collateralToBorrower} sats to borrower, badDebt=${result.badDebt}`,
    );
    if (result.badDebt) {
      console.error(`FAIL: ${result.position.id} produced bad debt — the seized collateral didn't cover debt + incentive.`);
      process.exit(1);
    }
  }

  const supplyAfter = world.market.accounting.totalSupplyAssets;
  line();
  console.log("Positions after liquidation:");
  for (const p of listPositions(world)) {
    console.log(`  ${p.id}: status=${p.status}`);
  }

  line();
  // "Lender made whole" means the lender-owed supply-side assets did not
  // drop as a result of the liquidation — the liquidator's repay covers it.
  if (supplyAfter < supplyBefore) {
    console.error(`FAIL: totalSupplyAssets dropped from ${supplyBefore} to ${supplyAfter} — lender was NOT made whole.`);
    process.exit(1);
  }
  console.log(`PASS: totalSupplyAssets held at ${supplyAfter} (was ${supplyBefore}) — lender made whole.`);
}

main();
