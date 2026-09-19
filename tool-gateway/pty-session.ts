import { randomUUID } from "node:crypto";
import type { PtyState } from "@mooncode/contracts";
import { createNativePtyBackend, type PtyBackend } from "./pty-backend.js";

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_WALL_MS = 60_000;
const DEFAULT_IDLE_MS = 30_000;

export type PtySessionLimits = {
  wallMs?: number;
  idleMs?: number;
  maxOutputBytes?: number;
};

export type PtySessionInfo = {
  sessionId: string;
  state: PtyState;
  exitCode?: number;
  /** Next absolute byte offset (total bytes ever produced). */
  nextOffset: number;
  truncated: boolean;
};

type InternalSession = {
  id: string;
  root: string;
  state: PtyState;
  child: PtyBackend | null;
  /** Ring buffer holding the most recent output bytes. */
  ring: Buffer;
  /** Absolute offset of ring[0]. */
  ringStart: number;
  /** Total bytes ever appended (absolute next write offset). */
  nextOffset: number;
  maxOutputBytes: number;
  truncated: boolean;
  inputSeq: number;
  exitCode?: number;
  wallTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleMs: number;
  wallMs: number;
};

/**
 * Native interactive session manager backed by node-pty (ConPTY on Windows).
 * The legacy terminal.pty_* contract remains available while BRIDGE-007 layers
 * command lifecycle semantics on top of the same native terminal primitive.
 */
export class PtySessionManager {
  private readonly sessions = new Map<string, InternalSession>();

  start(input: {
    root: string;
    executable: string;
    argv: string[];
    cols?: number;
    rows?: number;
    limits?: PtySessionLimits;
  }): PtySessionInfo {
    const id = randomUUID();
    const maxOutputBytes = input.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const wallMs = input.limits?.wallMs ?? DEFAULT_WALL_MS;
    const idleMs = input.limits?.idleMs ?? DEFAULT_IDLE_MS;

    const session: InternalSession = {
      id,
      root: input.root,
      state: "STARTING",
      child: null,
      ring: Buffer.alloc(0),
      ringStart: 0,
      nextOffset: 0,
      maxOutputBytes,
      truncated: false,
      inputSeq: 0,
      idleMs,
      wallMs,
    };
    this.sessions.set(id, session);

    const env = this.safeEnvironment(input.root);

    let child: PtyBackend;
    try {
      child = createNativePtyBackend({
        root: input.root,
        executable: input.executable,
        argv: input.argv,
        env,
        cols: input.cols,
        rows: input.rows,
      });
    } catch {
      session.state = "FAILED";
      return this.info(session);
    }

    session.child = child;
    session.state = "RUNNING";

    const onChunk = (chunk: Buffer) => {
      this.append(session, chunk);
      this.touchIdle(session);
    };
    child.onData(onChunk);
    child.onExit((code) => {
      session.exitCode = code;
      if (session.state === "KILLING") {
        session.state = "KILLED";
      } else if (session.state === "RUNNING" || session.state === "STARTING") {
        session.state = "EXITED";
      }
      this.clearTimers(session);
    });

    session.wallTimer = setTimeout(() => this.kill(id, "wall"), wallMs);
    session.wallTimer.unref?.();
    this.touchIdle(session);

    return this.info(session);
  }

  write(
    sessionId: string,
    data: string,
    expectedInputSeq?: number,
  ): { ok: true; inputSeq: number; state: PtyState } | { ok: false; code: string; message: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, code: "PTY_SESSION_NOT_FOUND", message: "会话不存在。" };
    if (s.state !== "RUNNING") {
      return { ok: false, code: "PTY_NOT_RUNNING", message: `会话状态为 ${s.state}，无法写入。` };
    }
    if (expectedInputSeq !== undefined && expectedInputSeq !== s.inputSeq) {
      return {
        ok: false,
        code: "PTY_INPUT_SEQ_MISMATCH",
        message: `expectedInputSeq=${expectedInputSeq} but next=${s.inputSeq}`,
      };
    }
    if (data.length > 16 * 1024) {
      return { ok: false, code: "PTY_INPUT_TOO_LARGE", message: "单次输入不得超过 16KiB。" };
    }
    if (!s.child) {
      return { ok: false, code: "PTY_STDIN_CLOSED", message: "stdin 已关闭。" };
    }
    if (!s.child.write(data)) {
      return { ok: false, code: "PTY_STDIN_CLOSED", message: "stdin 已关闭。" };
    }
    s.inputSeq += 1;
    this.touchIdle(s);
    return { ok: true, inputSeq: s.inputSeq, state: s.state };
  }

  read(
    sessionId: string,
    fromOffset: number,
  ):
    | {
        ok: true;
        offset: number;
        data: string;
        eof: boolean;
        state: PtyState;
        exitCode?: number;
        truncated: boolean;
      }
    | { ok: false; code: string; message: string } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, code: "PTY_SESSION_NOT_FOUND", message: "会话不存在。" };
    if (!Number.isFinite(fromOffset) || fromOffset < 0 || !Number.isInteger(fromOffset)) {
      return { ok: false, code: "PTY_BAD_OFFSET", message: "fromOffset 必须是非负整数。" };
    }
    if (fromOffset < s.ringStart) {
      return {
        ok: false,
        code: "PTY_OFFSET_EVICTED",
        message: `fromOffset ${fromOffset} 已从 ring 淘汰；ringStart=${s.ringStart}`,
      };
    }
    if (fromOffset > s.nextOffset) {
      return {
        ok: false,
        code: "PTY_OFFSET_AHEAD",
        message: `fromOffset ${fromOffset} 超过 nextOffset=${s.nextOffset}`,
      };
    }
    const rel = fromOffset - s.ringStart;
    const slice = s.ring.subarray(rel);
    const terminal =
      s.state === "EXITED" || s.state === "KILLED" || s.state === "FAILED" || s.state === "ORPHANED";
    return {
      ok: true,
      offset: fromOffset,
      data: slice.toString("utf8"),
      eof: terminal && fromOffset + slice.length >= s.nextOffset,
      state: s.state,
      exitCode: s.exitCode,
      truncated: s.truncated,
    };
  }

  kill(sessionId: string, _reason?: string): PtySessionInfo | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.state === "EXITED" || s.state === "KILLED" || s.state === "FAILED") {
      return this.info(s);
    }
    s.state = "KILLING";
    this.clearTimers(s);
    try {
      s.child?.kill(false);
      setTimeout(() => {
        try {
          if (s.state === "KILLING") s.child?.kill(true);
        } catch {
          /* ignore */
        }
      }, 1000).unref?.();
    } catch {
      s.state = "ORPHANED";
    }
    // Best-effort: if process already gone, mark KILLED shortly via close handler.
    // If still killing after short wait in tests, state may still be KILLING until close.
    return this.info(s);
  }

  killAll(reason = "manager closed"): PtySessionInfo[] {
    const result: PtySessionInfo[] = [];
    for (const id of this.sessions.keys()) {
      const info = this.kill(id, reason);
      if (info) result.push(info);
    }
    return result;
  }

  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === "RUNNING" || session.state === "STARTING" || session.state === "KILLING") count += 1;
    }
    return count;
  }

  get(sessionId: string): PtySessionInfo | null {
    const s = this.sessions.get(sessionId);
    return s ? this.info(s) : null;
  }

  private append(s: InternalSession, chunk: Buffer): void {
    if (chunk.length === 0) return;
    let data = chunk;
    if (s.nextOffset + data.length > s.maxOutputBytes && s.ringStart === 0 && s.nextOffset < s.maxOutputBytes) {
      // First fill: truncate new data to remaining capacity and flag.
      const remain = s.maxOutputBytes - s.nextOffset;
      if (remain <= 0) {
        s.truncated = true;
        return;
      }
      data = data.subarray(0, remain);
      s.truncated = true;
    }
    // Ring: keep only last maxOutputBytes.
    const combined = Buffer.concat([s.ring, data]);
    if (combined.length > s.maxOutputBytes) {
      const overflow = combined.length - s.maxOutputBytes;
      s.ring = combined.subarray(overflow);
      s.ringStart += overflow;
      s.truncated = true;
    } else {
      s.ring = combined;
    }
    s.nextOffset += data.length;
  }

  private touchIdle(s: InternalSession): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.state !== "RUNNING") return;
    s.idleTimer = setTimeout(() => this.kill(s.id, "idle"), s.idleMs);
    s.idleTimer.unref?.();
  }

  private clearTimers(s: InternalSession): void {
    if (s.wallTimer) clearTimeout(s.wallTimer);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.wallTimer = undefined;
    s.idleTimer = undefined;
  }

  private info(s: InternalSession): PtySessionInfo {
    return {
      sessionId: s.id,
      state: s.state,
      exitCode: s.exitCode,
      nextOffset: s.nextOffset,
      truncated: s.truncated,
    };
  }

  private safeEnvironment(root: string): NodeJS.ProcessEnv {
    const allow = [
      "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
      "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
      "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
    ];
    const env: NodeJS.ProcessEnv = {
      TERM: "xterm-256color",
      TEMP: root,
      TMP: root,
      TMPDIR: root,
    };
    for (const key of allow) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }
}
