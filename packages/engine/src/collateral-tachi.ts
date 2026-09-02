// Real CollateralPort — backs KOSEN_MODE=tachi (the default) against
// @kosen/tachi-kit's commitment.ts primitives (docs/DIRECTIVE-02.md Task 3).
//
// Deliberately does NOT call commitment.ts's own `commitState()`. Verified
// live against regtest (scripts/04-spike-musig-vault.ts) that its
// shareForLiquidation() call (tachi-kit's health.ts) is satUSD's own
// collateralization-*ratio* model (>=100%, e.g. 150%) — not Kōsen's LTV
// model (<=100%, e.g. 86% LLTV). Feeding an 86 "LLTV" through it computes a
// wildly wrong liquidation price (confirmed: shareSats saturates at 100% of
// collateral). Re-checked against satusd's 2026-09-02 main merge: still
// present — a separate userValueSats/feeSats bug that existed alongside it
// has since been fixed upstream, but this one is a genuine model mismatch,
// not a bug, so it won't be "fixed" the same way. Per sync-kit.sh's own rule
// ("do not edit the vendored copy"), this is not patched in tachi-kit
// locally — this module builds the refund PSBT directly against the
// lower-level SDK primitives instead, using engine/health.ts's own
// shareForLiquidation (Kōsen's LTV-based one, tested against the exact
// value verified live).
//
// The interactive MuSig2 signing itself (the borrower-client <-> engine HTTP
// round trip) is out of scope here — this module takes an already-
// constructed AggSigner per channel (built via @kosen/tachi-kit's
// createAggSigner with a real `exchange`), matching how the original
// CollateralPort seam comment in position.ts described tachi-kit as "where
// it plugs in." Wiring borrowerPub -> a live signer session is Task 4+'s
// concern (the engine's HTTP layer), not this adapter's.
import {
  buildRefundPsbt,
  signRefundPsbtAsUser,
  cosignRefund,
  finalizeRefundPsbt,
  encodeStateHint,
  RefundCosignError,
} from "@tachibtc/taurus-vault-core";
import type { BitcoinCoreRpcClient, Wallet } from "@tachibtc/taurus-wallet-aggregator";
import {
  openCollateral,
  broadcastLiquidation,
  closeChannel,
  watchChannel,
  txidFromHex,
  type AggSigner,
  type CollateralChannel,
} from "@kosen/tachi-kit";
import type { NetworkConfig } from "@kosen/tachi-kit";
import type {
  ChannelSnapshot,
  CollateralPort,
  CommitStateArgs,
  CommitStateResult,
  OpenChannelArgs,
  OpenChannelResult,
} from "./collateral-port.js";
import { shareForLiquidation } from "./health.js";

const DEFAULT_FEE_SATS = 1_000n;

interface ChannelHandle {
  readonly channel: CollateralChannel;
  readonly rpc: BitcoinCoreRpcClient;
  readonly protocolPayoutAddress: string;
  lastN: bigint;
  latestRefundHex: string | null;
  latestShareSats: bigint | null;
  latestUserValueSats: bigint | null;
  latestRefundTxid: string | null;
}

/** Resolves the pieces open() needs for a given borrower — the seam Task 4's HTTP layer fills in. */
export interface ChannelResources {
  readonly ownerSigner: AggSigner;
  readonly funderWallet: Wallet;
  readonly rpc: BitcoinCoreRpcClient;
  readonly borrowerReturnAddress: string;
  readonly protocolPayoutAddress: string;
}

export class TachiCollateralPort implements CollateralPort {
  private readonly channels = new Map<string, ChannelHandle>();

  constructor(
    private readonly config: NetworkConfig,
    private readonly resolveResources: (borrowerPub: string) => Promise<ChannelResources> | ChannelResources,
  ) {}

  async open(args: OpenChannelArgs): Promise<OpenChannelResult> {
    const resources = await this.resolveResources(args.borrowerPub);
    const channel = await openCollateral(this.config, {
      ownerSigner: resources.ownerSigner,
      borrowerReturnAddress: resources.borrowerReturnAddress,
      funderWallet: resources.funderWallet,
      rpc: resources.rpc,
      amountSats: args.amountSats,
      csvBlocks: args.termBlocks,
    });
    this.channels.set(channel.vaultId, {
      channel,
      rpc: resources.rpc,
      protocolPayoutAddress: resources.protocolPayoutAddress,
      lastN: 0n,
      latestRefundHex: null,
      latestShareSats: null,
      latestUserValueSats: null,
      latestRefundTxid: null,
    });

    return {
      channelId: channel.vaultId,
      vaultAddress: channel.vault.p2tr.address,
      fundingTxid: channel.funding.txid,
      exitTxHex: channel.exitTxHex,
    };
  }

  private requireChannel(channelId: string): ChannelHandle {
    const handle = this.channels.get(channelId);
    if (!handle) throw new Error(`TachiCollateralPort: unknown channel ${channelId}`);
    return handle;
  }

  async commit(channelId: string, args: CommitStateArgs): Promise<CommitStateResult> {
    const handle = this.requireChannel(channelId);
    const shareSats = shareForLiquidation(args.collateralSats, args.lltvWad, args.penaltyBps);
    const userValueSats = handle.channel.funding.valueSats - shareSats - DEFAULT_FEE_SATS;
    if (userValueSats <= 0n) {
      throw new Error(`commit: share (${shareSats}) + fee leaves no room for the borrower's to_local output`);
    }

    const n = handle.lastN + 1n;
    const hint = encodeStateHint(n, handle.channel.stateObfuscator);
    const built = buildRefundPsbt({
      vault: handle.channel.vault,
      funding: handle.channel.funding,
      toLocal: handle.channel.toLocal,
      userValueSats,
      extraOutputs: [{ address: handle.protocolPayoutAddress, valueSats: shareSats }],
      feeSats: DEFAULT_FEE_SATS,
      sequence: hint.sequence,
      locktime: hint.locktime,
    });
    const verify = {
      maxFeeSats: DEFAULT_FEE_SATS * 5n,
      toLocal: handle.channel.toLocal,
      expectedUserValueSats: userValueSats,
      expectedDelayedPubkey: handle.channel.vault.userKey.xOnly,
    };
    await signRefundPsbtAsUser(built.psbt, handle.channel.ownerSigner, handle.channel.vault, verify);
    try {
      await cosignRefund(built.psbt, handle.channel.vault, {
        url: `${this.config.tachiUrl}/tachi_signTransaction`,
        timeoutMs: 90_000,
      });
    } catch (e) {
      if (e instanceof RefundCosignError) throw new Error(`commit: refund cosign failed: status=${e.status} msg=${e.message}`);
      throw e;
    }
    const refundHex = finalizeRefundPsbt(built.psbt, handle.channel.vault, verify);

    const refundTxid = txidFromHex(refundHex);
    handle.lastN = n;
    handle.latestRefundHex = refundHex;
    handle.latestShareSats = shareSats;
    handle.latestUserValueSats = userValueSats;
    handle.latestRefundTxid = refundTxid;

    return { n, shareSats, refundTxid };
  }

  async liquidate(channelId: string): Promise<{ txid: string }> {
    const handle = this.requireChannel(channelId);
    if (!handle.latestRefundHex) throw new Error(`liquidate: no committed state to broadcast for channel ${channelId}`);
    const txid = await broadcastLiquidation(handle.rpc, handle.latestRefundHex);
    return { txid };
  }

  async close(channelId: string, toAddress: string): Promise<{ txid: string }> {
    const handle = this.requireChannel(channelId);
    const txid = await closeChannel(this.config, handle.channel, handle.rpc);
    void toAddress; // closeChannel pays the full remainder back to the borrower's exit address already recorded on the channel
    return { txid };
  }

  watch(channelId: string, onEvent: (event: unknown) => void): () => void {
    const handle = this.requireChannel(channelId);
    const subscription = watchChannel(this.config, handle.channel, onEvent);
    return () => subscription.close();
  }

  async getSnapshot(channelId: string): Promise<ChannelSnapshot | undefined> {
    const handle = this.channels.get(channelId);
    if (!handle) return undefined;

    const hasCommittedState =
      handle.latestShareSats !== null && handle.latestUserValueSats !== null && handle.latestRefundTxid !== null;

    return {
      channelId,
      vaultAddress: handle.channel.vault.p2tr.address,
      termBlocks: handle.channel.vault.p2tr.exitLeaf.csvBlocks,
      exitTxHex: handle.channel.exitTxHex,
      latestState: hasCommittedState
        ? {
            n: handle.lastN,
            shareSats: handle.latestShareSats!,
            userValueSats: handle.latestUserValueSats!,
            protocolPayoutAddress: handle.protocolPayoutAddress,
            refundTxid: handle.latestRefundTxid!,
          }
        : null,
    };
  }
}
