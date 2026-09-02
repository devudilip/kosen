import Link from "next/link";
import { engine } from "@/lib/engine-client";
import { centsToUsd, pctFromDecimalString } from "@/lib/format";

export default async function MarketsPage() {
  const markets = await engine.listMarkets();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Markets</h1>
        <p className="mt-1 text-sm text-black/60">
          Isolated by design — a bad oracle or an aggressive LLTV in one market cannot touch another.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-black/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/5 text-black/60">
            <tr>
              <th className="px-4 py-3 font-medium">Market</th>
              <th className="px-4 py-3 font-medium">LLTV</th>
              <th className="px-4 py-3 font-medium">Utilization</th>
              <th className="px-4 py-3 font-medium">Supply APY</th>
              <th className="px-4 py-3 font-medium">Borrow APY</th>
              <th className="px-4 py-3 font-medium">TVL</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.id} className="border-t border-black/10">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/borrow?market=${m.id}`} className="hover:underline">
                    {m.collateralAsset} → {m.loanAsset}
                  </Link>
                </td>
                <td className="px-4 py-3">{pctFromDecimalString(m.lltv)}</td>
                <td className="px-4 py-3">{pctFromDecimalString(m.utilization)}</td>
                <td className="px-4 py-3 text-green-700">{pctFromDecimalString(m.supplyApy)}</td>
                <td className="px-4 py-3">{pctFromDecimalString(m.borrowApy)}</td>
                <td className="px-4 py-3">{centsToUsd(m.tvlLoanUnits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
