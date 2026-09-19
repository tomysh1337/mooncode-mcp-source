import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createNativePtyBackend, type PtyBackend } from "./pty-backend.js";
import type { WorkspaceAccessScope } from "./workspace-files.js";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_BYTES = 32 * 1024;
const DEFAULT_RETENTION_MS = 30 * 60_000;
const DEFAULT_MAX_TERMINALS = 8;
const MAX_CONFIGURED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURED_RETENTION_MS = 24 * 60 * 60_000;
const MAX_CONFIGURED_TERMINALS = 32;
const MAX_COMMAND_CHARS = 100_000;
const MAX_INPUT_CHARS = 16 * 1024;

export type ManagedCommandStatus = "running" | "completed" | "failed" | "cancelled";

export class CommandManagerError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "NOT_FOUND" | "OUTPUT_EXPIRED" | "CANCELLED" | "RESOURCE_BUSY" | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "CommandManagerError";
  }
}

export interface ManagedCommandSnapshot {
  commandId: string;
  terminalId: string;
  terminalReused: boolean;
  status: ManagedCommandStatus;
  exitCode?: number;
  cwd: string;
  finalCwd?: string;
  background: boolean;
  earliestOffset: number;
  nextOffset: number;
  outputLost: boolean;
  inputSeq: number;
}

export interface ManagedCommandOutput extends ManagedCommandSnapshot {
  outputStartOffset: number;
  output: string;
  hasMore: boolean;
}

type TerminalState = "idle" | "waiting_begin" | "capturing" | "closed";

type ManagedTerminal = {
  id: string;
  backend: PtyBackend;
  state: TerminalState;
  currentCommandId?: string;
  currentCwd: string;
  parseBuffer: string;
  lastUsedAt: number;
  useCount: number;
  exitPromise: Promise<void>;
  resolveExit: () => void;
};

type ManagedCommand = {
  id: string;
  terminalId: string;
  terminalReused: boolean;
  ownerSessionId?: string;
  status: ManagedCommandStatus;
  exitCode?: number;
  cwd: string;
  finalCwd?: string;
  background: boolean;
  beginMarker: string;
  endMarker: string;
  ring: Buffer;
  earliestOffset: number;
  nextOffset: number;
  outputLost: boolean;
  inputSeq: number;
  started: boolean;
  cancelRequested: boolean;
  startedPromise: Promise<void>;
  resolveStarted: () => void;
  completion: Promise<void>;
  resolveCompletion: () => void;
  activityWaiters: Set<() => void>;
  detachAbort?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

export interface ManagedRunOptions {
  command: string;
  cwd?: string;
  background: boolean;
  timeoutMs?: number;
  ownerSessionId?: string;
  signal?: AbortSignal;
}

export class CommandManager {
  private readonly rootPromise: Promise<string>;
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly commands = new Map<string, ManagedCommand>();
  private readonly expiredCommands = new Map<string, number>();

  constructor(
    root: string,
    private readonly options: {
      maxOutputBytes?: number;
      retentionMs?: number;
      maxTerminals?: number;
      accessScope?: WorkspaceAccessScope | (() => WorkspaceAccessScope);
    } = {},
  ) {
    if (this.options.maxOutputBytes !== undefined && (!Number.isSafeInteger(this.options.maxOutputBytes) || this.options.maxOutputBytes < 1 || this.options.maxOutputBytes > MAX_CONFIGURED_OUTPUT_BYTES)) {
      throw new CommandManagerError("INVALID_ARGUMENT", `maxOutputBytes must be an integer from 1 to ${MAX_CONFIGURED_OUTPUT_BYTES}`);
    }
    if (this.options.retentionMs !== undefined && (!Number.isSafeInteger(this.options.retentionMs) || this.options.retentionMs < 1 || this.options.retentionMs > MAX_CONFIGURED_RETENTION_MS)) {
      throw new CommandManagerError("INVALID_ARGUMENT", `retentionMs must be an integer from 1 to ${MAX_CONFIGURED_RETENTION_MS}`);
    }
    if (this.options.maxTerminals !== undefined && (!Number.isSafeInteger(this.options.maxTerminals) || this.options.maxTerminals < 1 || this.options.maxTerminals > MAX_CONFIGURED_TERMINALS)) {
      throw new CommandManagerError("INVALID_ARGUMENT", `maxTerminals must be an integer from 1 to ${MAX_CONFIGURED_TERMINALS}`);
    }
    this.rootPromise = realpath(resolve(root)).catch(() => resolve(root));
  }

  async run(options: ManagedRunOptions): Promise<ManagedCommandOutput> {
    this.cleanupExpiredTombstones();
    if (typeof options.command !== "string" || !options.command.trim() || options.command.length > MAX_COMMAND_CHARS) {
      throw new CommandManagerError("INVALID_ARGUMENT", `command must contain 1-${MAX_COMMAND_CHARS} characters`);
    }
    if (typeof options.background !== "boolean") {
      throw new CommandManagerError("INVALID_ARGUMENT", "background must be boolean");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new CommandManagerError("INVALID_ARGUMENT", "timeout_ms must be an integer from 1000 to 120000");
    }
    if (options.signal?.aborted) throw new CommandManagerError("CANCELLED", "command request was cancelled");

    const root = await this.rootPromise;
    const terminal = this.acquireTerminal(root);
    const requestedCwd = options.cwd === undefined ? undefined : await this.resolveCwd(root, options.cwd);
    const command = this.createCommand(terminal, options, requestedCwd ?? terminal.currentCwd);
    terminal.currentCommandId = command.id;
    terminal.state = "waiting_begin";
    terminal.parseBuffer = "";

    if (options.signal) {
      const onAbort = () => this.cancel(command.id, "command authorization/request was revoked");
      options.signal.addEventListener("abort", onAbort, { once: true });
      command.detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }

    const payload = this.commandPayload(command, options.command, requestedCwd);
    if (!terminal.backend.write(payload)) {
      this.failBeforeStart(command, terminal, "native PTY rejected command input");
      throw new CommandManagerError("INTERNAL_ERROR", "native PTY rejected command input");
    }

    if (options.background) {
      await Promise.race([command.startedPromise, command.completion, this.delay(2_000)]);
      if (options.signal?.aborted && command.status === "cancelled") {
        throw new CommandManagerError("CANCELLED", "command was cancelled");
      }
      return this.outputSnapshot(command, command.earliestOffset, DEFAULT_READ_BYTES);
    }

    await Promise.race([command.completion, this.delay(timeoutMs)]);
    if (options.signal?.aborted && command.status === "cancelled") {
      throw new CommandManagerError("CANCELLED", "command was cancelled");
    }
    return this.outputSnapshot(command, command.earliestOffset, DEFAULT_READ_BYTES);
  }

  getOutput(commandId: string, offset = 0, maxBytes = DEFAULT_READ_BYTES): ManagedCommandOutput {
    const command = this.getCommand(commandId);
    if (!Number.isInteger(offset) || offset < 0) throw new CommandManagerError("INVALID_ARGUMENT", "offset must be a non-negative integer");
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) {
      throw new CommandManagerError("INVALID_ARGUMENT", "max_bytes must be an integer from 1 to 131072");
    }
    return this.outputSnapshot(command, offset, maxBytes);
  }

  sendInput(commandId: string, input: string, appendNewline = true): { commandId: string; terminalId: string; inputSeq: number; status: ManagedCommandStatus } {
    const command = this.getCommand(commandId);
    if (command.status !== "running") throw new CommandManagerError("INVALID_ARGUMENT", `command status is ${command.status}, input is closed`);
    if (typeof input !== "string" || input.length > MAX_INPUT_CHARS) {
      throw new CommandManagerError("INVALID_ARGUMENT", `input must contain at most ${MAX_INPUT_CHARS} characters`);
    }
    const terminal = this.terminals.get(command.terminalId);
    if (!terminal || terminal.state === "closed" || terminal.currentCommandId !== command.id) {
      throw new CommandManagerError("INTERNAL_ERROR", "command terminal is unavailable");
    }
    const data = appendNewline ? `${input}${process.platform === "win32" ? "\r" : "\n"}` : input;
    if (!terminal.backend.write(data)) throw new CommandManagerError("INTERNAL_ERROR", "native PTY rejected command input");
    command.inputSeq += 1;
    return { commandId, terminalId: command.terminalId, inputSeq: command.inputSeq, status: command.status };
  }

  ownerSessionId(commandId: string): string | undefined {
    return this.getCommand(commandId).ownerSessionId;
  }

  async waitForCompletion(commandId: string): Promise<ManagedCommandSnapshot> {
    const command = this.getCommand(commandId);
    await command.completion;
    return this.snapshot(command);
  }

  async waitForActivity(commandId: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<ManagedCommandOutput> {
    const command = this.getCommand(commandId);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new CommandManagerError("INVALID_ARGUMENT", "timeout_ms must be an integer from 1000 to 120000");
    }
    if (signal?.aborted) throw new CommandManagerError("CANCELLED", "wait request was cancelled");

    const baselineOffset = command.nextOffset;
    if (command.status !== "running") {
      return this.outputSnapshot(command, Math.max(baselineOffset, command.earliestOffset), 128 * 1024);
    }

    await new Promise<void>((resolveWait, rejectWait) => {
      let settled = false;
      const finish = (error?: CommandManagerError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        command.activityWaiters.delete(onActivity);
        signal?.removeEventListener("abort", onAbort);
        if (error) rejectWait(error);
        else resolveWait();
      };
      const onActivity = () => finish();
      const onAbort = () => finish(new CommandManagerError("CANCELLED", "wait request was cancelled"));
      const timer = setTimeout(() => finish(), timeoutMs);
      timer.unref?.();
      command.activityWaiters.add(onActivity);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (command.status !== "running" || command.nextOffset !== baselineOffset) finish();
    });

    return this.outputSnapshot(command, Math.max(baselineOffset, command.earliestOffset), 128 * 1024);
  }

  cancel(commandId: string, _reason = "command cancelled"): boolean {
    const command = this.commands.get(commandId);
    if (!command || command.status !== "running") return false;
    command.cancelRequested = true;
    const terminal = this.terminals.get(command.terminalId);
    if (!terminal) {
      this.finalizeCommand(command, "cancelled", undefined);
      return true;
    }
    terminal.backend.kill(true);
    return true;
  }

  async close(reason = "CommandManager closed", timeoutMs = 3_000): Promise<boolean> {
    for (const command of this.commands.values()) {
      if (command.status === "running") this.cancel(command.id, reason);
    }
    const terminals = [...this.terminals.values()];
    for (const terminal of terminals) {
      if (terminal.state !== "closed") terminal.backend.kill(true);
    }
    if (terminals.length === 0) return true;
    const drained = await Promise.race([
      Promise.all(terminals.map((terminal) => terminal.exitPromise)).then(() => true),
      this.delay(timeoutMs).then(() => false),
    ]);
    if (!drained) {
      for (const terminal of terminals) {
        if (terminal.state !== "closed") terminal.backend.kill(true);
      }
    }
    return drained;
  }

  get activeTerminalCount(): number {
    return [...this.terminals.values()].filter((terminal) => terminal.state !== "closed").length;
  }

  get activeCommandCount(): number {
    return [...this.commands.values()].filter((command) => command.status === "running").length;
  }

  private acquireTerminal(root: string): ManagedTerminal {
    const idle = [...this.terminals.values()]
      .filter((terminal) => terminal.state === "idle")
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (idle) return idle;
    const active = [...this.terminals.values()].filter((terminal) => terminal.state !== "closed").length;
    if (active >= (this.options.maxTerminals ?? DEFAULT_MAX_TERMINALS)) {
      throw new CommandManagerError("RESOURCE_BUSY", "all MoonCode PTY terminal slots are busy");
    }
    return this.createTerminal(root);
  }

  private createTerminal(root: string): ManagedTerminal {
    const { executable, argv } = this.shellCommand();
    const backend = createNativePtyBackend({
      root,
      executable,
      argv,
      env: this.safeEnvironment(root),
      cols: 120,
      rows: 30,
    });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolveExitPromise) => { resolveExit = resolveExitPromise; });
    const terminal: ManagedTerminal = {
      id: randomUUID(),
      backend,
      state: "idle",
      currentCwd: root,
      parseBuffer: "",
      lastUsedAt: Date.now(),
      useCount: 0,
      exitPromise,
      resolveExit,
    };
    this.terminals.set(terminal.id, terminal);
    backend.onData((chunk) => this.handleTerminalData(terminal, chunk));
    backend.onExit((code) => this.handleTerminalExit(terminal, code));
    return terminal;
  }

  private createCommand(terminal: ManagedTerminal, options: ManagedRunOptions, cwd: string): ManagedCommand {
    const id = randomUUID();
    let resolveStarted!: () => void;
    let resolveCompletion!: () => void;
    const startedPromise = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise; });
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
    const command: ManagedCommand = {
      id,
      terminalId: terminal.id,
      terminalReused: terminal.useCount > 0,
      ownerSessionId: options.ownerSessionId,
      status: "running",
      cwd,
      background: options.background,
      // Marker plaintext is never sent through the terminal. The wrapper only
      // carries base64 and decodes it at execution time, so PSReadLine echo and
      // prediction cannot accidentally satisfy the framing parser.
      beginMarker: `MOONCODE_BEGIN_${id}_${randomUUID().replaceAll("-", "")}`,
      endMarker: `MOONCODE_END_${id}_${randomUUID().replaceAll("-", "")}`,
      ring: Buffer.alloc(0),
      earliestOffset: 0,
      nextOffset: 0,
      outputLost: false,
      inputSeq: 0,
      started: false,
      cancelRequested: false,
      startedPromise,
      resolveStarted,
      completion,
      resolveCompletion,
      activityWaiters: new Set(),
    };
    terminal.useCount += 1;
    this.commands.set(id, command);
    return command;
  }

  private commandPayload(command: ManagedCommand, text: string, cwd?: string): string {
    if (process.platform === "win32") {
      const text64 = Buffer.from(text, "utf16le").toString("base64");
      const begin64 = Buffer.from(command.beginMarker, "utf8").toString("base64");
      const end64 = Buffer.from(command.endMarker, "utf8").toString("base64");
      const cwdClause = cwd
        ? `$__mcCwd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cwd, "utf8").toString("base64")}'));Set-Location -LiteralPath $__mcCwd;`
        : "";
      return [
        cwdClause,
        `$__mcUtf8=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$__mcUtf8;[Console]::OutputEncoding=$__mcUtf8;$OutputEncoding=$__mcUtf8;Remove-Module PSReadLine -ErrorAction SilentlyContinue;`,
        `$__mcBegin=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${begin64}'));$__mcEnd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${end64}'));`,
        `$global:LASTEXITCODE=$null;[Console]::Out.WriteLine($__mcBegin);`,
        `$__mcText=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${text64}'));`,
        `$__mcCaught=$false;try{Invoke-Expression $__mcText;$__mcOk=$?}catch{$__mcCaught=$true;$__mcOk=$false;Write-Error $_};`,
        `$__mcExit=if($null -ne $global:LASTEXITCODE){[int]$global:LASTEXITCODE}elseif($__mcOk -and -not $__mcCaught){0}else{1};`,
        `$__mcPwd=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path));`,
        `$__mcPwdChunks=@();for($__mcI=0;$__mcI -lt $__mcPwd.Length;$__mcI+=64){$__mcPwdChunks+=$__mcPwd.Substring($__mcI,[Math]::Min(64,$__mcPwd.Length-$__mcI))};`,
        `[Console]::Out.WriteLine();[Console]::Out.WriteLine($__mcEnd+':'+$__mcExit+':'+$__mcPwdChunks.Count);foreach($__mcChunk in $__mcPwdChunks){[Console]::Out.WriteLine('C:'+$__mcChunk)}`,
        "\r",
      ].join("");
    }

    const escaped = text.replace(/'/g, `'"'"'`);
    const cwdClause = cwd ? `cd -- '${cwd.replace(/'/g, `'"'"'`)}' && ` : "";
    const begin64 = Buffer.from(command.beginMarker, "utf8").toString("base64");
    const end64 = Buffer.from(command.endMarker, "utf8").toString("base64");
    return `${cwdClause}__mc_begin=$(printf '%s' '${begin64}' | base64 -d); __mc_end=$(printf '%s' '${end64}' | base64 -d); printf '%s\\n' "$__mc_begin"; eval '${escaped}'; __mc_exit=$?; __mc_pwd=$(printf '%s' "$PWD" | base64 | tr -d '\\n'); printf '\\n%s:%s:%s\\n' "$__mc_end" "$__mc_exit" "$__mc_pwd"\n`;
  }

  private handleTerminalData(terminal: ManagedTerminal, chunk: Buffer): void {
    const commandId = terminal.currentCommandId;
    if (!commandId) return;
    const command = this.commands.get(commandId);
    if (!command || command.status !== "running") return;
    terminal.parseBuffer += chunk.toString("utf8");

    if (terminal.state === "waiting_begin") {
      const index = terminal.parseBuffer.indexOf(command.beginMarker);
      if (index < 0) {
        const keep = Math.max(command.beginMarker.length - 1, 128);
        if (terminal.parseBuffer.length > keep) terminal.parseBuffer = terminal.parseBuffer.slice(-keep);
        return;
      }
      terminal.parseBuffer = terminal.parseBuffer.slice(index + command.beginMarker.length).replace(/^\r?\n/, "");
      terminal.state = "capturing";
      command.started = true;
      command.resolveStarted();
    }

    if (terminal.state !== "capturing") return;
    const endIndex = terminal.parseBuffer.indexOf(command.endMarker);
    if (endIndex >= 0) {
      const afterMarker = terminal.parseBuffer.slice(endIndex + command.endMarker.length);
      const header = /^:([-]?\d+):(\d+)\r?\n/.exec(afterMarker);
      if (!header) return;
      const chunkCount = Number(header[2]);
      if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunkCount > 128) {
        this.destroyTerminal(terminal, command, "failed", undefined);
        return;
      }
      const metadataTail = afterMarker.slice(header[0].length);
      const lines = metadataTail.split(/\r?\n/);
      if (lines.length <= chunkCount) return;
      const chunks: string[] = [];
      for (let i = 0; i < chunkCount; i++) {
        const match = /^C:([A-Za-z0-9+/=]*)$/.exec(lines[i] ?? "");
        if (!match) {
          this.destroyTerminal(terminal, command, "failed", undefined);
          return;
        }
        chunks.push(match[1] ?? "");
      }
      let userOutput = terminal.parseBuffer.slice(0, endIndex);
      if (userOutput.endsWith("\r\n")) userOutput = userOutput.slice(0, -2);
      else if (userOutput.endsWith("\n")) userOutput = userOutput.slice(0, -1);
      this.appendOutput(command, userOutput);
      const exitCode = Number(header[1]);
      try {
        command.finalCwd = Buffer.from(chunks.join(""), "base64").toString("utf8") || command.cwd;
        terminal.currentCwd = command.finalCwd;
      } catch {
        command.finalCwd = command.cwd;
      }
      terminal.parseBuffer = "";
      terminal.currentCommandId = undefined;
      terminal.state = "idle";
      terminal.lastUsedAt = Date.now();
      this.finalizeCommand(command, exitCode === 0 ? "completed" : "failed", exitCode);
      return;
    }

    // Keep only the suffix that could still become an end marker if ConPTY
    // split the marker across callbacks. Everything else is real user output
    // and must be visible immediately, including short interactive prompts.
    const keep = this.markerPrefixSuffixLength(terminal.parseBuffer, command.endMarker);
    const cut = terminal.parseBuffer.length - keep;
    if (cut > 0) {
      let safeCut = cut;
      if (/[\uD800-\uDBFF]/.test(terminal.parseBuffer[safeCut - 1] ?? "") && /[\uDC00-\uDFFF]/.test(terminal.parseBuffer[safeCut] ?? "")) safeCut -= 1;
      if (safeCut > 0) {
        this.appendOutput(command, terminal.parseBuffer.slice(0, safeCut));
        terminal.parseBuffer = terminal.parseBuffer.slice(safeCut);
      }
    }
  }

  private markerPrefixSuffixLength(value: string, marker: string): number {
    const max = Math.min(value.length, marker.length - 1);
    for (let length = max; length > 0; length -= 1) {
      if (value.endsWith(marker.slice(0, length))) return length;
    }
    return 0;
  }

  private handleTerminalExit(terminal: ManagedTerminal, code: number): void {
    const previousState = terminal.state;
    terminal.state = "closed";
    terminal.resolveExit();
    const command = terminal.currentCommandId ? this.commands.get(terminal.currentCommandId) : undefined;
    terminal.currentCommandId = undefined;
    if (command && command.status === "running") {
      if (previousState === "capturing" && terminal.parseBuffer) this.appendOutput(command, terminal.parseBuffer);
      this.finalizeCommand(command, command.cancelRequested ? "cancelled" : code === 0 ? "completed" : "failed", code);
    }
    terminal.parseBuffer = "";
    this.terminals.delete(terminal.id);
  }

  private destroyTerminal(terminal: ManagedTerminal, command: ManagedCommand, status: ManagedCommandStatus, exitCode?: number): void {
    command.cancelRequested ||= status === "cancelled";
    terminal.backend.kill(true);
    this.finalizeCommand(command, status, exitCode);
  }

  private failBeforeStart(command: ManagedCommand, terminal: ManagedTerminal, _message: string): void {
    terminal.backend.kill(true);
    this.finalizeCommand(command, "failed", undefined);
  }

  private finalizeCommand(command: ManagedCommand, status: ManagedCommandStatus, exitCode?: number): void {
    if (command.status !== "running") return;
    command.status = status;
    command.exitCode = exitCode;
    command.detachAbort?.();
    command.detachAbort = undefined;
    if (!command.started) command.resolveStarted();
    command.resolveCompletion();
    this.notifyActivity(command);
    const retentionMs = this.options.retentionMs ?? DEFAULT_RETENTION_MS;
    command.expiryTimer = setTimeout(() => {
      this.commands.delete(command.id);
      this.expiredCommands.set(command.id, Date.now() + retentionMs);
    }, retentionMs);
    command.expiryTimer.unref?.();
  }

  private appendOutput(command: ManagedCommand, text: string): void {
    if (!text) return;
    const chunk = Buffer.from(text, "utf8");
    if (chunk.length === 0) return;
    command.nextOffset += chunk.length;
    let combined = Buffer.concat([command.ring, chunk]);
    const max = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (combined.length > max) {
      let overflow = combined.length - max;
      while (overflow < combined.length && (combined[overflow]! & 0xc0) === 0x80) overflow += 1;
      combined = combined.subarray(overflow);
      command.outputLost = true;
    }
    command.ring = combined;
    command.earliestOffset = command.nextOffset - command.ring.length;
    this.notifyActivity(command);
  }

  private notifyActivity(command: ManagedCommand): void {
    if (command.activityWaiters.size === 0) return;
    const waiters = [...command.activityWaiters];
    command.activityWaiters.clear();
    for (const resolveWait of waiters) resolveWait();
  }

  private outputSnapshot(command: ManagedCommand, offset: number, maxBytes: number): ManagedCommandOutput {
    if (offset < command.earliestOffset) {
      throw new CommandManagerError("OUTPUT_EXPIRED", `offset ${offset} is older than earliest_offset ${command.earliestOffset}`);
    }
    if (offset > command.nextOffset) {
      throw new CommandManagerError("INVALID_ARGUMENT", `offset ${offset} exceeds next_offset ${command.nextOffset}`);
    }
    const relativeOffset = offset - command.earliestOffset;
    if (relativeOffset < command.ring.length && (command.ring[relativeOffset]! & 0xc0) === 0x80) {
      throw new CommandManagerError("INVALID_ARGUMENT", "offset must point to a UTF-8 code point boundary");
    }
    let end = Math.min(command.ring.length, relativeOffset + maxBytes);
    while (end < command.ring.length && end > relativeOffset && (command.ring[end]! & 0xc0) === 0x80) end -= 1;
    if (end === relativeOffset && end < command.ring.length) {
      end += 1;
      while (end < command.ring.length && (command.ring[end]! & 0xc0) === 0x80) end += 1;
    }
    const slice = command.ring.subarray(relativeOffset, end);
    return {
      ...this.snapshot(command),
      outputStartOffset: offset,
      output: slice.toString("utf8"),
      hasMore: offset + slice.length < command.nextOffset,
      nextOffset: offset + slice.length,
    };
  }

  private snapshot(command: ManagedCommand): ManagedCommandSnapshot {
    return {
      commandId: command.id,
      terminalId: command.terminalId,
      terminalReused: command.terminalReused,
      status: command.status,
      exitCode: command.exitCode,
      cwd: command.cwd,
      finalCwd: command.finalCwd,
      background: command.background,
      earliestOffset: command.earliestOffset,
      nextOffset: command.nextOffset,
      outputLost: command.outputLost,
      inputSeq: command.inputSeq,
    };
  }

  private getCommand(commandId: string): ManagedCommand {
    if (typeof commandId !== "string" || !commandId) throw new CommandManagerError("INVALID_ARGUMENT", "command_id is required");
    const command = this.commands.get(commandId);
    if (command) return command;
    if (this.expiredCommands.has(commandId)) throw new CommandManagerError("OUTPUT_EXPIRED", "command output retention window expired");
    throw new CommandManagerError("NOT_FOUND", "command_id was not found");
  }

  private async resolveCwd(root: string, requested: string): Promise<string> {
    const accessScope = typeof this.options.accessScope === "function" ? this.options.accessScope() : this.options.accessScope ?? "workspace";
    if (accessScope === "computer") {
      if (!requested || requested.includes("\0")) throw new CommandManagerError("INVALID_ARGUMENT", "cwd must be a valid directory path");
      if (process.platform === "win32" && (requested.startsWith("\\\\") || requested.startsWith("//") || /^\\\\[?.]\\/.test(requested))) {
        throw new CommandManagerError("INVALID_ARGUMENT", "UNC and Windows device cwd paths are not allowed");
      }
      const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
      let actual: string;
      try {
        actual = await realpath(candidate);
      } catch {
        throw new CommandManagerError("NOT_FOUND", `cwd not found: ${requested}`);
      }
      const info = await stat(actual);
      if (!info.isDirectory()) throw new CommandManagerError("INVALID_ARGUMENT", "cwd must resolve to a directory");
      return actual;
    }
    if (!requested || isAbsolute(requested) || requested.includes("\0") || (process.platform === "win32" && requested.includes(":"))) {
      throw new CommandManagerError("INVALID_ARGUMENT", "cwd must be a workspace-relative directory");
    }
    const candidate = resolve(root, requested);
    const lexical = relative(root, candidate);
    if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      throw new CommandManagerError("INVALID_ARGUMENT", "cwd leaves the selected workspace");
    }
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch {
      throw new CommandManagerError("NOT_FOUND", `cwd not found: ${requested}`);
    }
    const info = await stat(actual);
    if (!info.isDirectory()) throw new CommandManagerError("INVALID_ARGUMENT", "cwd must resolve to a directory");
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new CommandManagerError("INVALID_ARGUMENT", "resolved cwd leaves the selected workspace");
    }
    return actual;
  }

  private shellCommand(): { executable: string; argv: string[] } {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      return {
        executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        argv: ["-NoLogo", "-NoProfile", "-NoExit"],
      };
    }
    const bash = "/bin/bash";
    if (existsSync(bash)) return { executable: bash, argv: ["--noprofile", "--norc"] };
    return { executable: "/bin/sh", argv: [] };
  }

  private safeEnvironment(root: string): NodeJS.ProcessEnv {
    const allow = [
      "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
      "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
    ];
    const env: NodeJS.ProcessEnv = { TERM: "xterm-256color", TEMP: root, TMP: root, TMPDIR: root };
    for (const key of allow) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }

  private cleanupExpiredTombstones(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.expiredCommands) if (expiresAt <= now) this.expiredCommands.delete(id);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, ms);
      timer.unref?.();
    });
  }
}
