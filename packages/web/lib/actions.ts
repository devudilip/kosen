"use server";

import { askCopilot, type CopilotAnswer } from "@kosen/ai";
import { engine } from "./engine-client";

// Server action backing the copilot panel on the position page. Context is
// built entirely from the engine's own view of the position — the model
// never sees anything the deterministic engine didn't already compute
// (docs/AGENT-BRIEF.md: "It can't hallucinate your health factor because it
// isn't the thing calculating it.").
export async function askPositionCopilot(positionId: string, question: string): Promise<CopilotAnswer> {
  const position = await engine.getPosition(positionId);
  return askCopilot(
    {
      positionId: position.id,
      debtAssets: BigInt(position.debtOwed),
      collateralSats: BigInt(position.collateralSats),
      lltv: BigInt(position.lltvWad),
      currentPriceLoanUnitsPerBtc: BigInt(position.currentPriceLoanUnitsPerBtc),
    },
    question,
  );
}
