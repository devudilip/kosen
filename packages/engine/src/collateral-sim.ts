// CollateralPort for KOSEN_MODE=sim — offline dev and tests, no network, no
// bitcoind. Directive 02 Task 3: "collateral-sim.ts wraps demo-world for
// KOSEN_MODE=sim." Never demo this mode live (docs/DIRECTIVE-02.md, "Do
// not" section) — it exists so the rest of the stack (position lifecycle,
// AI layer, web app) can be built and tested without a live Tachi
// connection, exactly like collateral-tachi.ts's real vaults but with
// fabricated (not cryptographically real) identifiers.
import { randomBytes } from "node:crypto";
import type { CollateralPort, CommitStateArgs, CommitStateResult, OpenChannelArgs, OpenChannelResult } from "./collateral-port.js";
import { shareForLiquidation } from "./health.js";

interface SimChannel {
  readonly channelId: string;
  readonly borrowerPub: string;
  readonly amountSats: bigint;
  readonly termBlocks: number;
  status: "open" | "liquidated" | "closed";
  lastN: bigint;
  latestShareSats: bigint;
  watchers: Set<(event: unknown) => void>;
}

function fakeHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export class SimCollateralPort implements CollateralPort {
  private channels = new Map<string, SimChannel>();

  async open(args: OpenChannelArgs): Promise<OpenChannelResult> {
    const channelId = fakeHex(32);
    this.channels.set(channelId, {
      channelId,
      borrowerPub: args.borrowerPub,
      amountSats: args.amountSats,
      termBlocks: args.termBlocks,
      status: "open",
      lastN: 0n,
      latestShareSats: 0n,
      watchers: new Set(),
    });
    return {
      channelId,
      vaultAddress: `sim1${fakeHex(20)}`,
      fundingTxid: fakeHex(32),
      exitTxHex: fakeHex(128), // never actually broadcastable — sim mode has no real Bitcoin behind it
    };
  }

  private requireOpenChannel(channelId: string): SimChannel {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`SimCollateralPort: unknown channel ${channelId}`);
    if (channel.status !== "open") throw new Error(`SimCollateralPort: channel ${channelId} is not open (status: ${channel.status})`);
    return channel;
  }

  async commit(channelId: string, args: CommitStateArgs): Promise<CommitStateResult> {
    const channel = this.requireOpenChannel(channelId);
    const shareSats = shareForLiquidation(args.collateralSats, args.lltvWad, args.penaltyBps);
    channel.lastN += 1n;
    channel.latestShareSats = shareSats;
    const result: CommitStateResult = { n: channel.lastN, shareSats, refundTxid: fakeHex(32) };
    for (const onEvent of channel.watchers) onEvent({ event: "state-committed", channelId, ...result });
    return result;
  }

  async liquidate(channelId: string): Promise<{ txid: string }> {
    const channel = this.requireOpenChannel(channelId);
    channel.status = "liquidated";
    const txid = fakeHex(32);
    for (const onEvent of channel.watchers) onEvent({ event: "liquidated", channelId, txid, shareSats: channel.latestShareSats });
    return { txid };
  }

  async close(channelId: string, toAddress: string): Promise<{ txid: string }> {
    const channel = this.requireOpenChannel(channelId);
    channel.status = "closed";
    const txid = fakeHex(32);
    for (const onEvent of channel.watchers) onEvent({ event: "closed", channelId, toAddress, txid });
    return { txid };
  }

  watch(channelId: string, onEvent: (event: unknown) => void): () => void {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`SimCollateralPort: unknown channel ${channelId}`);
    channel.watchers.add(onEvent);
    return () => channel.watchers.delete(onEvent);
  }
}
