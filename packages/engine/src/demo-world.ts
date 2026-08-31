// In-memory seeded demo state. This is NOT the production ledger design —
// it exists so the web app and demo scripts have real, computed numbers to
// render (market utilization, health factors, a risk histogram) without
// waiting on a live Tachi connection or a running bitcoind. Every number it
// serves is computed by the same pure engine functions the real server will
// use; only the storage and seeding are throwaway.
import {
  accrueInterest,
  BTC_TO_SATUSD,
  borrowRate,
  debtOwed,
  draw,
  findLiquidatablePositions,
  healthFactor,
  isLiquidatable,
  liquidationPrice,
  loanToValue,
  MarketRegistry,
  openPosition,
  repay as repayPosition,
  runLiquidationSweep,
  SATS_PER_BTC,
  supply,
  supplyRate,
  utilization,
  WAD,
  type LiquidationResult,
  type Market,
  type Position,
} from "./index.js";

const SATUSD_CENTS_PER_BTC_AT_SEED = 6_500_000n; // $65,000/BTC, in USD cents

export interface World {
  registry: MarketRegistry;
  market: Market;
  positions: Map<string, Position>;
  priceLoanUnitsPerBtc: bigint; // satUSD cents per BTC, for the BTC->satUSD market
  now: bigint;
  liquidationHistory: LiquidationResult[];
}

function seedPositions(marketId: string, market: Market, now: bigint): { market: Market; positions: Position[] } {
  let accounting = market.accounting;
  const positions: Position[] = [];

  // Conservative borrower: long vault history implied by an early open,
  // well under the LLTV even before any price move. $20,000 debt against
  // $65,000 collateral = ~31% LTV.
  let p1 = openPosition("pos-conservative", marketId, "borrower-conservative-xonly", "vault-conservative", SATS_PER_BTC, now - 200_000n);
  const d1 = draw(p1, accounting, 2_000_000n, SATUSD_CENTS_PER_BTC_AT_SEED, market.params.lltv);
  positions.push(d1.position);
  accounting = d1.market;

  // Aggressive borrower: near the LLTV at seed time (~81.5%), so a modest
  // price drop pushes them underwater — this is the one the liquidation
  // demo targets. $53,000 debt against $65,000 collateral.
  let p2 = openPosition("pos-aggressive", marketId, "borrower-aggressive-xonly", "vault-aggressive", SATS_PER_BTC, now - 50_000n);
  const d2 = draw(p2, accounting, 5_300_000n, SATUSD_CENTS_PER_BTC_AT_SEED, market.params.lltv);
  positions.push(d2.position);
  accounting = d2.market;

  return { market: { ...market, accounting }, positions };
}

export function createWorld(now: bigint = 1_000_000n): World {
  const registry = new MarketRegistry();
  let market = registry.create(BTC_TO_SATUSD, now);

  // Seed lender liquidity first so positions below have something to borrow.
  const funded = supply(market.accounting, 10_000_000_00n); // $10M satUSD supplied
  market = registry.update(market.id, funded.state);

  const seeded = seedPositions(market.id, market, now);
  market = registry.update(market.id, seeded.market.accounting);

  const positions = new Map(seeded.positions.map((p) => [p.id, p]));

  return {
    registry,
    market,
    positions,
    priceLoanUnitsPerBtc: SATUSD_CENTS_PER_BTC_AT_SEED,
    now,
    liquidationHistory: [],
  };
}

export interface MarketView {
  id: string;
  collateralAsset: string;
  loanAsset: string;
  lltv: string; // decimal string, e.g. "0.86"
  utilization: string;
  supplyApy: string;
  borrowApy: string;
  totalSupplyAssets: string;
  totalBorrowAssets: string;
  tvlLoanUnits: string;
}

function wadToDecimalString(v: bigint, decimals = 4): string {
  const scale = 10n ** BigInt(decimals);
  const scaled = (v * scale) / WAD;
  const s = scaled.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export function marketView(world: World): MarketView {
  const { market } = world;
  const u = utilization(market.accounting.totalBorrowAssets, market.accounting.totalSupplyAssets);
  return {
    id: market.id,
    collateralAsset: market.params.collateralAsset,
    loanAsset: market.params.loanAsset,
    lltv: wadToDecimalString(market.params.lltv),
    utilization: wadToDecimalString(u),
    supplyApy: wadToDecimalString(supplyRate(u, market.params.irm)),
    borrowApy: wadToDecimalString(borrowRate(u, market.params.irm)),
    totalSupplyAssets: market.accounting.totalSupplyAssets.toString(),
    totalBorrowAssets: market.accounting.totalBorrowAssets.toString(),
    tvlLoanUnits: market.accounting.totalSupplyAssets.toString(),
  };
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
  // Exact bigint fields (WAD/sats), for callers that need to feed this back
  // into engine math (e.g. the copilot) without re-parsing the rounded
  // decimal strings above.
  lltvWad: string;
  currentPriceLoanUnitsPerBtc: string;
}

export function positionView(world: World, positionId: string): PositionView | undefined {
  const position = world.positions.get(positionId);
  if (!position) return undefined;
  const debt = debtOwed(position, world.market.accounting);
  const lltv = world.market.params.lltv;
  const ltv = loanToValue(debt, position.collateralSats, world.priceLoanUnitsPerBtc);
  const hf = healthFactor(debt, position.collateralSats, world.priceLoanUnitsPerBtc, lltv);
  const liqPrice = liquidationPrice(debt, position.collateralSats, lltv);

  return {
    id: position.id,
    borrower: position.borrower,
    vaultId: position.vaultId,
    status: position.status,
    collateralSats: position.collateralSats.toString(),
    debtOwed: debt.toString(),
    ltv: wadToDecimalString(ltv),
    healthFactor: wadToDecimalString(hf),
    liquidationPriceLoanUnitsPerBtc: liqPrice === null ? null : liqPrice.toString(),
    isLiquidatable: isLiquidatable(debt, position.collateralSats, world.priceLoanUnitsPerBtc, lltv),
    lltvWad: lltv.toString(),
    currentPriceLoanUnitsPerBtc: world.priceLoanUnitsPerBtc.toString(),
  };
}

export function listPositions(world: World): PositionView[] {
  return [...world.positions.keys()]
    .map((id) => positionView(world, id))
    .filter((v): v is PositionView => v !== undefined);
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

const BUCKETS: Array<{ label: string; max: bigint }> = [
  { label: "0-50%", max: (WAD * 50n) / 100n },
  { label: "50-70%", max: (WAD * 70n) / 100n },
  { label: "70-80%", max: (WAD * 80n) / 100n },
  { label: "80-86%", max: (WAD * 86n) / 100n },
  { label: "86%+", max: WAD * 100n },
];

export function riskView(world: World): RiskView {
  const lltv = world.market.params.lltv;
  const open = [...world.positions.values()].filter((p) => p.status === "open");

  const buckets = BUCKETS.map((b) => ({ label: b.label, count: 0, exposure: 0n }));
  for (const position of open) {
    const debt = debtOwed(position, world.market.accounting);
    const value = (position.collateralSats * world.priceLoanUnitsPerBtc) / SATS_PER_BTC;
    const ltv = value === 0n ? WAD : (debt * WAD) / value;
    const bucket = buckets.find((_b, i) => ltv <= BUCKETS[i].max) ?? buckets[buckets.length - 1];
    bucket.count += 1;
    bucket.exposure += debt;
  }

  const atRisk = findLiquidatablePositions(open, world.market.accounting, world.priceLoanUnitsPerBtc, lltv);

  return {
    buckets: buckets.map((b) => ({ label: b.label, count: b.count, exposureLoanUnits: b.exposure.toString() })),
    atRiskPositionIds: atRisk.map((p) => p.id),
    liquidationHistoryCount: world.liquidationHistory.length,
  };
}

// Mutators used by demo scripts / dev-only routes.
export function setPrice(world: World, priceLoanUnitsPerBtc: bigint): World {
  return { ...world, priceLoanUnitsPerBtc };
}

export function advanceTime(world: World, now: bigint): World {
  const accounting = accrueInterest(world.market.accounting, now, world.market.params.irm);
  const market = world.registry.update(world.market.id, accounting);
  return { ...world, market, now };
}

export function repayOnPosition(world: World, positionId: string, assets: bigint): World {
  const position = world.positions.get(positionId);
  if (!position) throw new Error(`unknown position: ${positionId}`);
  const result = repayPosition(position, world.market.accounting, assets);
  const market = world.registry.update(world.market.id, result.market);
  const positions = new Map(world.positions);
  positions.set(positionId, result.position);
  return { ...world, market, positions };
}

export function sweepLiquidations(world: World): World {
  const open = [...world.positions.values()].filter((p) => p.status === "open");
  const { liquidated, market: nextAccounting } = runLiquidationSweep(
    open,
    world.market.accounting,
    world.priceLoanUnitsPerBtc,
    world.market.params.lltv,
    world.now,
  );
  const market = world.registry.update(world.market.id, nextAccounting);
  const positions = new Map(world.positions);
  for (const result of liquidated) positions.set(result.position.id, result.position);
  return { ...world, market, positions, liquidationHistory: [...world.liquidationHistory, ...liquidated] };
}
