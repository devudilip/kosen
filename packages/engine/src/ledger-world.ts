// Real server state — an append-only, hash-chained ledger of positions,
// replacing demo-world.ts's plain in-memory Map (docs/DIRECTIVE-02.md
// Task 4: "World -> ledger"). demo-world.ts is kept as-is for KOSEN_MODE=sim
// (offline dev and tests); this module is what backs KOSEN_MODE=tachi.
//
// Design: each event records what was ALREADY validated and committed
// through a CollateralPort call — fold() mechanically applies the resulting
// accounting, it does not re-run authorization checks (those already
// happened, against the price/LLTV in effect at the time, before the event
// was appended). That's what makes the ledger a genuine audit trail rather
// than a second copy of the business logic: replaying it from genesis
// always reproduces the exact same state, and any edit to history breaks
// the hash chain (ledger.ts's own guarantee).
import { Ledger } from "./ledger.js";
import { BTC_TO_SATUSD, MarketRegistry, type Market, type MarketId } from "./market.js";
import { borrow as borrowShares, repay as repayShares, type MarketAccounting } from "./shares.js";
import {
  debtOwed,
  draw as drawPure,
  openPosition as openPositionPure,
  repay as repayPure,
  type Position,
} from "./position.js";
import { liquidate as liquidatePure, DEFAULT_LIQUIDATION_INCENTIVE_BPS } from "./liquidation.js";
import { findLiquidatablePositions } from "./liquidator.js";
import type { CollateralPort } from "./collateral-port.js";

export type PositionLedgerEvent =
  | {
      type: "position-opened";
      positionId: string;
      marketId: MarketId;
      borrower: string;
      channelId: string;
      vaultAddress: string;
      collateralSats: string;
      timestamp: string;
    }
  | { type: "drawn"; positionId: string; assets: string; refundTxid: string; shareSats: string }
  | { type: "repaid"; positionId: string; assets: string; refundTxid: string | null; shareSats: string | null }
  | {
      type: "liquidated";
      positionId: string;
      debtRepaid: string;
      collateralSeized: string;
      collateralToBorrower: string;
      badDebt: boolean;
      txid: string;
      timestamp: string;
    }
  | { type: "closed"; positionId: string; txid: string; timestamp: string };

export interface FoldedState {
  readonly market: MarketAccounting;
  readonly positions: ReadonlyMap<string, Position>;
  readonly channelIdByPosition: ReadonlyMap<string, string>;
}

/** Pure fold — the entire ledger, reduced to current state. Never mutated incrementally; always re-derived. */
export function foldPositionLedger(ledger: Ledger<PositionLedgerEvent>, initialMarket: MarketAccounting): FoldedState {
  return ledger.fold<FoldedState>(
    (state, entry) => {
      const event = entry.payload;
      switch (event.type) {
        case "position-opened": {
          const position = openPositionPure(
            event.positionId,
            event.marketId,
            event.borrower,
            event.vaultAddress,
            BigInt(event.collateralSats),
            BigInt(event.timestamp),
          );
          const positions = new Map(state.positions);
          positions.set(position.id, position);
          const channelIdByPosition = new Map(state.channelIdByPosition);
          channelIdByPosition.set(position.id, event.channelId);
          return { ...state, positions, channelIdByPosition };
        }
        case "drawn": {
          const position = requirePosition(state, event.positionId);
          const { state: market, sharesMinted } = borrowShares(state.market, BigInt(event.assets));
          const positions = new Map(state.positions);
          positions.set(position.id, { ...position, borrowShares: position.borrowShares + sharesMinted });
          return { ...state, market, positions };
        }
        case "repaid": {
          const position = requirePosition(state, event.positionId);
          const { state: market, sharesBurned } = repayShares(state.market, BigInt(event.assets));
          const positions = new Map(state.positions);
          positions.set(position.id, { ...position, borrowShares: position.borrowShares - sharesBurned });
          return { ...state, market, positions };
        }
        case "liquidated": {
          const position = requirePosition(state, event.positionId);
          const { state: market } = repayShares(state.market, BigInt(event.debtRepaid));
          const positions = new Map(state.positions);
          positions.set(position.id, {
            ...position,
            borrowShares: 0n,
            collateralSats: 0n,
            status: "liquidated",
            closedAt: BigInt(event.timestamp),
          });
          return { ...state, market, positions };
        }
        case "closed": {
          const position = requirePosition(state, event.positionId);
          const positions = new Map(state.positions);
          positions.set(position.id, { ...position, status: "closed", closedAt: BigInt(event.timestamp) });
          return { ...state, positions };
        }
      }
    },
    { market: initialMarket, positions: new Map(), channelIdByPosition: new Map() },
  );
}

function requirePosition(state: FoldedState, positionId: string): Position {
  const position = state.positions.get(positionId);
  if (!position) throw new Error(`foldPositionLedger: event references unknown position ${positionId}`);
  return position;
}

// Default penalty for every commit — matches engine/liquidation.ts's
// DEFAULT_LIQUIDATION_INCENTIVE_BPS so the refund share committed to the
// vault always matches what the deterministic liquidator will actually seize.
const PENALTY_BPS = DEFAULT_LIQUIDATION_INCENTIVE_BPS;

/**
 * The real, ledger-backed world. Every mutating call does the real
 * CollateralPort operation FIRST (open a vault, commit a refund state,
 * broadcast a liquidation, close a channel) and only appends the ledger
 * event once that succeeds — so the ledger can never claim something
 * happened on Bitcoin that didn't.
 */
export class LedgerWorld {
  readonly ledger = new Ledger<PositionLedgerEvent>();
  readonly market: Market;
  private readonly registry = new MarketRegistry();

  constructor(private readonly collateralPort: CollateralPort, now: bigint) {
    this.market = this.registry.create(BTC_TO_SATUSD, now);
  }

  get state(): FoldedState {
    return foldPositionLedger(this.ledger, this.market.accounting);
  }

  async openPosition(
    positionId: string,
    borrower: string,
    amountSats: bigint,
    termBlocks: number,
    now: bigint,
  ): Promise<Position> {
    const opened = await this.collateralPort.open({ borrowerPub: borrower, amountSats, termBlocks });
    this.ledger.append(
      {
        type: "position-opened",
        positionId,
        marketId: this.market.id,
        borrower,
        channelId: opened.channelId,
        vaultAddress: opened.vaultAddress,
        collateralSats: amountSats.toString(),
        timestamp: now.toString(),
      },
      now,
    );
    return this.state.positions.get(positionId)!;
  }

  async draw(positionId: string, assets: bigint, priceLoanUnitsPerBtc: bigint, now: bigint): Promise<Position> {
    const state = this.state;
    const position = requirePosition(state, positionId);
    const channelId = state.channelIdByPosition.get(positionId);
    if (!channelId) throw new Error(`draw: no channel recorded for position ${positionId}`);

    // Validate the LLTV BEFORE touching Bitcoin — draw() throws if this
    // would push the position over its LLTV, exactly like position.test.ts
    // already covers.
    const projected = drawPure(position, state.market, assets, priceLoanUnitsPerBtc, this.market.params.lltv);
    const projectedDebt = debtOwed(projected.position, projected.market);

    const commit = await this.collateralPort.commit(channelId, {
      collateralSats: position.collateralSats,
      debtSats: projectedDebt,
      lltvWad: this.market.params.lltv,
      penaltyBps: PENALTY_BPS,
      priceWad: priceLoanUnitsPerBtc,
    });
    this.ledger.append(
      { type: "drawn", positionId, assets: assets.toString(), refundTxid: commit.refundTxid, shareSats: commit.shareSats.toString() },
      now,
    );
    return this.state.positions.get(positionId)!;
  }

  async repay(positionId: string, assets: bigint, priceLoanUnitsPerBtc: bigint, now: bigint): Promise<Position> {
    const state = this.state;
    const position = requirePosition(state, positionId);
    const channelId = state.channelIdByPosition.get(positionId);
    if (!channelId) throw new Error(`repay: no channel recorded for position ${positionId}`);

    const projected = repayPure(position, state.market, assets);
    const remainingDebt = debtOwed(projected.position, projected.market);

    // A fully repaid position has nothing left to commit a refund state
    // for — commitState requires debt > 0 (see health.ts's
    // shareForLiquidation, which is 0 with no debt to secure).
    let refundTxid: string | null = null;
    let shareSats: string | null = null;
    if (remainingDebt > 0n) {
      const commit = await this.collateralPort.commit(channelId, {
        collateralSats: position.collateralSats,
        debtSats: remainingDebt,
        lltvWad: this.market.params.lltv,
        penaltyBps: PENALTY_BPS,
        priceWad: priceLoanUnitsPerBtc,
      });
      refundTxid = commit.refundTxid;
      shareSats = commit.shareSats.toString();
    }

    this.ledger.append({ type: "repaid", positionId, assets: assets.toString(), refundTxid, shareSats }, now);
    return this.state.positions.get(positionId)!;
  }

  /** Deterministic sweep: for every liquidatable position, broadcast its already-committed refund and record the outcome. */
  async sweepLiquidations(priceLoanUnitsPerBtc: bigint, now: bigint): Promise<Position[]> {
    const liquidatedPositions: Position[] = [];
    let state = this.state;
    const candidates = findLiquidatablePositions([...state.positions.values()], state.market, priceLoanUnitsPerBtc, this.market.params.lltv);

    for (const position of candidates) {
      const channelId = state.channelIdByPosition.get(position.id);
      if (!channelId) throw new Error(`sweepLiquidations: no channel recorded for position ${position.id}`);

      const result = liquidatePure(position, state.market, priceLoanUnitsPerBtc, this.market.params.lltv, PENALTY_BPS, now);
      const { txid } = await this.collateralPort.liquidate(channelId);

      this.ledger.append(
        {
          type: "liquidated",
          positionId: position.id,
          debtRepaid: result.debtRepaid.toString(),
          collateralSeized: result.collateralSeized.toString(),
          collateralToBorrower: result.collateralToBorrower.toString(),
          badDebt: result.badDebt,
          txid,
          timestamp: now.toString(),
        },
        now,
      );

      state = this.state;
      liquidatedPositions.push(state.positions.get(position.id)!);
    }

    return liquidatedPositions;
  }

  async closePosition(positionId: string, toAddress: string, now: bigint): Promise<Position> {
    const state = this.state;
    const position = requirePosition(state, positionId);
    if (debtOwed(position, state.market) !== 0n) {
      throw new Error(`closePosition: outstanding debt must be repaid first for ${positionId}`);
    }
    const channelId = state.channelIdByPosition.get(positionId);
    if (!channelId) throw new Error(`closePosition: no channel recorded for position ${positionId}`);

    const { txid } = await this.collateralPort.close(channelId, toAddress);
    this.ledger.append({ type: "closed", positionId, txid, timestamp: now.toString() }, now);
    return this.state.positions.get(positionId)!;
  }
}
