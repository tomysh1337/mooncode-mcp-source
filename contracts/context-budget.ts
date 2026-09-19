import type { ModelMessage } from "./index.js";

/** Soft budget for model-facing history (chars). Keeps Runtime in control of context size. */
export interface ContextBudgetConfig {
  /** Max total characters of serialized history passed to the model. */
  maxHistoryChars: number;
  /** Max characters of a single tool result before truncation. */
  maxToolResultChars: number;
  /** Always keep the first user message when trimming. */
  keepFirstUser: boolean;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxHistoryChars: 48_000,
  maxToolResultChars: 8_000,
  keepFirstUser: true,
};

export function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 32);
  return `${content.slice(0, head)}\n\n…[truncated ${content.length - maxChars} chars]…\n\n${content.slice(-tail)}`;
}

function messageChars(m: ModelMessage): number {
  if (m.role === "user") return m.content.length;
  if (m.role === "tool") return m.content.length + m.toolCallId.length;
  if (m.role === "assistant") {
    const calls = m.toolCalls?.map((c) => JSON.stringify(c)).join("") ?? "";
    return (m.content?.length ?? 0) + calls.length;
  }
  return 0;
}

/**
 * Fit history under maxHistoryChars by:
 * 1) truncating individual tool results
 * 2) dropping oldest non-first-user messages (middle-out)
 */
export function fitHistoryToBudget(
  history: ModelMessage[],
  config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
): { history: ModelMessage[]; truncated: boolean; dropped: number } {
  let dropped = 0;
  let truncated = false;

  const normalized = history.map((m) => {
    if (m.role !== "tool") return m;
    if (m.content.length <= config.maxToolResultChars) return m;
    truncated = true;
    return {
      ...m,
      content: truncateToolContent(m.content, config.maxToolResultChars),
    };
  });

  let total = normalized.reduce((sum, m) => sum + messageChars(m), 0);
  if (total <= config.maxHistoryChars) {
    return { history: normalized, truncated, dropped };
  }

  const result = [...normalized];
  // Drop from the middle (keep first user + recent tail).
  while (total > config.maxHistoryChars && result.length > 2) {
    let dropIndex = config.keepFirstUser && result[0]?.role === "user" ? 1 : 0;
    // Prefer dropping older assistant/tool pairs in the front half.
    if (dropIndex >= result.length - 1) break;
    const removed = result.splice(dropIndex, 1)[0];
    total -= messageChars(removed);
    dropped += 1;
    truncated = true;
  }

  return { history: result, truncated, dropped };
}
