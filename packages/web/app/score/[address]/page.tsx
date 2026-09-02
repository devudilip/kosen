import { demoScoreForAddress, MAX_LLTV_CEILING, MAX_LLTV_FLOOR } from "@kosen/ai";

export default async function ScorePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const now = 1_000_000_000n;
  const { result, features, isReplay } = await demoScoreForAddress(address, now);

  const serializableFeatures = JSON.parse(
    JSON.stringify(features, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Credit score</h1>
        <p className="mt-1 font-mono text-xs text-black/50">borrower {address}</p>
      </div>

      {isReplay && (
        <div className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          Showing a stored replay — no <code>ANTHROPIC_API_KEY</code> is set in this environment. The
          replayability is the feature: this is exactly what a judge would see for any past score, live or not.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Score" value={String(result.clamped.score)} />
        <Stat label="Tier" value={result.clamped.tier} />
        <Stat
          label="Max LLTV"
          value={`${(result.clamped.maxLLTV * 100).toFixed(1)}%`}
          highlight={result.clamped.clamped.maxLLTV}
        />
        <Stat
          label="Rate premium"
          value={`${result.clamped.ratePremiumBps} bps`}
          highlight={result.clamped.clamped.ratePremiumBps}
        />
      </div>

      <div className="rounded-lg border border-black/10 p-4">
        <div className="text-sm font-medium">Hard clamp band (applied in code, unconditionally)</div>
        <p className="mt-1 text-sm text-black/60">
          maxLLTV is clamped into <code>[{MAX_LLTV_FLOOR}, {MAX_LLTV_CEILING}]</code> after the model returns.
          The model&rsquo;s raw opinion was <strong>{(result.raw.maxLLTV * 100).toFixed(1)}%</strong>
          {result.clamped.clamped.maxLLTV ? " — it was clamped." : " — already inside the band."}
        </p>
      </div>

      <div>
        <h2 className="text-lg font-medium">Reasoning</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {result.clamped.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {result.clamped.redFlags.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-amber-800">Red flags</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-800">
              {result.clamped.redFlags.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div>
        <h2 className="text-lg font-medium">Feature vector the model saw</h2>
        <p className="mt-1 text-sm text-black/60">
          Deterministic, LLM-free extraction over public Bitcoin/Tachi data (
          <code>packages/ai/src/features.ts</code>) — no vibes, just numbers.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-black/5 p-4 text-xs">
          {JSON.stringify(serializableFeatures, null, 2)}
        </pre>
      </div>

      <details className="rounded-lg border border-black/10 p-4">
        <summary className="cursor-pointer text-sm font-medium">Full prompt sent to the model</summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs">{result.prompt}</pre>
      </details>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-black/10 p-4">
      <div className="text-xs text-black/50">{label}</div>
      <div className={`mt-1 text-lg font-medium ${highlight ? "text-amber-700" : ""}`}>{value}</div>
    </div>
  );
}
