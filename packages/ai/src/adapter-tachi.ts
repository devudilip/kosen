// Maps live data onto ai/features.ts's FeatureInput (docs/DIRECTIVE-02.md
// Task 6: "map live listVaults, getAddressTransactions, subscribeVaultEvents
// breach receipts, and the engine's position history onto FeatureInput").
//
// Two genuinely different data sources feed this, on purpose:
//
// 1. Vault deposit history and prior-loan outcomes come from Kōsen's OWN
//    ledger (engine/ledger-world.ts's PositionLedgerEvent) — Tachi has no
//    concept of "a loan" or "a repayment"; that's Kōsen's business logic,
//    and we already have it authoritatively and instantly, with no network
//    round trip. Reconstructing it by scanning raw L1 transactions would be
//    both slower (getAddressTransactions is a full-chain scan — the SDK's
//    own doc warns ~17s for 2 matching txs on a small regtest chain) and
//    strictly less accurate than the data we already have.
// 2. Watchtower receipts (unilateral exit attempts) and the counterparty
//    graph are genuinely Tachi/Bitcoin-native — nothing in Kōsen's own
//    ledger could tell you this, so these two are real live calls.
import type {
  CounterpartyEdge,
  FeatureInput,
  PositionOutcome,
  PositionRecord,
  VaultEvent,
  WatchtowerReceipt,
} from "./features.js";
import type { createTachiClient } from "@kosen/tachi-kit";

type TachiClient = ReturnType<typeof createTachiClient>;

// Re-exported here to name the shape this module expects from the engine —
// kept structurally compatible with ledger-world.ts's PositionLedgerEvent
// rather than importing it directly, so this module doesn't force @kosen/ai
// to load the full engine surface for one type.
export interface PositionLedgerEventLike {
  readonly type: "position-opened" | "drawn" | "repaid" | "liquidated" | "closed";
  readonly positionId: string;
  readonly borrower?: string;
  readonly vaultAddress?: string;
  readonly collateralSats?: string;
  readonly timestamp?: string;
}

/**
 * Pure, no network — the part worth unit-testing. Filters a full ledger down
 * to one borrower's positions and derives both `vaultEvents` (one "deposit"
 * per position opened) and `positions` (prior-loan outcomes) from it.
 *
 * `enteredLiquidationBandCount` and `selfCured` are honestly reported as 0/
 * false: the current ledger doesn't yet track LTV crossing a warning band
 * over time (that would need a distinct event type this phase hasn't built).
 * Reporting a fabricated signal here would undermine the one property that
 * makes this credible — say so rather than guess.
 */
export function positionLedgerToFeatureSources(
  events: readonly PositionLedgerEventLike[],
  borrower: string,
  now: bigint,
): { vaultEvents: VaultEvent[]; positions: PositionRecord[] } {
  const positionIds = new Set(
    events.filter((e) => e.type === "position-opened" && e.borrower === borrower).map((e) => e.positionId),
  );

  const vaultEvents: VaultEvent[] = [];
  const outcomeByPosition = new Map<string, PositionOutcome>();
  const openedAtByPosition = new Map<string, bigint>();
  const closedAtByPosition = new Map<string, bigint>();
  const vaultIdByPosition = new Map<string, string>();

  for (const event of events) {
    if (!positionIds.has(event.positionId)) continue;

    switch (event.type) {
      case "position-opened": {
        const timestamp = BigInt(event.timestamp ?? "0");
        vaultIdByPosition.set(event.positionId, event.vaultAddress ?? event.positionId);
        openedAtByPosition.set(event.positionId, timestamp);
        outcomeByPosition.set(event.positionId, "open");
        vaultEvents.push({
          type: "deposit",
          vaultId: event.vaultAddress ?? event.positionId,
          amountSats: BigInt(event.collateralSats ?? "0"),
          timestamp,
        });
        break;
      }
      case "repaid":
        // A position that closes cleanly after being fully repaid is
        // marked "repaid" below by "closed"; an in-progress repay doesn't
        // change the outcome on its own.
        break;
      case "liquidated":
        outcomeByPosition.set(event.positionId, "liquidated");
        closedAtByPosition.set(event.positionId, BigInt(event.timestamp ?? now.toString()));
        break;
      case "closed":
        if (outcomeByPosition.get(event.positionId) !== "liquidated") {
          outcomeByPosition.set(event.positionId, "repaid");
        }
        closedAtByPosition.set(event.positionId, BigInt(event.timestamp ?? now.toString()));
        break;
    }
  }

  const positions: PositionRecord[] = [...positionIds].map((positionId) => ({
    vaultId: vaultIdByPosition.get(positionId) ?? positionId,
    openedAt: openedAtByPosition.get(positionId) ?? now,
    closedAt: closedAtByPosition.get(positionId) ?? null,
    outcome: outcomeByPosition.get(positionId) ?? "open",
    enteredLiquidationBandCount: 0,
    selfCured: false,
  }));

  return { vaultEvents, positions };
}

/**
 * Live Tachi call: unilateral exit attempts observed on this borrower's
 * vaults. Advisory-adjacent data, not money-moving — safe to call directly.
 *
 * FINDING (verified live): `getWatchtowerReceipts({ vault })` wants the
 * Tachi *vault ID* — the derived hash from `registerVault`
 * (`sha256(fundingTxid || be32(vout))`, what CollateralPort.open() returns
 * as `channelId`) — NOT the vault's P2TR address. Passing the address gets
 * a 400 "invalid vault id". This is a different identifier than
 * `fetchCounterpartyEdges` below wants (an address), despite both being
 * "the vault" colloquially — do not conflate them.
 */
export async function fetchWatchtowerReceipts(tachi: TachiClient, vaultIds: readonly string[]): Promise<WatchtowerReceipt[]> {
  const receipts: WatchtowerReceipt[] = [];
  for (const vaultId of vaultIds) {
    const raw = await tachi.getWatchtowerReceipts({ vault: vaultId });
    // getWatchtowerReceipts returns Record<string, unknown> in the SDK's own
    // types (undocumented shape) — treat defensively rather than assume a
    // schema. A receipt list, if present, is expected under `receipts`.
    const list = Array.isArray((raw as { receipts?: unknown }).receipts) ? (raw as { receipts: unknown[] }).receipts : [];
    for (const entry of list) {
      const timestamp = extractTimestamp(entry);
      receipts.push({ vaultId, type: "exitAttempt", timestamp });
    }
  }
  return receipts;
}

function extractTimestamp(entry: unknown): bigint {
  if (entry && typeof entry === "object" && "time" in entry && typeof (entry as { time: unknown }).time === "number") {
    return BigInt(Math.floor((entry as { time: number }).time));
  }
  return 0n;
}

/**
 * Live Tachi call: the counterparty graph from this address's transaction
 * history. `getAddressTransactions` is a full-chain scan on the daemon side
 * (its own doc warns latency grows with chain height) — always pass a small
 * `pageSize` and expect this to be the slow part of live scoring.
 */
export async function fetchCounterpartyEdges(
  tachi: TachiClient,
  address: string,
  borrowerXOnlyHex: string,
  pageSize = 25,
): Promise<CounterpartyEdge[]> {
  const response = await tachi.getAddressTransactions(address, { pageSize });
  const counts = new Map<string, number>();

  for (const tx of response.transactions) {
    for (const vout of tx.vout) {
      if (!vout.owner || vout.owner === borrowerXOnlyHex) continue;
      counts.set(vout.owner, (counts.get(vout.owner) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([counterparty, txCount]) => ({ counterparty, txCount }));
}

export interface BorrowerChannel {
  readonly vaultId: string; // Tachi's derived vault ID hash — what CollateralPort.open() returns as channelId
  readonly vaultAddress: string; // the vault's P2TR address
}

export interface BuildLiveFeatureInputArgs {
  readonly tachi: TachiClient;
  readonly positionLedger: readonly PositionLedgerEventLike[];
  readonly borrower: string; // x-only pubkey
  readonly channels: readonly BorrowerChannel[]; // this borrower's known channels
  readonly priceSeries?: FeatureInput["priceSeries"]; // no live price-history service yet — caller supplies what it has
  readonly now: bigint;
  /** Called when a live Tachi call fails and this module degrades to an empty result for it. Defaults to console.warn. */
  readonly onWarning?: (message: string) => void;
}

/**
 * Orchestrates the full live extraction. This is what
 * scripts/06-score-live-borrower.ts calls.
 *
 * FINDING (verified live): `getAddressTransactions` is a documented
 * full-chain scan (the SDK's own doc warns latency grows with chain
 * height), and on a regtest chain that's accumulated a lot of blocks from
 * heavy testing, it can exceed the client's request timeout entirely. A
 * borrower's counterparty graph is real signal but not essential — the
 * scorer already treats an empty counterpartyEdges list as "no data" rather
 * than a red flag — so a failure here degrades to an empty result instead
 * of failing the whole feature extraction. Watchtower receipts get the same
 * treatment for the same reason: neither is worth blocking a credit score on.
 */
export async function buildLiveFeatureInput(args: BuildLiveFeatureInputArgs): Promise<FeatureInput> {
  const warn = args.onWarning ?? ((message: string) => console.warn(`[adapter-tachi] ${message}`));
  const { vaultEvents, positions } = positionLedgerToFeatureSources(args.positionLedger, args.borrower, args.now);

  const watchtowerReceipts = await fetchWatchtowerReceipts(
    args.tachi,
    args.channels.map((c) => c.vaultId),
  ).catch((err) => {
    warn(`getWatchtowerReceipts failed, degrading to no receipts: ${(err as Error).message}`);
    return [];
  });

  const counterpartyMaps = await Promise.all(
    args.channels.map((c) =>
      fetchCounterpartyEdges(args.tachi, c.vaultAddress, args.borrower).catch((err) => {
        warn(`getAddressTransactions failed for ${c.vaultAddress}, degrading to no counterparty data: ${(err as Error).message}`);
        return [] as CounterpartyEdge[];
      }),
    ),
  );
  const counterpartyEdges = mergeCounterpartyEdges(counterpartyMaps.flat());

  return {
    vaultEvents,
    positions,
    priceSeries: args.priceSeries ?? [],
    watchtowerReceipts,
    counterpartyEdges,
  };
}

function mergeCounterpartyEdges(edges: readonly CounterpartyEdge[]): CounterpartyEdge[] {
  const merged = new Map<string, number>();
  for (const edge of edges) merged.set(edge.counterparty, (merged.get(edge.counterparty) ?? 0) + edge.txCount);
  return [...merged.entries()].map(([counterparty, txCount]) => ({ counterparty, txCount }));
}
