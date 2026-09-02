import { SECONDS_PER_YEAR, WAD } from "./units.js";
import { borrowRate, type IrmParams, KINKED_IRM, utilization } from "./irm.js";

// Virtual shares/assets offset (Morpho-Blue style) so the first depositor
// cannot mint a share price that lets them steal later depositors' rounding
// dust. Never let totalShares or totalAssets be used raw without this offset.
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

export interface MarketAccounting {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint; // unix seconds
}

export function emptyMarketAccounting(now: bigint): MarketAccounting {
  return {
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    lastUpdate: now,
  };
}

type RoundDir = "down" | "up";

function mulDivRound(a: bigint, b: bigint, denom: bigint, round: RoundDir): bigint {
  if (denom === 0n) throw new Error("mulDivRound: division by zero");
  const product = a * b;
  if (round === "down") return product / denom;
  return (product + denom - 1n) / denom;
}

// assets -> shares. Round toward the protocol: "down" when the user is the
// one receiving shares for their deposit (mint fewer, never more), "up" when
// the protocol is computing shares it must burn/repay to charge for.
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivRound(
    assets,
    totalShares + VIRTUAL_SHARES,
    totalAssets + VIRTUAL_ASSETS,
    "up",
  );
}

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivRound(
    assets,
    totalShares + VIRTUAL_SHARES,
    totalAssets + VIRTUAL_ASSETS,
    "down",
  );
}

export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivRound(
    shares,
    totalAssets + VIRTUAL_ASSETS,
    totalShares + VIRTUAL_SHARES,
    "up",
  );
}

export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivRound(
    shares,
    totalAssets + VIRTUAL_ASSETS,
    totalShares + VIRTUAL_SHARES,
    "down",
  );
}

// Supply: depositing mints shares rounded down (never overmint); withdrawing
// by asset amount burns shares rounded up (never let the withdrawer shortchange
// remaining suppliers).
export function supply(m: MarketAccounting, assets: bigint): { state: MarketAccounting; sharesMinted: bigint } {
  const sharesMinted = toSharesDown(assets, m.totalSupplyAssets, m.totalSupplyShares);
  return {
    state: {
      ...m,
      totalSupplyAssets: m.totalSupplyAssets + assets,
      totalSupplyShares: m.totalSupplyShares + sharesMinted,
    },
    sharesMinted,
  };
}

export function withdraw(m: MarketAccounting, assets: bigint): { state: MarketAccounting; sharesBurned: bigint } {
  if (assets > m.totalSupplyAssets - m.totalBorrowAssets) {
    throw new Error("withdraw: insufficient liquidity");
  }
  const sharesBurned = toSharesUp(assets, m.totalSupplyAssets, m.totalSupplyShares);
  if (sharesBurned > m.totalSupplyShares) throw new Error("withdraw: exceeds total supply shares");
  return {
    state: {
      ...m,
      totalSupplyAssets: m.totalSupplyAssets - assets,
      totalSupplyShares: m.totalSupplyShares - sharesBurned,
    },
    sharesBurned,
  };
}

// Borrow: borrowing mints borrow shares rounded up (the borrower always owes
// at least as much as they took); repaying by asset amount burns shares
// rounded down (never let a repayer erase more debt than they paid for).
export function borrow(m: MarketAccounting, assets: bigint): { state: MarketAccounting; sharesMinted: bigint } {
  if (assets > m.totalSupplyAssets - m.totalBorrowAssets) {
    throw new Error("borrow: insufficient liquidity");
  }
  const sharesMinted = toSharesUp(assets, m.totalBorrowAssets, m.totalBorrowShares);
  return {
    state: {
      ...m,
      totalBorrowAssets: m.totalBorrowAssets + assets,
      totalBorrowShares: m.totalBorrowShares + sharesMinted,
    },
    sharesMinted,
  };
}

export function repay(m: MarketAccounting, assets: bigint): { state: MarketAccounting; sharesBurned: bigint } {
  const sharesBurned = toSharesDown(assets, m.totalBorrowAssets, m.totalBorrowShares);
  if (sharesBurned > m.totalBorrowShares) throw new Error("repay: exceeds total borrow shares");
  return {
    state: {
      ...m,
      totalBorrowAssets: m.totalBorrowAssets - assets,
      totalBorrowShares: m.totalBorrowShares - sharesBurned,
    },
    sharesBurned,
  };
}

// Accrue interest since lastUpdate at the IRM's rate for current utilization.
// Interest is minted into totalBorrowAssets (what borrowers owe) and
// totalSupplyAssets (what suppliers are owed) symmetrically — share counts
// are untouched, so the interest is realized purely as a share-price increase.
// This is why interest must NEVER be accrued per-position: the index approach
// here is O(1) regardless of how many positions exist in the market.
export function accrueInterest(
  m: MarketAccounting,
  now: bigint,
  irmParams: IrmParams = KINKED_IRM,
): MarketAccounting {
  if (now < m.lastUpdate) throw new Error("accrueInterest: time moved backwards");
  const elapsed = now - m.lastUpdate;
  if (elapsed === 0n) return m;
  if (m.totalBorrowAssets === 0n) return { ...m, lastUpdate: now };

  const u = utilization(m.totalBorrowAssets, m.totalSupplyAssets);
  const rate = borrowRate(u, irmParams); // WAD annual fraction
  const interest = (m.totalBorrowAssets * rate * elapsed) / (WAD * SECONDS_PER_YEAR);

  return {
    ...m,
    totalBorrowAssets: m.totalBorrowAssets + interest,
    totalSupplyAssets: m.totalSupplyAssets + interest,
    lastUpdate: now,
  };
}
