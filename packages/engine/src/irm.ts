import { WAD, wadMul, wadDiv, pct } from "./units.js";

// Kinked interest rate model, all rates expressed as annualized WAD fractions
// (1 WAD = 100% APR). Below target utilization, rate rises gently along
// slope1; above it, borrowing gets punished along the much steeper slope2 to
// pull utilization back down.
export interface IrmParams {
  targetUtilization: bigint; // WAD, e.g. pct(90)
  baseRate: bigint; // WAD annual, e.g. pct(2)
  slope1: bigint; // WAD annual, added at u == targetUtilization
  slope2: bigint; // WAD annual, added at u == 100%
}

export const KINKED_IRM: IrmParams = {
  targetUtilization: pct(90),
  baseRate: pct(2),
  slope1: pct(4),
  slope2: pct(60),
};

// utilization = totalBorrow / totalSupply, both in the same asset's base
// units. Returns 0 when there is no supply (nothing to lend against).
export function utilization(totalBorrowAssets: bigint, totalSupplyAssets: bigint): bigint {
  if (totalSupplyAssets === 0n) return 0n;
  const u = wadDiv(totalBorrowAssets, totalSupplyAssets);
  return u > WAD ? WAD : u;
}

// Annualized borrow rate (WAD) for a given utilization under the kinked curve.
export function borrowRate(u: bigint, params: IrmParams = KINKED_IRM): bigint {
  if (u < 0n || u > WAD) throw new Error("utilization out of [0, WAD] range");
  const { targetUtilization: uOpt, baseRate, slope1, slope2 } = params;

  if (u <= uOpt) {
    // Linear ramp from baseRate to baseRate + slope1 as u goes 0 -> uOpt.
    const progress = uOpt === 0n ? WAD : wadDiv(u, uOpt);
    return baseRate + wadMul(progress, slope1);
  }

  // Linear ramp from baseRate + slope1 to baseRate + slope1 + slope2 as u
  // goes uOpt -> 100%.
  const remaining = WAD - uOpt;
  const progress = remaining === 0n ? WAD : wadDiv(u - uOpt, remaining);
  return baseRate + slope1 + wadMul(progress, slope2);
}

// Supply rate is the borrow rate scaled down by utilization (only borrowed
// assets earn interest) — no separate protocol fee/reserve cut modeled yet.
export function supplyRate(u: bigint, params: IrmParams = KINKED_IRM): bigint {
  return wadMul(borrowRate(u, params), u);
}
