export type RunId = string & { readonly __brand: "RunId" };
export type CapabilityId = string & { readonly __brand: "CapabilityId" };
export type ToolName =
  | "workspace.read"
  | "workspace.apply_patch"
  | "terminal.run_recipe"
  | "terminal.pty_start"
  | "terminal.pty_write"
  | "terminal.pty_read"
  | "terminal.pty_kill";
export type ToolEffect = "READ_ONLY" | "IDEMPOTENT" | "NON_IDEMPOTENT";
export interface WorkspaceReadArgs { path: string; }
export interface WorkspaceApplyPatchArgs {
  path: string;
  /** Full new file content after the patch is applied. */
  content: string;
  /** Expected SHA-256 of the existing file content, or null if the file must not exist yet. */
  expectedHash: string | null;
}
export interface TerminalRunRecipeArgs {
  /** Allowlisted recipe id, e.g. "echo" | "node_version". */
  recipeId: string;
  /** Recipe parameters; only schema-approved keys are accepted. */
  args?: Record<string, string>;
  /** Relative cwd under workspace root; defaults to ".". */
  cwd?: string;
}
export interface TerminalPtyStartArgs {
  /** Allowlisted recipe only in MVP — no arbitrary SHELL. */
  recipeId: string;
  args?: Record<string, string>;
  cwd?: string;
  cols?: number;
  rows?: number;
}
export interface TerminalPtyWriteArgs {
  sessionId: string;
  /** UTF-8 text to write to stdin (MVP). */
  data: string;
  /** Optional replay guard; must match next expected seq when provided. */
  expectedInputSeq?: number;
}
export interface TerminalPtyReadArgs {
  sessionId: string;
  /** Absolute byte offset to resume from (0 = start). */
  fromOffset: number;
}
export interface TerminalPtyKillArgs {
  sessionId: string;
}
export type PtyState =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "KILLING"
  | "KILLED"
  | "ORPHANED"
  | "FAILED";
export type ToolArgs =
  | WorkspaceReadArgs
  | WorkspaceApplyPatchArgs
  | TerminalRunRecipeArgs
  | TerminalPtyStartArgs
  | TerminalPtyWriteArgs
  | TerminalPtyReadArgs
  | TerminalPtyKillArgs;
export interface ToolCall {
  id: string;
  tool: ToolName;
  args: ToolArgs;
}
export interface Capability {
  id: CapabilityId;
  tool: ToolName;
  root: string;
  expiresAt: number;
  parameterHash: string;
  effect: ToolEffect;
}
export interface ToolRequest {
  runId: RunId;
  call: ToolCall;
  capabilityId: CapabilityId;
}
export type ToolResult =
  | {
      ok: true;
      toolCallId: string;
      value: {
        path?: string;
        content?: string;
        bytesWritten?: number;
        hash?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        truncated?: boolean;
        recipeId?: string;
        sessionId?: string;
        state?: PtyState;
        offset?: number;
        data?: string;
        eof?: boolean;
        inputSeq?: number;
      };
    }
  | { ok: false; toolCallId: string; code: string; message: string };
export type RunState = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface AgentEvent { seq: number; id: string; timestamp: string; runId: RunId; type: string; payload: unknown; prevHash: string | null; hash: string; }
export type ApprovalDecision = "ALLOW" | "DENY";
export type ApprovalStatus = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "DENIED";
export interface ApprovalRequest { approvalId: string; runId: RunId; capabilityId: CapabilityId; tool: ToolName; effect: ToolEffect; reason: string; createdAt: string; }
export interface ApprovalState { request: ApprovalRequest; status: ApprovalStatus; decision?: ApprovalDecision; decidedAt?: string; }

/** Model layer contracts (Fake + real adapters share this surface). */
export type ModelAction =
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_calls"; calls: ToolCall[] }
  | { kind: "final"; text: string };

export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "action"; action: ModelAction };

/** One turn of conversation history passed back to the model after tool execution. */
export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelAdapter {
  /** Non-streaming convenience API used by tests and simple runtimes. */
  nextAction(prompt: string, signal?: AbortSignal, history?: ModelMessage[]): Promise<ModelAction>;
  /** Optional token stream; adapters that support it should prefer this path. */
  stream?(prompt: string, signal?: AbortSignal, history?: ModelMessage[]): AsyncIterable<ModelStreamEvent>;
}

export {
  DEFAULT_CONTEXT_BUDGET,
  fitHistoryToBudget,
  truncateToolContent,
} from "./context-budget.js";
export type { ContextBudgetConfig } from "./context-budget.js";

/** Public MCP surface shared by the Runtime and its clients. */
export const BRIDGE_MCP_MODERN_PROTOCOL = "2026-07-28" as const;
export const BRIDGE_MCP_SUPPORTED_PROTOCOLS = [
  BRIDGE_MCP_MODERN_PROTOCOL,
  "2025-06-18",
  "2025-03-26",
] as const;

export const BRIDGE_MCP_SERVER_INFO = {
  name: "mooncode-bridge",
  version: "0.2.0",
} as const;

export const BRIDGE_MCP_INSTRUCTIONS =
  "You are connected to a local MoonCode workspace via MCP. Paths are relative to the opened workspace. Never access parent directories. Writes are available only when the local user enabled them.";

/** Canonical tool names from PLAN §4.3. Concrete schemas are fixed by BRIDGE-004..008 as each tool is implemented. */
export const BRIDGE_PLAN_TOOL_NAMES = [
  "list_directory",
  "find_files",
  "read_files",
  "search_files",
  "apply_patch",
  "lsp",
  "get_diagnostics",
  "run_command",
  "get_command_output",
  "send_command_input",
  "wait",
  "set_todos",
  "report_progress",
] as const;
export type BridgePlanToolName = (typeof BRIDGE_PLAN_TOOL_NAMES)[number];

/** Controlled 2025-era aliases. They must use the same authorization and write gateway as canonical tools. */
export const BRIDGE_LEGACY_ALIAS_TOOL_NAMES = ["read_file", "write_file"] as const;
export type BridgeLegacyAliasToolName = (typeof BRIDGE_LEGACY_ALIAS_TOOL_NAMES)[number];
export type BridgePublicToolName = BridgePlanToolName | BridgeLegacyAliasToolName;

export interface BridgeListDirectoryArgs {
  path?: string;
  cursor?: string;
  limit?: number;
  include_hidden?: boolean;
  include_ignored?: boolean;
}

export interface BridgeFindFilesArgs {
  patterns: string[];
  path?: string;
  exclude?: string[];
  include_hidden?: boolean;
  include_ignored?: boolean;
  sort?: "path_asc" | "modified_desc";
  max_results?: number;
}

export interface BridgeReadFileRequest {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface BridgeReadFilesArgs {
  files: BridgeReadFileRequest[];
}

export interface BridgeSearchFilesArgs {
  pattern: string;
  path?: string;
  glob?: string[];
  regex?: boolean;
  case_sensitive?: boolean;
  context_lines?: number;
  max_results?: number;
  max_per_file?: number;
  include_hidden?: boolean;
  include_ignored?: boolean;
}

export interface BridgeApplyPatchArgs {
  /** Codex-style multi-file patch bounded by *** Begin Patch / *** End Patch. */
  patch: string;
  /** Raw-byte versions observed before editing. Existing sources require sha256:<hex>; new destinations require null. */
  expected_versions?: Record<string, string | null>;
}

export type BridgeLspOperation =
  | "workspace_symbols"
  | "document_symbols"
  | "definition"
  | "references"
  | "implementation"
  | "hover";

export interface BridgeLspArgs {
  operation: BridgeLspOperation;
  /** Workspace-relative source path. Required except for workspace_symbols. */
  path?: string;
  /** 1-based source line. Required for definition/references/implementation/hover. */
  line?: number;
  /** 1-based UTF-16 code-unit column. Required for definition/references/implementation/hover. */
  column?: number;
  /** Symbol query. Required for workspace_symbols. */
  query?: string;
  /** references only; include the declaration when available. */
  include_declaration?: boolean;
  max_results?: number;
}

export type BridgeDiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface BridgeGetDiagnosticsArgs {
  /** Optional workspace-relative file path. Omit for workspace diagnostics. */
  path?: string;
  severity?: BridgeDiagnosticSeverity[];
  max_results?: number;
}

export type BridgeIdeProviderState = "ready" | "unavailable" | "not_ready" | "project_mismatch";

export interface BridgeRunCommandArgs {
  /** Shell command executed inside a persistent native PTY terminal. */
  command: string;
  /** Optional workspace-relative working directory. Omit to reuse the terminal's current directory. */
  cwd?: string;
  /** Return after command framing starts instead of waiting for completion. */
  background: boolean;
  /** Foreground wait bound. A timeout returns status=running and does not terminate the command. */
  timeout_ms?: number;
}

export interface BridgeGetCommandOutputArgs {
  command_id: string;
  /** Absolute UTF-8 byte offset. Defaults to zero. */
  offset?: number;
  max_bytes?: number;
}

export interface BridgeSendCommandInputArgs {
  command_id: string;
  input: string;
  /** Append a terminal newline (CR on Windows, LF on POSIX). Defaults to true. */
  append_newline?: boolean;
}

export interface BridgeWaitArgs {
  command_id: string;
  /** Bound the wait only. Timeout returns the current running snapshot and never terminates the command. */
  timeout_ms?: number;
}

export type BridgeTodoStatus = "pending" | "in_progress" | "completed";

export interface BridgeTodoItem {
  id: string;
  content: string;
  status: BridgeTodoStatus;
}

export interface BridgeSetTodosArgs {
  /** Complete replacement snapshot for the current MoonCode authorization session. */
  todos: BridgeTodoItem[];
}

export interface BridgeReportProgressArgs {
  message: string;
  /** Omit to associate with the sole in_progress todo, when one exists. */
  todo_id?: string;
  /** Optional trustworthy measured progress. current and total must be supplied together. */
  current?: number;
  total?: number;
  /** Optional trustworthy stage progress. phase and phase_total must be supplied together. */
  phase?: number;
  phase_total?: number;
}

/** Implemented public names. Every advertised name must have a Runtime implementation and acceptance coverage. */
export const BRIDGE_IMPLEMENTED_TOOL_NAMES = [
  "list_directory",
  "find_files",
  "read_files",
  "search_files",
  "apply_patch",
  "lsp",
  "get_diagnostics",
  "run_command",
  "get_command_output",
  "send_command_input",
  "wait",
  "set_todos",
  "report_progress",
  "read_file",
  "write_file",
] as const satisfies readonly BridgePublicToolName[];

export type BridgePublicErrorCode =
  | "INVALID_ARGUMENT"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "CANCELLED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "OUTPUT_EXPIRED"
  | "RESOURCE_BUSY"
  | "INTERNAL_ERROR";

export interface BridgePublicError {
  code: BridgePublicErrorCode;
  message: string;
}

export interface BridgeToolDefinition {
  name: BridgePublicToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export const BRIDGE_TOOL_DEFINITIONS: readonly BridgeToolDefinition[] = [
  {
    name: "list_directory",
    description: "List one directory inside the selected MoonCode workspace with stable name-based pagination. Hidden and ignored entries are excluded by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path. Use . for workspace root." },
        cursor: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        include_hidden: { type: "boolean", default: false },
        include_ignored: { type: "boolean", default: false }
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "find_files",
    description: "Find files by glob patterns inside the selected workspace. Search is bounded and does not traverse links outside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 } },
        path: { type: "string", default: "." },
        exclude: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
        include_hidden: { type: "boolean", default: false },
        include_ignored: { type: "boolean", default: false },
        sort: { type: "string", enum: ["path_asc", "modified_desc"], default: "path_asc" },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      },
      required: ["patterns"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_files",
    description: "Read one or more UTF-8 text files with 1-based inclusive line ranges, raw-byte SHA-256 versions and bounded output.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              start_line: { type: "integer", minimum: 1 },
              end_line: { type: "integer", minimum: 1 }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_files",
    description: "Search UTF-8 workspace text by literal text or regular expression with bounded context and result counts.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: { type: "string", default: "." },
        glob: { type: "array", maxItems: 20, items: { type: "string", minLength: 1 } },
        regex: { type: "boolean", default: false },
        case_sensitive: { type: "boolean" },
        context_lines: { type: "integer", minimum: 0, maximum: 5, default: 1 },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        max_per_file: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        include_hidden: { type: "boolean", default: false },
        include_ignored: { type: "boolean", default: false }
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "apply_patch",
    description: "Apply one validated multi-file patch transaction inside the selected workspace. Requires raw-byte expected versions and local write authorization.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", minLength: 1 },
        expected_versions: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { type: "string", pattern: "^sha256:[0-9a-fA-F]{64}$" },
              { type: "null" }
            ]
          }
        }
      },
      required: ["patch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lsp",
    description: "Query the active MoonCode Extension Host language providers for symbols, definitions, references, implementations or hover information. Source positions are 1-based UTF-16 coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["workspace_symbols", "document_symbols", "definition", "references", "implementation", "hover"] },
        path: { type: "string", minLength: 1 },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        query: { type: "string" },
        include_declaration: { type: "boolean", default: true },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      },
      required: ["operation"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_diagnostics",
    description: "Read live diagnostics from the MoonCode Extension Host, including unsaved editor state. Optionally scope to one workspace-relative file and filter severity.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        severity: {
          type: "array",
          uniqueItems: true,
          minItems: 1,
          maxItems: 4,
          items: { type: "string", enum: ["error", "warning", "information", "hint"] }
        },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "run_command",
    description: "Run a shell command inside a persistent native PTY terminal. MoonCode reuses idle terminals so shell cwd/environment state persists. timeout_ms only bounds the wait for this call: timed-out commands remain running and are resumed with get_command_output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 100000 },
        cwd: { type: "string", minLength: 1 },
        background: { type: "boolean" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 120000 }
      },
      required: ["command", "background"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_command_output",
    description: "Read incremental raw terminal output for one MoonCode command by absolute UTF-8 byte offset. The response reports status, exit_code, earliest_offset, next_offset and whether older output was evicted.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0 },
        max_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 32768 }
      },
      required: ["command_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "send_command_input",
    description: "Send interactive UTF-8 input to a running MoonCode PTY command. append_newline models pressing Enter and defaults to true.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 1 },
        input: { type: "string", maxLength: 16384 },
        append_newline: { type: "boolean", default: true }
      },
      required: ["command_id", "input"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "wait",
    description: "Wait for a MoonCode command to complete or produce new terminal output. Timeout and request cancellation stop only this wait; they never terminate the underlying command.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", minLength: 1 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 }
      },
      required: ["command_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "set_todos",
    description: "Replace the complete durable todo snapshot for the current MoonCode authorization session. Todo ids must be unique and at most one todo may be in_progress.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: 24,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 80 },
              content: { type: "string", minLength: 1, maxLength: 400 },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] }
            },
            required: ["id", "content", "status"],
            additionalProperties: false
          }
        }
      },
      required: ["todos"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "report_progress",
    description: "Append one progress event to the current MoonCode authorization session. Omit todo_id to associate with the sole in_progress todo when present. Supply measured current+total or phase+phase_total only when those values are real; clients must not invent percentage progress.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000 },
        todo_id: { type: "string", minLength: 1, maxLength: 80 },
        current: { type: "integer", minimum: 0, maximum: 1000000000000 },
        total: { type: "integer", minimum: 1, maximum: 1000000000000 },
        phase: { type: "integer", minimum: 1, maximum: 10000 },
        phase_total: { type: "integer", minimum: 1, maximum: 10000 }
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "read_file",
    description: "Compatibility alias for reading one UTF-8 text file through the same secure reader used by read_files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file in the local MoonCode workspace. Disabled unless the local user enabled writes.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
] as const;
