#!/usr/bin/env -S npx tsx
// pnpm bootstrap — startup assertion against live Tachi regtest infra
// (docs/PLAN.md Phase 1): getHealth() + chain_id, then confirm a local
// bitcoind is reachable (Tachi's hosted regtest has no bitcoind attached —
// docs/TACHI-API.md, "regtest bitcoind proxy 404s").
//
// BLOCKED on @kosen/tachi-kit. Run `pnpm sync-kit` once ../satusd publishes
// packages/tachi-kit, then delete this guard and fill in the real calls
// below — the shape is already documented in docs/TACHI-API.md.
async function main(): Promise<void> {
  let tachiKit: unknown;
  try {
    tachiKit = await import("@kosen/tachi-kit");
  } catch {
    console.error("bootstrap: @kosen/tachi-kit is not vendored yet.");
    console.error("Run `pnpm sync-kit` once ../satusd has published packages/tachi-kit.");
    process.exit(1);
  }

  // Expected implementation once vendored (docs/TACHI-API.md):
  //
  //   const { TachiClient } = tachiKit as typeof import("@kosen/tachi-kit");
  //   const tachi = new TachiClient({ baseUrl: process.env.TACHI_RPC_URL!, timeoutMs: 10_000 });
  //   const health = await tachi.getHealth();
  //   const stats = await tachi.getStats();
  //   const expectedChainId = process.env.TACHI_NETWORK === "signet" ? "tachi-signet-1" : "tachi-regtest-1";
  //   if (stats.chain_id !== expectedChainId) {
  //     throw new Error(`chain_id mismatch: expected ${expectedChainId}, got ${stats.chain_id}`);
  //   }
  //   console.log(`Connected to ${stats.chain_id} at height ${stats.height}. Health: ${JSON.stringify(health)}`);
  //
  //   if (process.env.TACHI_NETWORK !== "signet") {
  //     // regtest: Tachi's hosted proxy 404s, so confirm the LOCAL bitcoind instead.
  //     await tachi.bitcoinRPC({ id: 1, jsonrpc: "1.0", method: "getblockchaininfo", params: [] });
  //   }

  console.error("bootstrap: @kosen/tachi-kit resolved but this script's body is still a stub — fill it in per the comment above.");
  process.exit(1);
}

main();
