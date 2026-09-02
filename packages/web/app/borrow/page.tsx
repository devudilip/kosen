import Link from "next/link";
import { engine } from "@/lib/engine-client";
import { centsToUsd, pctFromDecimalString, satsToBtc } from "@/lib/format";

export default async function BorrowPage() {
  const [markets, positions] = await Promise.all([engine.listMarkets(), engine.listPositions()]);
  const market = markets[0];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Borrow</h1>
        <p className="mt-1 text-sm text-black/60">
          Deposit BTC into a TAURUS vault, get scored by the credit agent, borrow to your tier. Live vault
          deposit needs <code>@kosen/tachi-kit</code>, still pending vendoring from{" "}
          <code>../satusd</code> — this page shows the seeded demo positions and their assigned scores in the
          meantime.
        </p>
      </div>

      {market && (
        <div className="rounded-lg border border-black/10 p-4">
          <div className="text-sm font-medium">
            {market.collateralAsset} → {market.loanAsset}
          </div>
          <div className="mt-1 text-sm text-black/60">
            LLTV {pctFromDecimalString(market.lltv)} · Borrow APY {pctFromDecimalString(market.borrowApy)}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-lg font-medium">Demo borrowers</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {positions.map((p) => (
            <div key={p.id} className="rounded-lg border border-black/10 p-4">
              <div className="font-mono text-xs text-black/50">{p.borrower}</div>
              <div className="mt-2 text-sm">
                {satsToBtc(p.collateralSats)} collateral · {centsToUsd(p.debtOwed)} borrowed
              </div>
              <div className="mt-3 flex gap-3 text-sm">
                <Link href={`/position/${p.id}`} className="text-accent hover:underline">
                  View position
                </Link>
                <Link href={`/score/${p.borrower}`} className="text-accent hover:underline">
                  View credit score
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
