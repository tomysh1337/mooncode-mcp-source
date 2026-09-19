import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BridgeApplyPatchArgs, BridgePublicErrorCode } from "@mooncode/contracts";
import { WorkspaceFileError, WorkspaceFileService, type WorkspaceAccessScope } from "./workspace-files.js";

const TX_ROOT_NAME = ".mooncode";
const TX_DIR_NAME = "patch-transactions";
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_FILES = 100;

type PatchKind = "add" | "update" | "delete" | "move";

interface PatchHunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface PatchHunk {
  lines: PatchHunkLine[];
}

type ParsedPatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

interface TextFileSnapshot {
  path: string;
  absolute: string;
  exists: true;
  bytes: Buffer;
  version: string;
  text: string;
  bom: boolean;
  eol: "\n" | "\r\n" | "\r";
  finalNewline: boolean;
}

interface MissingSnapshot {
  path: string;
  absolute: string;
  exists: false;
  version: null;
}

type FileSnapshot = TextFileSnapshot | MissingSnapshot;

interface PlannedOperation {
  kind: PatchKind;
  sourcePath?: string;
  targetPath: string;
  source?: TextFileSnapshot;
  beforeBytes?: Buffer;
  afterBytes?: Buffer;
  beforeVersion: string | null;
  afterVersion: string | null;
}

interface JournalOperation {
  kind: PatchKind;
  sourcePath?: string;
  targetPath: string;
  sourceAbsolute?: string;
  targetAbsolute: string;
  stagedAbsolute?: string;
  backupAbsolute?: string;
  sourceBackedUp: boolean;
  targetCommitted: boolean;
}

interface PatchJournal {
  version: 1;
  transactionId: string;
  workspaceRoot: string;
  phase: "prepared" | "committing" | "rolling_back" | "recovery_required";
  operations: JournalOperation[];
}

export type WorkspaceDirtyChecker = (paths: readonly string[], signal?: AbortSignal) => Promise<readonly string[]>;

export interface WorkspacePatchFileResult {
  action: PatchKind;
  path: string;
  source_path?: string;
  before_version: string | null;
  after_version: string | null;
  status: "planned" | "applied" | "rolled_back" | "recovery_required";
}

export interface WorkspacePatchResult {
  transaction_id: string | null;
  applied: boolean;
  rolled_back: boolean;
  recovery_required: boolean;
  error?: { code: BridgePublicErrorCode; message: string };
  files: WorkspacePatchFileResult[];
  diff: string;
  diff_truncated: boolean;
}

export interface WorkspacePatchServiceOptions {
  dirtyChecker?: WorkspaceDirtyChecker;
  accessScope?: WorkspaceAccessScope | (() => WorkspaceAccessScope);
  faultInjector?: (event: {
    phase: "before_commit" | "after_source_backup" | "after_target_commit" | "before_rollback_restore";
    index: number;
    path: string;
  }) => void | Promise<void>;
}

export interface WorkspacePatchApplyOptions {
  /** Acquired after lock/version/dirty revalidation and held through commit or rollback. */
  enterCommitCriticalSection?: () => (() => void) | Promise<() => void>;
}

export class WorkspacePatchError extends Error {
  constructor(readonly code: BridgePublicErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePatchError";
  }
}

const pathLocks = new Map<string, Promise<void>>();
const rootRecoveryPromises = new Map<string, Promise<void>>();
const blockedRecoveryRoots = new Set<string>();

function recoveryRootKey(root: string): string {
  return process.platform === "win32" ? root.toLocaleLowerCase() : root;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspacePatchError("CANCELLED", "patch request was cancelled");
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeUtf8(bytes: Buffer): { text: string; bom: boolean; eol: "\n" | "\r\n" | "\r"; finalNewline: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new WorkspacePatchError("INVALID_ARGUMENT", "patch target is not valid UTF-8/UTF-8-BOM text");
  }
  if (text.includes("\0")) throw new WorkspacePatchError("INVALID_ARGUMENT", "binary patch targets are not supported");
  const match = text.match(/\r\n|\n|\r/);
  const eol = (match?.[0] ?? "\n") as "\n" | "\r\n" | "\r";
  return { text, bom, eol, finalNewline: /(?:\r\n|\n|\r)$/.test(text) };
}

function encodeText(text: string, template?: TextFileSnapshot): Buffer {
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const eol = template?.eol ?? "\n";
  const converted = eol === "\n" ? normalized : normalized.replace(/\n/g, eol);
  const body = Buffer.from(converted, "utf8");
  return template?.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function joinLines(lines: string[], finalNewline: boolean): string {
  return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}

function parsePatch(text: string): ParsedPatchOperation[] {
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) throw new WorkspacePatchError("INVALID_ARGUMENT", "patch exceeds 2 MiB");
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "*** Begin Patch") throw new WorkspacePatchError("INVALID_ARGUMENT", "patch must start with *** Begin Patch");
  const endIndex = lines.lastIndexOf("*** End Patch");
  if (endIndex < 1 || lines.slice(endIndex + 1).some((line) => line.trim() !== "")) {
    throw new WorkspacePatchError("INVALID_ARGUMENT", "patch must end with *** End Patch");
  }
  const operations: ParsedPatchOperation[] = [];
  let i = 1;
  while (i < endIndex) {
    const header = lines[i]!;
    let match = header.match(/^\*\*\* Add File: (.+)$/);
    if (match) {
      const path = match[1]!.trim();
      i += 1;
      const content: string[] = [];
      while (i < endIndex && !lines[i]!.startsWith("*** ")) {
        const line = lines[i]!;
        if (!line.startsWith("+")) throw new WorkspacePatchError("INVALID_ARGUMENT", `add file lines must start with + (${path})`);
        content.push(line.slice(1));
        i += 1;
      }
      operations.push({ kind: "add", path, content: content.length ? `${content.join("\n")}\n` : "" });
      continue;
    }
    match = header.match(/^\*\*\* Delete File: (.+)$/);
    if (match) {
      operations.push({ kind: "delete", path: match[1]!.trim() });
      i += 1;
      continue;
    }
    match = header.match(/^\*\*\* Update File: (.+)$/);
    if (match) {
      const path = match[1]!.trim();
      i += 1;
      let moveTo: string | undefined;
      if (i < endIndex) {
        const move = lines[i]!.match(/^\*\*\* Move to: (.+)$/);
        if (move) {
          moveTo = move[1]!.trim();
          i += 1;
        }
      }
      const hunks: PatchHunk[] = [];
      while (i < endIndex && !lines[i]!.startsWith("*** ")) {
        if (!lines[i]!.startsWith("@@")) throw new WorkspacePatchError("INVALID_ARGUMENT", `update section requires @@ hunks (${path})`);
        i += 1;
        const hunkLines: PatchHunkLine[] = [];
        while (i < endIndex && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("*** ")) {
          const line = lines[i]!;
          if (line === "\\ No newline at end of file") {
            i += 1;
            continue;
          }
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            throw new WorkspacePatchError("INVALID_ARGUMENT", `invalid hunk line prefix (${path})`);
          }
          hunkLines.push({ kind: prefix === " " ? "context" : prefix === "+" ? "add" : "remove", text: line.slice(1) });
          i += 1;
        }
        if (hunkLines.length === 0) throw new WorkspacePatchError("INVALID_ARGUMENT", `empty update hunk (${path})`);
        hunks.push({ lines: hunkLines });
      }
      if (hunks.length === 0 && !moveTo) throw new WorkspacePatchError("INVALID_ARGUMENT", `update requires a hunk or Move to (${path})`);
      operations.push({ kind: "update", path, moveTo, hunks });
      continue;
    }
    if (!header.trim()) {
      i += 1;
      continue;
    }
    throw new WorkspacePatchError("INVALID_ARGUMENT", `unknown patch directive: ${header}`);
  }
  if (operations.length === 0) throw new WorkspacePatchError("INVALID_ARGUMENT", "patch contains no file operations");
  if (operations.length > MAX_PATCH_FILES) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch exceeds ${MAX_PATCH_FILES} file operations`);
  return operations;
}

function applyHunks(snapshot: TextFileSnapshot, hunks: PatchHunk[]): string {
  const split = splitLines(snapshot.text);
  const lines = [...split.lines];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    const candidates: number[] = [];
    for (let start = cursor; start <= lines.length - oldLines.length; start += 1) {
      let matches = true;
      for (let offset = 0; offset < oldLines.length; offset += 1) {
        if (lines[start + offset] !== oldLines[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) candidates.push(start);
    }
    if (candidates.length !== 1) {
      throw new WorkspacePatchError("VERSION_CONFLICT", candidates.length === 0 ? "patch hunk context does not match current file" : "patch hunk context is ambiguous");
    }
    const start = candidates[0]!;
    lines.splice(start, oldLines.length, ...newLines);
    cursor = start + newLines.length;
  }
  return joinLines(lines, split.finalNewline);
}

function formatWholeFileDiff(oldPath: string | null, newPath: string | null, before: Buffer | undefined, after: Buffer | undefined): string {
  const oldLabel = oldPath ? `a/${oldPath}` : "/dev/null";
  const newLabel = newPath ? `b/${newPath}` : "/dev/null";
  const beforeText = before ? decodeUtf8(before).text.replace(/\r\n|\r/g, "\n") : "";
  const afterText = after ? decodeUtf8(after).text.replace(/\r\n|\r/g, "\n") : "";
  const beforeLines = splitLines(beforeText).lines;
  const afterLines = splitLines(afterText).lines;
  const body = [
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return body.join("\n");
}

async function acquirePathLocks(paths: string[]): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const key of [...new Set(paths)].sort()) {
    const previous = pathLocks.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
    const chain = previous.then(() => gate);
    pathLocks.set(key, chain);
    await previous;
    releases.push(() => {
      releaseGate();
      if (pathLocks.get(key) === chain) pathLocks.delete(key);
    });
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function mapFsError(error: unknown): WorkspacePatchError {
  if (error instanceof WorkspacePatchError) return error;
  if (error instanceof WorkspaceFileError) return new WorkspacePatchError(error.code, error.message);
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if ([
      "INVALID_ARGUMENT",
      "UNAUTHENTICATED",
      "PERMISSION_DENIED",
      "NOT_FOUND",
      "VERSION_CONFLICT",
      "CANCELLED",
      "TIMEOUT",
      "PROVIDER_UNAVAILABLE",
      "OUTPUT_EXPIRED",
      "INTERNAL_ERROR",
    ].includes(code)) {
      return new WorkspacePatchError(code as BridgePublicErrorCode, error instanceof Error ? error.message : code);
    }
  }
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT" || errno.code === "ENOTDIR") return new WorkspacePatchError("NOT_FOUND", errno.message);
  if (errno.code === "EACCES" || errno.code === "EPERM") return new WorkspacePatchError("PERMISSION_DENIED", errno.message);
  return new WorkspacePatchError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

export class WorkspacePatchService {
  readonly root: string;
  private readonly files: WorkspaceFileService;

  constructor(root: string, private readonly options: WorkspacePatchServiceOptions = {}) {
    this.root = resolve(root);
    this.files = new WorkspaceFileService(this.root, { accessScope: options.accessScope });
  }

  private transactionRoot(): string {
    return join(this.root, TX_ROOT_NAME, TX_DIR_NAME);
  }

  private async snapshot(path: string, mustExist: boolean, signal?: AbortSignal): Promise<FileSnapshot> {
    checkAbort(signal);
    if (mustExist) {
      const safe = await this.files.resolveExistingPath(path, signal);
      const info = await stat(safe.realPath);
      if (!info.isFile()) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch target is not a file: ${safe.workspacePath}`);
      const bytes = await readFile(safe.realPath);
      const decoded = decodeUtf8(bytes);
      return { path: safe.workspacePath, absolute: safe.realPath, exists: true, bytes, version: sha256(bytes), ...decoded };
    }
    const absolute = await this.files.resolveWritePath(path, signal);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch target exists and is not a file: ${path}`);
      const safe = await this.files.resolveExistingPath(path, signal);
      const bytes = await readFile(safe.realPath);
      const decoded = decodeUtf8(bytes);
      return { path: safe.workspacePath, absolute: safe.realPath, exists: true, bytes, version: sha256(bytes), ...decoded };
    } catch (error) {
      if (error instanceof WorkspacePatchError || error instanceof WorkspaceFileError) throw error;
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT" && errno.code !== "ENOTDIR") throw mapFsError(error);
      return { path: path.replace(/\\/g, "/"), absolute, exists: false, version: null };
    }
  }

  private requireExpected(expected: Record<string, string | null> | undefined, path: string, actual: string | null): void {
    if (!expected || !Object.prototype.hasOwnProperty.call(expected, path)) {
      throw new WorkspacePatchError("VERSION_CONFLICT", `expected_versions is missing ${path}`);
    }
    const wanted = expected[path];
    if (wanted !== actual) throw new WorkspacePatchError("VERSION_CONFLICT", `version changed for ${path}`);
  }

  private async assertNotDirty(paths: string[], signal?: AbortSignal): Promise<void> {
    if (!this.options.dirtyChecker) return;
    const dirty = await this.options.dirtyChecker([...new Set(paths)].sort(), signal);
    if (dirty.length > 0) throw new WorkspacePatchError("VERSION_CONFLICT", `unsaved editor buffers block patch: ${dirty.join(", ")}`);
  }

  private async buildPlan(parsed: ParsedPatchOperation[], expected: Record<string, string | null> | undefined, signal?: AbortSignal): Promise<PlannedOperation[]> {
    const plan: PlannedOperation[] = [];
    const touched = new Set<string>();
    for (const operation of parsed) {
      checkAbort(signal);
      if (operation.kind === "add") {
        const target = await this.snapshot(operation.path, false, signal);
        this.requireExpected(expected, target.path, target.version);
        if (target.exists) throw new WorkspacePatchError("VERSION_CONFLICT", `add target already exists: ${target.path}`);
        if (touched.has(target.path)) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch touches ${target.path} more than once`);
        touched.add(target.path);
        const afterBytes = encodeText(operation.content);
        plan.push({ kind: "add", targetPath: target.path, beforeVersion: null, afterVersion: sha256(afterBytes), afterBytes });
        continue;
      }
      const source = await this.snapshot(operation.path, true, signal);
      if (!source.exists) throw new WorkspacePatchError("NOT_FOUND", `file not found: ${operation.path}`);
      this.requireExpected(expected, source.path, source.version);
      if (touched.has(source.path)) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch touches ${source.path} more than once`);
      touched.add(source.path);
      if (operation.kind === "delete") {
        plan.push({ kind: "delete", sourcePath: source.path, targetPath: source.path, source, beforeBytes: source.bytes, beforeVersion: source.version, afterVersion: null });
        continue;
      }
      const updatedText = operation.hunks.length ? applyHunks(source, operation.hunks) : source.text;
      const afterBytes = encodeText(updatedText, source);
      if (operation.moveTo) {
        const destination = await this.snapshot(operation.moveTo, false, signal);
        this.requireExpected(expected, destination.path, destination.version);
        if (destination.exists) throw new WorkspacePatchError("VERSION_CONFLICT", `move destination already exists: ${destination.path}`);
        if (touched.has(destination.path)) throw new WorkspacePatchError("INVALID_ARGUMENT", `patch touches ${destination.path} more than once`);
        touched.add(destination.path);
        plan.push({ kind: "move", sourcePath: source.path, targetPath: destination.path, source, beforeBytes: source.bytes, afterBytes, beforeVersion: source.version, afterVersion: sha256(afterBytes) });
      } else {
        plan.push({ kind: "update", sourcePath: source.path, targetPath: source.path, source, beforeBytes: source.bytes, afterBytes, beforeVersion: source.version, afterVersion: sha256(afterBytes) });
      }
    }
    return plan;
  }

  private async resolvePlanPaths(plan: PlannedOperation[], signal?: AbortSignal): Promise<JournalOperation[]> {
    const operations: JournalOperation[] = [];
    for (const item of plan) {
      checkAbort(signal);
      const targetAbsolute = await this.files.resolveWritePath(item.targetPath, signal);
      let sourceAbsolute: string | undefined;
      if (item.sourcePath) sourceAbsolute = (await this.files.resolveExistingPath(item.sourcePath, signal)).realPath;
      operations.push({
        kind: item.kind,
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        sourceAbsolute,
        targetAbsolute,
        sourceBackedUp: false,
        targetCommitted: false,
      });
    }
    return operations;
  }

  private async writeJournal(path: string, journal: PatchJournal): Promise<void> {
    const temp = `${path}.tmp-${randomUUID()}`;
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }

  private async rollback(journal: PatchJournal, journalPath: string): Promise<boolean> {
    journal.phase = "rolling_back";
    await this.writeJournal(journalPath, journal);
    try {
      for (let i = journal.operations.length - 1; i >= 0; i -= 1) {
        const operation = journal.operations[i]!;
        await this.options.faultInjector?.({
          phase: "before_rollback_restore",
          index: i,
          path: operation.targetPath,
        });
        if (operation.targetCommitted) {
          await rm(operation.targetAbsolute, { recursive: false, force: true });
          operation.targetCommitted = false;
          await this.writeJournal(journalPath, journal);
        }
        if (operation.sourceBackedUp && operation.backupAbsolute && operation.sourceAbsolute) {
          await mkdir(dirname(operation.sourceAbsolute), { recursive: true });
          await rename(operation.backupAbsolute, operation.sourceAbsolute);
          operation.sourceBackedUp = false;
          await this.writeJournal(journalPath, journal);
        }
        if (operation.stagedAbsolute) {
          await rm(operation.stagedAbsolute, { force: true });
        }
      }
      return true;
    } catch {
      journal.phase = "recovery_required";
      try { await this.writeJournal(journalPath, journal); } catch { /* preserve whatever journal remains */ }
      return false;
    }
  }

  private async cleanupTransaction(transactionDir: string): Promise<void> {
    await rm(transactionDir, { recursive: true, force: true });
    try { await rmdir(this.transactionRoot()); } catch { /* another transaction or already gone */ }
    try { await rmdir(join(this.root, TX_ROOT_NAME)); } catch { /* keep when non-empty */ }
  }

  async recoverPendingTransactions(): Promise<{ recovered: number; recovery_required: string[] }> {
    const recoveryKey = recoveryRootKey(this.root);
    const wasBlocked = blockedRecoveryRoots.has(recoveryKey);
    const root = this.transactionRoot();
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        blockedRecoveryRoots.delete(recoveryKey);
        return { recovered: 0, recovery_required: [] };
      }
      throw mapFsError(error);
    }
    let recovered = 0;
    const failed: string[] = [];
    for (const entry of entries) {
      const transactionDir = join(root, entry);
      const journalPath = join(transactionDir, "journal.json");
      try {
        const journal = JSON.parse(await readFile(journalPath, "utf8")) as PatchJournal;
        if (journal.version !== 1 || resolve(journal.workspaceRoot) !== this.root) {
          failed.push(entry);
          continue;
        }
        const ok = await this.rollback(journal, journalPath);
        if (ok) {
          recovered += 1;
          await this.cleanupTransaction(transactionDir);
        } else {
          failed.push(entry);
        }
      } catch {
        failed.push(entry);
      }
    }
    if (failed.length > 0) blockedRecoveryRoots.add(recoveryKey);
    else {
      blockedRecoveryRoots.delete(recoveryKey);
      if (wasBlocked) rootRecoveryPromises.set(recoveryKey, Promise.resolve());
    }
    return { recovered, recovery_required: failed };
  }

  private async ensureRecovered(): Promise<void> {
    const key = recoveryRootKey(this.root);
    if (blockedRecoveryRoots.has(key)) {
      throw new WorkspacePatchError("INTERNAL_ERROR", "unresolved patch recovery blocks writes for this workspace");
    }
    let recoveryPromise = rootRecoveryPromises.get(key);
    if (!recoveryPromise) {
      recoveryPromise = (async () => {
        const recovery = await this.recoverPendingTransactions();
        if (recovery.recovery_required.length > 0) {
          throw new WorkspacePatchError(
            "INTERNAL_ERROR",
            `unresolved patch recovery blocks writes: ${recovery.recovery_required.join(", ")}`,
          );
        }
      })();
      rootRecoveryPromises.set(key, recoveryPromise);
    }
    await recoveryPromise;
  }

  async applyPatch(
    args: BridgeApplyPatchArgs,
    signal?: AbortSignal,
    applyOptions: WorkspacePatchApplyOptions = {},
  ): Promise<WorkspacePatchResult> {
    let transactionId: string | null = null;
    let plan: PlannedOperation[] = [];
    let diff = "";
    let diffTruncated = false;
    let releaseLocks: (() => void) | undefined;
    let transactionDir: string | undefined;
    let journalPath: string | undefined;
    let journal: PatchJournal | undefined;
    let leaveCommitCriticalSection: (() => void) | undefined;
    try {
      checkAbort(signal);
      if (!args || typeof args.patch !== "string" || !args.patch) throw new WorkspacePatchError("INVALID_ARGUMENT", "patch is required");
      await this.ensureRecovered();
      const parsed = parsePatch(args.patch);
      plan = await this.buildPlan(parsed, args.expected_versions, signal);
      const touched = plan.flatMap((item) => item.sourcePath && item.sourcePath !== item.targetPath ? [item.sourcePath, item.targetPath] : [item.targetPath]);
      await this.assertNotDirty(touched, signal);
      releaseLocks = await acquirePathLocks(touched.map((path) => resolve(this.root, path.split("/").join(sep))));
      checkAbort(signal);
      // Lock-after revalidation closes the TOCTOU window between preflight and commit.
      plan = await this.buildPlan(parsed, args.expected_versions, signal);
      await this.assertNotDirty(touched, signal);
      if (applyOptions.enterCommitCriticalSection) {
        leaveCommitCriticalSection = await applyOptions.enterCommitCriticalSection();
      }
      checkAbort(signal);

      transactionId = randomUUID();
      transactionDir = join(this.transactionRoot(), transactionId);
      await mkdir(join(transactionDir, "staged"), { recursive: true });
      await mkdir(join(transactionDir, "backup"), { recursive: true });
      const journalOperations = await this.resolvePlanPaths(plan, signal);
      for (let index = 0; index < plan.length; index += 1) {
        const item = plan[index]!;
        const journalOperation = journalOperations[index]!;
        if (item.afterBytes) {
          const staged = join(transactionDir, "staged", `${index}.bin`);
          await writeFile(staged, item.afterBytes);
          journalOperation.stagedAbsolute = staged;
        }
        if (item.sourcePath) journalOperation.backupAbsolute = join(transactionDir, "backup", `${index}.bin`);
      }
      journal = { version: 1, transactionId, workspaceRoot: this.root, phase: "prepared", operations: journalOperations };
      journalPath = join(transactionDir, "journal.json");
      await this.writeJournal(journalPath, journal);

      const diffParts = plan.map((item) => formatWholeFileDiff(item.sourcePath ?? null, item.kind === "delete" ? null : item.targetPath, item.beforeBytes, item.afterBytes));
      diff = diffParts.join("\n");
      if (Buffer.byteLength(diff, "utf8") > 256 * 1024) {
        diff = `${Buffer.from(diff, "utf8").subarray(0, 256 * 1024).toString("utf8")}\n... diff truncated ...`;
        diffTruncated = true;
      }

      journal.phase = "committing";
      await this.writeJournal(journalPath, journal);
      for (let index = 0; index < plan.length; index += 1) {
        checkAbort(signal);
        const item = plan[index]!;
        const operation = journal.operations[index]!;
        await this.options.faultInjector?.({ phase: "before_commit", index, path: item.targetPath });
        if (operation.sourceAbsolute && operation.backupAbsolute) {
          await mkdir(dirname(operation.backupAbsolute), { recursive: true });
          await rename(operation.sourceAbsolute, operation.backupAbsolute);
          operation.sourceBackedUp = true;
          await this.writeJournal(journalPath, journal);
          await this.options.faultInjector?.({ phase: "after_source_backup", index, path: item.targetPath });
        }
        if (item.kind !== "delete") {
          if (!operation.stagedAbsolute) throw new WorkspacePatchError("INTERNAL_ERROR", `missing staged content for ${item.targetPath}`);
          await mkdir(dirname(operation.targetAbsolute), { recursive: true });
          await rename(operation.stagedAbsolute, operation.targetAbsolute);
          operation.targetCommitted = true;
          await this.writeJournal(journalPath, journal);
          await this.options.faultInjector?.({ phase: "after_target_commit", index, path: item.targetPath });
        }
      }

      const files: WorkspacePatchFileResult[] = plan.map((item) => ({
        action: item.kind,
        path: item.targetPath,
        source_path: item.sourcePath && item.sourcePath !== item.targetPath ? item.sourcePath : undefined,
        before_version: item.beforeVersion,
        after_version: item.afterVersion,
        status: "applied",
      }));
      await this.cleanupTransaction(transactionDir);
      return { transaction_id: transactionId, applied: true, rolled_back: false, recovery_required: false, files, diff, diff_truncated: diffTruncated };
    } catch (error) {
      const mapped = mapFsError(error);
      let rolledBack = false;
      let recoveryRequired = false;
      if (journal && journalPath && transactionDir && journal.phase !== "prepared") {
        rolledBack = await this.rollback(journal, journalPath);
        recoveryRequired = !rolledBack;
        if (rolledBack) await this.cleanupTransaction(transactionDir);
        else blockedRecoveryRoots.add(recoveryRootKey(this.root));
      } else if (transactionDir) {
        await this.cleanupTransaction(transactionDir);
      }
      return {
        transaction_id: transactionId,
        applied: false,
        rolled_back: rolledBack,
        recovery_required: recoveryRequired,
        error: { code: mapped.code, message: mapped.message },
        files: plan.map((item) => ({
          action: item.kind,
          path: item.targetPath,
          source_path: item.sourcePath && item.sourcePath !== item.targetPath ? item.sourcePath : undefined,
          before_version: item.beforeVersion,
          after_version: item.afterVersion,
          status: recoveryRequired ? "recovery_required" : rolledBack ? "rolled_back" : "planned",
        })),
        diff,
        diff_truncated: diffTruncated,
      };
    } finally {
      leaveCommitCriticalSection?.();
      releaseLocks?.();
    }
  }

  async replaceFile(
    path: string,
    content: string,
    expectedVersion: string | null,
    signal?: AbortSignal,
    applyOptions: WorkspacePatchApplyOptions = {},
  ): Promise<WorkspacePatchResult> {
    const existing = await this.snapshot(path, false, signal);
    const escapedPath = existing.path;
    const patch = existing.exists
      ? ["*** Begin Patch", `*** Update File: ${escapedPath}`, "@@", ...splitLines(existing.text).lines.map((line) => `-${line}`), ...splitLines(content).lines.map((line) => `+${line}`), "*** End Patch"].join("\n")
      : ["*** Begin Patch", `*** Add File: ${escapedPath}`, ...splitLines(content).lines.map((line) => `+${line}`), "*** End Patch"].join("\n");
    return await this.applyPatch({ patch, expected_versions: { [escapedPath]: expectedVersion } }, signal, applyOptions);
  }
}
