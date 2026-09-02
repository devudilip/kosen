import { createHash } from "node:crypto";
import { emptyMarketAccounting, type MarketAccounting } from "./shares.js";
import { KINKED_IRM, type IrmParams } from "./irm.js";
import { pct } from "./units.js";

// A market is an isolated tuple: (collateral, loan asset, LLTV, oracle, IRM).
// Nothing is shared across markets — a bad oracle or an aggressive LLTV in
// one market cannot bleed into another's accounting.
export interface MarketParams {
  collateralAsset: string; // e.g. "BTC"
  loanAsset: string; // e.g. "satUSD" or "BTC"
  lltv: bigint; // WAD fraction, e.g. pct(86)
  oracle: string; // oracle identifier/address
  irm: IrmParams;
}

export type MarketId = string;

// Deterministic id from the params so two nodes constructing the same market
// always agree on its identity without a central registrar.
export function marketId(params: MarketParams): MarketId {
  const canonical = JSON.stringify({
    collateralAsset: params.collateralAsset,
    loanAsset: params.loanAsset,
    lltv: params.lltv.toString(),
    oracle: params.oracle,
    irm: {
      targetUtilization: params.irm.targetUtilization.toString(),
      baseRate: params.irm.baseRate.toString(),
      slope1: params.irm.slope1.toString(),
      slope2: params.irm.slope2.toString(),
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface Market {
  id: MarketId;
  params: MarketParams;
  accounting: MarketAccounting;
}

export class MarketRegistry {
  private markets = new Map<MarketId, Market>();

  create(params: MarketParams, now: bigint): Market {
    const id = marketId(params);
    if (this.markets.has(id)) throw new Error(`market already exists: ${id}`);
    const market: Market = { id, params, accounting: emptyMarketAccounting(now) };
    this.markets.set(id, market);
    return market;
  }

  get(id: MarketId): Market {
    const market = this.markets.get(id);
    if (!market) throw new Error(`unknown market: ${id}`);
    return market;
  }

  update(id: MarketId, accounting: MarketAccounting): Market {
    const market = this.get(id);
    const next = { ...market, accounting };
    this.markets.set(id, next);
    return next;
  }

  list(): Market[] {
    return [...this.markets.values()];
  }
}

// Launch markets per the README.
export const BTC_TO_SATUSD: MarketParams = {
  collateralAsset: "BTC",
  loanAsset: "satUSD",
  lltv: pct(86),
  oracle: "btc-usd",
  irm: KINKED_IRM,
};

export const BTC_TO_BTC_LEVERAGE: MarketParams = {
  collateralAsset: "BTC",
  loanAsset: "BTC",
  lltv: pct(91.5),
  oracle: "btc-usd",
  irm: KINKED_IRM,
};
