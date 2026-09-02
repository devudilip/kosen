// Fixed-point math for rates and utilization. Never use floats near money.
// WAD = 1e18, the standard fixed-point scale for rates/ratios.
export const WAD = 1_000_000_000n * 1_000_000_000n;

export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

export function wadMul(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("wadDiv: division by zero");
  return (a * WAD) / b;
}

// Percent helper for readable test fixtures: pct(90) -> 0.90 * WAD
export function pct(p: number): bigint {
  return (BigInt(Math.round(p * 1000)) * WAD) / 100_000n;
}
