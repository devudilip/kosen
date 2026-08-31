import { engine } from "@/lib/engine-client";
import { centsToUsd, pctFromDecimalString } from "@/lib/format";

export default async function LendPage() {
  const markets = await engine.listMarkets();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Lend</h1>
        <p className="mt-1 text-sm text-black/60">
          Supply liquidity, earn the utilization-scaled rate off the kinked IRM. Per-market risk is isolated —
          your exposure in one market never touches another.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {markets.map((m) => (
          <div key={m.id} className="rounded-lg border border-black/10 p-4">
            <div className="text-sm font-medium">
              {m.collateralAsset} → {m.loanAsset}
            </div>
            <dl className="mt-3 space-y-1 text-sm text-black/70">
              <div className="flex justify-between">
                <dt>Supply APY</dt>
                <dd className="text-green-700">{pctFromDecimalString(m.supplyApy)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Utilization</dt>
                <dd>{pctFromDecimalString(m.utilization)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Total supplied</dt>
                <dd>{centsToUsd(m.totalSupplyAssets)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Total borrowed</dt>
                <dd>{centsToUsd(m.totalBorrowAssets)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
