// Type-only re-export so client components (e.g. copilot-panel.tsx) never
// pull @kosen/ai's runtime (Anthropic SDK, better-sqlite3) into the browser
// bundle — only the shape of the server action's return value.
export type { CopilotAnswer } from "@kosen/ai";
