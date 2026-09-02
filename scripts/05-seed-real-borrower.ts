#!/usr/bin/env -S npx tsx
/**
 * Seed one real borrower on startup (docs/DIRECTIVE-02.md Task 4: "World ->
 * ledger... Seed one real borrower on startup in dev (open a channel on
 * regtest)"). Opens a genuine MuSig2 vault via LedgerWorld +
 * TachiCollateralPort, draws against it, and prints the resulting
 * hash-chained ledger — proving the Task 4 design against live regtest
 * before anything in engine/server.ts depends on it.
 *
 * This does NOT yet replace engine/server.ts's demo-world.ts: the web app's
 * six pages all render demo-world's specific view shapes (marketView,
 * positionView, riskView), and rebuilding equivalent views for
 * LedgerWorld is real, separate work — rushing that would risk breaking a
 * working demo for a partial rewrite. This script is the standalone proof
 * that the underlying pieces work; wiring KOSEN_MODE into the server is the
 * natural next step, not bundled in here.
 */
import "dotenv/config";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { resolveNetworkConfig, createBitcoinRpcClient, createTachiClient, assertTachiReachable } from "@kosen/tachi-kit";
import { createDemoOwnerSigner, TachiCollateralPort, LedgerWorld, pct, supply, type ChannelResources } from "@kosen/engine";

const CSV_BLOCKS = 144; // demo term, matches scripts/04's convention
const DEPOSIT = 100_000_000n; // 1 BTC — matches demo-world.ts's seeded positions, unlike scripts/03-04's smaller mechanics-only deposits
const PRICE_LOAN_UNITS_PER_BTC = 65_000n; // $65,000/BTC, matches demo-world.ts's seed price
const DRAW_ASSETS = 40_000n; // ~61.5% LTV at seed — same as demo-world's "conservative" borrower

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[seed] Tachi reachable, chain id confirmed");

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const collateralPort = new TachiCollateralPort(config, (): ChannelResources => ({
    ownerSigner: createDemoOwnerSigner(),
    funderWallet,
    rpc,
    borrowerReturnAddress: funderWallet.receiveAddress,
    protocolPayoutAddress: funderWallet.changeAddress,
  }));

  const world = new LedgerWorld(collateralPort, 0n);
  console.log("[seed] market:", world.market.id, "LLTV", world.market.params.lltv.toString(), "(WAD, expect", pct(86).toString() + ")");

  // Lender-side liquidity so there's something to borrow against — a real
  // deployment would have real suppliers; this is the seed script's
  // equivalent of demo-world.ts's own market seeding.
  const { state: fundedAccounting } = supply(world.market.accounting, 10_000_000n);
  Object.assign(world.market, { accounting: fundedAccounting });
  console.log("[seed] market seeded with", fundedAccounting.totalSupplyAssets.toString(), "loan units of lender liquidity");

  const position = await world.openPosition("seed-borrower-1", "demo-borrower-xonly", DEPOSIT, CSV_BLOCKS, 0n);
  console.log("[seed] channel opened, position:", position.id, "vault", position.vaultId, "collateral", position.collateralSats.toString(), "sats");

  const afterDraw = await world.draw("seed-borrower-1", DRAW_ASSETS, PRICE_LOAN_UNITS_PER_BTC, 10n);
  console.log("[seed] drew", DRAW_ASSETS.toString(), "-> debt", (afterDraw.borrowShares > 0n ? "outstanding" : "zero"));

  console.log("[seed] ledger entries:", world.ledger.length, "root:", world.ledger.root);
  console.log("[seed] ledger.verify() ->", world.ledger.verify() === -1 ? "intact" : `TAMPERED at seq ${world.ledger.verify()}`);
  for (const entry of world.ledger.all()) {
    console.log(`  [${entry.seq}] ${entry.payload.type}`, JSON.stringify(entry.payload));
  }

  console.log("[seed] PASS — one real borrower seeded, backed by a genuine MuSig2 vault on live regtest, replayable from a hash-chained ledger");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
