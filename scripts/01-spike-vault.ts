#!/usr/bin/env -S npx tsx
/**
 * Phase 1 exit criteria: create a vault, print the P2TR address, deposit
 * 100,000 sats, mine a block, confirm the deposit landed on-chain.
 *
 * Mirrors satusd's scripts/01-spike-vault.ts — both products drive the
 * identical TAURUS vault + deposit sequence (docs/DIRECTIVE-02.md, Task 1).
 */
import "dotenv/config";
import { BitcoinCoreRpcClient, WalletAggregator } from "@tachibtc/taurus-wallet-aggregator";
import { describeTapscript } from "@tachibtc/taurus-vault-core";
import {
  resolveNetworkConfig,
  createTachiClient,
  createBitcoinRpcClient,
  assertTachiReachable,
  createProtocolVault,
  deposit,
} from "@kosen/tachi-kit";

async function main() {
  const config = resolveNetworkConfig("regtest");
  const tachi = createTachiClient(config);

  console.log(`[spike] asserting Tachi daemon reachable at ${config.tachiUrl}`);
  await assertTachiReachable(tachi, config);
  console.log("[spike] daemon healthy, chain id confirmed");

  const mnemonic = process.env.DEMO_MNEMONIC;
  if (!mnemonic) throw new Error("DEMO_MNEMONIC is not set — copy .env.example to .env");

  const rpc = createBitcoinRpcClient(config);
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: "regtest", rpc });
  const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
  await userWallet.sync();
  console.log(`[spike] user wallet synced, balance: ${userWallet.balance.confirmed} sats`);

  // The demo mnemonic is the public BIP-39 test vector, shared with satusd's
  // own spikes against the same regtest chain — vault addresses derive
  // deterministically from (mnemonic, key index), so an index satusd might
  // also use collides ("vault ... is already funded", vaults are one-deposit-
  // atomic). Use a Kōsen-specific index to avoid it.
  const KEY_INDEX = Number(process.env.SPIKE_KEY_INDEX ?? 31);
  const vault = await createProtocolVault(config, { userWallet, userKeyIndex: KEY_INDEX });
  console.log(`[spike] vault P2TR address: ${vault.p2tr.address}`);
  console.log(`[spike] exit leaf CSV blocks: ${vault.p2tr.exitLeaf.csvBlocks}`);
  console.log(
    `[spike] exit leaf spendable by user key alone: ${vault.p2tr.exitLeaf.userKey.equals(vault.userKey.xOnly)}`,
  );
  console.log(`[spike] exit leaf tapscript: ${describeTapscript(vault.p2tr.exitLeaf.script)}`);

  const depositResult = await deposit({
    vault,
    userWallet,
    rpc,
    amountSats: 100_000n,
    feeRateSatVb: 2,
  });
  console.log(`[spike] deposit broadcast, txid: ${depositResult.txid}`);

  const [minedHash] = await rpc.call<string[]>("generatetoaddress", [1, userWallet.receiveAddress]);
  console.log(`[spike] mined confirming block: ${minedHash}`);

  const scan = await rpc.call<{ success: boolean; total_amount: number }>("scantxoutset", [
    "start",
    [`addr(${vault.p2tr.address})`],
  ]);
  if (!scan.success) throw new Error("scantxoutset did not succeed");
  const vaultSats = BigInt(Math.round(scan.total_amount * 1e8));
  console.log(`[spike] vault balance on-chain: ${vaultSats} sats`);

  if (vaultSats < depositResult.amountSats) {
    throw new Error(`deposit did not land: expected >= ${depositResult.amountSats} sats, found ${vaultSats}`);
  }

  console.log("[spike] PASS — vault created, deposit confirmed on live regtest");
}

main().catch((err) => {
  console.error("[spike] failed:", err);
  process.exit(1);
});
