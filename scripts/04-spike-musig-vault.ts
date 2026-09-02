#!/usr/bin/env -S npx tsx
/**
 * Spike 04 — does `commitment.ts` (vendored from satusd, docs/DIRECTIVE-02.md
 * Task 2/3) actually work end to end against live regtest? Their own spike
 * proved the *inline* logic; this is the first live run of the *extracted*
 * module boundary. Uses `openCollateral`/`broadcastLiquidation` as-is, but
 * NOT `commitState` — see the LLTV_KOSEN_BPS comment below for two real bugs
 * found in it for Kōsen's use, worked around here by building the refund
 * PSBT directly with Kōsen's own math. This is what
 * engine/src/collateral-tachi.ts (Task 3) is about to build on.
 *
 * Uses fresh ephemeral MuSig2 keypairs (not the shared demo mnemonic), so
 * this vault can never collide with satusd's own concurrent work.
 *
 * The composite owner signer below drives BOTH parties' real
 * `createAggSigner` instances concurrently in one process — a stand-in for
 * the borrower-client/engine HTTP round trip musig.ts's own doc comment
 * describes. `commitment.ts` itself does not know or care; it only sees one
 * `AggSigner`.
 *
 * Acceptance: openCollateral registers a vault with P_agg as owner; the
 * pre-signed exit_tx is rejected before the CSV and accepted after; a
 * committed refund state is cosigned by the real 5-of-7 quorum, and
 * broadcastLiquidation mines it.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import {
  buildRefundPsbt,
  signRefundPsbtAsUser,
  cosignRefund,
  finalizeRefundPsbt,
  encodeStateHint,
} from "@tachibtc/taurus-vault-core";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  checkQuorum,
  createAggSigner,
  createInProcessExchangePair,
  openCollateral,
  broadcastLiquidation,
  type AggSigner,
} from "@kosen/tachi-kit";

const CSV_BLOCKS = 144; // demo term (~1 day on mainnet), COLLATERAL-MODEL.md §3
const DEPOSIT = 300_000n;
const PENALTY_BPS = 500n; // 5%
// Kōsen's own LTV (<=100%, e.g. 86%) — NOT to be confused with commitment.ts's
// commitState()/shareForLiquidation(), which is satusd's satUSD-specific
// collateralization-RATIO math (>=100%, e.g. 150%). FINDING: feeding an 86
// "lltvBps" into that function computes a wildly wrong liquidation price
// (verified: shareSats saturates at 100% of collateral — the two models
// divide by the threshold in opposite places). commitState() also has a
// second, independent bug: userValueSats doesn't reserve room for feeSats,
// so sum(outputs) == funding.valueSats exactly and buildRefundPsbt rejects
// it as an amount mismatch once you add a fee on top. Both are real bugs in
// the vendored module, not something to patch locally (see sync-kit.sh's
// "do not edit the vendored copy" rule) — so this script bypasses
// commitState and builds the refund PSBT directly, using Kōsen's own
// LTV-based share formula (COLLATERAL-MODEL.md §3.5). This is exactly what
// engine/src/collateral-tachi.ts (Task 3) does for real.
const LLTV_KOSEN_BPS = 8_600n; // 86%

/** COLLATERAL-MODEL.md §3.5, in bps: share = collateral * lltv * (1+penalty). */
function kosenShareForLiquidation(collateralSats: bigint, lltvBps: bigint, penaltyBps: bigint): bigint {
  const raw = (collateralSats * lltvBps * (10_000n + penaltyBps)) / 100_000_000n;
  return raw > collateralSats ? collateralSats : raw;
}

/** Drives both real MuSig2 parties concurrently, in-process — a spike-only stand-in for the HTTP round trip. */
function makeSpikeOwnerSigner(borrowerSecret: Buffer, protocolSecret: Buffer): AggSigner {
  const borrowerPub = Buffer.from(IndividualPubkey(borrowerSecret));
  const protocolPub = Buffer.from(IndividualPubkey(protocolSecret));
  const [exchangeForBorrower, exchangeForProtocol] = createInProcessExchangePair();
  const borrowerSigner = createAggSigner({ localSecret: borrowerSecret, remotePub: protocolPub, exchange: exchangeForBorrower });
  const protocolSigner = createAggSigner({ localSecret: protocolSecret, remotePub: borrowerPub, exchange: exchangeForProtocol });

  return {
    publicKey: borrowerSigner.publicKey,
    xOnly: borrowerSigner.xOnly,
    sign(): never {
      throw new Error("ECDSA is not supported on a MuSig2 owner key — Taproot script-path spends only");
    },
    async signSchnorr(sighash: Buffer): Promise<Buffer> {
      const [sig] = await Promise.all([borrowerSigner.signSchnorr(sighash), protocolSigner.signSchnorr(sighash)]);
      return sig;
    },
  };
}

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[commitment] quorum:", await checkQuorum(tachi));

  const borrowerSecret = randomBytes(32);
  const protocolSecret = randomBytes(32);
  const ownerSigner = makeSpikeOwnerSigner(borrowerSecret, protocolSecret);
  console.log("[commitment] P_agg x-only:", ownerSigner.xOnly.toString("hex"));

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();

  const channel = await openCollateral(config, {
    ownerSigner,
    borrowerReturnAddress: funderWallet.receiveAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
  });
  console.log("[commitment] channel opened:", channel.vault.p2tr.address, "vaultId", channel.vaultId);
  console.log("[commitment] exit_tx pre-signed, length", channel.exitTxHex.length, "hex chars");

  const tooEarly = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [channel.exitTxHex],
  ]);
  console.log("[commitment] exit_tx accepted before CSV matures?", tooEarly[0].allowed, tooEarly[0]["reject-reason"] ?? "");
  if (tooEarly[0].allowed) throw new Error("exit_tx should NOT be valid before the CSV delay matures");

  await rpc.call("generatetoaddress", [CSV_BLOCKS, funderWallet.receiveAddress]);
  const matured = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [channel.exitTxHex],
  ]);
  console.log("[commitment] exit_tx accepted after CSV matures?", matured[0].allowed, matured[0]["reject-reason"] ?? "");
  if (!matured[0].allowed) throw new Error("exit_tx should be valid once the CSV delay has matured");

  // NOT using commitment.ts's commitState() here — see the LLTV_BPS comment
  // above and the commit message: it has two bugs for Kōsen's use (satUSD's
  // ratio-style share math, and userValueSats not reserving room for
  // feeSats). Building the refund PSBT directly with Kōsen's own LTV-based
  // share formula (COLLATERAL-MODEL.md §3.5) is exactly what
  // engine/src/collateral-tachi.ts (Task 3) does for real; this proves it
  // against live regtest before that module depends on it.
  const feeSats = 1_000n;
  const share = kosenShareForLiquidation(DEPOSIT, LLTV_KOSEN_BPS, PENALTY_BPS);
  const userValueSats = channel.funding.valueSats - share - feeSats;
  if (userValueSats <= 0n) throw new Error("share + fee leaves no room for the borrower's to_local output");
  console.log("[commitment] Kōsen-style share (LTV", LLTV_KOSEN_BPS, "bps):", share.toString(), "sats");

  const hint = encodeStateHint(1n, channel.stateObfuscator);
  const refundBuilt = buildRefundPsbt({
    vault: channel.vault,
    funding: channel.funding,
    toLocal: channel.toLocal,
    userValueSats,
    extraOutputs: [{ address: funderWallet.changeAddress, valueSats: share }],
    feeSats,
    sequence: hint.sequence,
    locktime: hint.locktime,
  });
  const refundVerify = {
    maxFeeSats: feeSats * 5n,
    toLocal: channel.toLocal,
    expectedUserValueSats: userValueSats,
    expectedDelayedPubkey: channel.vault.userKey.xOnly,
  };
  await signRefundPsbtAsUser(refundBuilt.psbt, channel.ownerSigner, channel.vault, refundVerify);
  await cosignRefund(refundBuilt.psbt, channel.vault, { url: `${config.tachiUrl}/tachi_signTransaction`, timeoutMs: 90_000 });
  const refundHex = finalizeRefundPsbt(refundBuilt.psbt, channel.vault, refundVerify);
  console.log("[commitment] refund cosigned by the real quorum");

  const accept = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[refundHex]]);
  console.log("[commitment] refund testmempoolaccept:", accept[0].allowed, accept[0]["reject-reason"] ?? "");
  if (!accept[0].allowed) throw new Error("committed refund was not accepted by bitcoind");

  const txid = await broadcastLiquidation(rpc, refundHex);
  await rpc.call("generatetoaddress", [1, funderWallet.receiveAddress]);
  console.log("[commitment] LIQUIDATION BROADCAST + MINED:", txid);

  console.log("[commitment] PASS — commitment.ts's extracted module boundary works end to end on live regtest");
}

main().catch((err) => {
  console.error("[commitment] failed:", err);
  process.exit(1);
});
