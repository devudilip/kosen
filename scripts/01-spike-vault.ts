#!/usr/bin/env -S npx tsx
// pnpm spike — prove vault + deposit + VTXO transfer against live regtest
// (docs/PLAN.md Phase 1 exit criteria: "pnpm spike moves BTC on live regtest").
//
// BLOCKED on @kosen/tachi-kit. Run `pnpm sync-kit` once ../satusd publishes
// packages/tachi-kit. The canonical sequence is documented in
// docs/TACHI-API.md ("Canonical VTXO sequence") — mirror satusd's own
// scripts/01-spike-vault.ts once the kit lands, since both products drive
// the identical seven-call sequence.
async function main(): Promise<void> {
  try {
    await import("@kosen/tachi-kit");
  } catch {
    console.error("spike: @kosen/tachi-kit is not vendored yet.");
    console.error("Run `pnpm sync-kit` once ../satusd has published packages/tachi-kit.");
    process.exit(1);
  }

  // Expected implementation once vendored (docs/TACHI-API.md):
  //
  //   const vault = await createVault({ network, userWallet, validators: { endpoint: `${TACHI_URL}/tachi_validators` } });
  //   verifyVaultP2tr(vault.p2tr);
  //   await userWallet.sync();
  //   const deposit = await depositToVault({ vault, userWallet, rpc, amountSats: 100_000n, feeRateSatVb: 2 });
  //   const draft = buildTachiTxDeposit({ userXOnly, amountSats: 100_000n, nonce, feeSats });
  //   await broadcastTachiTx(await signTachiTx(draft, userSigner), { url: `${TACHI_URL}/tachi_txBroadcastSync` });
  //   const vtxoId = vtxoIdFromDeposit(depositTachi, 0);
  //   await waitForVtxoCommit(vtxoId, { baseUrl: TACHI_URL, overallTimeoutMs: 60_000, pollIntervalMs: 1_500 });
  //   console.log(`Deposited 100,000 sats into vault ${vault.p2tr.address}, VTXO ${vtxoId} committed.`);

  console.error("spike: @kosen/tachi-kit resolved but this script's body is still a stub — fill it in per the comment above.");
  process.exit(1);
}

main();
