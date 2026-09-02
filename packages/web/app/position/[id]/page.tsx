import Link from "next/link";
import { notFound } from "next/navigation";
import { engine, type ChannelView } from "@/lib/engine-client";
import { centsToUsd, pctFromDecimalString, satsToBtc } from "@/lib/format";
import { CopilotPanel } from "./copilot-panel";

export default async function PositionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let position;
  try {
    position = await engine.getPosition(id);
  } catch {
    notFound();
  }
  if (!position) notFound();

  const healthy = Number(position.healthFactor) >= 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Position {position.id}</h1>
          <p className="mt-1 font-mono text-xs text-black/50">borrower {position.borrower}</p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            position.status === "open"
              ? healthy
                ? "bg-green-100 text-green-800"
                : "bg-amber-100 text-amber-800"
              : "bg-black/10 text-black/60"
          }`}
        >
          {position.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Collateral" value={satsToBtc(position.collateralSats)} />
        <Stat label="Debt owed" value={centsToUsd(position.debtOwed)} />
        <Stat label="LTV" value={pctFromDecimalString(position.ltv)} />
        <Stat label="Health factor" value={Number(position.healthFactor).toFixed(2)} highlight={!healthy} />
        <Stat
          label="Liquidation price"
          value={position.liquidationPriceLoanUnitsPerBtc ? centsToUsd(position.liquidationPriceLoanUnitsPerBtc) : "—"}
        />
        <Stat label="Vault" value={position.vaultId} mono />
      </div>

      {position.isLiquidatable && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This position&rsquo;s LTV is above the market&rsquo;s LLTV. It is eligible for liquidation by any
          public-API liquidator — the protocol never decides this with the AI, only with{" "}
          <code>LTV &gt; LLTV</code>.
        </div>
      )}

      {position.channel && <VaultTransparency channel={position.channel} />}

      <div className="flex gap-3">
        <Link
          href={`/score/${position.borrower}`}
          className="rounded-md border border-black/15 px-4 py-2 text-sm hover:bg-black/5"
        >
          View credit score
        </Link>
        <Link href="/risk" className="rounded-md border border-black/15 px-4 py-2 text-sm hover:bg-black/5">
          Risk dashboard
        </Link>
      </div>

      <CopilotPanel positionId={position.id} />
    </div>
  );
}

function Stat({ label, value, highlight, mono }: { label: string; value: string; highlight?: boolean; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-black/10 p-4">
      <div className="text-xs text-black/50">{label}</div>
      <div className={`mt-1 text-lg font-medium ${highlight ? "text-amber-700" : ""} ${mono ? "font-mono text-sm" : ""}`}>
        {value}
      </div>
    </div>
  );
}

// Directive Task 7's transparency story: this position is backed by a real
// MuSig2 vault on Bitcoin (KOSEN_MODE=tachi), and every money number here
// links to something independently verifiable — a Bitcoin address, an L1
// balance read straight off bitcoind, and the pre-signed liquidation
// refund's own actual outputs, not a description of them.
function VaultTransparency({ channel }: { channel: ChannelView }) {
  return (
    <div className="space-y-4 rounded-lg border border-black/10 p-4">
      <div>
        <div className="text-sm font-medium">Vault & custody</div>
        <p className="mt-1 text-xs text-black/50">
          Backed by a real Bitcoin Taproot vault, jointly owned by borrower + protocol (MuSig2) — neither party
          can move it alone.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Vault address" value={channel.vaultAddress} mono />
        <Stat
          label="L1 balance"
          value={channel.l1BalanceSats === null ? "unavailable" : satsToBtc(channel.l1BalanceSats)}
        />
        <Stat label="Exit timelock" value={`${channel.termBlocks} blocks`} />
      </div>
      <p className="text-xs text-black/40">
        Verify independently: <code>bitcoin-cli getaddressinfo {channel.vaultAddress}</code> or any regtest
        block explorer.
      </p>

      {channel.latestState ? (
        <div className="rounded-md bg-black/[0.03] p-4">
          <div className="text-sm font-medium">What happens if I default</div>
          <p className="mt-1 text-xs text-black/50">
            State #{channel.latestState.n} — a liquidation refund is already signed by both the borrower and the
            protocol, and cosigned by Tachi&rsquo;s validator quorum. These are its real outputs, not a
            projection:
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded border border-black/10 p-3">
              <div className="text-xs text-black/50">→ Protocol (on liquidation)</div>
              <div className="mt-1 font-medium">{satsToBtc(channel.latestState.shareSats)}</div>
              <div className="mt-1 font-mono text-[11px] text-black/40">{channel.latestState.protocolPayoutAddress}</div>
            </div>
            <div className="rounded border border-black/10 p-3">
              <div className="text-xs text-black/50">→ You (revocable to_local)</div>
              <div className="mt-1 font-medium">{satsToBtc(channel.latestState.userValueSats)}</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-black/40">
            Liquidation tx hash-to-be:{" "}
            <code className="break-all">{channel.latestState.refundTxid}</code> — this is the real txid of the
            held, unbroadcast refund (computed from its own bytes). Verify once liquidated:{" "}
            <code>bitcoin-cli getrawtransaction {channel.latestState.refundTxid}</code>.
          </p>
        </div>
      ) : (
        <p className="text-xs text-black/40">No state committed yet — nothing to liquidate against.</p>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-black/50">Pre-signed exit transaction (borrower&rsquo;s unilateral-exit guarantee)</summary>
        <p className="mt-2 text-xs text-black/50">
          Fully signed at open. If this protocol disappears entirely, broadcasting this after the exit timelock
          matures returns the vault&rsquo;s full balance to the borrower&rsquo;s own address — no cooperation
          needed from anyone.
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-black/5 p-2 text-[10px]">{channel.exitTxHex}</pre>
      </details>
    </div>
  );
}
