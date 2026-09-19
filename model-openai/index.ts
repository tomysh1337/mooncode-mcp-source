import { randomUUID } from "node:crypto";
import type {
  ModelAction,
  ModelAdapter,
  ModelMessage,
  ModelStreamEvent,
  ToolCall,
  ToolName,
} from "@mooncode/contracts";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const API_TO_TOOL_NAME: Record<string, ToolName> = {
  workspace_read: "workspace.read",
  workspace_apply_patch: "workspace.apply_patch",
  terminal_run_recipe: "terminal.run_recipe",
};

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "workspace_read",
      description: "Read a UTF-8 text file under the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "workspace_apply_patch",
      description: "Create or overwrite a workspace file (requires approval).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedHash: { type: ["string", "null"] },
        },
        required: ["path", "content", "expectedHash"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "terminal_run_recipe",
      description: "Run an allowlisted terminal recipe.",
      parameters: {
        type: "object",
        properties: {
          recipeId: { type: "string" },
          args: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["recipeId"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT =
  "You are MoonCode, a coding agent with restricted tools. Only use the provided tools. Prefer workspace_read before editing. Respond in the user's language.";

function parseToolCall(name: string, argsJson: string, id?: string): ToolCall | null {
  const tool = API_TO_TOOL_NAME[name];
  if (!tool) return null;
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return null;
  }
  return { id: id ?? randomUUID(), tool, args: args as ToolCall["args"] };
}

export class OpenAICompatibleModel implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.apiKey) throw new Error("OPENAI_API_KEY required");
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = config.model ?? "gpt-4o-mini";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async nextAction(prompt: string, signal?: AbortSignal, history?: ModelMessage[]): Promise<ModelAction> {
    let action: ModelAction | undefined;
    for await (const ev of this.stream(prompt, signal, history)) {
      if (ev.type === "action") action = ev.action;
    }
    return action ?? { kind: "final", text: "" };
  }

  async *stream(prompt: string, signal?: AbortSignal, history?: ModelMessage[]): AsyncIterable<ModelStreamEvent> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: SYSTEM_PROMPT },
    ];
    if (history && history.length > 0) {
      for (const m of history) {
        if (m.role === "user") {
          messages.push({ role: "user", content: m.content });
        } else if (m.role === "assistant") {
          if (m.toolCalls && m.toolCalls.length > 0) {
            messages.push({
              role: "assistant",
              content: m.content ?? null,
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: {
                  name:
                    c.tool === "workspace.read"
                      ? "workspace_read"
                      : c.tool === "workspace.apply_patch"
                        ? "workspace_apply_patch"
                        : "terminal_run_recipe",
                  arguments: JSON.stringify(c.args),
                },
              })),
            });
          } else {
            messages.push({ role: "assistant", content: m.content ?? "" });
          }
        } else if (m.role === "tool") {
          messages.push({
            role: "tool",
            tool_call_id: m.toolCallId,
            content: m.content,
          });
        }
      }
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      const body = res.body ? await res.text().catch(() => "") : "";
      throw new Error(`OpenAI request failed: ${res.status} ${body.slice(0, 400)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textAcc = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          json = JSON.parse(data) as typeof json;
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          textAcc += delta.content;
          yield { type: "delta", text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
          }
        }
      }
    }

    if (toolAcc.size > 0) {
      const first = [...toolAcc.values()][0]!;
      const call = parseToolCall(first.name, first.args, first.id || undefined);
      if (call) {
        yield { type: "action", action: { kind: "tool_call", call } };
        return;
      }
    }

    yield { type: "action", action: { kind: "final", text: textAcc } };
  }
}

export function createModelFromEnv(): ModelAdapter | null {
  const apiKey = process.env.MOONCODE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAICompatibleModel({
    apiKey,
    baseUrl: process.env.MOONCODE_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
    model: process.env.MOONCODE_OPENAI_MODEL ?? process.env.OPENAI_MODEL,
  });
}
