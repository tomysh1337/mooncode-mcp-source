import { randomUUID } from "node:crypto";
import type { ModelAction, ModelAdapter, ModelMessage, ModelStreamEvent, ToolCall } from "@mooncode/contracts";

export type { ModelAction, ModelAdapter, ModelStreamEvent };

export class FakeModel implements ModelAdapter {
  async nextAction(prompt: string, _signal?: AbortSignal, history?: ModelMessage[]): Promise<ModelAction> {
    // After a successful tool result, produce a final answer that incorporates the observation.
    if (history && history.length > 0) {
      const toolMsgs = history.filter((m) => m.role === "tool");
      if (toolMsgs.length > 0) {
        const lastBatchStart = (() => {
          // Collect trailing contiguous tool messages (parallel batch).
          let i = history.length - 1;
          while (i >= 0 && history[i]?.role === "tool") i -= 1;
          return i + 1;
        })();
        const batch = history.slice(lastBatchStart).filter((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool");
        if (batch.some((m) => m.content.startsWith("ERROR:"))) {
          const err = batch.find((m) => m.content.startsWith("ERROR:"))!;
          return { kind: "final", text: `工具失败：${err.content.slice(6).trim()}` };
        }
        const joined = batch
          .map((m) => {
            const c = m.content;
            return c.length > 400 ? `${c.slice(0, 400)}\n…` : c;
          })
          .join("\n---\n");
        return { kind: "final", text: `根据工具结果：\n${joined}` };
      }
    }

    // Parallel reads: "同时读取 A 和 B" / "read A and B"
    const parallelRead = prompt.match(/同时读取\s+([\w./-]+)\s*和\s*([\w./-]+)|read\s+([\w./-]+)\s+and\s+([\w./-]+)/i);
    if (parallelRead) {
      const a = parallelRead[1] ?? parallelRead[3]!;
      const b = parallelRead[2] ?? parallelRead[4]!;
      return {
        kind: "tool_calls",
        calls: [
          { id: randomUUID(), tool: "workspace.read", args: { path: a } },
          { id: randomUUID(), tool: "workspace.read", args: { path: b } },
        ],
      };
    }

    if (/git\s*status|git状态|仓库状态/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "git_status" },
        },
      };
    }
    if (/git\s*diff|查看diff|看diff/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "git_diff" },
        },
      };
    }
    if (/git\s*log|提交历史|commit\s*log/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "git_log", args: { maxCount: "10" } },
        },
      };
    }
    if (/git\s*show|查看提交|看提交/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "git_show", args: { rev: "HEAD" } },
        },
      };
    }
    if (/list\s*dir|列目录|目录列表|ls\b|dir\b/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "list_dir", args: { path: "." } },
        },
      };
    }
    if (/pnpm\s*test|跑测试|运行测试|执行测试/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "pnpm_test" },
        },
      };
    }
    if (/pnpm\s*install|安装依赖|装依赖/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "pnpm_install" },
        },
      };
    }
    if (/pnpm\s*typecheck|类型检查|typecheck/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "pnpm_typecheck" },
        },
      };
    }
    if (/node.?version|node\s*版本|查看\s*node/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "terminal.run_recipe",
          args: { recipeId: "node_version" },
        },
      };
    }
    if (/patch|写入|修改|创建|apply_patch|写文件/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: {
          id: randomUUID(),
          tool: "workspace.apply_patch",
          args: {
            path: "NOTES.md",
            content: "# Notes\nWritten by MoonCode MVP.\n",
            expectedHash: null,
          },
        },
      };
    }
    if (/read|读取|查看|打开/i.test(prompt)) {
      return {
        kind: "tool_call",
        call: { id: randomUUID(), tool: "workspace.read", args: { path: "README.md" } },
      };
    }
    return {
      kind: "final",
      text: "Fake Model：支持读取/写入、list_dir、node_version、git_status/diff/log/show、pnpm_test/typecheck/build/install。",
    };
  }
  async *stream(prompt: string, signal?: AbortSignal, history?: ModelMessage[]): AsyncIterable<ModelStreamEvent> {
    const action = await this.nextAction(prompt, signal, history);
    if (action.kind === "final") {
      // Emit coarse deltas so runtime streaming path is exercised in tests.
      const text = action.text;
      const chunk = Math.max(1, Math.ceil(text.length / 4));
      for (let i = 0; i < text.length; i += chunk) {
        if (signal?.aborted) return;
        yield { type: "delta", text: text.slice(i, i + chunk) };
      }
    }
    yield { type: "action", action };
  }
}
