import { WAD, wadDiv } from "./units.js";

// Pure, network-free health math — LTV, health factor, liquidation price.
// This mirrors the contract tachi-kit/health.ts is expected to publish
// (docs/PLAN.md Phase 3, ../../SHARED-CONTEXT.md). Both products' risk logic
// depends on exactly this math, so when the kit is vendored, this module
// should be swapped for tachi-kit's re-export rather than kept as a fork —
// track that in the sync-kit checksum. Until then this unblocks Phase 3/4
// entirely, since none of it needs network access.

export const SATS_PER_BTC = 100_000_000n;

// Value of `collateralSats` BTC expressed in loan-asset base units, given a
// price quoted as "loan-asset base units per whole BTC" (e.g. satUSD cents
// per BTC, or sats per BTC for the BTC->BTC leveraged market).
export function collateralValue(collateralSats: bigint, priceLoanUnitsPerBtc: bigint): bigint {
  return (collateralSats * priceLoanUnitsPerBtc) / SATS_PER_BTC;
}

// LTV = debt / collateral value, as a WAD fraction. Undefined (returns 0)
// when there is no collateral — such a position cannot be opened anyway.
export function loanToValue(borrowAssets: bigint, collateralSats: bigint, priceLoanUnitsPerBtc: bigint): bigint {
  const value = collateralValue(collateralSats, priceLoanUnitsPerBtc);
  if (value === 0n) return borrowAssets === 0n ? 0n : WAD; // no collateral backing any debt = maximally unhealthy
  return wadDiv(borrowAssets, value);
}

// Health factor = lltv / ltv, as a WAD fraction. >1 WAD is healthy, <1 WAD is
// liquidatable (equivalently: ltv > lltv). A position with no debt is
// maximally healthy regardless of collateral.
export function healthFactor(
  borrowAssets: bigint,
  collateralSats: bigint,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
): bigint {
  if (borrowAssets === 0n) return WAD * 1_000_000n; // effectively infinite
  const ltv = loanToValue(borrowAssets, collateralSats, priceLoanUnitsPerBtc);
  if (ltv === 0n) return WAD * 1_000_000n;
  return wadDiv(lltv, ltv);
}

export function isLiquidatable(
  borrowAssets: bigint,
  collateralSats: bigint,
  priceLoanUnitsPerBtc: bigint,
  lltv: bigint,
): boolean {
  return loanToValue(borrowAssets, collateralSats, priceLoanUnitsPerBtc) > lltv;
}

// The collateral-asset price (loan units per BTC) at which this position's
// LTV would exactly equal lltv. Below this price (for a BTC-collateral
// market), the position becomes liquidatable. Returns null when there is no
// debt (no price makes an undrawn position liquidatable).
export function liquidationPrice(borrowAssets: bigint, collateralSats: bigint, lltv: bigint): bigint | null {
  if (borrowAssets === 0n) return null;
  if (collateralSats === 0n) return 0n;
  // ltv > lltv  <=>  borrowAssets / collateralValue > lltv
  //              <=> collateralValue < borrowAssets / lltv
  //              <=> price < borrowAssets * SATS_PER_BTC / (collateralSats * lltv)
  return (borrowAssets * SATS_PER_BTC * WAD) / (collateralSats * lltv);
}

// The sats a liquidation refund's protocol-payout output should carry
// (docs/COLLATERAL-MODEL.md §3.5, verified against live regtest in
// scripts/04-spike-musig-vault.ts): share = collateral * lltv * (1+penalty),
// capped at the full collateral. Substituting priceLiq (liquidationPrice)
// back into share = debt*(1+penalty)*SATS_PER_BTC/priceLiq cancels debt out
// entirely — the share depends only on collateral, lltv, and the penalty,
// not on the specific debt or price at commit time. This is the ONE
// authoritative share formula both collateral-tachi.ts and
// collateral-sim.ts must use — do not reach for @kosen/tachi-kit's
// shareForLiquidation, which is satUSD's own collateralization-*ratio*
// model (>=100%) and computes something else entirely for an LTV (<=100%)
// input (verified: it saturates at 100% of collateral).
export function shareForLiquidation(collateralSats: bigint, lltv: bigint, penaltyBps: bigint): bigint {
  const raw = (collateralSats * lltv * (10_000n + penaltyBps)) / (WAD * 10_000n);
  return raw > collateralSats ? collateralSats : raw;
}
