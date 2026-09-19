import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalState,
  RunId,
  RunState,
  ToolCall,
  TerminalRunRecipeArgs,
  WorkspaceApplyPatchArgs,
  WorkspaceReadArgs,
} from "@mooncode/contracts";
import { JsonlEventStore } from "@mooncode/event-store";
import { FakeModel } from "@mooncode/model-fake";
import { ToolGateway } from "@mooncode/tool-gateway";
import type { ModelAdapter, ModelAction, ModelMessage, ToolResult } from "@mooncode/contracts";
import { DEFAULT_CONTEXT_BUDGET, fitHistoryToBudget, type ContextBudgetConfig } from "@mooncode/contracts";
import { createModelFromEnv } from "@mooncode/model-openai";
export { BridgeTaskError, BridgeTaskStore } from "./bridge-tasks.js";
export type { BridgeProgressRecord, BridgeTaskSnapshot, BridgeTodoItem, BridgeTodoStatus } from "./bridge-tasks.js";
export interface RunResult { runId: RunId; state: RunState; response: string; }
export class ApprovalManager {
  private readonly states = new Map<string, ApprovalState>();
  request(state: ApprovalState): ApprovalState { this.states.set(state.request.approvalId, state); return state; }
  decide(approvalId: string, decision: ApprovalDecision): ApprovalState {
    const current = this.states.get(approvalId); if (!current) throw new Error("APPROVAL_NOT_FOUND");
    if (current.status !== "PENDING") throw new Error("APPROVAL_ALREADY_DECIDED");
    const next = { ...current, status: decision === "ALLOW" ? "APPROVED" : "DENIED", decision, decidedAt: new Date().toISOString() } as ApprovalState;
    this.states.set(approvalId, next); return next;
  }
  get(approvalId: string): ApprovalState | undefined { return this.states.get(approvalId); }
}

export type ApprovalHandler = (state: ApprovalState) => Promise<ApprovalDecision>;

export class AgentRuntime {
  constructor(
    private readonly model: ModelAdapter = new FakeModel(),
    private readonly approvals = new ApprovalManager(),
    private readonly onApproval?: ApprovalHandler,
    private readonly contextBudget: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
  ) {}

  async run(
    prompt: string,
    workspaceRoot: string,
    eventFile: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    contextBudgetOverride?: Partial<ContextBudgetConfig>,
  ): Promise<RunResult> {
    await mkdir(dirname(eventFile), { recursive: true });
    const store = new JsonlEventStore(eventFile);
    const gateway = new ToolGateway();
    const runId = randomUUID() as RunId;
    const budget: ContextBudgetConfig = {
      ...this.contextBudget,
      ...sanitizeContextBudget(contextBudgetOverride),
    };

    const emit = async (type: string, payload: unknown) => {
      const event = await store.append(runId, type, payload);
      onEvent?.(event);
      return event;
    };

    const cancelled = async () => {
      const response = "运行已取消。";
      await emit("run.cancelled", { state: "CANCELLED", response });
      return { runId, state: "CANCELLED" as const, response };
    };

    await emit("run.started", { prompt, workspaceRoot });
    if (signal?.aborted) return cancelled();

    const MAX_TURNS = 8;
    const history: ModelMessage[] = [{ role: "user", content: prompt }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) return cancelled();

      const budgeted = fitHistoryToBudget(history, budget);
      if (budgeted.truncated) {
        await emit("context.truncated", {
          dropped: budgeted.dropped,
          maxHistoryChars: budget.maxHistoryChars,
          maxToolResultChars: budget.maxToolResultChars,
        });
        history.length = 0;
        history.push(...budgeted.history);
      }

      const action = await this.resolveModelAction(prompt, signal, emit, history);
      await emit("model.action", { ...action, turn });
      if (signal?.aborted) return cancelled();

      if (action.kind === "final") {
        const response = action.text ?? "";
        await emit("run.completed", { state: "COMPLETED", response, turns: turn + 1 });
        return { runId, state: "COMPLETED", response };
      }

      const calls: ToolCall[] =
        action.kind === "tool_calls"
          ? action.calls
          : action.kind === "tool_call"
            ? [action.call]
            : [];

      if (calls.length === 0) {
        const response = "模型未返回有效工具调用。";
        await emit("run.completed", { state: "FAILED", response, code: "EMPTY_TOOL_CALLS" });
        return { runId, state: "FAILED", response };
      }

      history.push({ role: "assistant", toolCalls: calls });

      const outcome = await this.executeToolBatch({
        calls,
        runId,
        workspaceRoot,
        gateway,
        emit,
        signal,
        turn,
        history,
      });
      if (outcome) return outcome;
    }

    const response = `已达到最大工具轮次（${MAX_TURNS}），停止以避免无限循环。`;
    await emit("run.completed", { state: "FAILED", response, code: "MAX_TURNS" });
    return { runId, state: "FAILED", response };
  }
  private async executeToolBatch(input: {
    calls: ToolCall[];
    runId: RunId;
    workspaceRoot: string;
    gateway: ToolGateway;
    emit: (type: string, payload: unknown) => Promise<unknown>;
    signal?: AbortSignal;
    turn: number;
    history: ModelMessage[];
  }): Promise<RunResult | null> {
    const { calls, runId, workspaceRoot, gateway, emit, signal, turn, history } = input;

    const cancelled = async (): Promise<RunResult> => {
      const response = "运行已取消。";
      await emit("run.cancelled", { state: "CANCELLED", response });
      return { runId, state: "CANCELLED", response };
    };

    type Prepared = {
      call: ToolCall;
      capability: ReturnType<ToolGateway["issueReadCapability"]>;
      approvalStatus: ApprovalState["status"];
    };
    const prepared: Prepared[] = [];

    for (const call of calls) {
      let capability;
      if (call.tool === "workspace.read") {
        capability = gateway.issueReadCapability(workspaceRoot, call.args as WorkspaceReadArgs);
      } else if (call.tool === "workspace.apply_patch") {
        capability = gateway.issueApplyPatchCapability(workspaceRoot, call.args as WorkspaceApplyPatchArgs);
      } else if (call.tool === "terminal.run_recipe") {
        capability = gateway.issueTerminalRecipeCapability(workspaceRoot, call.args as TerminalRunRecipeArgs);
      } else if (call.tool === "terminal.pty_start") {
        capability = gateway.issuePtyStartCapability(workspaceRoot, call.args as import("@mooncode/contracts").TerminalPtyStartArgs);
      } else if (call.tool === "terminal.pty_write") {
        capability = gateway.issuePtyWriteCapability(workspaceRoot, call.args as import("@mooncode/contracts").TerminalPtyWriteArgs);
      } else if (call.tool === "terminal.pty_read") {
        capability = gateway.issuePtyReadCapability(workspaceRoot, call.args as import("@mooncode/contracts").TerminalPtyReadArgs);
      } else if (call.tool === "terminal.pty_kill") {
        capability = gateway.issuePtyKillCapability(workspaceRoot, call.args as import("@mooncode/contracts").TerminalPtyKillArgs);
      } else {
        const response = `不支持的工具：${(call as ToolCall).tool}`;
        await emit("run.completed", { state: "FAILED", response });
        return { runId, state: "FAILED", response };
      }

      await emit("capability.issued", {
        id: capability.id,
        tool: capability.tool,
        effect: capability.effect,
        expiresAt: capability.expiresAt,
      });

      let approvalStatus: ApprovalState["status"] = "NOT_REQUIRED";
      if (capability.effect === "NON_IDEMPOTENT") {
        const approvalId = randomUUID();
        const pending: ApprovalState = {
          request: {
            approvalId,
            runId,
            capabilityId: capability.id,
            tool: call.tool,
            effect: capability.effect,
            reason:
              call.tool === "terminal.run_recipe"
                ? `请求执行 recipe ${(call.args as TerminalRunRecipeArgs).recipeId}`
                : `请求执行 ${call.tool} 于 ${(call.args as { path?: string }).path ?? "."}`,
            createdAt: new Date().toISOString(),
          },
          status: "PENDING",
        };
        this.approvals.request(pending);
        await emit("approval.requested", pending.request);

        const decision = this.onApproval
          ? await this.onApproval(pending)
          : ("ALLOW" as ApprovalDecision);

        if (signal?.aborted) {
          gateway.revoke(capability.id);
          return cancelled();
        }

        const decided = this.approvals.decide(approvalId, decision);
        await emit("approval.decided", {
          approvalId,
          status: decided.status,
          decision: decided.decision,
        });
        approvalStatus = decided.status;

        if (decided.decision === "DENY") {
          gateway.revoke(capability.id);
          const response = "用户拒绝了该操作。";
          await emit("run.completed", { state: "FAILED", response, code: "APPROVAL_DENIED" });
          return { runId, state: "FAILED", response };
        }
      }

      prepared.push({ call, capability, approvalStatus });
    }

    // Parallel only when every tool is READ_ONLY or IDEMPOTENT.
    // NON_IDEMPOTENT already approved above, but still run sequentially for safer journaling.
    const canParallel = prepared.every(
      (p) => p.capability.effect === "READ_ONLY" || p.capability.effect === "IDEMPOTENT",
    );

    if (canParallel && prepared.length > 1) {
      await emit("tool.batch", { mode: "parallel", count: prepared.length, turn });
      // Emit audit events sequentially (hash chain is single-writer), execute tools in parallel.
      for (const { call, capability, approvalStatus } of prepared) {
        await emit("tool.requested", {
          tool: call.tool,
          args: call.args,
          capabilityId: capability.id,
          approval: approvalStatus,
          turn,
          parallel: true,
        });
      }
      const results = await Promise.all(
        prepared.map(async ({ call, capability }) => {
          const result = await gateway.execute({ runId, call, capabilityId: capability.id }, signal);
          return { call, result };
        }),
      );
      if (signal?.aborted) return cancelled();
      for (const { call, result } of results) {
        await emit("tool.completed", result);
        history.push({
          role: "tool",
          toolCallId: call.id,
          content: formatToolResultForModel(call, result),
        });
      }
      return null;
    }

    for (const { call, capability, approvalStatus } of prepared) {
      await emit("tool.requested", {
        tool: call.tool,
        args: call.args,
        capabilityId: capability.id,
        approval: approvalStatus,
        turn,
        parallel: false,
      });
      if (signal?.aborted) {
        gateway.revoke(capability.id);
        return cancelled();
      }
      const result = await gateway.execute({ runId, call, capabilityId: capability.id }, signal);
      await emit("tool.completed", result);
      if (signal?.aborted) {
        gateway.revoke(capability.id);
        return cancelled();
      }
      history.push({
        role: "tool",
        toolCallId: call.id,
        content: formatToolResultForModel(call, result),
      });
    }
    return null;
  }
  private async resolveModelAction(
    prompt: string,
    signal: AbortSignal | undefined,
    emit: (type: string, payload: unknown) => Promise<unknown>,
    history?: ModelMessage[],
  ): Promise<ModelAction> {
    if (this.model.stream) {
      let action: ModelAction | undefined;
      for await (const ev of this.model.stream(prompt, signal, history)) {
        if (signal?.aborted) break;
        if (ev.type === "delta") {
          await emit("model.delta", { text: ev.text });
        } else if (ev.type === "action") {
          action = ev.action;
        }
      }
      return action ?? { kind: "final", text: "" };
    }
    return this.model.nextAction(prompt, signal, history);
  }
}

function formatToolResultForModel(call: ToolCall, result: ToolResult): string {
  if (!result.ok) {
    return `ERROR: ${result.code}: ${result.message}`;
  }
  if (call.tool === "workspace.read") {
    const content = result.value.content ?? "";
    return `path=${(call.args as WorkspaceReadArgs).path}\nlength=${content.length}\n\n${content}`;
  }
  if (call.tool === "workspace.apply_patch") {
    return `path=${(call.args as WorkspaceApplyPatchArgs).path}\nbytesWritten=${result.value.bytesWritten ?? 0}\nhash=${result.value.hash ?? ""}`;
  }
  if (call.tool === "terminal.pty_start") {
    return `sessionId=${result.value.sessionId}\nstate=${result.value.state}\nrecipeId=${result.value.recipeId}`;
  }
  if (call.tool === "terminal.pty_write") {
    return `sessionId=${result.value.sessionId}\ninputSeq=${result.value.inputSeq}\nstate=${result.value.state}`;
  }
  if (call.tool === "terminal.pty_read") {
    return `sessionId=${result.value.sessionId}\noffset=${result.value.offset}\neof=${result.value.eof}\nstate=${result.value.state}\n\n${result.value.data ?? ""}`;
  }
  if (call.tool === "terminal.pty_kill") {
    return `sessionId=${result.value.sessionId}\nstate=${result.value.state}\nexitCode=${result.value.exitCode ?? ""}`;
  }
  return `recipeId=${result.value.recipeId}\nexitCode=${result.value.exitCode}${result.value.truncated ? "\ntruncated=true" : ""}\n\n${result.value.stdout ?? ""}`;
}

export interface IpcRunRequest {
  type: "run.start";
  requestId: string;
  prompt: string;
  workspaceRoot: string;
  eventFile: string;
  /** Optional per-run context budget override (stdio IPC). */
  contextBudget?: Partial<ContextBudgetConfig>;
}
export interface IpcCancelRequest {
  type: "run.cancel";
  requestId: string;
}
export interface IpcApprovalDecision {
  type: "approval.decide";
  requestId: string;
  approvalId: string;
  decision: ApprovalDecision;
}
export type IpcRequest = IpcRunRequest | IpcCancelRequest | IpcApprovalDecision;

export async function serveStdio(runtimeFactory?: () => AgentRuntime): Promise<void> {
  const pendingApprovals = new Map<
    string,
    { resolve: (d: ApprovalDecision) => void; requestId: string }
  >();

  const makeRuntime = () =>
    runtimeFactory?.() ??
    new AgentRuntime(
      new FakeModel(),
      new ApprovalManager(),
      async (state) =>
        new Promise<ApprovalDecision>((resolve) => {
          pendingApprovals.set(state.request.approvalId, {
            resolve,
            requestId: "",
          });
          // The requestId is filled by the outer handler when we know it.
        }),
    );

  // We keep one runtime instance per process for simplicity in MVP.
  let currentRequestId: string | null = null;
  const runtime = new AgentRuntime(
    createModelFromEnv() ?? new FakeModel(),
    new ApprovalManager(),
    async (state) => {
      const requestId = currentRequestId ?? "unknown";
      process.stdout.write(
        JSON.stringify({
          type: "approval.needed",
          requestId,
          approval: state.request,
        }) + "\n",
      );
      return new Promise<ApprovalDecision>((resolve) => {
        pendingApprovals.set(state.request.approvalId, { resolve, requestId });
      });
    },
  );

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const active = new Map<string, AbortController>();

  for await (const line of input) {
    if (!line.trim()) continue;
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({ type: "error", code: "INVALID_JSON" }) + "\n");
      continue;
    }

    if (request.type === "approval.decide") {
      const pending = pendingApprovals.get(request.approvalId);
      if (pending) {
        pendingApprovals.delete(request.approvalId);
        pending.resolve(request.decision);
      }
      continue;
    }

    if (request.type === "run.cancel") {
      active.get(request.requestId)?.abort();
      continue;
    }

    if (
      request.type !== "run.start" ||
      !request.requestId ||
      !request.prompt ||
      !request.workspaceRoot ||
      !request.eventFile
    ) {
      process.stdout.write(
        JSON.stringify({
          type: "error",
          requestId: (request as { requestId?: string }).requestId,
          code: "INVALID_REQUEST",
        }) + "\n",
      );
      continue;
    }

    const controller = new AbortController();
    active.set(request.requestId, controller);
    currentRequestId = request.requestId;

    void runtime
      .run(request.prompt, request.workspaceRoot, request.eventFile, controller.signal, (event) => {
        process.stdout.write(
          JSON.stringify({ type: "run.event", requestId: request.requestId, event }) + "\n",
        );
      }, request.contextBudget)
      .then(
        (result) =>
          process.stdout.write(
            JSON.stringify({ type: "run.completed", requestId: request.requestId, ...result }) + "\n",
          ),
        (error) =>
          process.stdout.write(
            JSON.stringify({
              type: "error",
              requestId: request.requestId,
              code: "RUNTIME_ERROR",
              message: String(error),
            }) + "\n",
          ),
      )
      .finally(() => {
        active.delete(request.requestId);
        if (currentRequestId === request.requestId) currentRequestId = null;
      });
  }
}

export { JsonlEventStore, FakeModel, ToolGateway };
export { startBridgeServer, serveBridgeFromArgv } from "./bridge-http.js";
export { BridgeAuthError, BridgeTokenVerifier, protectedResourceMetadataUrl, validateBridgeAuthConfiguration, validateProductionOAuthConfiguration } from "./bridge-auth.js";
export type { BridgeAuthContext, BridgeAuthMode, BridgeOAuthOptions, BridgeRuntimeMode } from "./bridge-auth.js";
export { BridgeSessionManager, BridgeSessionPermissionError } from "./bridge-session.js";
export type { BridgeAuthorizationSession, BridgeCommandLease, BridgePermissionMode, BridgeWriteLease } from "./bridge-session.js";
export { BridgeIdeBroker, BridgeIdeError } from "./bridge-ide.js";
export type { BridgeIdeRequestKind, BridgeIdeResponseMessage, BridgeIdeService } from "./bridge-ide.js";
export { BridgeTunnelError, BridgeTunnelManager } from "./bridge-tunnel.js";
export type { BridgeTunnelOptions, BridgeTunnelProviderKind, BridgeTunnelState, BridgeTunnelStatus } from "./bridge-tunnel.js";

/** Clamp / validate partial budget from untrusted IPC input. */
function sanitizeContextBudget(
  partial?: Partial<ContextBudgetConfig>,
): Partial<ContextBudgetConfig> {
  if (!partial) return {};
  const out: Partial<ContextBudgetConfig> = {};
  if (typeof partial.maxHistoryChars === "number" && Number.isFinite(partial.maxHistoryChars)) {
    out.maxHistoryChars = Math.max(512, Math.min(2_000_000, Math.floor(partial.maxHistoryChars)));
  }
  if (typeof partial.maxToolResultChars === "number" && Number.isFinite(partial.maxToolResultChars)) {
    out.maxToolResultChars = Math.max(256, Math.min(500_000, Math.floor(partial.maxToolResultChars)));
  }
  if (typeof partial.keepFirstUser === "boolean") {
    out.keepFirstUser = partial.keepFirstUser;
  }
  return out;
}
