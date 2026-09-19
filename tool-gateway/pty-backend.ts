import { spawnSync } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";

export type PtyBackend = {
  readonly pid: number;
  write(data: string): boolean;
  resize(cols: number, rows: number): void;
  kill(force?: boolean): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number) => void): void;
};

export type PtySpawnOptions = {
  root: string;
  executable: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
};

/** Native node-pty backend. Windows uses ConPTY; POSIX uses forkpty. */
export function createNativePtyBackend(options: PtySpawnOptions): PtyBackend {
  let terminal: IPty;
  terminal = spawnPty(options.executable, options.argv, {
    name: "xterm-256color",
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    cwd: options.root,
    env: options.env as Record<string, string>,
  });

  return {
    pid: terminal.pid,
    write(data) {
      try {
        terminal.write(data);
        return true;
      } catch {
        return false;
      }
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill(force = false) {
      try {
        if (process.platform === "win32") {
          // node-pty's Windows kill path has varied across releases. Use the
          // real shell PID and taskkill /T so the ConPTY client process tree is
          // synchronously terminated, then close node-pty's handle below.
          spawnSync("taskkill.exe", ["/PID", String(terminal.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          try { terminal.kill(); } catch { /* process may already be gone */ }
          return;
        }
        terminal.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        /* ignore */
      }
    },
    onData(cb) {
      terminal.onData((data) => cb(Buffer.from(data, "utf8")));
    },
    onExit(cb) {
      terminal.onExit((event) => cb(event.exitCode));
    },
  };
}
