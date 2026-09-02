"use client";

import { useState, useTransition } from "react";
import { askPositionCopilot } from "@/lib/actions";
import type { CopilotAnswer } from "@/lib/actions-types";

const SUGGESTIONS = ["What happens if BTC drops 30%?", "Cheapest way back above 80% LTV?"];

export function CopilotPanel({ positionId }: { positionId: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<CopilotAnswer | null>(null);
  const [isPending, startTransition] = useTransition();

  function ask(q: string) {
    setQuestion(q);
    startTransition(async () => {
      const result = await askPositionCopilot(positionId, q);
      setAnswer(result);
    });
  }

  return (
    <div className="rounded-lg border border-black/10 p-4">
      <div className="text-sm font-medium">Risk copilot</div>
      <p className="mt-1 text-xs text-black/50">
        Grounded strictly in this position&rsquo;s live data. Every number in the answer traces back to a
        deterministic engine calculation, never the model&rsquo;s own arithmetic.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            className="rounded-full border border-black/15 px-3 py-1 text-xs hover:bg-black/5"
            disabled={isPending}
          >
            {s}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) ask(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about this position..."
          className="flex-1 rounded-md border border-black/15 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {isPending ? "Asking..." : "Ask"}
        </button>
      </form>

      {answer && (
        <div className="mt-4 rounded-md bg-black/5 p-3 text-sm">
          <p>{answer.answer}</p>
          {answer.isReplay && (
            <p className="mt-2 text-xs text-black/50">
              Offline mode (no ANTHROPIC_API_KEY) — answered by pattern-matching your question onto the same
              engine scenario math a live call would use as a tool.
            </p>
          )}
          {answer.toolCalls.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-black/50">Grounding tool calls</summary>
              <pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(answer.toolCalls, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
