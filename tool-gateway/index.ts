import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  Capability,
  CapabilityId,
  ToolArgs,
  ToolRequest,
  ToolResult,
  TerminalRunRecipeArgs,
  WorkspaceApplyPatchArgs,
  WorkspaceReadArgs,
} from "@mooncode/contracts";

import type {
  TerminalPtyStartArgs,
  TerminalPtyWriteArgs,
  TerminalPtyReadArgs,
  TerminalPtyKillArgs,
} from "@mooncode/contracts";
import { PtySessionManager } from "./pty-session.js";
import { WorkspaceFileError, WorkspaceFileService } from "./workspace-files.js";
import { WorkspacePatchService } from "./workspace-patch.js";

export { CommandManager, CommandManagerError } from "./command-manager.js";
export type { ManagedCommandOutput, ManagedCommandSnapshot, ManagedCommandStatus, ManagedRunOptions } from "./command-manager.js";

export { WorkspaceFileError, WorkspaceFileService } from "./workspace-files.js";
export type {
  WorkspaceFindResult,
  WorkspaceListResult,
  WorkspaceReadItemResult,
  WorkspaceReadResult,
  WorkspaceSearchResult,
} from "./workspace-files.js";
export { WorkspacePatchError, WorkspacePatchService } from "./workspace-patch.js";
export type {
  WorkspacePatchApplyOptions,
  WorkspaceDirtyChecker,
  WorkspacePatchFileResult,
  WorkspacePatchResult,
  WorkspacePatchServiceOptions,
} from "./workspace-patch.js";

const hashArgs = (a: ToolArgs) => createHash("sha256").update(JSON.stringify(a)).digest("hex");
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_WALL_MS = 15_000;

type RecipeDef = {
  executable: string;
  buildArgv: (args: Record<string, string>) => string[] | { error: string };
  effect: "IDEMPOTENT" | "NON_IDEMPOTENT";
  /** Per-recipe wall-clock limit; defaults to DEFAULT_WALL_MS. */
  wallMs?: number;
};

/** Resolve a command from PATH without using a shell. */
function whichCommand(name: string): string {
  // Windows npm/pnpm shims are *.cmd; Node spawn with shell:false can execute .cmd when the name includes the extension.
  if (process.platform === "win32" && (name === "pnpm" || name === "npm" || name === "yarn")) {
    return `${name}.cmd`;
  }
  return name;
}

const RECIPES: Record<string, RecipeDef> = {
  echo: {
    executable: process.execPath,
    buildArgv: (args) => {
      const text = args.text ?? "";
      if (text.length > 1024) return { error: "echo text too long" };
      return ["-e", `process.stdout.write(${JSON.stringify(text)})`];
    },
    effect: "IDEMPOTENT",
  },
  node_version: {
    executable: process.execPath,
    buildArgv: () => ["--version"],
    effect: "IDEMPOTENT",
  },
  git_status: {
    executable: whichCommand("git"),
    buildArgv: () => ["status", "--porcelain=v1", "-b"],
    effect: "IDEMPOTENT",
    wallMs: 10_000,
  },
  git_diff: {
    executable: whichCommand("git"),
    buildArgv: (args) => {
      // Optional relative path filter only; never accept arbitrary flags.
      const path = args.path;
      if (path !== undefined) {
        if (typeof path !== "string" || path.includes("..") || path.startsWith("-") || path.length > 512) {
          return { error: "invalid git_diff path" };
        }
        return ["diff", "--", path];
      }
      return ["diff"];
    },
    effect: "IDEMPOTENT",
    wallMs: 15_000,
  },
  git_log: {
    executable: whichCommand("git"),
    buildArgv: (args) => {
      // Fixed safe format; optional maxCount only (1..50).
      const raw = args.maxCount;
      let n = 10;
      if (raw !== undefined) {
        const parsed = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
          return { error: "invalid git_log maxCount (1-50)" };
        }
        n = parsed;
      }
      return ["log", `--max-count=${n}`, "--pretty=format:%h %ad %an %s", "--date=short"];
    },
    effect: "IDEMPOTENT",
    wallMs: 15_000,
  },
  git_show: {
    executable: whichCommand("git"),
    buildArgv: (args) => {
      // Only allow a commit-ish that looks like a short/full SHA; no flags, no pathspecs.
      const rev = args.rev ?? "HEAD";
      if (typeof rev !== "string" || !/^[0-9a-fA-F]{7,40}$|^HEAD$/.test(rev)) {
        return { error: "invalid git_show rev (use HEAD or 7-40 hex SHA)" };
      }
      return ["show", "--stat", "--format=medium", rev];
    },
    effect: "IDEMPOTENT",
    wallMs: 15_000,
  },
  list_dir: {
    // Cross-platform directory listing via node; never shell out to ls/dir.
    executable: process.execPath,
    buildArgv: (args) => {
      const path = args.path ?? ".";
      if (
        typeof path !== "string" ||
        path.includes("..") ||
        path.startsWith("/") ||
        path.startsWith("\\") ||
        /^[A-Za-z]:/.test(path) ||
        path.length > 512
      ) {
        return { error: "invalid list_dir path" };
      }
      // Emit name + type only; sorted; max 500 entries.
      const script = `
const fs=require('fs');const path=require('path');
const root=process.cwd();
const target=path.resolve(root,${JSON.stringify(path)});
if(!target.startsWith(root)){console.error('PATH_OUTSIDE');process.exit(2);}
let entries=[];
try{entries=fs.readdirSync(target,{withFileTypes:true});}catch(e){console.error(String(e&&e.message||e));process.exit(1);}
entries.sort((a,b)=>a.name.localeCompare(b.name));
const lines=entries.slice(0,500).map(d=>(d.isDirectory()?'d':'f')+' '+d.name);
process.stdout.write(lines.join('\\n')+(entries.length>500?'\\n… truncated':'') );
`;
      return ["-e", script];
    },
    effect: "IDEMPOTENT",
    wallMs: 10_000,
  },
  pnpm_test: {
    executable: whichCommand("pnpm"),
    buildArgv: () => ["test"],
    effect: "NON_IDEMPOTENT",
    wallMs: 120_000,
  },
  pnpm_typecheck: {
    executable: whichCommand("pnpm"),
    buildArgv: () => ["typecheck"],
    effect: "IDEMPOTENT",
    wallMs: 60_000,
  },
  pnpm_build: {
    executable: whichCommand("pnpm"),
    buildArgv: () => ["build"],
    effect: "NON_IDEMPOTENT",
    wallMs: 120_000,
  },
  pnpm_install: {
    executable: whichCommand("pnpm"),
    // No user-controlled flags: install can mutate node_modules / lockfile → always NON_IDEMPOTENT + approval.
    buildArgv: () => ["install"],
    effect: "NON_IDEMPOTENT",
    wallMs: 300_000,
  },
  interactive_echo: {
    executable: process.execPath,
    buildArgv: () => {
      const script =
        "process.stdin.setEncoding('utf8');" +
        "process.stdout.write('READY\\n');" +
        "process.stdin.on('data',function(d){process.stdout.write('ECHO:'+d);});" +
        "process.stdin.on('end',function(){process.exit(0);});";
      return ["-e", script];
    },
    effect: "NON_IDEMPOTENT",
    wallMs: 60_000,
  },
};

function resolveSafePath(
  root: string,
  relativePath: string,
): { ok: true; target: string } | { ok: false; code: string; message: string } {
  if (isAbsolute(relativePath)) {
    return { ok: false, code: "PATH_OUTSIDE_WORKSPACE", message: "不允许使用绝对路径。" };
  }
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, code: "PATH_TRAVERSAL", message: "路径越过 Workspace Root。" };
  }
  return { ok: true, target };
}

function runRecipe(
  recipe: RecipeDef,
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean; cancelled: boolean }> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ exitCode: -1, stdout: "", stderr: "", truncated: false, cancelled: true });
      return;
    }

    // Empty-ish env: only PATH and minimal locale. No inherited secrets.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TEMP: cwd,
      TMP: cwd,
      TMPDIR: cwd,
    };

    const child = spawn(recipe.executable, argv, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const finish = (exitCode: number, cancelled: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
        cancelled,
      });
    };

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 1000).unref?.();
      } catch {
        /* ignore */
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const wallTimer = setTimeout(() => {
      truncated = true;
      onAbort();
    }, recipe.wallMs ?? DEFAULT_WALL_MS);
    wallTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        stdout = Buffer.concat([stdout, chunk.subarray(0, MAX_OUTPUT_BYTES - stdout.length)]);
        onAbort();
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_OUTPUT_BYTES - stderr.length)]);
        onAbort();
      } else {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.on("error", (err) => {
      clearTimeout(wallTimer);
      signal?.removeEventListener("abort", onAbort);
      finish(1, false);
      void err;
    });

    child.on("close", (code) => {
      clearTimeout(wallTimer);
      signal?.removeEventListener("abort", onAbort);
      finish(code ?? 1, Boolean(signal?.aborted));
    });
  });
}

export class ToolGateway {
  private readonly capabilities = new Map<CapabilityId, Capability>();
  constructor(private readonly now = Date.now) {}
  private readonly pty = new PtySessionManager();

  issueReadCapability(root: string, args: WorkspaceReadArgs, ttlMs = 30000): Capability {
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "workspace.read",
      root: resolve(root),
      expiresAt: this.now() + ttlMs,
      parameterHash: hashArgs(args),
      effect: "READ_ONLY",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issueApplyPatchCapability(root: string, args: WorkspaceApplyPatchArgs, ttlMs = 30000): Capability {
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "workspace.apply_patch",
      root: resolve(root),
      expiresAt: this.now() + ttlMs,
      parameterHash: hashArgs(args),
      effect: "NON_IDEMPOTENT",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issueTerminalRecipeCapability(root: string, args: TerminalRunRecipeArgs, ttlMs = 30000): Capability {
    const recipe = RECIPES[args.recipeId];
    const effect = recipe?.effect ?? "NON_IDEMPOTENT";
    // Capability must outlive the recipe wall-clock limit so long jobs (install/build) don't expire mid-run.
    const minTtl = (recipe?.wallMs ?? DEFAULT_WALL_MS) + 5_000;
    const effectiveTtl = Math.max(ttlMs, minTtl);
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "terminal.run_recipe",
      root: resolve(root),
      expiresAt: this.now() + effectiveTtl,
      parameterHash: hashArgs(args),
      effect,
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issuePtyStartCapability(root: string, args: TerminalPtyStartArgs, ttlMs = 30000): Capability {
    const recipe = RECIPES[args.recipeId];
    const minTtl = (recipe?.wallMs ?? DEFAULT_WALL_MS) + 5_000;
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "terminal.pty_start",
      root: resolve(root),
      expiresAt: this.now() + Math.max(ttlMs, minTtl),
      parameterHash: hashArgs(args),
      effect: "NON_IDEMPOTENT",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issuePtyWriteCapability(root: string, args: TerminalPtyWriteArgs, ttlMs = 30000): Capability {
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "terminal.pty_write",
      root: resolve(root),
      expiresAt: this.now() + ttlMs,
      parameterHash: hashArgs(args),
      effect: "NON_IDEMPOTENT",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issuePtyReadCapability(root: string, args: TerminalPtyReadArgs, ttlMs = 30000): Capability {
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "terminal.pty_read",
      root: resolve(root),
      expiresAt: this.now() + ttlMs,
      parameterHash: hashArgs(args),
      effect: "READ_ONLY",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  issuePtyKillCapability(root: string, args: TerminalPtyKillArgs, ttlMs = 30000): Capability {
    const c: Capability = {
      id: randomUUID() as CapabilityId,
      tool: "terminal.pty_kill",
      root: resolve(root),
      expiresAt: this.now() + ttlMs,
      parameterHash: hashArgs(args),
      effect: "NON_IDEMPOTENT",
    };
    this.capabilities.set(c.id, c);
    return c;
  }

  async execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    const c = this.capabilities.get(request.capabilityId);
    if (!c) return { ok: false, toolCallId: request.call.id, code: "CAPABILITY_NOT_FOUND", message: "Capability 不存在。" };
    if (c.tool !== request.call.tool) {
      return { ok: false, toolCallId: request.call.id, code: "CAPABILITY_TOOL_MISMATCH", message: "Capability 与工具不匹配。" };
    }
    if (this.now() >= c.expiresAt) {
      return { ok: false, toolCallId: request.call.id, code: "CAPABILITY_EXPIRED", message: "Capability 已过期。" };
    }
    if (hashArgs(request.call.args) !== c.parameterHash) {
      return { ok: false, toolCallId: request.call.id, code: "PARAMETER_HASH_MISMATCH", message: "请求参数与 Capability 不匹配。" };
    }

    if (request.call.tool === "workspace.read") {
      const args = request.call.args as WorkspaceReadArgs;
      if (!args || typeof args.path !== "string") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      try {
        const service = new WorkspaceFileService(c.root);
        const read = await service.readFiles({ files: [{ path: args.path }] }, signal);
        const item = read.files[0];
        if (!item) {
          return { ok: false, toolCallId: request.call.id, code: "READ_FAILED", message: "读取器没有返回文件结果。" };
        }
        if (!item.ok) {
          const gatewayCode = item.code === "NOT_FOUND"
            ? "ENOENT"
            : item.code === "PERMISSION_DENIED"
              ? "PATH_TRAVERSAL"
              : item.code;
          return { ok: false, toolCallId: request.call.id, code: gatewayCode, message: item.message };
        }
        return {
          ok: true,
          toolCallId: request.call.id,
          value: {
            path: item.path,
            content: item.content,
            hash: item.version.replace(/^sha256:/, ""),
            truncated: item.truncated,
          },
        };
      } catch (e: unknown) {
        if (e instanceof WorkspaceFileError) {
          const gatewayCode = e.code === "NOT_FOUND" ? "ENOENT" : e.code === "PERMISSION_DENIED" ? "PATH_TRAVERSAL" : e.code;
          return { ok: false, toolCallId: request.call.id, code: gatewayCode, message: e.message };
        }
        const code = (e as NodeJS.ErrnoException).code ?? "READ_FAILED";
        return { ok: false, toolCallId: request.call.id, code, message: `读取失败：${code}` };
      }
    }

    if (request.call.tool === "workspace.apply_patch") {
      const args = request.call.args as WorkspaceApplyPatchArgs;
      if (
        !args ||
        typeof args.path !== "string" ||
        typeof args.content !== "string" ||
        (args.expectedHash !== null && typeof args.expectedHash !== "string")
      ) {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      try {
        const expectedVersion = args.expectedHash === null ? null : `sha256:${args.expectedHash.toLowerCase()}`;
        const result = await new WorkspacePatchService(c.root).replaceFile(args.path, args.content, expectedVersion, signal);
        if (!result.applied) {
          const publicCode = result.error?.code ?? "INTERNAL_ERROR";
          const gatewayCode = publicCode === "VERSION_CONFLICT"
            ? "HASH_MISMATCH"
            : publicCode === "PERMISSION_DENIED"
              ? "PATH_TRAVERSAL"
              : publicCode;
          return { ok: false, toolCallId: request.call.id, code: gatewayCode, message: result.error?.message ?? "补丁事务失败。" };
        }
        const safe = await new WorkspaceFileService(c.root).resolveExistingPath(args.path, signal);
        const bytes = await readFile(safe.realPath);
        return {
          ok: true,
          toolCallId: request.call.id,
          value: {
            path: safe.workspacePath,
            bytesWritten: bytes.length,
            hash: createHash("sha256").update(bytes).digest("hex"),
          },
        };
      } catch (e: unknown) {
        if (e instanceof WorkspaceFileError) {
          const gatewayCode = e.code === "PERMISSION_DENIED" ? "PATH_TRAVERSAL" : e.code;
          return { ok: false, toolCallId: request.call.id, code: gatewayCode, message: e.message };
        }
        const code = (e as NodeJS.ErrnoException).code ?? "WRITE_FAILED";
        return { ok: false, toolCallId: request.call.id, code, message: `补丁事务失败：${code}` };
      }
    }

    if (request.call.tool === "terminal.run_recipe") {
      const args = request.call.args as TerminalRunRecipeArgs;
      if (!args || typeof args.recipeId !== "string") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      const recipe = RECIPES[args.recipeId];
      if (!recipe) {
        return { ok: false, toolCallId: request.call.id, code: "RECIPE_NOT_ALLOWED", message: `Recipe 不在白名单：${args.recipeId}` };
      }
      const cwdRel = args.cwd ?? ".";
      const safeCwd = resolveSafePath(c.root, cwdRel);
      if (!safeCwd.ok) return { ok: false, toolCallId: request.call.id, code: safeCwd.code, message: safeCwd.message };

      const argvOrErr = recipe.buildArgv(args.args ?? {});
      if (!Array.isArray(argvOrErr)) {
        return { ok: false, toolCallId: request.call.id, code: "RECIPE_ARGS_INVALID", message: argvOrErr.error };
      }

      const result = await runRecipe(recipe, argvOrErr, safeCwd.target, signal);
      if (result.cancelled) {
        return { ok: false, toolCallId: request.call.id, code: "CANCELLED", message: "命令已取消。" };
      }
      return {
        ok: true,
        toolCallId: request.call.id,
        value: {
          recipeId: args.recipeId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        },
      };
    }

    if (request.call.tool === "terminal.pty_start") {
      const args = request.call.args as TerminalPtyStartArgs;
      if (!args || typeof args.recipeId !== "string") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      const recipe = RECIPES[args.recipeId];
      if (!recipe) {
        return { ok: false, toolCallId: request.call.id, code: "RECIPE_NOT_ALLOWED", message: `Recipe 不在白名单：${args.recipeId}` };
      }
      const cwdRel = args.cwd ?? ".";
      const safeCwd = resolveSafePath(c.root, cwdRel);
      if (!safeCwd.ok) return { ok: false, toolCallId: request.call.id, code: safeCwd.code, message: safeCwd.message };
      const argvOrErr = recipe.buildArgv(args.args ?? {});
      if (!Array.isArray(argvOrErr)) {
        return { ok: false, toolCallId: request.call.id, code: "RECIPE_ARGS_INVALID", message: argvOrErr.error };
      }
      const info = this.pty.start({
        root: safeCwd.target,
        executable: recipe.executable,
        argv: argvOrErr,
        cols: args.cols,
        rows: args.rows,
        limits: { wallMs: recipe.wallMs ?? DEFAULT_WALL_MS },
      });
      return {
        ok: true,
        toolCallId: request.call.id,
        value: {
          sessionId: info.sessionId,
          state: info.state,
          recipeId: args.recipeId,
          truncated: info.truncated,
        },
      };
    }

    if (request.call.tool === "terminal.pty_write") {
      const args = request.call.args as TerminalPtyWriteArgs;
      if (!args || typeof args.sessionId !== "string" || typeof args.data !== "string") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      const result = this.pty.write(args.sessionId, args.data, args.expectedInputSeq);
      if (!result.ok) {
        return { ok: false, toolCallId: request.call.id, code: result.code, message: result.message };
      }
      return {
        ok: true,
        toolCallId: request.call.id,
        value: { sessionId: args.sessionId, inputSeq: result.inputSeq, state: result.state },
      };
    }

    if (request.call.tool === "terminal.pty_read") {
      const args = request.call.args as TerminalPtyReadArgs;
      if (!args || typeof args.sessionId !== "string" || typeof args.fromOffset !== "number") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      const result = this.pty.read(args.sessionId, args.fromOffset);
      if (!result.ok) {
        return { ok: false, toolCallId: request.call.id, code: result.code, message: result.message };
      }
      return {
        ok: true,
        toolCallId: request.call.id,
        value: {
          sessionId: args.sessionId,
          offset: result.offset,
          data: result.data,
          eof: result.eof,
          state: result.state,
          exitCode: result.exitCode,
          truncated: result.truncated,
        },
      };
    }

    if (request.call.tool === "terminal.pty_kill") {
      const args = request.call.args as TerminalPtyKillArgs;
      if (!args || typeof args.sessionId !== "string") {
        return { ok: false, toolCallId: request.call.id, code: "MALFORMED_TOOL_CALL", message: "Tool Call 参数非法。" };
      }
      const info = this.pty.kill(args.sessionId);
      if (!info) {
        return { ok: false, toolCallId: request.call.id, code: "PTY_SESSION_NOT_FOUND", message: "会话不存在。" };
      }
      return {
        ok: true,
        toolCallId: request.call.id,
        value: { sessionId: info.sessionId, state: info.state, exitCode: info.exitCode },
      };
    }

    return { ok: false, toolCallId: request.call.id, code: "UNKNOWN_TOOL", message: "未知工具。" };
  }

  revoke(capabilityId: CapabilityId): void {
    this.capabilities.delete(capabilityId);
  }

  close(reason = "ToolGateway closed"): void {
    this.pty.killAll(reason);
  }
}
