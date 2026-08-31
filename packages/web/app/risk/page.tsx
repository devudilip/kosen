import Link from "next/link";
import { engine } from "@/lib/engine-client";
import { centsToUsd } from "@/lib/format";

export default async function RiskPage() {
  const [risk, positions] = await Promise.all([engine.getRisk(), engine.listPositions()]);
  const maxCount = Math.max(1, ...risk.buckets.map((b) => b.count));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Risk dashboard</h1>
        <p className="mt-1 text-sm text-black/60">
          At-risk positions by LTV bucket. The AI narrates this for lenders; it never decides a liquidation —
          that is <code>LTV &gt; LLTV</code>, deterministic, in <code>engine/liquidation.ts</code>.
        </p>
      </div>

      <div className="space-y-2">
        {risk.buckets.map((b) => (
          <div key={b.label} className="flex items-center gap-4">
            <div className="w-20 shrink-0 text-sm text-black/60">{b.label}</div>
            <div className="h-6 flex-1 rounded bg-black/5">
              <div
                className={`h-6 rounded ${b.label === "86%+" ? "bg-amber-500" : "bg-accent/70"}`}
                style={{ width: `${(b.count / maxCount) * 100}%` }}
              />
            </div>
            <div className="w-32 shrink-0 text-right text-sm">
              {b.count} · {centsToUsd(b.exposureLoanUnits)}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-black/10 p-4">
          <div className="text-xs text-black/50">Positions currently liquidatable</div>
          <div className="mt-1 text-lg font-medium">{risk.atRiskPositionIds.length}</div>
        </div>
        <div className="rounded-lg border border-black/10 p-4">
          <div className="text-xs text-black/50">Liquidations processed (this session)</div>
          <div className="mt-1 text-lg font-medium">{risk.liquidationHistoryCount}</div>
        </div>
      </div>

      {risk.atRiskPositionIds.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-900">At-risk positions</div>
          <ul className="mt-2 space-y-1 text-sm">
            {risk.atRiskPositionIds.map((id) => (
              <li key={id}>
                <Link href={`/position/${id}`} className="text-amber-900 underline">
                  {id}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-lg font-medium">All open positions</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-black/60">
            <tr>
              <th className="py-2 font-medium">Position</th>
              <th className="py-2 font-medium">LTV</th>
              <th className="py-2 font-medium">Health factor</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id} className="border-t border-black/10">
                <td className="py-2">
                  <Link href={`/position/${p.id}`} className="hover:underline">
                    {p.id}
                  </Link>
                </td>
                <td className="py-2">{(Number(p.ltv) * 100).toFixed(1)}%</td>
                <td className="py-2">{Number(p.healthFactor).toFixed(2)}</td>
                <td className="py-2">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
