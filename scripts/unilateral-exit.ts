#!/usr/bin/env -S npx tsx
/**
 * pnpm demo:exit — THE CLOSER (docs/DEMO.md, docs/PLAN.md Phase 8). Proves
 * the borrower's BTC was never custodied by this protocol, even under a
 * joint MuSig2 key.
 *
 * Track B's guarantee is NOT "the borrower can sign alone whenever they
 * like" (that was Track A's model, superseded — see
 * docs/COLLATERAL-MODEL.md §2-3). It's stronger in a different way: the
 * exit transaction was fully agg-signed ONCE, at channel-open time, before
 * any loan asset was released — `exitTxHex` already carries every signature
 * it will ever need. From that point on, broadcasting it needs nothing
 * further from the protocol, the borrower's own MuSig2 partial, or anyone
 * else — only the CSV timelock has to mature. That is what "kill the
 * engine" actually demonstrates below: everything after the KILL POINT
 * marker uses nothing but bitcoind RPC and a string of hex this script
 * already held before that point.
 *
 * Uses the same dev-only in-process MuSig2 signer as scripts/05/06 and
 * engine/server.ts's KOSEN_MODE=tachi — see docs there for why that's fine
 * for a demo and never for production.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { IndividualPubkey } from "@scure/btc-signer/musig2.js";
import {
  resolveNetworkConfig,
  createBitcoinRpcClient,
  createTachiClient,
  assertTachiReachable,
  createAggSigner,
  createInProcessExchangePair,
  openCollateral,
  type AggSigner,
} from "@kosen/tachi-kit";

const CSV_BLOCKS = 144; // demo term (~1 day on mainnet) — same convention as scripts/04-06
const DEPOSIT = 100_000_000n; // 1 BTC
const EXIT_FEE_SATS = 1_000n;

/** DEV/DEMO ONLY — never for production. See musig.ts's own doc comment on createInProcessExchangePair. */
function devOwnerSigner(): AggSigner {
  const borrowerSecret = randomBytes(32);
  const protocolSecret = randomBytes(32);
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

async function main(): Promise<void> {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);
  await assertTachiReachable(tachi, config);
  console.log("[exit] Tachi reachable, chain id confirmed");

  const mnemonic = process.env.DEMO_MNEMONIC!;
  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const funderWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await funderWallet.sync();
  const borrowerOwnAddress = funderWallet.receiveAddress; // the "borrower's own wallet" in this dev setup

  console.log("[exit] opening a real channel — this is the protocol's cooperation, and the LAST it will ever give...");
  const channel = await openCollateral(config, {
    ownerSigner: devOwnerSigner(),
    borrowerReturnAddress: borrowerOwnAddress,
    funderWallet,
    rpc,
    amountSats: DEPOSIT,
    csvBlocks: CSV_BLOCKS,
    exitFeeSats: EXIT_FEE_SATS,
  });
  console.log(`[exit] vault: ${channel.vault.p2tr.address}`);
  console.log(`[exit] exit leaf CSV timelock: ${channel.vault.p2tr.exitLeaf.csvBlocks} blocks`);
  if (channel.vault.p2tr.exitLeaf.csvBlocks !== CSV_BLOCKS) {
    throw new Error(`expected ${CSV_BLOCKS}-block timelock, got ${channel.vault.p2tr.exitLeaf.csvBlocks}`);
  }
  console.log(`[exit] exitTxHex held by the borrower, length ${channel.exitTxHex.length} hex chars`);

  const preKill = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[channel.exitTxHex]]);
  console.log("[exit] exit_tx accepted before CSV matures?", preKill[0].allowed, preKill[0]["reject-reason"] ?? "");
  if (preKill[0].allowed) throw new Error("exit_tx should NOT be valid before the CSV delay matures");

  console.log("");
  console.log("=".repeat(60));
  console.log("KILL POINT — everything above needed the protocol's cooperation.");
  console.log("Everything below uses only bitcoind RPC and the exitTxHex string");
  console.log("already printed above. No further signature, no further call");
  console.log("into @kosen/tachi-kit's commitment.ts, no engine process at all.");
  console.log("=".repeat(60));
  console.log("");

  const balanceBefore = await scanBalance(rpc, borrowerOwnAddress);
  console.log(`[exit] borrower wallet balance before sweep: ${balanceBefore} sats`);

  // Mine to the wallet's change address, not its receive address (the
  // "borrower's own" one used below) — mining to borrowerOwnAddress would
  // hand it coinbase rewards for every block and confound the before/after
  // comparison with unrelated funds.
  const minerAddress = funderWallet.changeAddress;
  console.log(`[exit] mining ${CSV_BLOCKS} blocks to mature the CSV delay...`);
  await rpc.call("generatetoaddress", [CSV_BLOCKS, minerAddress]);

  const postMaturity = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [
    [channel.exitTxHex],
  ]);
  console.log("[exit] exit_tx accepted after CSV matures?", postMaturity[0].allowed, postMaturity[0]["reject-reason"] ?? "");
  if (!postMaturity[0].allowed) throw new Error("exit_tx should be valid once the CSV delay has matured");

  const txid = await rpc.call<string>("sendrawtransaction", [channel.exitTxHex]);
  await rpc.call("generatetoaddress", [1, minerAddress]);
  console.log(`[exit] SWEPT — txid ${txid}`);

  const balanceAfter = await scanBalance(rpc, borrowerOwnAddress);
  const swept = balanceAfter - balanceBefore;
  console.log(`[exit] borrower wallet balance after sweep: ${balanceAfter} sats (+${swept})`);
  if (swept !== DEPOSIT - EXIT_FEE_SATS) {
    throw new Error(`expected the borrower's balance to increase by exactly ${DEPOSIT - EXIT_FEE_SATS}, got ${swept}`);
  }

  const vaultBalanceAfter = await scanBalance(rpc, channel.vault.p2tr.address);
  console.log(`[exit] vault balance after sweep: ${vaultBalanceAfter} sats (should be 0 — fully swept)`);
  if (vaultBalanceAfter !== 0n) throw new Error("vault should be fully emptied by the exit sweep");

  console.log(`[exit] PASS — borrower's own wallet now holds the swept ${DEPOSIT - EXIT_FEE_SATS} sats`);
  console.log("[exit] No custodian, no bridge, no wrapped BTC ever held this — and the protocol never signed a thing after open.");
}

async function scanBalance(rpc: ReturnType<typeof createBitcoinRpcClient>, address: string): Promise<bigint> {
  const scan = await rpc.call<{ success: boolean; total_amount: number }>("scantxoutset", ["start", [`addr(${address})`]]);
  if (!scan.success) throw new Error(`scantxoutset did not succeed for ${address}`);
  return BigInt(Math.round(scan.total_amount * 1e8));
}

main().catch((err) => {
  console.error("[exit] failed:", err);
  process.exit(1);
});
