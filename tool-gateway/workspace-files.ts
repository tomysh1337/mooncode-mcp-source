import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  BridgeFindFilesArgs,
  BridgeListDirectoryArgs,
  BridgePublicErrorCode,
  BridgeReadFileRequest,
  BridgeReadFilesArgs,
  BridgeSearchFilesArgs,
} from "@mooncode/contracts";

const require = createRequire(import.meta.url);
const ignoreFactory = require("ignore") as () => {
  add(patterns: string | readonly string[]): unknown;
  test(pathname: string): { ignored: boolean; unignored: boolean };
};
const safeRegex = require("safe-regex2") as (expression: string | RegExp, options?: { limit?: number }) => boolean;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_FIND_RESULTS = 100;
const MAX_FIND_RESULTS = 500;
const MAX_SCAN_CANDIDATES = 5_000;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 500;
const DEFAULT_SEARCH_PER_FILE = 20;
const MAX_SEARCH_PER_FILE = 100;
const DEFAULT_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 5;
const DEFAULT_READ_BYTES_PER_FILE = 64 * 1024;
const MAX_READ_BYTES_TOTAL = 256 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024;

type EntryType = "file" | "directory" | "symlink" | "other";

interface IgnoreRuleSet {
  base: string;
  matcher: ReturnType<typeof ignoreFactory>;
}

interface WalkFile {
  path: string;
  absolute: string;
  size: number;
  modifiedMs: number;
}

export class WorkspaceFileError extends Error {
  constructor(readonly code: BridgePublicErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export type WorkspaceAccessScope = "workspace" | "computer";

export interface WorkspaceFileServiceOptions {
  accessScope?: WorkspaceAccessScope | (() => WorkspaceAccessScope);
}

export interface WorkspaceListResult {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    type: EntryType;
    size?: number;
    modified_at?: string;
    target_inside_workspace?: boolean;
  }>;
  next_cursor: string | null;
  truncated: boolean;
}

export interface WorkspaceFindResult {
  matches: Array<{ path: string; size: number; modified_at: string }>;
  truncated: boolean;
  scanned_candidates: number;
  scan_limit: number;
}

export type WorkspaceReadItemResult =
  | {
      ok: true;
      path: string;
      content: string;
      version: string;
      size_bytes: number;
      total_lines: number;
      actual_start_line: number | null;
      actual_end_line: number | null;
      truncated: boolean;
      complete: boolean;
      binary: false;
    }
  | {
      ok: false;
      path: string;
      code: BridgePublicErrorCode;
      message: string;
      binary?: boolean;
      version?: string;
      size_bytes?: number;
    };

export interface WorkspaceReadResult {
  files: WorkspaceReadItemResult[];
  total_content_bytes: number;
  max_total_content_bytes: number;
}

export interface WorkspaceSearchResult {
  matches: Array<{
    path: string;
    line: number;
    column: number;
    text: string;
    before: string[];
    after: string[];
  }>;
  truncated: boolean;
  scanned_candidates: number;
  skipped_binary: number;
  skipped_oversized: number;
}

function toPosix(value: string): string {
  return value.split(sep).join("/").replace(/\\/g, "/");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeRelativePath(input: string, allowDot = true): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new WorkspaceFileError("INVALID_ARGUMENT", "path must be a non-empty relative path");
  }
  if (input.includes("\0")) throw new WorkspaceFileError("INVALID_ARGUMENT", "path contains NUL");
  if (input.length > 4096) throw new WorkspaceFileError("INVALID_ARGUMENT", "path is too long");
  if (
    isAbsolute(input)
    || /^[A-Za-z]:/.test(input)
    || input.startsWith("\\\\")
    || input.startsWith("//")
    || /^\\\\[?.]\\/.test(input)
  ) {
    throw new WorkspaceFileError("PERMISSION_DENIED", "absolute, UNC and device paths are not allowed");
  }

  const normalizedSeparators = input.replace(/\\/g, "/");
  const segments = normalizedSeparators.split("/").filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") throw new WorkspaceFileError("PERMISSION_DENIED", "path must stay inside the selected workspace");
    if (process.platform === "win32") {
      if (segment.includes(":")) throw new WorkspaceFileError("PERMISSION_DENIED", "Windows alternate data streams are not allowed");
      if (/[<>"|?*]/.test(segment)) throw new WorkspaceFileError("INVALID_ARGUMENT", "path contains characters invalid on Windows");
      if (/[. ]$/.test(segment)) throw new WorkspaceFileError("PERMISSION_DENIED", "Windows trailing dot/space aliases are not allowed");
      const stem = segment.split(".")[0]?.toUpperCase() ?? "";
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
        throw new WorkspaceFileError("PERMISSION_DENIED", "Windows device names are not allowed");
      }
    }
  }
  if (segments.length === 0) {
    if (allowDot) return ".";
    throw new WorkspaceFileError("INVALID_ARGUMENT", "path must name a file");
  }
  return segments.join("/");
}

function clampInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WorkspaceFileError("INVALID_ARGUMENT", `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceFileError("CANCELLED", "request was cancelled");
}

function rawVersion(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isProbablyBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.05;
}

function decodeUtf8(bytes: Buffer): string {
  if (isProbablyBinary(bytes)) throw new WorkspaceFileError("INVALID_ARGUMENT", "binary file is not supported as UTF-8 text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceFileError("INVALID_ARGUMENT", "file is not valid UTF-8 text");
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false, bytes: bytes.length };
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0, bytes: 0 };
  let end = Math.min(maxBytes, bytes.length);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const output = decoder.decode(bytes.subarray(0, end));
      return { text: output, truncated: true, bytes: end };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true, bytes: 0 };
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|\n$|\r$/.test(text)) lines.pop();
  return lines;
}

function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad cursor");
    return parsed as Record<string, unknown>;
  } catch {
    throw new WorkspaceFileError("INVALID_ARGUMENT", "cursor is invalid");
  }
}

function ignoredByRules(path: string, isDirectory: boolean, rules: IgnoreRuleSet[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const basePrefix = rule.base && rule.base !== "." ? `${rule.base}/` : "";
    if (basePrefix && path !== rule.base && !path.startsWith(basePrefix)) continue;
    const rel = basePrefix ? path.slice(basePrefix.length) : path;
    if (!rel) continue;
    const result = rule.matcher.test(isDirectory ? `${rel}/` : rel);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function matchesAny(path: string, patterns: string[], includeHidden = false): boolean {
  for (const pattern of patterns) {
    try {
      if (matchesGlob(path, pattern)) return true;
      // Node's matchesGlob follows conventional glob dotfile semantics. When the
      // caller explicitly opted into hidden files, a broad pattern such as
      // **/*.ts should match src/.hidden.ts as users expect from this API.
      if (includeHidden && matchesGlob(path.replace(/(^|\/)\./g, "$1"), pattern)) return true;
    } catch {
      throw new WorkspaceFileError("INVALID_ARGUMENT", `invalid glob pattern: ${pattern}`);
    }
  }
  return false;
}

export class WorkspaceFileService {
  readonly root: string;
  private readonly realRootPromise: Promise<string>;

  constructor(root: string, private readonly options: WorkspaceFileServiceOptions = {}) {
    this.root = resolve(root);
    this.realRootPromise = realpath(this.root).catch((error: NodeJS.ErrnoException) => {
      throw new WorkspaceFileError(error.code === "ENOENT" ? "NOT_FOUND" : "INTERNAL_ERROR", `workspace root cannot be resolved: ${error.code ?? error.message}`);
    });
  }

  private async realRoot(): Promise<string> {
    return await this.realRootPromise;
  }

  private accessScope(): WorkspaceAccessScope {
    return typeof this.options.accessScope === "function" ? this.options.accessScope() : this.options.accessScope ?? "workspace";
  }

  private explicitComputerPath(input: string): boolean {
    if (this.accessScope() !== "computer") return false;
    return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(input) : isAbsolute(input);
  }

  private normalizeComputerAbsolutePath(input: string): string {
    if (typeof input !== "string" || !input || input.includes("\0") || input.length > 4096) {
      throw new WorkspaceFileError("INVALID_ARGUMENT", "absolute path is invalid");
    }
    if (input.startsWith("\\\\") || input.startsWith("//") || /^\\\\[?.]\\/.test(input)) {
      throw new WorkspaceFileError("PERMISSION_DENIED", "UNC and Windows device paths are not allowed");
    }
    if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(input)) {
      throw new WorkspaceFileError("PERMISSION_DENIED", "computer access requires a local drive absolute path");
    }
    if (process.platform !== "win32" && !isAbsolute(input)) {
      throw new WorkspaceFileError("PERMISSION_DENIED", "computer access requires an absolute path");
    }
    const target = resolve(input);
    if (process.platform === "win32") {
      const tail = target.slice(2).replace(/\\/g, "/");
      for (const segment of tail.split("/").filter(Boolean)) {
        if (segment.includes(":")) throw new WorkspaceFileError("PERMISSION_DENIED", "Windows alternate data streams are not allowed");
      }
    }
    return target;
  }

  async resolveExistingPath(relativePath: string, signal?: AbortSignal): Promise<{ path: string; realPath: string; workspacePath: string }> {
    checkAbort(signal);
    if (this.explicitComputerPath(relativePath)) {
      const lexical = this.normalizeComputerAbsolutePath(relativePath);
      let actual: string;
      try {
        actual = await realpath(lexical);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT" || errno.code === "ENOTDIR") throw new WorkspaceFileError("NOT_FOUND", `path not found: ${relativePath}`);
        if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", `path cannot be accessed: ${relativePath}`);
        throw new WorkspaceFileError("INTERNAL_ERROR", `path resolution failed: ${errno.code ?? errno.message}`);
      }
      checkAbort(signal);
      return { path: lexical, realPath: actual, workspacePath: lexical };
    }
    const normalized = normalizeRelativePath(relativePath);
    const lexical = resolve(this.root, normalized);
    if (!isInside(this.root, lexical)) throw new WorkspaceFileError("PERMISSION_DENIED", "path must stay inside the selected workspace");
    let actual: string;
    try {
      actual = await realpath(lexical);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT" || errno.code === "ENOTDIR") throw new WorkspaceFileError("NOT_FOUND", `path not found: ${normalized}`);
      if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", `path cannot be accessed: ${normalized}`);
      throw new WorkspaceFileError("INTERNAL_ERROR", `path resolution failed: ${errno.code ?? errno.message}`);
    }
    const root = await this.realRoot();
    if (!isInside(root, actual)) throw new WorkspaceFileError("PERMISSION_DENIED", "resolved path escapes the selected workspace");
    checkAbort(signal);
    return { path: lexical, realPath: actual, workspacePath: normalized === "." ? "." : toPosix(relative(this.root, lexical)) };
  }

  async resolveWritePath(relativePath: string, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (this.explicitComputerPath(relativePath)) {
      const target = this.normalizeComputerAbsolutePath(relativePath);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new WorkspaceFileError("PERMISSION_DENIED", "writing through a symbolic link or junction is not allowed");
        return target;
      } catch (error) {
        if (error instanceof WorkspaceFileError) throw error;
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "ENOENT") {
          if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", `write target cannot be accessed: ${relativePath}`);
          throw new WorkspaceFileError("INTERNAL_ERROR", `write target resolution failed: ${errno.code ?? errno.message}`);
        }
      }
      let ancestor = dirname(target);
      while (true) {
        try {
          await realpath(ancestor);
          break;
        } catch (error) {
          const errno = error as NodeJS.ErrnoException;
          if (errno.code !== "ENOENT") {
            if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", "write parent cannot be accessed");
            throw new WorkspaceFileError("INTERNAL_ERROR", `write parent resolution failed: ${errno.code ?? errno.message}`);
          }
          const next = dirname(ancestor);
          if (next === ancestor) throw new WorkspaceFileError("NOT_FOUND", "no existing parent directory was found for the write target");
          ancestor = next;
        }
      }
      checkAbort(signal);
      return target;
    }
    const normalized = normalizeRelativePath(relativePath, false);
    const target = resolve(this.root, normalized);
    if (!isInside(this.root, target)) throw new WorkspaceFileError("PERMISSION_DENIED", "path must stay inside the selected workspace");
    const root = await this.realRoot();

    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new WorkspaceFileError("PERMISSION_DENIED", "writing through a symbolic link or junction is not allowed");
      const actual = await realpath(target);
      if (!isInside(root, actual)) throw new WorkspaceFileError("PERMISSION_DENIED", "resolved write target escapes the selected workspace");
      return target;
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") {
        if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", `write target cannot be accessed: ${normalized}`);
        throw new WorkspaceFileError("INTERNAL_ERROR", `write target resolution failed: ${errno.code ?? errno.message}`);
      }
    }

    let ancestor = dirname(target);
    while (true) {
      try {
        const actual = await realpath(ancestor);
        if (!isInside(root, actual)) throw new WorkspaceFileError("PERMISSION_DENIED", "write parent resolves outside the selected workspace");
        break;
      } catch (error) {
        if (error instanceof WorkspaceFileError) throw error;
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== "ENOENT") {
          if (errno.code === "EACCES" || errno.code === "EPERM") throw new WorkspaceFileError("PERMISSION_DENIED", "write parent cannot be accessed");
          throw new WorkspaceFileError("INTERNAL_ERROR", `write parent resolution failed: ${errno.code ?? errno.message}`);
        }
        const next = dirname(ancestor);
        if (next === ancestor || !isInside(this.root, next)) throw new WorkspaceFileError("PERMISSION_DENIED", "write parent escapes the selected workspace");
        ancestor = next;
      }
    }
    checkAbort(signal);
    return target;
  }

  private async readIgnoreRuleSet(absoluteDir: string, workspaceDir: string): Promise<IgnoreRuleSet | null> {
    const sources: string[] = [];
    for (const fileName of [".gitignore", ".ignore"]) {
      try {
        sources.push(await readFile(join(absoluteDir, fileName), "utf8"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "EPERM") throw error;
      }
    }
    if (sources.length === 0) return null;
    const matcher = ignoreFactory();
    matcher.add(sources.join("\n"));
    return { base: workspaceDir, matcher };
  }

  private async ignoreRulesForDirectory(workspaceDir: string, signal?: AbortSignal): Promise<IgnoreRuleSet[]> {
    const defaultMatcher = ignoreFactory();
    defaultMatcher.add(["node_modules/", ".mooncode/"]);
    const rules: IgnoreRuleSet[] = [{ base: ".", matcher: defaultMatcher }];
    const parts = workspaceDir === "." ? [] : workspaceDir.split("/");
    const dirs = ["."];
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.push(current);
    }
    for (const dir of dirs) {
      checkAbort(signal);
      const absoluteDir = join(this.root, dir === "." ? "" : dir);
      const rule = await this.readIgnoreRuleSet(absoluteDir, dir);
      if (rule) rules.push(rule);
    }
    return rules;
  }

  async listDirectory(args: BridgeListDirectoryArgs, signal?: AbortSignal): Promise<WorkspaceListResult> {
    const requestedPath = args.path ?? ".";
    const safe = await this.resolveExistingPath(requestedPath, signal);
    const directoryStat = await stat(safe.realPath);
    if (!directoryStat.isDirectory()) throw new WorkspaceFileError("INVALID_ARGUMENT", "list_directory path must be a directory");
    const limit = clampInteger(args.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
    const includeHidden = args.include_hidden === true;
    const includeIgnored = args.include_ignored === true;
    const external = isAbsolute(safe.workspacePath);
    const rules = includeIgnored || external ? [] : await this.ignoreRulesForDirectory(safe.workspacePath, signal);
    let after = "";
    if (args.cursor !== undefined) {
      const cursor = decodeCursor(args.cursor);
      if (
        cursor.v !== 1
        || cursor.path !== safe.workspacePath
        || cursor.include_hidden !== includeHidden
        || cursor.include_ignored !== includeIgnored
        || typeof cursor.after !== "string"
      ) throw new WorkspaceFileError("INVALID_ARGUMENT", "cursor does not belong to this listing request");
      after = cursor.after;
    }

    const raw = await readdir(safe.realPath, { withFileTypes: true });
    raw.sort((a, b) => ordinalCompare(a.name, b.name));
    const visible = [] as WorkspaceListResult["entries"];
    for (const entry of raw) {
      checkAbort(signal);
      if (entry.name <= after) continue;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const entryPath = external ? join(safe.workspacePath, entry.name) : safe.workspacePath === "." ? entry.name : `${safe.workspacePath}/${entry.name}`;
      if (!includeIgnored && external && (entry.name === "node_modules" || entry.name === ".mooncode")) continue;
      if (!includeIgnored && !external && ignoredByRules(entryPath, entry.isDirectory(), rules)) continue;
      const absolute = join(safe.realPath, entry.name);
      let type: EntryType = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
      let size: number | undefined;
      let modifiedAt: string | undefined;
      let targetInside: boolean | undefined;
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          type = "symlink";
          try {
            const target = await realpath(absolute);
            targetInside = isInside(await this.realRoot(), target);
          } catch {
            targetInside = false;
          }
        } else {
          size = info.isFile() ? info.size : undefined;
          modifiedAt = info.mtime.toISOString();
        }
      } catch {
        type = "other";
      }
      visible.push({ name: entry.name, path: entryPath, type, size, modified_at: modifiedAt, target_inside_workspace: targetInside });
      if (visible.length > limit) break;
    }
    const hasMore = visible.length > limit;
    const entries = hasMore ? visible.slice(0, limit) : visible;
    const nextCursor = hasMore && entries.length > 0
      ? encodeCursor({ v: 1, path: safe.workspacePath, include_hidden: includeHidden, include_ignored: includeIgnored, after: entries.at(-1)!.name })
      : null;
    return { path: safe.workspacePath, entries, next_cursor: nextCursor, truncated: hasMore };
  }

  private async walkFiles(
    startPath: string,
    options: { includeHidden: boolean; includeIgnored: boolean },
    signal?: AbortSignal,
  ): Promise<{ files: WalkFile[]; scanned: number; truncated: boolean }> {
    const start = await this.resolveExistingPath(startPath, signal);
    const startInfo = await stat(start.realPath);
    if (!startInfo.isDirectory()) throw new WorkspaceFileError("INVALID_ARGUMENT", "path must be a directory");
    const external = isAbsolute(start.workspacePath);
    const rootRules = options.includeIgnored || external ? [] : await this.ignoreRulesForDirectory(start.workspacePath, signal);
    const stack: Array<{ absolute: string; workspacePath: string; rules: IgnoreRuleSet[] }> = [{ absolute: start.realPath, workspacePath: start.workspacePath, rules: rootRules }];
    const files: WalkFile[] = [];
    let scanned = 0;
    let truncated = false;
    const realRoot = external ? start.realPath : await this.realRoot();

    while (stack.length > 0) {
      checkAbort(signal);
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current.absolute, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "ENOENT") continue;
        throw error;
      }
      entries.sort((a, b) => ordinalCompare(a.name, b.name));
      let childRules = current.rules;
      if (!options.includeIgnored && !external) {
        const nestedRule = await this.readIgnoreRuleSet(current.absolute, current.workspacePath);
        if (nestedRule) childRules = [...current.rules, nestedRule];
      }
      const directories: Array<{ absolute: string; workspacePath: string; rules: IgnoreRuleSet[] }> = [];
      for (const entry of entries) {
        checkAbort(signal);
        if (!options.includeHidden && entry.name.startsWith(".")) continue;
        const workspacePath = external ? join(current.workspacePath, entry.name) : current.workspacePath === "." ? entry.name : `${current.workspacePath}/${entry.name}`;
        if (!options.includeIgnored && external && (entry.name === "node_modules" || entry.name === ".mooncode")) continue;
        if (!options.includeIgnored && !external && ignoredByRules(workspacePath, entry.isDirectory(), childRules)) continue;
        const absolute = join(current.absolute, entry.name);
        if (entry.isSymbolicLink()) {
          // Links are visible through list_directory but recursive find/search never follow them.
          continue;
        }
        if (entry.isDirectory()) {
          try {
            const actual = await realpath(absolute);
            if (isInside(realRoot, actual)) directories.push({ absolute: actual, workspacePath, rules: childRules });
          } catch { /* disappearing/unreadable directory */ }
          continue;
        }
        if (!entry.isFile()) continue;
        scanned += 1;
        if (scanned > MAX_SCAN_CANDIDATES) {
          truncated = true;
          break;
        }
        try {
          const info = await stat(absolute);
          files.push({ path: workspacePath, absolute, size: info.size, modifiedMs: info.mtimeMs });
        } catch { /* disappearing file */ }
      }
      if (truncated) break;
      // Reverse so lexical-first directory is popped first from the LIFO stack.
      directories.sort((a, b) => ordinalCompare(b.workspacePath, a.workspacePath));
      stack.push(...directories);
    }
    return { files, scanned: Math.min(scanned, MAX_SCAN_CANDIDATES), truncated };
  }

  async findFiles(args: BridgeFindFilesArgs, signal?: AbortSignal): Promise<WorkspaceFindResult> {
    if (!Array.isArray(args.patterns) || args.patterns.length < 1 || args.patterns.length > 20 || args.patterns.some((pattern) => typeof pattern !== "string" || !pattern)) {
      throw new WorkspaceFileError("INVALID_ARGUMENT", "patterns must contain 1-20 non-empty glob patterns");
    }
    const exclude = args.exclude ?? [];
    if (!Array.isArray(exclude) || exclude.length > 50 || exclude.some((pattern) => typeof pattern !== "string" || !pattern)) {
      throw new WorkspaceFileError("INVALID_ARGUMENT", "exclude must contain at most 50 non-empty glob patterns");
    }
    // Validate globs before traversal so malformed inputs fail deterministically.
    matchesAny("validation/path.txt", args.patterns);
    if (exclude.length) matchesAny("validation/path.txt", exclude);
    const maxResults = clampInteger(args.max_results, DEFAULT_FIND_RESULTS, 1, MAX_FIND_RESULTS, "max_results");
    const sort = args.sort ?? "path_asc";
    if (sort !== "path_asc" && sort !== "modified_desc") throw new WorkspaceFileError("INVALID_ARGUMENT", "sort must be path_asc or modified_desc");
    const walk = await this.walkFiles(args.path ?? ".", { includeHidden: args.include_hidden === true, includeIgnored: args.include_ignored === true }, signal);
    const includeHidden = args.include_hidden === true;
    let matches = walk.files.filter((file) => matchesAny(file.path, args.patterns, includeHidden) && (exclude.length === 0 || !matchesAny(file.path, exclude, includeHidden)));
    matches.sort((a, b) => sort === "modified_desc" ? (b.modifiedMs - a.modifiedMs || ordinalCompare(a.path, b.path)) : ordinalCompare(a.path, b.path));
    const truncated = walk.truncated || matches.length > maxResults;
    matches = matches.slice(0, maxResults);
    return {
      matches: matches.map((file) => ({ path: file.path, size: file.size, modified_at: new Date(file.modifiedMs).toISOString() })),
      truncated,
      scanned_candidates: walk.scanned,
      scan_limit: MAX_SCAN_CANDIDATES,
    };
  }

  private async readOne(request: BridgeReadFileRequest, maxContentBytes: number, signal?: AbortSignal): Promise<WorkspaceReadItemResult> {
    try {
      if (!request || typeof request.path !== "string" || !request.path) throw new WorkspaceFileError("INVALID_ARGUMENT", "path is required");
      const startLine = clampInteger(request.start_line, 1, 1, Number.MAX_SAFE_INTEGER, "start_line");
      const endLine = request.end_line === undefined ? Number.MAX_SAFE_INTEGER : clampInteger(request.end_line, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, "end_line");
      if (endLine < startLine) throw new WorkspaceFileError("INVALID_ARGUMENT", "end_line must be greater than or equal to start_line");
      const safe = await this.resolveExistingPath(request.path, signal);
      const info = await stat(safe.realPath);
      if (!info.isFile()) throw new WorkspaceFileError("INVALID_ARGUMENT", "read_files path must be a file");
      if (info.size > MAX_SOURCE_FILE_BYTES) throw new WorkspaceFileError("INVALID_ARGUMENT", `file exceeds ${MAX_SOURCE_FILE_BYTES} byte source limit`);
      checkAbort(signal);
      const bytes = await readFile(safe.realPath);
      checkAbort(signal);
      const version = rawVersion(bytes);
      let text: string;
      try {
        text = decodeUtf8(bytes);
      } catch (error) {
        if (error instanceof WorkspaceFileError) {
          return { ok: false, path: safe.workspacePath, code: error.code, message: error.message, binary: true, version, size_bytes: bytes.length };
        }
        throw error;
      }
      const lines = splitLogicalLines(text);
      const totalLines = lines.length;
      if (startLine > totalLines) {
        return {
          ok: true,
          path: safe.workspacePath,
          content: "",
          version,
          size_bytes: bytes.length,
          total_lines: totalLines,
          actual_start_line: null,
          actual_end_line: null,
          truncated: false,
          complete: totalLines === 0 && startLine === 1,
          binary: false,
        };
      }
      const selectedEnd = Math.min(endLine, totalLines);
      const fullRange = startLine === 1 && selectedEnd === totalLines;
      const selected = fullRange ? text : lines.slice(startLine - 1, selectedEnd).join("\n");
      const limited = truncateUtf8(selected, Math.min(DEFAULT_READ_BYTES_PER_FILE, maxContentBytes));
      let actualEnd = selectedEnd;
      if (limited.truncated) {
        const emittedLines = splitLogicalLines(limited.text).length;
        actualEnd = emittedLines === 0 ? startLine - 1 : Math.min(selectedEnd, startLine + emittedLines - 1);
      }
      return {
        ok: true,
        path: safe.workspacePath,
        content: limited.text,
        version,
        size_bytes: bytes.length,
        total_lines: totalLines,
        actual_start_line: limited.text.length === 0 ? null : startLine,
        actual_end_line: limited.text.length === 0 ? null : actualEnd,
        truncated: limited.truncated,
        complete: fullRange && !limited.truncated,
        binary: false,
      };
    } catch (error) {
      if (error instanceof WorkspaceFileError) return { ok: false, path: request?.path ?? "", code: error.code, message: error.message };
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT" || errno.code === "ENOTDIR") return { ok: false, path: request?.path ?? "", code: "NOT_FOUND", message: "file not found" };
      if (errno.code === "EACCES" || errno.code === "EPERM") return { ok: false, path: request?.path ?? "", code: "PERMISSION_DENIED", message: "file cannot be accessed" };
      return { ok: false, path: request?.path ?? "", code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async readFiles(args: BridgeReadFilesArgs, signal?: AbortSignal): Promise<WorkspaceReadResult> {
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 20) {
      throw new WorkspaceFileError("INVALID_ARGUMENT", "files must contain 1-20 requests");
    }
    const results: WorkspaceReadItemResult[] = [];
    let emittedBytes = 0;
    for (const request of args.files) {
      checkAbort(signal);
      const item = await this.readOne(request, Math.max(0, MAX_READ_BYTES_TOTAL - emittedBytes), signal);
      results.push(item);
      if (item.ok) emittedBytes += Buffer.byteLength(item.content, "utf8");
    }
    return { files: results, total_content_bytes: emittedBytes, max_total_content_bytes: MAX_READ_BYTES_TOTAL };
  }

  async searchFiles(args: BridgeSearchFilesArgs, signal?: AbortSignal): Promise<WorkspaceSearchResult> {
    if (typeof args.pattern !== "string" || !args.pattern) throw new WorkspaceFileError("INVALID_ARGUMENT", "pattern is required");
    const context = clampInteger(args.context_lines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES, "context_lines");
    const maxResults = clampInteger(args.max_results, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS, "max_results");
    const maxPerFile = clampInteger(args.max_per_file, DEFAULT_SEARCH_PER_FILE, 1, MAX_SEARCH_PER_FILE, "max_per_file");
    const globs = args.glob ?? [];
    if (!Array.isArray(globs) || globs.length > 20 || globs.some((glob) => typeof glob !== "string" || !glob)) {
      throw new WorkspaceFileError("INVALID_ARGUMENT", "glob must contain at most 20 non-empty patterns");
    }
    if (globs.length) matchesAny("validation/path.txt", globs);
    const caseSensitive = args.case_sensitive ?? /[A-Z]/.test(args.pattern);
    let regex: RegExp | undefined;
    if (args.regex === true) {
      if (!safeRegex(args.pattern, { limit: 25 })) {
        throw new WorkspaceFileError("INVALID_ARGUMENT", "regular expression was rejected as potentially unsafe");
      }
      try {
        regex = new RegExp(args.pattern, caseSensitive ? "g" : "gi");
      } catch (error) {
        throw new WorkspaceFileError("INVALID_ARGUMENT", `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const literalExpression = args.regex === true
      ? undefined
      : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
    const walk = await this.walkFiles(args.path ?? ".", { includeHidden: args.include_hidden === true, includeIgnored: args.include_ignored === true }, signal);
    const matches: WorkspaceSearchResult["matches"] = [];
    let skippedBinary = 0;
    let skippedOversized = 0;
    let truncated = walk.truncated;

    for (const file of walk.files) {
      checkAbort(signal);
      if (globs.length > 0 && !matchesAny(file.path, globs, args.include_hidden === true)) continue;
      if (file.size > MAX_SEARCH_FILE_BYTES) {
        skippedOversized += 1;
        continue;
      }
      let bytes: Buffer;
      try { bytes = await readFile(file.absolute); } catch { continue; }
      if (isProbablyBinary(bytes)) {
        skippedBinary += 1;
        continue;
      }
      let text: string;
      try { text = decodeUtf8(bytes); } catch {
        skippedBinary += 1;
        continue;
      }
      const lines = splitLogicalLines(text);
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index += 1) {
        checkAbort(signal);
        const line = lines[index]!;
        const expression = regex ?? literalExpression!;
        expression.lastIndex = 0;
        while (true) {
          const found = expression.exec(line);
          if (!found) break;
          matches.push({
            path: file.path,
            line: index + 1,
            column: found.index + 1,
            text: line,
            before: lines.slice(Math.max(0, index - context), index),
            after: lines.slice(index + 1, index + 1 + context),
          });
          fileMatches += 1;
          if (found[0].length === 0) expression.lastIndex += 1;
          if (fileMatches >= maxPerFile || matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
        if (fileMatches >= maxPerFile || matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) break;
    }
    return {
      matches: matches.slice(0, maxResults),
      truncated,
      scanned_candidates: walk.scanned,
      skipped_binary: skippedBinary,
      skipped_oversized: skippedOversized,
    };
  }
}
