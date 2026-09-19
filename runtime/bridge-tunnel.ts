import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type BridgeTunnelProviderKind = "none" | "cloudflare-quick" | "cloudflare-named" | "ngrok";
export type BridgeTunnelState = "stopped" | "starting" | "local_ready" | "connecting" | "public_ready" | "degraded" | "stopping" | "error";
export type BridgeTunnelPhase = "public_origin" | "propagation_wait" | "protocol_verification";

export interface BridgeTunnelOptions {
	kind: BridgeTunnelProviderKind;
	executable?: string;
	/** Stable HTTPS origin for cloudflare-named/ngrok, for example https://bridge.example.com. */
	publicUrl?: string;
	/** Runtime-only credential. Never log or serialize this field. */
	token?: string;
	proxyUrl?: string;
	startupTimeoutMs?: number;
	maxAttempts?: number;
}

export interface BridgeTunnelStatus {
	provider: BridgeTunnelProviderKind;
	state: BridgeTunnelState;
	localUrl: string | null;
	publicOrigin: string | null;
	attempt: number;
	errorCode: string | null;
	message: string | null;
	phase: BridgeTunnelPhase | null;
	requiresReauthorization: boolean;
}

export interface BridgeTunnelStartInput {
	localOrigin: string;
	onPublicOrigin(publicOrigin: string): Promise<void> | void;
	healthCheck(publicOrigin: string, signal: AbortSignal): Promise<void>;
}

export interface BridgeTunnelDependencies {
	spawnProcess?: typeof spawn;
	spawnSyncProcess?: typeof spawnSync;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class BridgeTunnelError extends Error {
	constructor(
		public readonly code: "INVALID_CONFIG" | "DEPENDENCY_MISSING" | "START_FAILED" | "TIMEOUT" | "HEALTH_FAILED" | "CANCELLED",
		message: string,
	) {
		super(message);
		this.name = "BridgeTunnelError";
	}
}

type TunnelLog = (event: Record<string, unknown>) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;

function abortError(): BridgeTunnelError {
	return new BridgeTunnelError("CANCELLED", "tunnel operation was cancelled");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
	const actual = value ?? fallback;
	if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum) {
		throw new BridgeTunnelError("INVALID_CONFIG", `${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return actual;
}

function normalizePublicOrigin(raw: string | undefined, provider: BridgeTunnelProviderKind): string {
	if (!raw) throw new BridgeTunnelError("INVALID_CONFIG", `${provider} requires a configured public HTTPS URL`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BridgeTunnelError("INVALID_CONFIG", `${provider} public URL is invalid`);
	}
	if (url.protocol !== "https:") throw new BridgeTunnelError("INVALID_CONFIG", `${provider} public URL must use https`);
	if (url.username || url.password || url.search || url.hash) {
		throw new BridgeTunnelError("INVALID_CONFIG", `${provider} public URL must not contain credentials, query, or fragment`);
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new BridgeTunnelError("INVALID_CONFIG", `${provider} public URL must be an origin without a path`);
	}
	return url.origin;
}

function redactProviderLine(raw: string, configuredToken?: string): string {
	let redacted = raw;
	if (configuredToken) redacted = redacted.split(configuredToken).join("[REDACTED_TOKEN]");
	return redacted
		.replace(/eyJ[A-Za-z0-9._~+\/-]{20,}/g, "[REDACTED_TOKEN]")
		.replace(/(TUNNEL_TOKEN|NGROK_AUTHTOKEN)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
		.trim()
		.slice(0, 500);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise<void>((resolve, reject) => {
		const finish = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(abortError());
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

export class BridgeTunnelManager {
	private readonly spawnProcess: typeof spawn;
	private readonly spawnSyncProcess: typeof spawnSync;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly startupTimeoutMs: number;
	private readonly maxAttempts: number;
	private child: ChildProcess | undefined;
	private controller: AbortController | undefined;
	private currentStatus: BridgeTunnelStatus;
	private closing = false;
	private generation = 0;

	constructor(
		private readonly options: BridgeTunnelOptions,
		private readonly log: TunnelLog,
		dependencies: BridgeTunnelDependencies = {},
	) {
		this.spawnProcess = dependencies.spawnProcess ?? spawn;
		this.spawnSyncProcess = dependencies.spawnSyncProcess ?? spawnSync;
		this.sleep = dependencies.sleep ?? defaultSleep;
		this.startupTimeoutMs = boundedInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 1_000, MAX_STARTUP_TIMEOUT_MS, "tunnel startupTimeoutMs");
		this.maxAttempts = boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS, "tunnel maxAttempts");
		if (options.proxyUrl) {
			let proxy: URL;
			try {
				proxy = new URL(options.proxyUrl);
			} catch {
				throw new BridgeTunnelError("INVALID_CONFIG", "tunnel proxyUrl is invalid");
			}
			if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
				throw new BridgeTunnelError("INVALID_CONFIG", "tunnel proxyUrl must use http or https");
			}
			if (proxy.username || proxy.password) {
				throw new BridgeTunnelError("INVALID_CONFIG", "tunnel proxy credentials must not be stored in proxyUrl settings");
			}
		}
		if (options.kind === "cloudflare-named" || options.kind === "ngrok") normalizePublicOrigin(options.publicUrl, options.kind);
		if ((options.kind === "cloudflare-named" || options.kind === "ngrok") && !options.token) {
			throw new BridgeTunnelError("INVALID_CONFIG", `${options.kind} requires a credential from SecretStorage/runtime environment`);
		}
		this.currentStatus = {
			provider: options.kind,
			state: "stopped",
			localUrl: null,
			publicOrigin: null,
			attempt: 0,
			errorCode: null,
			message: null,
			phase: null,
			requiresReauthorization: false,
		};
	}

	get status(): BridgeTunnelStatus {
		return { ...this.currentStatus };
	}

	markLocalReady(localUrl: string): void {
		this.transition({ state: "local_ready", localUrl, errorCode: null, message: null, phase: null });
	}

	async start(input: BridgeTunnelStartInput): Promise<BridgeTunnelStatus> {
		if (this.options.kind === "none") return this.status;
		await this.stopChildOnly();
		this.closing = false;
		this.controller?.abort();
		this.controller = new AbortController();
		const operationGeneration = ++this.generation;
		let lastError: BridgeTunnelError | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
			if (this.controller.signal.aborted) throw abortError();
			this.transition({ state: attempt === 1 ? "starting" : "connecting", attempt, errorCode: null, message: null, phase: null });
			try {
				const { child, publicOrigin } = await this.startAttempt(input.localOrigin, this.controller.signal);
				if (this.controller.signal.aborted) {
					await this.terminateProcessTree(child);
					throw abortError();
				}
				this.child = child;
				this.monitorChild(child, operationGeneration, publicOrigin);
				this.transition({ state: "connecting", publicOrigin, attempt, errorCode: null, message: "公网地址已取得，等待传播…", phase: "public_origin" });
				await input.onPublicOrigin(publicOrigin);
				this.transition({ state: "connecting", publicOrigin, attempt, errorCode: null, message: "正在等待公网地址传播…", phase: "propagation_wait" });
				await this.waitUntilHealthy(publicOrigin, input.healthCheck, this.controller.signal);
				this.transition({ state: "public_ready", publicOrigin, attempt, errorCode: null, message: null, phase: null, requiresReauthorization: false });
				return this.status;
			} catch (error) {
				const mapped = this.mapError(error);
				lastError = mapped;
				await this.stopChildOnly();
				if (mapped.code === "CANCELLED") throw mapped;
				if (attempt < this.maxAttempts) {
					this.transition({ state: "connecting", attempt, errorCode: mapped.code, message: mapped.message, phase: null });
					await this.sleep(Math.min(4_000, 250 * 2 ** (attempt - 1)), this.controller.signal);
				}
			}
		}

		const finalError = lastError ?? new BridgeTunnelError("START_FAILED", "tunnel failed to start");
		this.transition({ state: "error", errorCode: finalError.code, message: finalError.message, phase: null });
		throw finalError;
	}

	async health(healthCheck: (publicOrigin: string, signal: AbortSignal) => Promise<void>): Promise<BridgeTunnelStatus> {
		if (this.options.kind === "none") return this.status;
		const publicOrigin = this.currentStatus.publicOrigin;
		if (!publicOrigin || !this.child || this.child.exitCode !== null) {
			this.transition({ state: "degraded", errorCode: "START_FAILED", message: "tunnel helper is not running" });
			return this.status;
		}
		const controller = new AbortController();
		try {
			await healthCheck(publicOrigin, controller.signal);
			this.transition({ state: "public_ready", errorCode: null, message: null, phase: null });
		} catch (error) {
			const upstream = error as Error & { code?: unknown };
			this.transition({
				state: "degraded",
				errorCode: typeof upstream?.code === "string" && upstream.code ? upstream.code : "HEALTH_FAILED",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return this.status;
	}

	async stop(): Promise<void> {
		this.closing = true;
		this.generation += 1;
		this.transition({ state: "stopping" });
		this.controller?.abort();
		this.controller = undefined;
		await this.stopChildOnly();
		this.transition({ state: "stopped", publicOrigin: null, attempt: 0, errorCode: null, message: null, phase: null, requiresReauthorization: false });
	}

	private async startAttempt(localOrigin: string, signal: AbortSignal): Promise<{ child: ChildProcess; publicOrigin: string }> {
		if (signal.aborted) throw abortError();
		const provider = this.options.kind;
		if (provider === "cloudflare-quick") return await this.startCloudflareQuick(localOrigin, signal);
		if (provider === "cloudflare-named") {
			const publicOrigin = normalizePublicOrigin(this.options.publicUrl, provider);
			const child = this.spawnHelper(
				this.options.executable || "cloudflared",
				["tunnel", "--no-autoupdate", "run"],
				{ TUNNEL_TOKEN: this.options.token ?? "" },
			);
			try {
				await this.waitForSpawn(child, this.options.executable || "cloudflared", signal);
			} catch (error) {
				await this.terminateProcessTree(child);
				throw error;
			}
			return { child, publicOrigin };
		}
		if (provider === "ngrok") {
			const publicOrigin = normalizePublicOrigin(this.options.publicUrl, provider);
			const localPort = new URL(localOrigin).port;
			if (!localPort) throw new BridgeTunnelError("INVALID_CONFIG", "ngrok local origin must contain a port");
			const child = this.spawnHelper(
				this.options.executable || "ngrok",
				["http", localPort, "--url", publicOrigin],
				{ NGROK_AUTHTOKEN: this.options.token ?? "" },
			);
			try {
				await this.waitForSpawn(child, this.options.executable || "ngrok", signal);
			} catch (error) {
				await this.terminateProcessTree(child);
				throw error;
			}
			return { child, publicOrigin };
		}
		throw new BridgeTunnelError("INVALID_CONFIG", `unsupported tunnel provider ${provider}`);
	}

	private async startCloudflareQuick(localOrigin: string, signal: AbortSignal): Promise<{ child: ChildProcess; publicOrigin: string }> {
		const child = this.spawnHelper(
			this.options.executable || "cloudflared",
			["tunnel", "--no-autoupdate", "--url", localOrigin],
			{},
		);
		let output = "";
		let publicOrigin: string | undefined;
		return await new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				if (!error && publicOrigin) {
					settled = true;
					cleanup();
					resolve({ child, publicOrigin });
					return;
				}
				if (error) {
					settled = true;
					cleanup();
					void this.terminateProcessTree(child).finally(() => reject(error));
				}
			};
			const onData = (chunk: Buffer) => {
				const text = chunk.toString();
				output = (output + text).slice(-8_000);
				const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
				if (match) publicOrigin = new URL(match[0]).origin;
				finish();
			};
			const onExit = (code: number | null) => finish(new BridgeTunnelError("START_FAILED", `cloudflared exited before Quick Tunnel was ready (${code})`));
			const onError = (error: Error & { code?: string }) => finish(this.mapSpawnError(error, "cloudflared"));
			const onAbort = () => finish(abortError());
			const timer = setTimeout(() => finish(new BridgeTunnelError("TIMEOUT", "Cloudflare Quick Tunnel did not publish a public origin before startup timeout")), this.startupTimeoutMs);
			timer.unref?.();
			const cleanup = () => {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				child.off("exit", onExit);
				child.off("error", onError);
				signal.removeEventListener("abort", onAbort);
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.once("exit", onExit);
			child.once("error", onError);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private spawnHelper(executable: string, args: string[], secretEnv: Record<string, string>): ChildProcess {
		const env = { ...process.env };
		delete env.MOONCODE_CLOUDFLARE_TUNNEL_TOKEN;
		delete env.MOONCODE_NGROK_AUTHTOKEN;
		Object.assign(env, secretEnv);
		if (this.options.proxyUrl) {
			env.HTTPS_PROXY = this.options.proxyUrl;
			env.HTTP_PROXY = this.options.proxyUrl;
		}
		const child = this.spawnProcess(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env,
		});
		const onData = (chunk: Buffer) => {
			const line = redactProviderLine(chunk.toString(), this.options.token);
			if (line) this.log({ type: "bridge.tunnel_log", provider: this.options.kind, line });
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		return child;
	}

	private async waitForSpawn(child: ChildProcess, executable: string, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw abortError();
		if (child.pid && child.exitCode === null) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: BridgeTunnelError) => {
				if (settled) return;
				settled = true;
				child.off("spawn", onSpawn);
				child.off("error", onError);
				signal.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onSpawn = () => finish();
			const onError = (error: Error & { code?: string }) => finish(this.mapSpawnError(error, executable));
			const onAbort = () => finish(abortError());
			child.once("spawn", onSpawn);
			child.once("error", onError);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async waitUntilHealthy(
		publicOrigin: string,
		healthCheck: (publicOrigin: string, signal: AbortSignal) => Promise<void>,
		signal: AbortSignal,
		timeoutMs = this.startupTimeoutMs,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let delayMs = 200;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (signal.aborted) throw abortError();
			if (!this.child || this.child.exitCode !== null) throw new BridgeTunnelError("START_FAILED", "tunnel helper exited before public health became ready");
			try {
				this.transition({ state: "connecting", publicOrigin, phase: "protocol_verification", errorCode: null, message: "正在验证公网协议…" });
				await healthCheck(publicOrigin, signal);
				return;
			} catch (error) {
				lastError = error;
				this.transition({ state: "connecting", publicOrigin, phase: "propagation_wait", errorCode: null, message: "公网尚在传播，继续等待同一地址…" });
				await this.sleep(Math.min(delayMs, Math.max(1, deadline - Date.now())), signal);
				delayMs = Math.min(2_000, delayMs * 2);
			}
		}
		throw new BridgeTunnelError("HEALTH_FAILED", `public tunnel health did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timeout")}`);
	}

	private monitorChild(child: ChildProcess, operationGeneration: number, publicOrigin: string): void {
		child.once("error", (error: Error & { code?: string }) => {
			if (this.child === child) this.child = undefined;
			if (this.closing || operationGeneration !== this.generation) return;
			const mapped = this.mapSpawnError(error, this.options.executable || (this.options.kind === "ngrok" ? "ngrok" : "cloudflared"));
			this.transition({
				state: "degraded",
				publicOrigin,
				errorCode: mapped.code,
				message: mapped.message,
				requiresReauthorization: this.options.kind === "cloudflare-quick",
			});
		});
		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			if (this.closing || operationGeneration !== this.generation) return;
			const quick = this.options.kind === "cloudflare-quick";
			this.transition({
				state: "degraded",
				publicOrigin,
				errorCode: "START_FAILED",
				message: `tunnel helper exited (${code ?? signal ?? "unknown"})`,
				requiresReauthorization: quick,
			});
		});
	}

	private async stopChildOnly(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (child) await this.terminateProcessTree(child);
	}

	private async terminateProcessTree(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || !child.pid) return;
		if (process.platform === "win32") {
			this.spawnSyncProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} else {
			try { child.kill("SIGTERM"); } catch { /* already gone */ }
		}
		const deadline = Date.now() + 2_000;
		while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
		if (child.exitCode === null) {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
		}
	}

	private mapSpawnError(error: Error & { code?: string }, executable: string): BridgeTunnelError {
		if (error.code === "ENOENT") return new BridgeTunnelError("DEPENDENCY_MISSING", `${executable} executable was not found`);
		return new BridgeTunnelError("START_FAILED", `${executable} failed to start: ${error.message}`);
	}

	private mapError(error: unknown): BridgeTunnelError {
		if (error instanceof BridgeTunnelError) return error;
		const raw = error as Error & { code?: string };
		if (raw?.code === "ENOENT") return new BridgeTunnelError("DEPENDENCY_MISSING", raw.message || "tunnel executable was not found");
		return new BridgeTunnelError("START_FAILED", error instanceof Error ? error.message : String(error));
	}

	private transition(patch: Partial<BridgeTunnelStatus>): void {
		this.currentStatus = { ...this.currentStatus, ...patch };
		this.log({
			type: "bridge.tunnel_status",
			provider: this.currentStatus.provider,
			state: this.currentStatus.state,
			localUrl: this.currentStatus.localUrl,
			publicOrigin: this.currentStatus.publicOrigin,
			attempt: this.currentStatus.attempt,
			errorCode: this.currentStatus.errorCode,
			message: this.currentStatus.message,
			phase: this.currentStatus.phase,
			requiresReauthorization: this.currentStatus.requiresReauthorization,
		});
	}
}
