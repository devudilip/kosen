// Typed client over the engine's dev/demo HTTP surface (packages/engine/src/server.ts).
// Every shape here mirrors the *View types the server returns — see
// docs/PLAN.md Phase 3 ("Fastify routes + a typed client for the web app").
const ENGINE_URL = process.env.ENGINE_URL ?? "http://localhost:4000";

export interface MarketView {
  id: string;
  collateralAsset: string;
  loanAsset: string;
  lltv: string;
  utilization: string;
  supplyApy: string;
  borrowApy: string;
  totalSupplyAssets: string;
  totalBorrowAssets: string;
  tvlLoanUnits: string;
}

// Present only when the engine is running with KOSEN_MODE=tachi
// (packages/engine/src/ledger-world-views.ts) — a real MuSig2 vault backs
// this position. Absent (undefined) in the default KOSEN_MODE=sim.
export interface DefaultOutcome {
  n: string;
  shareSats: string; // -> protocol, on liquidation
  userValueSats: string; // -> borrower's to_local, on liquidation
  protocolPayoutAddress: string;
  refundTxid: string; // the liquidation tx hash-to-be
}

export interface ChannelView {
  vaultAddress: string;
  vaultId: string;
  termBlocks: number;
  exitTxHex: string;
  l1BalanceSats: string | null;
  latestState: DefaultOutcome | null;
}

export interface PositionView {
  id: string;
  borrower: string;
  vaultId: string;
  status: string;
  collateralSats: string;
  debtOwed: string;
  ltv: string;
  healthFactor: string;
  liquidationPriceLoanUnitsPerBtc: string | null;
  isLiquidatable: boolean;
  lltvWad: string;
  currentPriceLoanUnitsPerBtc: string;
  channel?: ChannelView | null;
}

export interface RiskBucket {
  label: string;
  count: number;
  exposureLoanUnits: string;
}

export interface RiskView {
  buckets: RiskBucket[];
  atRiskPositionIds: string[];
  liquidationHistoryCount: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const engine = {
  listMarkets: () => get<MarketView[]>("/markets"),
  getMarket: (id: string) => get<MarketView>(`/markets/${id}`),
  listPositions: () => get<PositionView[]>("/positions"),
  getPosition: (id: string) => get<PositionView>(`/positions/${id}`),
  repay: (id: string, assets: string) => post<PositionView>(`/positions/${id}/repay`, { assets }),
  getRisk: () => get<RiskView>("/risk"),
  setDemoPrice: (priceLoanUnitsPerBtc: string) => post<MarketView>("/demo/price", { priceLoanUnitsPerBtc }),
  sweepLiquidations: () => post<RiskView>("/demo/sweep-liquidations"),
  resetDemo: () => post<MarketView>("/demo/reset"),
};
