// Deterministic feature extraction — NO LLM HERE. This is where credit
// scoring earns its credibility: every number below has a documented
// derivation from public Bitcoin/Tachi data, and the same input always
// produces the same output (snapshot-tested in features.test.ts).
//
// Inputs are shaped generically rather than as raw tachi-kit responses so
// this module can be built and tested before tachi-kit is vendored (see
// docs/PLAN.md Phase 5). scripts/score-address.ts is the thin adapter that
// will map live tachi-kit calls (getAddressVtxos, getAddressTransactions,
// getWatchtowerReceipts) onto this shape.

export interface VaultEvent {
  type: "deposit" | "withdraw";
  vaultId: string;
  amountSats: bigint;
  timestamp: bigint; // unix seconds
}

export type PositionOutcome = "repaid" | "liquidated" | "open";

export interface PositionRecord {
  vaultId: string;
  openedAt: bigint;
  closedAt: bigint | null; // null if still open
  outcome: PositionOutcome;
  enteredLiquidationBandCount: number; // times LTV crossed into the warning band
  selfCured: boolean; // exited the liquidation band by repaying/adding collateral, without being liquidated
}

export interface PricePoint {
  timestamp: bigint;
  priceUsdCents: bigint;
}

export interface WatchtowerReceipt {
  vaultId: string;
  type: "exitAttempt";
  timestamp: bigint;
}

export interface CounterpartyEdge {
  counterparty: string; // x-only pubkey
  txCount: number;
}

export interface FeatureInput {
  vaultEvents: VaultEvent[];
  positions: PositionRecord[];
  priceSeries: PricePoint[]; // sorted ascending by timestamp
  watchtowerReceipts: WatchtowerReceipt[];
  counterpartyEdges: CounterpartyEdge[];
}

export interface FeatureVector {
  // Vault history
  vaultAgeSeconds: bigint;
  vaultCount: number;
  depositCount: number;
  withdrawCount: number;
  lifetimeVolumeSats: bigint;
  avgDepositIntervalSeconds: bigint | null;

  // Drawdown survived
  largestDrawdownSurvivedBps: number; // 0-10000, basis points of peak-to-trough price drop endured without liquidation

  // Protocol history
  priorPositions: number;
  repayments: number;
  liquidations: number;
  timesEnteredLiquidationBand: number;
  timesSelfCured: number;

  // Collateral concentration
  collateralConcentrationHhi: number; // Herfindahl-Hirschman index, 0-10000; 10000 = all in one vault

  // Exit behavior
  unilateralExitAttempts: number;

  // Counterparty graph
  counterpartyDegree: number;
  counterpartyClusteringBps: number; // 0-10000, share of tx volume concentrated in the single largest counterparty
}

export function extractFeatures(input: FeatureInput, now: bigint): FeatureVector {
  const { vaultEvents, positions, priceSeries, watchtowerReceipts, counterpartyEdges } = input;

  const vaultIds = new Set(vaultEvents.map((e) => e.vaultId));
  const deposits = vaultEvents.filter((e) => e.type === "deposit");
  const withdrawals = vaultEvents.filter((e) => e.type === "withdraw");

  const firstEventAt = vaultEvents.reduce<bigint | null>(
    (min, e) => (min === null || e.timestamp < min ? e.timestamp : min),
    null,
  );
  const vaultAgeSeconds = firstEventAt === null ? 0n : now - firstEventAt;

  const lifetimeVolumeSats = vaultEvents.reduce((sum, e) => sum + e.amountSats, 0n);

  const depositTimestamps = deposits.map((d) => d.timestamp).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const avgDepositIntervalSeconds =
    depositTimestamps.length < 2
      ? null
      : (depositTimestamps[depositTimestamps.length - 1] - depositTimestamps[0]) /
        BigInt(depositTimestamps.length - 1);

  const largestDrawdownSurvivedBps = computeLargestSurvivedDrawdownBps(positions, priceSeries);

  const repayments = positions.filter((p) => p.outcome === "repaid").length;
  const liquidations = positions.filter((p) => p.outcome === "liquidated").length;
  const timesEnteredLiquidationBand = positions.reduce((sum, p) => sum + p.enteredLiquidationBandCount, 0);
  const timesSelfCured = positions.filter((p) => p.selfCured).length;

  const collateralConcentrationHhi = computeHhi(deposits, vaultIds);

  const unilateralExitAttempts = watchtowerReceipts.filter((r) => r.type === "exitAttempt").length;

  const counterpartyDegree = counterpartyEdges.length;
  const totalCounterpartyTx = counterpartyEdges.reduce((sum, e) => sum + e.txCount, 0);
  const largestCounterpartyTx = counterpartyEdges.reduce((max, e) => Math.max(max, e.txCount), 0);
  const counterpartyClusteringBps =
    totalCounterpartyTx === 0 ? 0 : Math.round((largestCounterpartyTx / totalCounterpartyTx) * 10_000);

  return {
    vaultAgeSeconds,
    vaultCount: vaultIds.size,
    depositCount: deposits.length,
    withdrawCount: withdrawals.length,
    lifetimeVolumeSats,
    avgDepositIntervalSeconds,
    largestDrawdownSurvivedBps,
    priorPositions: positions.length,
    repayments,
    liquidations,
    timesEnteredLiquidationBand,
    timesSelfCured,
    collateralConcentrationHhi,
    unilateralExitAttempts,
    counterpartyDegree,
    counterpartyClusteringBps,
  };
}

// For each non-liquidated position, walk the price series over its open
// window and find the largest peak-to-trough drop the borrower survived
// without being liquidated. Liquidated positions don't count — the borrower
// didn't "survive" that drawdown, the protocol closed them out.
function computeLargestSurvivedDrawdownBps(positions: PositionRecord[], priceSeries: PricePoint[]): number {
  let largestBps = 0;

  for (const position of positions) {
    if (position.outcome === "liquidated") continue;

    const windowEnd = position.closedAt ?? priceSeries[priceSeries.length - 1]?.timestamp ?? position.openedAt;
    const windowPrices = priceSeries.filter(
      (p) => p.timestamp >= position.openedAt && p.timestamp <= windowEnd,
    );
    if (windowPrices.length < 2) continue;

    let peak = windowPrices[0].priceUsdCents;
    for (const point of windowPrices) {
      if (point.priceUsdCents > peak) {
        peak = point.priceUsdCents;
      }
      if (peak === 0n) continue;
      const dropBps = Number(((peak - point.priceUsdCents) * 10_000n) / peak);
      if (dropBps > largestBps) largestBps = dropBps;
    }
  }

  return largestBps;
}

// Herfindahl-Hirschman index over deposit volume per vault, scaled to
// 0-10000 (Tachi/VTXO convention: fully concentrated in one vault = 10000).
function computeHhi(deposits: VaultEvent[], vaultIds: Set<string>): number {
  if (vaultIds.size === 0) return 0;
  const totals = new Map<string, bigint>();
  for (const d of deposits) {
    totals.set(d.vaultId, (totals.get(d.vaultId) ?? 0n) + d.amountSats);
  }
  const grandTotal = [...totals.values()].reduce((sum, v) => sum + v, 0n);
  if (grandTotal === 0n) return 0;

  let hhi = 0;
  for (const amount of totals.values()) {
    const shareBps = Number((amount * 10_000n) / grandTotal);
    hhi += Math.round((shareBps * shareBps) / 10_000);
  }
  return Math.min(hhi, 10_000);
}
