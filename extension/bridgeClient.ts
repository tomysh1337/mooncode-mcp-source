import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

export type BridgePermissionMode = 'read_only' | 'auto';
export type BridgeAccessScope = 'workspace' | 'computer';
export type BridgeAuthMode = 'capability_url' | 'oauth';
export type BridgeTunnelProvider = 'none' | 'cloudflare-quick' | 'cloudflare-named' | 'ngrok';
export type BridgeBrowserOriginMode = 'known' | 'custom' | 'universal_https';

export interface BridgeTunnelStatus {
	provider: BridgeTunnelProvider;
	state: 'stopped' | 'starting' | 'local_ready' | 'connecting' | 'public_ready' | 'degraded' | 'stopping' | 'error';
	localUrl: string | null;
	publicOrigin: string | null;
	attempt: number;
	errorCode: string | null;
	message: string | null;
	phase: 'public_origin' | 'propagation_wait' | 'protocol_verification' | null;
	requiresReauthorization: boolean;
}

export interface BridgeTunnelLaunchSettings {
	provider: BridgeTunnelProvider;
	publicUrl?: string;
	executable?: string;
	proxyUrl?: string;
	startupTimeoutMs?: number;
	maxAttempts?: number;
	localPort?: number;
	/** Provider transport credential from VS Code SecretStorage. Never serialized to argv. */
	token?: string;
}

export interface BridgeOAuthLaunchSettings {
	issuer: string;
	jwksUri: string;
	resourceId: string;
	endpointGeneration: number;
	resource?: string;
}

export interface BridgeReady {
	localUrl: string;
	publicUrl: string | null;
	port: number;
	allowWrite: boolean;
	permissionMode: BridgePermissionMode;
	accessScope: BridgeAccessScope;
	authMode: BridgeAuthMode;
	browserOriginMode: BridgeBrowserOriginMode;
	tunnelStatus: BridgeTunnelStatus;
}

export interface BridgeCommandOutput {
	command_id: string;
	terminal_id: string;
	terminal_reused: boolean;
	status: string;
	exit_code: number | null;
	cwd: string;
	final_cwd: string | null;
	background: boolean;
	earliest_offset: number;
	next_offset: number;
	output_lost: boolean;
	input_seq: number;
	output_start_offset: number;
	output: string;
	has_more: boolean;
}

export class BridgeControlError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'BridgeControlError';
	}
}

export type BridgeEvent = Record<string, unknown>;

export interface BridgeIdeRequest {
	requestId: string;
	kind: 'lsp' | 'get_diagnostics';
	args: Record<string, unknown>;
}

function normalizeTunnelStatus(value: unknown, fallbackProvider: BridgeTunnelProvider): BridgeTunnelStatus {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const provider = raw.provider === 'none' || raw.provider === 'cloudflare-quick' || raw.provider === 'cloudflare-named' || raw.provider === 'ngrok'
		? raw.provider
		: fallbackProvider;
	const state = raw.state === 'stopped' || raw.state === 'starting' || raw.state === 'local_ready' || raw.state === 'connecting' || raw.state === 'public_ready' || raw.state === 'degraded' || raw.state === 'stopping' || raw.state === 'error'
		? raw.state
		: provider === 'none' ? 'local_ready' : 'error';
	return {
		provider,
		state,
		localUrl: typeof raw.localUrl === 'string' ? raw.localUrl : null,
		publicOrigin: typeof raw.publicOrigin === 'string' ? raw.publicOrigin : null,
		attempt: Number.isSafeInteger(raw.attempt) ? Number(raw.attempt) : 0,
		errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : null,
		message: typeof raw.message === 'string' ? raw.message : null,
		phase: raw.phase === 'public_origin' || raw.phase === 'propagation_wait' || raw.phase === 'protocol_verification' ? raw.phase : null,
		requiresReauthorization: raw.requiresReauthorization === true,
	};
}

export class BridgeClient {
	private child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
	private stopPromise: Promise<void> | undefined;
	private readonly startTimeoutMs: number;
	private readonly stopTimeoutMs: number;
	private controlSequence = 0;
	private readonly controlRequests = new Map<string, { resolve: (value: BridgeCommandOutput) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		private readonly entry: string,
		private readonly cwd: string,
		timeouts: { startTimeoutMs?: number; stopTimeoutMs?: number } = {},
	) {
		this.startTimeoutMs = timeouts.startTimeoutMs ?? 30_000;
		this.stopTimeoutMs = timeouts.stopTimeoutMs ?? 5_000;
	}

	get running(): boolean {
		return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
	}

	async start(options: {
		workspace: string;
		allowWrite: boolean;
		accessScope?: BridgeAccessScope;
		authMode?: BridgeAuthMode;
		browserOriginMode?: BridgeBrowserOriginMode;
		browserOrigins?: string[];
		tunnel?: BridgeTunnelLaunchSettings;
		oauth?: BridgeOAuthLaunchSettings;
		onEvent: (event: BridgeEvent) => void;
		onIdeRequest?: (request: BridgeIdeRequest, signal: AbortSignal) => Promise<unknown>;
	}): Promise<BridgeReady> {
		await this.stop('Bridge restart');
		const tunnel: BridgeTunnelLaunchSettings = options.tunnel ?? { provider: 'none' };
		const authMode: BridgeAuthMode = options.authMode ?? 'capability_url';
		const browserOriginMode: BridgeBrowserOriginMode = options.browserOriginMode ?? 'universal_https';
		const browserOrigins = options.browserOrigins ?? [];
		// R3-002: Bridge Start gates only on local Runtime/MCP readiness.
		// Public tunnel establishment continues asynchronously after bridge.ready.
		const effectiveStartTimeoutMs = this.startTimeoutMs;
		const endpointSecret = randomBytes(32).toString('base64url');
		const requestedPort = tunnel.provider === 'cloudflare-named'
			? Math.max(1, Math.min(65535, Math.floor(tunnel.localPort ?? 48271)))
			: 0;
		const args = [
			this.entry,
			'--bridge',
			'--workspace', options.workspace,
			'--port', String(requestedPort),
			'--secret', endpointSecret,
			'--auth-mode', authMode,
			'--access-scope', options.accessScope ?? 'workspace',
			'--browser-origin-mode', browserOriginMode,
			'--tunnel-provider', tunnel.provider,
		];
		if (browserOrigins.length > 0) args.push('--browser-origins-json', JSON.stringify(browserOrigins));
		if (tunnel.provider === 'none') args.push('--no-tunnel');
		if (tunnel.publicUrl) args.push('--tunnel-public-url', tunnel.publicUrl);
		if (tunnel.executable) args.push('--tunnel-executable', tunnel.executable);
		if (tunnel.proxyUrl) args.push('--tunnel-proxy-url', tunnel.proxyUrl);
		if (tunnel.startupTimeoutMs) args.push('--tunnel-startup-timeout-ms', String(tunnel.startupTimeoutMs));
		if (tunnel.maxAttempts) args.push('--tunnel-max-attempts', String(tunnel.maxAttempts));
		if (options.oauth) {
			args.push(
				'--oauth-issuer', options.oauth.issuer,
				'--oauth-jwks-uri', options.oauth.jwksUri,
				'--oauth-resource-id', options.oauth.resourceId,
				'--oauth-endpoint-generation', String(options.oauth.endpointGeneration),
			);
			let resource = options.oauth.resource;
			if (!resource && tunnel.publicUrl && (tunnel.provider === 'cloudflare-named' || tunnel.provider === 'ngrok')) {
				resource = `${new URL(tunnel.publicUrl).origin}/mcp/${endpointSecret}`;
			}
			if (resource) args.push('--oauth-resource', resource);
		}
		if (options.allowWrite) args.push('--allow-write');
		const childEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		if (tunnel.provider === 'cloudflare-named' && tunnel.token) {
			childEnv.MOONCODE_CLOUDFLARE_TUNNEL_TOKEN = tunnel.token;
		}
		if (tunnel.provider === 'ngrok' && tunnel.token) {
			childEnv.MOONCODE_NGROK_AUTHTOKEN = tunnel.token;
		}
		const child = spawn(process.execPath, args, {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: childEnv,
		});
		this.child = child;
		const ideControllers = new Map<string, AbortController>();
		const stderr: string[] = [];
		child.stderr.on('data', (buf: Buffer) => {
			stderr.push(buf.toString());
			options.onEvent({ type: 'bridge.stderr', line: buf.toString().trim().slice(0, 300) });
		});
		return await new Promise((resolve, reject) => {
			let settled = false;
			const finishReject = async (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				input.close();
				await this.forceKillTree(child);
				if (this.child === child) this.child = undefined;
				reject(error);
			};
			const timer = setTimeout(() => {
				void finishReject(new Error(`Bridge start timeout${stderr.length ? ': ' + stderr.join('').slice(-400) : ''}`));
			}, effectiveStartTimeoutMs);
			const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
			input.on('line', line => {
				let parsed: BridgeEvent;
				try {
					parsed = JSON.parse(line) as BridgeEvent;
				} catch {
					options.onEvent({ type: 'bridge.stdout', line });
					return;
				}
				options.onEvent(parsed);
				if (parsed.type === 'bridge.command_output_response' && typeof parsed.requestId === 'string') {
					const pending = this.controlRequests.get(parsed.requestId);
					if (!pending) return;
					this.controlRequests.delete(parsed.requestId);
					clearTimeout(pending.timer);
					if (parsed.ok === true && parsed.output && typeof parsed.output === 'object') {
						pending.resolve(parsed.output as unknown as BridgeCommandOutput);
					} else {
						const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as { code?: unknown; message?: unknown } : {};
						const code = typeof error.code === 'string' ? error.code : 'COMMAND_OUTPUT_ERROR';
						pending.reject(new BridgeControlError(code, typeof error.message === 'string' ? error.message : 'command output unavailable'));
					}
					return;
				}
				if (parsed.type === 'bridge.ide_request') {
					const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : '';
					const kind = parsed.kind === 'lsp' || parsed.kind === 'get_diagnostics' ? parsed.kind : undefined;
					const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
						? parsed.args as Record<string, unknown>
						: undefined;
					if (!requestId || !kind || !args || !options.onIdeRequest) {
						this.sendControl({ type: 'bridge.ide_response', requestId, ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Extension Host IDE adapter is unavailable' } });
						return;
					}
					const controller = new AbortController();
					ideControllers.set(requestId, controller);
					void options.onIdeRequest({ requestId, kind, args }, controller.signal).then(
						result => {
							if (!ideControllers.delete(requestId) || controller.signal.aborted) return;
							this.sendControl({ type: 'bridge.ide_response', requestId, ok: true, result });
						},
						error => {
							if (!ideControllers.delete(requestId) || controller.signal.aborted) return;
							const rawCode = (error as { code?: unknown })?.code;
							const code = typeof rawCode === 'string' ? rawCode : 'INTERNAL_ERROR';
							const message = error instanceof Error ? error.message : String(error);
							this.sendControl({ type: 'bridge.ide_response', requestId, ok: false, error: { code, message } });
						},
					);
					return;
				}
				if (parsed.type === 'bridge.ide_cancel' && typeof parsed.requestId === 'string') {
					const controller = ideControllers.get(parsed.requestId);
					if (controller) {
						ideControllers.delete(parsed.requestId);
						controller.abort();
					}
					return;
				}
				if (parsed.type === 'bridge.ready') {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({
						localUrl: String(parsed.localUrl),
						publicUrl: (parsed.publicUrl as string | null) ?? null,
						port: Number(parsed.port),
						allowWrite: Boolean(parsed.allowWrite),
						permissionMode: parsed.permissionMode === 'auto' ? 'auto' : 'read_only',
						accessScope: parsed.accessScope === 'computer' ? 'computer' : 'workspace',
						authMode: parsed.authMode === 'oauth' ? 'oauth' : 'capability_url',
						browserOriginMode: parsed.browserOriginMode === 'known' || parsed.browserOriginMode === 'custom' ? parsed.browserOriginMode : 'universal_https',
						tunnelStatus: normalizeTunnelStatus(parsed.tunnelStatus, tunnel.provider),
					});
				}
			});
			child.on('exit', code => {
				this.rejectControlRequests(new Error(`Bridge exited (${code})`));
				for (const controller of ideControllers.values()) controller.abort();
				ideControllers.clear();
				if (this.child === child) this.child = undefined;
				clearTimeout(timer);
				input.close();
				if (!settled) {
					settled = true;
					reject(new Error(`Bridge exited (${code})${stderr.length ? ': ' + stderr.join('').slice(-400) : ''}`));
				}
			});
		});
	}

	setPermissionMode(mode: BridgePermissionMode): void {
		this.sendControl({ type: 'bridge.setMode', mode });
	}

	setAccessScope(accessScope: BridgeAccessScope): void {
		this.sendControl({ type: 'bridge.setAccessScope', accessScope });
	}

	revokeAll(reason = 'local authorization revoked'): void {
		this.sendControl({ type: 'bridge.revokeAll', reason });
	}

	revokeDevice(deviceId: string, reason = 'device authorization revoked'): void {
		this.sendControl({ type: 'bridge.revokeDevice', deviceId, reason });
	}

	revokeSubject(subject: string, reason = 'principal authorization revoked'): void {
		this.sendControl({ type: 'bridge.revokeSubject', subject, reason });
	}

	setDirtyPaths(paths: readonly string[]): void {
		this.sendControl({ type: 'bridge.setDirtyPaths', paths: [...paths] });
	}

	checkTunnelHealth(): void {
		this.sendControl({ type: 'bridge.checkTunnel' });
	}

	retryPublicTunnel(): void {
		this.sendControl({ type: 'bridge.retryPublicTunnel' });
	}

	getCommandOutput(commandId: string, offset = 0, maxBytes = 32 * 1024): Promise<BridgeCommandOutput> {
		if (!this.running) return Promise.reject(new Error('Bridge is not running'));
		if (!commandId || commandId.length > 200) return Promise.reject(new Error('invalid command id'));
		const boundedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
		const boundedMaxBytes = Number.isSafeInteger(maxBytes) ? Math.max(1, Math.min(128 * 1024, maxBytes)) : 32 * 1024;
		const requestId = `command-output-${++this.controlSequence}`;
		return new Promise<BridgeCommandOutput>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.controlRequests.delete(requestId)) return;
				reject(new Error('command output request timed out'));
			}, 5_000);
			timer.unref?.();
			this.controlRequests.set(requestId, { resolve, reject, timer });
			this.sendControl({ type: 'bridge.getCommandOutput', requestId, commandId, offset: boundedOffset, maxBytes: boundedMaxBytes });
		});
	}

	stop(reason = 'local Bridge stop'): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const child = this.child;
		if (!child) return Promise.resolve();
		this.stopPromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			const done = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (this.child === child) this.child = undefined;
				this.stopPromise = undefined;
				if (error) reject(error);
				else resolve();
			};
			child.once('exit', () => done());
			const timer = setTimeout(() => {
				void this.forceKillTree(child).then(
					() => done(),
					(error) => done(error instanceof Error ? error : new Error(String(error))),
				);
			}, this.stopTimeoutMs);
			timer.unref();
			try {
				child.stdin.write(`${JSON.stringify({ type: 'bridge.stop', reason })}\n`);
			} catch {
				void this.forceKillTree(child).then(
					() => done(),
					(error) => done(error instanceof Error ? error : new Error(String(error))),
				);
			}
		});
		return this.stopPromise;
	}

	private sendControl(message: Record<string, unknown>): void {
		const child = this.child;
		if (!child || child.exitCode !== null || child.stdin.destroyed) return;
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private rejectControlRequests(error: Error): void {
		for (const pending of this.controlRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.controlRequests.clear();
	}

	private async forceKillTree(child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<void> {
		if (child.exitCode !== null) return;
		if (process.platform === 'win32' && child.pid) {
			await new Promise<void>((resolve) => {
				const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
					stdio: 'ignore',
					windowsHide: true,
				});
				killer.once('error', () => {
					if (!child.killed) child.kill();
					resolve();
				});
				killer.once('exit', () => {
					if (child.exitCode === null && !child.killed) {
						try { child.kill(); } catch { /* process already gone */ }
					}
					resolve();
				});
			});
			if (await this.waitForExit(child, 1_500)) return;
			try { child.kill('SIGKILL'); } catch { /* process already gone */ }
			if (await this.waitForExit(child, 1_000)) return;
			throw new Error(`Bridge child process ${child.pid} did not exit after forced tree termination`);
		}
		if (!child.killed) child.kill('SIGKILL');
		if (!(await this.waitForExit(child, 1_500))) {
			throw new Error(`Bridge child process ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
		}
	}

	private async waitForExit(child: ChildProcessByStdio<Writable, Readable, Readable>, timeoutMs: number): Promise<boolean> {
		if (child.exitCode !== null) return true;
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off('exit', onExit);
				resolve(value);
			};
			const onExit = () => finish(true);
			const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
			timer.unref();
			child.once('exit', onExit);
		});
	}
}
