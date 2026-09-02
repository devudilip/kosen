#!/usr/bin/env -S npx tsx
// pnpm demo:exit — THE CLOSER (docs/DEMO.md). With the engine process
// killed, prove the borrower's BTC was never custodied by this protocol:
// print exitLeaf.csvBlocks (1008), assert the exit key is the borrower's
// own key, mine 1008 blocks, sweep with that key alone.
//
// BLOCKED on @kosen/tachi-kit. Run `pnpm sync-kit` once ../satusd publishes
// packages/tachi-kit — mirror satusd's own scripts/unilateral-exit.ts,
// since both products share the identical TAURUS exit-leaf mechanics
// (docs/TACHI-API.md, "TAURUS vault").
async function main(): Promise<void> {
  try {
    await import("@kosen/tachi-kit");
  } catch {
    console.error("demo:exit: @kosen/tachi-kit is not vendored yet.");
    console.error("Run `pnpm sync-kit` once ../satusd has published packages/tachi-kit.");
    process.exit(1);
  }

  // Expected implementation once vendored (docs/TACHI-API.md, docs/DEMO.md):
  //
  //   const { exitLeaf, exitControlBlock } = vault.p2tr;
  //   console.log(`Exit leaf CSV timelock: ${exitLeaf.csvBlocks} blocks`);
  //   if (exitLeaf.csvBlocks !== 1008) throw new Error(`expected 1008-block timelock, got ${exitLeaf.csvBlocks}`);
  //   if (!exitLeaf.userKey.equals(vault.userKey.xOnly)) {
  //     throw new Error("exit leaf key is not the borrower's own key — this would mean the protocol has custody");
  //   }
  //   await bitcoinRpc.generateToAddress(1008, minerAddress);
  //   const sweepTx = buildExitSweepTx({ vault, exitControlBlock, to: borrowerOwnAddress });
  //   await broadcastTxSync(await signTxWithBorrowerKeyAlone(sweepTx, userSigner));
  //   console.log("Swept with the borrower's key alone. No custodian, ever, held this BTC.");

  console.error("demo:exit: @kosen/tachi-kit resolved but this script's body is still a stub — fill it in per the comment above.");
  process.exit(1);
}

main();
