#!/usr/bin/env -S npx tsx
/**
 * Live run of ai/adapter-tachi.ts (docs/DIRECTIVE-02.md Task 6): open one
 * real channel on regtest, draw against it, then extract a FeatureInput
 * using the REAL adapter — engine's own ledger for vault/position history,
 * and genuine live Tachi calls (getWatchtowerReceipts,
 * getAddressTransactions) for the two things only Tachi can answer.
 *
 * Note on realism: a freshly opened vault genuinely has thin history — one
 * deposit, no prior positions, no counterparties yet. That's not a bug in
 * the adapter; it's the honest result for a brand-new borrower
 * (docs/AGENT-BRIEF.md's own troubleshooting note: "a borrower with no
 * history makes a boring demo" — which is exactly why ai/demo-score.ts's
 * fixture path exists for the *demo*, while this script proves the *live
 * mapping* actually works against real infrastructure).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { resolveNetworkConfig, createBitcoinRpcClient, createTachiClient, assertTachiReachable } from "@kosen/tachi-kit";
import { createDemoOwnerSigner, TachiCollateralPort, LedgerWorld, supply, type ChannelResources } from "@kosen/engine";
import { extractFeatures, buildLiveFeatureInput, scoreCreditRisk } from "@kosen/ai";

const CSV_BLOCKS = 144;
const DEPOSIT = 100_000_000n; // 1 BTC, matches scripts/05's convention
const PRICE_LOAN_UNITS_PER_BTC = 65_000n;
const DRAW_ASSETS = 40_000n;
const BORROWER_ID = "live-score-borrower-xonly";

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[score-live] Tachi reachable, chain id confirmed");

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
  const { state: fundedAccounting } = supply(world.market.accounting, 10_000_000n);
  Object.assign(world.market, { accounting: fundedAccounting });

  const position = await world.openPosition("live-score-position", BORROWER_ID, DEPOSIT, CSV_BLOCKS, 0n);
  const vaultId = world.state.channelIdByPosition.get(position.id)!; // Tachi's vault ID hash — NOT the same as position.vaultId (the P2TR address)
  console.log("[score-live] channel opened, vault address", position.vaultId, "vaultId", vaultId);
  await world.draw("live-score-position", DRAW_ASSETS, PRICE_LOAN_UNITS_PER_BTC, 10n);
  console.log("[score-live] drew", DRAW_ASSETS.toString(), "loan units");

  console.log("[score-live] extracting live feature input (real watchtower + address-tx calls)...");
  const input = await buildLiveFeatureInput({
    tachi,
    positionLedger: world.ledger.all().map((e) => e.payload),
    borrower: BORROWER_ID,
    channels: [{ vaultId, vaultAddress: position.vaultId }],
    now: 20n,
  });

  const features = extractFeatures(input, 20n);
  console.log("[score-live] live feature vector:");
  console.log(JSON.stringify(features, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[score-live] no ANTHROPIC_API_KEY set — feature extraction verified live; skipping the actual score");
    console.log("[score-live] PASS — live feature extraction works end to end");
    return;
  }

  const client = new Anthropic({ apiKey });
  const result = await scoreCreditRisk(client, BORROWER_ID, features);
  console.log("[score-live] live score:", JSON.stringify(result.clamped, null, 2));
  console.log("[score-live] PASS — live feature extraction and live scoring both work end to end");
}

main().catch((err) => {
  console.error("[score-live] failed:", err);
  process.exit(1);
});
