// View functions for LedgerWorld (KOSEN_MODE=tachi) — the real counterpart
// to demo-world.ts's marketView/positionView/riskView, kept field-compatible
// with those so the web app's existing rendering logic just works, with one
// addition: docs/DIRECTIVE-02.md Task 7's transparency data — vault
// address, live L1 balance, state number, share, and "what happens if I
// default" (the pre-signed refund's actual outputs, not a description of
// them). Unlike demo-world's views, position lookups here are async: a live
// L1 balance read is a real network call.
import {
  debtOwed,
  healthFactor,
  isLiquidatable,
  liquidationPrice,
  loanToValue,
  findLiquidatablePositions,
  utilization,
  supplyRate,
  borrowRate,
  WAD,
  type CollateralPort,
} from "./index.js";
import { wadToDecimalString, type MarketView, type PositionView, type RiskView } from "./demo-world.js";
import type { LedgerWorld } from "./ledger-world.js";

export function ledgerMarketView(world: LedgerWorld): MarketView {
  const accounting = world.state.market;
  const u = utilization(accounting.totalBorrowAssets, accounting.totalSupplyAssets);
  return {
    id: world.market.id,
    collateralAsset: world.market.params.collateralAsset,
    loanAsset: world.market.params.loanAsset,
    lltv: wadToDecimalString(world.market.params.lltv),
    utilization: wadToDecimalString(u),
    supplyApy: wadToDecimalString(supplyRate(u, world.market.params.irm)),
    borrowApy: wadToDecimalString(borrowRate(u, world.market.params.irm)),
    totalSupplyAssets: accounting.totalSupplyAssets.toString(),
    totalBorrowAssets: accounting.totalBorrowAssets.toString(),
    tvlLoanUnits: accounting.totalSupplyAssets.toString(),
  };
}

export interface DefaultOutcome {
  readonly n: string;
  /** Sats the protocol's refund output pays out, on liquidation. */
  readonly shareSats: string;
  /** Sats that return to the borrower's revocable to_local, on liquidation. */
  readonly userValueSats: string;
  readonly protocolPayoutAddress: string;
  /** The liquidation transaction's own hash — computed from the held, unbroadcast refund. Not a confirmation. */
  readonly refundTxid: string;
}

export interface ChannelView {
  readonly vaultAddress: string;
  readonly vaultId: string;
  readonly termBlocks: number;
  readonly exitTxHex: string;
  /** Live read via bitcoind scantxoutset — null if the read failed or wasn't attempted. */
  readonly l1BalanceSats: string | null;
  /** null until commit() has been called at least once for this channel. This IS the "what happens if I default" panel's data. */
  readonly latestState: DefaultOutcome | null;
}

export interface LedgerPositionView extends PositionView {
  readonly channel: ChannelView | null;
}

export interface LedgerPositionViewOptions {
  readonly collateralPort: CollateralPort;
  /** Live L1 balance reader (e.g. tachi-kit's getVaultBalanceSats bound to an rpc client). Omit to skip the live read entirely. */
  readonly readL1BalanceSats?: (vaultAddress: string) => Promise<bigint>;
}

export async function ledgerPositionView(
  world: LedgerWorld,
  positionId: string,
  priceLoanUnitsPerBtc: bigint,
  options: LedgerPositionViewOptions,
): Promise<LedgerPositionView | undefined> {
  const state = world.state;
  const position = state.positions.get(positionId);
  if (!position) return undefined;

  const debt = debtOwed(position, state.market);
  const lltv = world.market.params.lltv;
  const ltv = loanToValue(debt, position.collateralSats, priceLoanUnitsPerBtc);
  const hf = healthFactor(debt, position.collateralSats, priceLoanUnitsPerBtc, lltv);
  const liqPrice = liquidationPrice(debt, position.collateralSats, lltv);

  const channel = await buildChannelView(world, positionId, options);

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
    isLiquidatable: isLiquidatable(debt, position.collateralSats, priceLoanUnitsPerBtc, lltv),
    lltvWad: lltv.toString(),
    currentPriceLoanUnitsPerBtc: priceLoanUnitsPerBtc.toString(),
    channel,
  };
}

async function buildChannelView(
  world: LedgerWorld,
  positionId: string,
  options: LedgerPositionViewOptions,
): Promise<ChannelView | null> {
  const channelId = world.state.channelIdByPosition.get(positionId);
  if (!channelId) return null;

  const snapshot = await options.collateralPort.getSnapshot(channelId);
  if (!snapshot) return null;

  let l1BalanceSats: string | null = null;
  if (options.readL1BalanceSats) {
    try {
      l1BalanceSats = (await options.readL1BalanceSats(snapshot.vaultAddress)).toString();
    } catch {
      l1BalanceSats = null; // live read failed — degrade to "unavailable", never fail the whole view
    }
  }

  return {
    vaultAddress: snapshot.vaultAddress,
    vaultId: channelId,
    termBlocks: snapshot.termBlocks,
    exitTxHex: snapshot.exitTxHex,
    l1BalanceSats,
    latestState: snapshot.latestState
      ? {
          n: snapshot.latestState.n.toString(),
          shareSats: snapshot.latestState.shareSats.toString(),
          userValueSats: snapshot.latestState.userValueSats.toString(),
          protocolPayoutAddress: snapshot.latestState.protocolPayoutAddress,
          refundTxid: snapshot.latestState.refundTxid,
        }
      : null,
  };
}

export async function listLedgerPositions(
  world: LedgerWorld,
  priceLoanUnitsPerBtc: bigint,
  options: LedgerPositionViewOptions,
): Promise<LedgerPositionView[]> {
  const views = await Promise.all(
    [...world.state.positions.keys()].map((id) => ledgerPositionView(world, id, priceLoanUnitsPerBtc, options)),
  );
  return views.filter((v): v is LedgerPositionView => v !== undefined);
}

const BUCKETS: Array<{ label: string; max: bigint }> = [
  { label: "0-50%", max: (WAD * 50n) / 100n },
  { label: "50-70%", max: (WAD * 70n) / 100n },
  { label: "70-80%", max: (WAD * 80n) / 100n },
  { label: "80-86%", max: (WAD * 86n) / 100n },
  { label: "86%+", max: WAD * 100n },
];

export function ledgerRiskView(world: LedgerWorld, priceLoanUnitsPerBtc: bigint): RiskView {
  const state = world.state;
  const lltv = world.market.params.lltv;
  const open = [...state.positions.values()].filter((p) => p.status === "open");

  const buckets = BUCKETS.map((b) => ({ label: b.label, count: 0, exposure: 0n }));
  for (const position of open) {
    const debt = debtOwed(position, state.market);
    const value = (position.collateralSats * priceLoanUnitsPerBtc) / 100_000_000n;
    const ltv = value === 0n ? WAD : (debt * WAD) / value;
    const bucket = buckets.find((_b, i) => ltv <= BUCKETS[i].max) ?? buckets[buckets.length - 1];
    bucket.count += 1;
    bucket.exposure += debt;
  }

  const atRisk = findLiquidatablePositions(open, state.market, priceLoanUnitsPerBtc, lltv);
  const liquidationHistoryCount = world.ledger.all().filter((e) => e.payload.type === "liquidated").length;

  return {
    buckets: buckets.map((b) => ({ label: b.label, count: b.count, exposureLoanUnits: b.exposure.toString() })),
    atRiskPositionIds: atRisk.map((p) => p.id),
    liquidationHistoryCount,
  };
}
