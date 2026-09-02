export function centsToUsd(cents: string | bigint): string {
  const v = typeof cents === "string" ? BigInt(cents) : cents;
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}

export function satsToBtc(sats: string | bigint): string {
  const v = typeof sats === "string" ? BigInt(sats) : sats;
  const btc = Number(v) / 1e8;
  return `${btc.toFixed(8)} BTC`;
}

export function pctFromDecimalString(s: string): string {
  return `${(Number(s) * 100).toFixed(2)}%`;
}
