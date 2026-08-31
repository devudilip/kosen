import Link from "next/link";
import { notFound } from "next/navigation";
import { engine } from "@/lib/engine-client";
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
