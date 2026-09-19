import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import {
	type AuthInfo,
	createMcpHandler,
	fromJsonSchema,
	isLegacyRequest,
	McpServer,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import {
	CommandManager,
	CommandManagerError,
	ToolGateway,
	type ManagedCommandOutput,
	WorkspaceFileError,
	WorkspaceFileService,
	WorkspacePatchService,
} from "@mooncode/tool-gateway";
import {
  type BridgeApplyPatchArgs,
  type BridgeFindFilesArgs,
  type BridgeGetCommandOutputArgs,
  type BridgeGetDiagnosticsArgs,
  type BridgeListDirectoryArgs,
	type BridgeLspArgs,
	BRIDGE_MCP_INSTRUCTIONS,
	BRIDGE_MCP_SERVER_INFO,
	BRIDGE_MCP_SUPPORTED_PROTOCOLS,
	BRIDGE_TOOL_DEFINITIONS,
	type BridgePublicErrorCode,
	type BridgePublicToolName,
  type BridgeReadFilesArgs,
  type BridgeReportProgressArgs,
  type BridgeRunCommandArgs,
  type BridgeSearchFilesArgs,
	type BridgeSetTodosArgs,
	type BridgeSendCommandInputArgs,
	type BridgeWaitArgs,
	type ToolResult,
	type WorkspaceApplyPatchArgs,
	type WorkspaceReadArgs,
} from "@mooncode/contracts";
import {
	BridgeAuthError,
	BridgeTokenVerifier,
	protectedResourceMetadataUrl,
	validateBridgeAuthConfiguration,
	type BridgeAuthContext,
	type BridgeAuthMode,
	type BridgeOAuthOptions,
	type BridgeRuntimeMode,
} from "./bridge-auth.js";
import {
	type BridgeAccessScope,
	BridgeSessionManager,
	BridgeSessionPermissionError,
	type BridgePermissionMode,
} from "./bridge-session.js";
import { BridgeIdeBroker, BridgeIdeError, type BridgeIdeResponseMessage, type BridgeIdeService } from "./bridge-ide.js";
import { BridgeTaskError, BridgeTaskStore } from "./bridge-tasks.js";
import {
	BridgeTunnelManager,
	type BridgeTunnelDependencies,
	type BridgeTunnelOptions,
	type BridgeTunnelProviderKind,
	type BridgeTunnelStatus,
} from "./bridge-tunnel.js";

export type BridgeLog = (event: Record<string, unknown>) => void;

export type BridgeBrowserOriginMode = "known" | "custom" | "universal_https";

export interface BridgeBrowserOriginPolicy {
	mode: BridgeBrowserOriginMode;
	origins?: readonly string[];
}

export interface BridgeOptions {
	workspaceRoot: string;
	accessScope?: BridgeAccessScope;
	port?: number;
	secret?: string;
	allowWrite?: boolean;
	host?: string;
	log?: BridgeLog;
	tunnel?: BridgeTunnelProviderKind | BridgeTunnelOptions;
	/** Test/runtime injection only; never serialized into product settings. */
	tunnelDependencies?: BridgeTunnelDependencies;
	mode?: BridgeRuntimeMode;
	authMode?: BridgeAuthMode;
	oauth?: BridgeOAuthOptions;
	browserOriginPolicy?: BridgeBrowserOriginPolicy;
	ide?: BridgeIdeService;
	commandOptions?: {
		maxOutputBytes?: number;
		retentionMs?: number;
		maxTerminals?: number;
	};
}

export interface BridgeHandle {
	port: number;
	secret: string;
	localUrl: string;
	publicUrl?: string;
	allowWrite: boolean;
	permissionMode: BridgePermissionMode;
	accessScope: BridgeAccessScope;
	authMode: BridgeAuthMode;
	browserOriginMode: BridgeBrowserOriginMode;
	oauthResource?: string;
	protectedResourceMetadataUrl?: string;
	tunnelStatus: BridgeTunnelStatus;
	setPermissionMode(mode: BridgePermissionMode): void;
	setAccessScope(scope: BridgeAccessScope): void;
	revokeDevice(deviceId: string, reason?: string): number;
	revokeSubject(subject: string, reason?: string): number;
	revokeAll(reason?: string): number;
	setDirtyPaths(paths: readonly string[]): void;
	getCommandOutput(commandId: string, offset?: number, maxBytes?: number): ManagedCommandOutput;
	connectPublicTunnel(): Promise<BridgeTunnelStatus>;
	checkTunnelHealth(): Promise<BridgeTunnelStatus>;
	close(): Promise<void>;
}

function normalizeTunnelOptions(input: BridgeOptions["tunnel"]): BridgeTunnelOptions {
	if (!input) return { kind: "none" };
	if (typeof input === "string") return { kind: input };
	return { ...input };
}

type TunnelFetch = typeof fetch;

export function createTunnelFetch(proxyUrl?: string): { fetch: TunnelFetch; close(): Promise<void> } {
	if (!proxyUrl) {
		return {
			fetch: ((input, init) => globalThis.fetch(input, init)) as TunnelFetch,
			async close() {},
		};
	}
	const dispatcher = new ProxyAgent(proxyUrl);
	return {
		fetch: (async (input, init) => await undiciFetch(input as any, { ...(init as any), dispatcher }) as unknown as Response) as TunnelFetch,
		async close() { await dispatcher.close(); },
	};
}

async function fetchJsonChecked(fetchImpl: TunnelFetch, url: string, signal: AbortSignal): Promise<{ response: Response; body: unknown }> {
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { accept: "application/json" },
		signal,
	});
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	return { response, body };
}

async function verifyPublishedBridgeHealth(
	fetchImpl: TunnelFetch,
	publicOrigin: string,
	resource: string,
	metadataUrl: string,
	signal: AbortSignal,
): Promise<void> {
	const health = await fetchJsonChecked(fetchImpl, `${publicOrigin}/health`, signal);
	if (!health.response.ok || (health.body as { ok?: unknown } | undefined)?.ok !== true) {
		throw new Error(`public /health failed with HTTP ${health.response.status}`);
	}
	const prm = await fetchJsonChecked(fetchImpl, metadataUrl, signal);
	if (!prm.response.ok) throw new Error(`public protected resource metadata failed with HTTP ${prm.response.status}`);
	if ((prm.body as { resource?: unknown } | undefined)?.resource !== resource) {
		throw new Error("public protected resource metadata resource does not match Bridge resource");
	}
	const challenge = await fetchImpl(resource, {
		method: "GET",
		headers: { accept: "application/json, text/event-stream" },
		signal,
	});
	if (challenge.status !== 401) throw new Error(`anonymous public MCP probe expected HTTP 401 but received ${challenge.status}`);
	const wwwAuthenticate = challenge.headers.get("www-authenticate") ?? "";
	if (!/Bearer/i.test(wwwAuthenticate) || !wwwAuthenticate.includes(metadataUrl)) {
		throw new Error("anonymous public MCP probe did not advertise the expected OAuth protected resource metadata");
	}
}

async function postMcpProbe(fetchImpl: TunnelFetch, url: string, body: unknown, signal: AbortSignal): Promise<{ response: Response; body: any }> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
		if (dataLine) {
			try { parsed = JSON.parse(dataLine.slice(5).trim()); } catch { parsed = undefined; }
		}
	}
	return { response, body: parsed };
}

async function verifyPublishedCapabilityBridgeHealth(
	fetchImpl: TunnelFetch,
	publicOrigin: string,
	resource: string,
	secret: string,
	signal: AbortSignal,
): Promise<void> {
	const health = await fetchJsonChecked(fetchImpl, `${publicOrigin}/health`, signal);
	if (!health.response.ok || (health.body as { ok?: unknown } | undefined)?.ok !== true) {
		throw new Error(`public /health failed with HTTP ${health.response.status}`);
	}
	const initialize = await postMcpProbe(fetchImpl, resource, {
		jsonrpc: "2.0",
		id: "mooncode-health-init",
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "mooncode-health", version: "1" },
		},
	}, signal);
	if (!initialize.response.ok || initialize.body?.error) {
		throw new Error(`public capability MCP initialize failed with HTTP ${initialize.response.status}`);
	}
	const tools = await postMcpProbe(fetchImpl, resource, {
		jsonrpc: "2.0",
		id: "mooncode-health-tools",
		method: "tools/list",
		params: {},
	}, signal);
	if (!tools.response.ok || tools.body?.error || !Array.isArray(tools.body?.result?.tools)) {
		throw new Error(`public capability MCP tools/list failed with HTTP ${tools.response.status}`);
	}
	const wrongSecret = `${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;
	const wrong = await postMcpProbe(fetchImpl, `${publicOrigin}/mcp/${wrongSecret}`, {
		jsonrpc: "2.0",
		id: "mooncode-health-wrong-secret",
		method: "initialize",
		params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mooncode-health", version: "1" } },
	}, signal);
	if (wrong.response.status !== 404) {
		throw new Error(`wrong capability secret expected HTTP 404 but received ${wrong.response.status}`);
	}
}

function requiredOAuthScopes(body: unknown): Array<"bridge.read" | "bridge.write" | "bridge.exec"> {
	const messages = Array.isArray(body) ? body : [body];
	const scopes = new Set<"bridge.read" | "bridge.write" | "bridge.exec">();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const candidate = message as { method?: unknown; params?: { name?: unknown } };
		if (candidate.method === "tools/call") {
			if (candidate.params?.name === "write_file" || candidate.params?.name === "apply_patch") scopes.add("bridge.write");
			else if (candidate.params?.name === "run_command" || candidate.params?.name === "send_command_input") scopes.add("bridge.exec");
			else scopes.add("bridge.read");
		} else {
			scopes.add("bridge.read");
		}
	}
	if (scopes.size === 0) scopes.add("bridge.read");
	return [...scopes];
}

function oauthChallenge(metadataUrl: string, error?: BridgeAuthError): string {
	let value = `Bearer resource_metadata="${metadataUrl.replace(/"/g, "")}"`;
	if (error) value += `, error="${error.oauthError}"`;
	if (error?.requiredScope) value += `, scope="${error.requiredScope}"`;
	return value;
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		...extra,
	});
	res.end(JSON.stringify(body));
}

const KNOWN_BROWSER_MCP_ORIGINS = new Set([
	"https://chatgpt.com",
	"https://chat.openai.com",
]);

function normalizeBrowserOrigin(value: string): string {
	const input = value.trim();
	if (!input || input === "null") throw new Error("browser Origin must be a non-null HTTPS origin");
	const url = new URL(input);
	if (url.protocol !== "https:") throw new Error("browser Origin must use HTTPS");
	if (url.username || url.password) throw new Error("browser Origin must not contain credentials");
	if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw new Error("browser Origin must not contain path, query, or fragment");
	if (!url.hostname) throw new Error("browser Origin must contain a hostname");
	return url.origin;
}

function normalizeBrowserOriginPolicy(input: BridgeBrowserOriginPolicy | undefined): { mode: BridgeBrowserOriginMode; origins: ReadonlySet<string> } {
	const mode = input?.mode ?? "universal_https";
	if (mode !== "known" && mode !== "custom" && mode !== "universal_https") throw new Error(`invalid browser Origin mode: ${String(mode)}`);
	const configured = input?.origins ?? [];
	if (configured.length > 100) throw new Error("browser Origin allowlist cannot exceed 100 entries");
	const origins = new Set<string>();
	for (const value of configured) origins.add(normalizeBrowserOrigin(value));
	return { mode, origins };
}

function browserOriginAllowed(origin: string, policy: { mode: BridgeBrowserOriginMode; origins: ReadonlySet<string> }): string | undefined {
	let normalized: string;
	try {
		normalized = normalizeBrowserOrigin(origin);
	} catch {
		return undefined;
	}
	if (policy.mode === "universal_https") return normalized;
	if (policy.mode === "known") return KNOWN_BROWSER_MCP_ORIGINS.has(normalized) ? normalized : undefined;
	return policy.origins.has(normalized) ? normalized : undefined;
}

function applyBrowserMcpCors(
	req: IncomingMessage,
	res: ServerResponse,
	policy: { mode: BridgeBrowserOriginMode; origins: ReadonlySet<string> },
): void {
	const origin = req.headers.origin;
	if (!origin) return;
	const allowedOrigin = browserOriginAllowed(origin, policy);
	if (!allowedOrigin) return;
	res.setHeader("access-control-allow-origin", allowedOrigin);
	res.setHeader("vary", "Origin");
	res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader(
		"access-control-allow-headers",
		"Accept, Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id",
	);
	res.setHeader("access-control-expose-headers", "MCP-Session-Id, MoonCode-Session-Id, WWW-Authenticate");
	res.setHeader("access-control-max-age", "600");
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 2 * 1024 * 1024) {
				chunks.length = 0;
				if (!settled) {
					settled = true;
					reject(new Error("BODY_TOO_LARGE"));
				}
				return;
			}
			if (!settled) chunks.push(c);
		});
		req.on("end", () => {
			if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (error) => {
			if (!settled) reject(error);
		});
	});
}

function preview(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function publicError(code: BridgePublicErrorCode, message: string): { ok: false; text: string } {
	return { ok: false, text: `ERROR ${code}: ${message}` };
}

function normalizeGatewayErrorCode(code: string): BridgePublicErrorCode {
	if (code === "ENOENT" || code === "FILE_NOT_FOUND") return "NOT_FOUND";
	if (code === "FILE_ALREADY_EXISTS" || code === "HASH_MISMATCH") return "VERSION_CONFLICT";
	if (code === "EACCES" || code === "EPERM" || code.startsWith("CAPABILITY_") || code === "PATH_OUTSIDE_WORKSPACE" || code === "PATH_TRAVERSAL") {
		return "PERMISSION_DENIED";
	}
	if (code === "MALFORMED_TOOL_CALL" || code === "PARAMETER_HASH_MISMATCH") return "INVALID_ARGUMENT";
	if (code === "ETIMEDOUT" || code === "TIMEOUT") return "TIMEOUT";
	if (code === "ABORT_ERR" || code === "CANCELLED") return "CANCELLED";
	return "INTERNAL_ERROR";
}

function resultText(result: ToolResult): string {
	if (!result.ok) {
		const code = normalizeGatewayErrorCode(result.code);
		return `ERROR ${code}: ${result.message}`;
	}
	return typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
}

function commandOutputText(result: ManagedCommandOutput): string {
	return JSON.stringify({
		command_id: result.commandId,
		terminal_id: result.terminalId,
		terminal_reused: result.terminalReused,
		status: result.status,
		exit_code: result.exitCode ?? null,
		cwd: result.cwd,
		final_cwd: result.finalCwd ?? null,
		background: result.background,
		earliest_offset: result.earliestOffset,
		next_offset: result.nextOffset,
		output_lost: result.outputLost,
		input_seq: result.inputSeq,
		output_start_offset: result.outputStartOffset,
		output: result.output,
		has_more: result.hasMore,
	}, null, 2);
}

function resultMetadata(name: BridgePublicToolName, text: string, args: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	const errorMatch = /^ERROR\s+([A-Z0-9_]+):/u.exec(text);
	if (errorMatch?.[1]) metadata.errorCode = errorMatch[1];
	let parsed: Record<string, unknown> | undefined;
	try {
		const value = JSON.parse(text) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
	} catch {
		// Public tool responses can be plain text. UI metadata remains intentionally small.
	}
	if (!parsed) return metadata;
	const commandId = typeof parsed.command_id === "string" ? parsed.command_id : undefined;
	if (commandId) {
		metadata.commandId = commandId;
		metadata.commandStatus = typeof parsed.status === "string" ? parsed.status : "unknown";
		metadata.cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
		metadata.exitCode = parsed.exit_code === null || Number.isSafeInteger(parsed.exit_code) ? parsed.exit_code : undefined;
		metadata.earliestOffset = Number.isSafeInteger(parsed.earliest_offset) ? parsed.earliest_offset : undefined;
		metadata.nextOffset = Number.isSafeInteger(parsed.next_offset) ? parsed.next_offset : undefined;
		metadata.outputLost = parsed.output_lost === true;
		if (name === "run_command" && typeof args.command === "string") metadata.commandSummary = preview(args.command);
	}
	if (typeof parsed.transaction_id === "string") metadata.transactionId = parsed.transaction_id;
	const collection = Array.isArray(parsed.files) ? parsed.files
		: Array.isArray(parsed.entries) ? parsed.entries
			: Array.isArray(parsed.matches) ? parsed.matches
				: Array.isArray(parsed.results) ? parsed.results
					: undefined;
	if (collection) metadata.resultSummary = `${collection.length} 项`;
	return metadata;
}

function assertCommandOwnership(
	commands: CommandManager,
	sessions: BridgeSessionManager,
	authInfo: AuthInfo | undefined,
	commandId: string,
): void {
	const ownerSessionId = commands.ownerSessionId(commandId);
	const callerSessionId = sessions.getSessionId(authInfo);
	if (ownerSessionId !== callerSessionId) {
		throw new BridgeSessionPermissionError("PERMISSION_DENIED", "command belongs to another MoonCode authorization session");
	}
}

async function invoke(
	gateway: ToolGateway,
	root: string,
	patcher: WorkspacePatchService,
	ide: BridgeIdeService | undefined,
	commands: CommandManager,
	tasks: BridgeTaskStore,
	name: BridgePublicToolName,
	args: Record<string, unknown>,
	sessions: BridgeSessionManager,
	authInfo: AuthInfo | undefined,
	signal?: AbortSignal,
): Promise<{ ok: boolean; text: string }> {
	if (signal?.aborted) return publicError("CANCELLED", "request was cancelled");
	const files = new WorkspaceFileService(root, { accessScope: () => sessions.accessScope });

	try {
		if (name === "lsp") {
			if (!ide) return publicError("PROVIDER_UNAVAILABLE", "MoonCode Extension Host IDE adapter is not connected");
			const result = await ide.request("lsp", args as unknown as BridgeLspArgs as unknown as Record<string, unknown>, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "get_diagnostics") {
			if (!ide) return publicError("PROVIDER_UNAVAILABLE", "MoonCode Extension Host IDE adapter is not connected");
			const result = await ide.request("get_diagnostics", args as unknown as BridgeGetDiagnosticsArgs as unknown as Record<string, unknown>, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "list_directory") {
			const result = await files.listDirectory(args as BridgeListDirectoryArgs, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "find_files") {
			const result = await files.findFiles(args as unknown as BridgeFindFilesArgs, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "read_files") {
			const result = await files.readFiles(args as unknown as BridgeReadFilesArgs, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "search_files") {
			const result = await files.searchFiles(args as unknown as BridgeSearchFilesArgs, signal);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "run_command") {
			const input = args as unknown as BridgeRunCommandArgs;
			const lease = sessions.beginCommand(authInfo, signal);
			try {
				const result = await commands.run({
					command: input.command,
					cwd: input.cwd,
					background: input.background,
					timeoutMs: input.timeout_ms,
					ownerSessionId: sessions.getSessionId(authInfo),
					signal: lease.signal,
				});
				if (result.status === "running") {
					lease.detachRequest();
					void commands.waitForCompletion(result.commandId)
						.catch(() => undefined)
						.finally(() => lease.finish());
				} else {
					lease.finish();
				}
				return { ok: true, text: commandOutputText(result) };
			} catch (error) {
				lease.finish();
				throw error;
			}
		}

		if (name === "get_command_output") {
			const input = args as unknown as BridgeGetCommandOutputArgs;
			assertCommandOwnership(commands, sessions, authInfo, input.command_id);
			const result = commands.getOutput(input.command_id, input.offset ?? 0, input.max_bytes ?? 32 * 1024);
			return { ok: true, text: commandOutputText(result) };
		}

		if (name === "send_command_input") {
			const input = args as unknown as BridgeSendCommandInputArgs;
			const lease = sessions.beginCommand(authInfo, signal);
			try {
				if (lease.signal.aborted) throw new CommandManagerError("CANCELLED", "command input request was cancelled");
				assertCommandOwnership(commands, sessions, authInfo, input.command_id);
				const result = commands.sendInput(input.command_id, input.input, input.append_newline ?? true);
				return {
					ok: true,
					text: JSON.stringify({
						command_id: result.commandId,
						terminal_id: result.terminalId,
						input_seq: result.inputSeq,
						status: result.status,
					}, null, 2),
				};
			} finally {
				lease.finish();
			}
		}

		if (name === "wait") {
			const input = args as unknown as BridgeWaitArgs;
			assertCommandOwnership(commands, sessions, authInfo, input.command_id);
			const result = await commands.waitForActivity(input.command_id, input.timeout_ms ?? 30_000, signal);
			return { ok: true, text: commandOutputText(result) };
		}

		if (name === "set_todos") {
			const input = args as unknown as BridgeSetTodosArgs;
			const sessionKey = sessions.getSessionId(authInfo) ?? "local";
			const result = tasks.setTodos(sessionKey, input);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "report_progress") {
			const input = args as unknown as BridgeReportProgressArgs;
			const sessionKey = sessions.getSessionId(authInfo) ?? "local";
			const result = tasks.reportProgress(sessionKey, input);
			return { ok: true, text: JSON.stringify(result, null, 2) };
		}

		if (name === "read_file") {
			const path = args.path;
			if (typeof path !== "string" || !path) return publicError("INVALID_ARGUMENT", "path is required");
			const result = await files.readFiles({ files: [{ path }] }, signal);
			const item = result.files[0];
			if (!item) return publicError("INTERNAL_ERROR", "read_file returned no result");
			if (!item.ok) return publicError(item.code, item.message);
			return { ok: true, text: JSON.stringify(item, null, 2) };
		}
	} catch (error) {
		if (error instanceof BridgeIdeError) return publicError(error.code, error.message);
		if (error instanceof WorkspaceFileError) return publicError(error.code, error.message);
		if (error instanceof CommandManagerError) return publicError(error.code, error.message);
		if (error instanceof BridgeTaskError) return publicError(error.code, error.message);
		if (error instanceof BridgeSessionPermissionError) return publicError(error.code, error.message);
		throw error;
	}

	if (name === "apply_patch") {
		let writeLease;
		try {
			writeLease = sessions.beginWrite(authInfo);
		} catch (error) {
			if (error instanceof BridgeSessionPermissionError) return publicError(error.code, error.message);
			throw error;
		}
		const result = await patcher.applyPatch(args as unknown as BridgeApplyPatchArgs, signal, {
			enterCommitCriticalSection: () => sessions.enterWriteCriticalSection(writeLease),
		});
		return { ok: result.applied, text: JSON.stringify(result, null, 2) };
	}

	if (name === "write_file") {
		let writeLease;
		try {
			writeLease = sessions.beginWrite(authInfo);
		} catch (error) {
			if (error instanceof BridgeSessionPermissionError) return publicError(error.code, error.message);
			throw error;
		}
		const path = args.path;
		const content = args.content;
		if (typeof path !== "string" || typeof content !== "string") {
			return publicError("INVALID_ARGUMENT", "path and content are required");
		}
		const existing = await files.readFiles({ files: [{ path }] }, signal);
		const item = existing.files[0];
		if (!item) return publicError("INTERNAL_ERROR", "write_file preflight returned no file result");
		let expectedVersion: string | null;
		if (item.ok) expectedVersion = item.version;
		else if (item.code === "NOT_FOUND") expectedVersion = null;
		else return publicError(item.code, item.message);
		const result = await patcher.replaceFile(path, content, expectedVersion, signal, {
			enterCommitCriticalSection: () => sessions.enterWriteCriticalSection(writeLease),
		});
		return { ok: result.applied, text: JSON.stringify(result, null, 2) };
	}

	return publicError("INVALID_ARGUMENT", `unknown tool ${name}`);
}

function createBridgeMcpServer(
	gateway: ToolGateway,
	root: string,
	patcher: WorkspacePatchService,
	ide: BridgeIdeService | undefined,
	commands: CommandManager,
	tasks: BridgeTaskStore,
	sessions: BridgeSessionManager,
	log: BridgeLog,
	authInfo?: AuthInfo,
): McpServer {
	const server = new McpServer(BRIDGE_MCP_SERVER_INFO, {
		instructions: BRIDGE_MCP_INSTRUCTIONS,
		supportedProtocolVersions: [...BRIDGE_MCP_SUPPORTED_PROTOCOLS],
	});

	for (const definition of BRIDGE_TOOL_DEFINITIONS) {
		server.registerTool(
			definition.name,
			{
				description: definition.description,
				inputSchema: fromJsonSchema<Record<string, unknown>>(definition.inputSchema),
				annotations: definition.annotations,
			},
			async (args, requestContext) => {
				if (requestContext.mcpReq.signal.aborted) {
					return { content: [{ type: "text", text: "ERROR CANCELLED: request was cancelled" }], isError: true };
				}
				try {
					sessions.assertToolPermission(definition.name, authInfo);
				} catch (error) {
					if (error instanceof BridgeSessionPermissionError) {
						return { content: [{ type: "text", text: `ERROR ${error.code}: ${error.message}` }], isError: true };
					}
					throw error;
				}
				const callId = randomUUID();
				const startedAt = new Date().toISOString();
				const startedMonotonic = performance.now();
				const todoId = definition.name === "report_progress" && typeof args.todo_id === "string" ? args.todo_id : undefined;
				log({ type: "bridge.call", callId, tool: definition.name, args, startedAt, todoId, sessionId: authInfo?.extra?.mooncodeSessionId });
				let out: { ok: boolean; text: string };
				try {
					out = await invoke(gateway, root, patcher, ide, commands, tasks, definition.name, args, sessions, authInfo, requestContext.mcpReq.signal);
				} catch (error) {
					const endedAt = new Date().toISOString();
					log({ type: "bridge.result", callId, tool: definition.name, ok: false, startedAt, endedAt, durationMs: Math.max(0, Math.round(performance.now() - startedMonotonic)), errorCode: "INTERNAL_ERROR" });
					throw error;
				}
				const endedAt = new Date().toISOString();
				const durationMs = Math.max(0, Math.round(performance.now() - startedMonotonic));
				const metadata = resultMetadata(definition.name, out.text, args);
				if (definition.name === "apply_patch") {
					try {
						const patchResult = JSON.parse(out.text) as {
							transaction_id?: unknown;
							applied?: unknown;
							rolled_back?: unknown;
							recovery_required?: unknown;
							files?: unknown;
							diff?: unknown;
							diff_truncated?: unknown;
							error?: unknown;
						};
						log({
							type: "bridge.patch_result",
							callId,
							endedAt,
							transactionId: patchResult.transaction_id ?? null,
							applied: Boolean(patchResult.applied),
							rolledBack: Boolean(patchResult.rolled_back),
							recoveryRequired: Boolean(patchResult.recovery_required),
							files: patchResult.files ?? [],
							diff: typeof patchResult.diff === "string" ? patchResult.diff : "",
							diffTruncated: Boolean(patchResult.diff_truncated),
							error: patchResult.error ?? null,
						});
					} catch {
						log({ type: "bridge.patch_result", callId, endedAt, applied: false, parseError: true });
					}
				}
				if (requestContext.mcpReq.signal.aborted && definition.annotations.readOnlyHint) {
					log({ type: "bridge.cancelled", callId, tool: definition.name, startedAt, endedAt, durationMs });
					return { content: [{ type: "text", text: "ERROR CANCELLED: request was cancelled" }], isError: true };
				}
				log({ type: "bridge.result", callId, tool: definition.name, ok: out.ok, startedAt, endedAt, durationMs, preview: preview(out.text), ...metadata });
				return { content: [{ type: "text", text: out.text }], isError: !out.ok };
			},
		);
	}

	return server;
}

async function handleLegacyJsonRequest(
	request: Request,
	res: ServerResponse,
	parsedBody: unknown,
	gateway: ToolGateway,
	root: string,
	patcher: WorkspacePatchService,
	ide: BridgeIdeService | undefined,
	commands: CommandManager,
	tasks: BridgeTaskStore,
	sessions: BridgeSessionManager,
	log: BridgeLog,
	authInfo?: AuthInfo,
): Promise<void> {
	const mcpServer = createBridgeMcpServer(gateway, root, patcher, ide, commands, tasks, sessions, log, authInfo);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
		supportedProtocolVersions: [...BRIDGE_MCP_SUPPORTED_PROTOCOLS],
	});
	transport.onerror = (error) => log({ type: "bridge.legacy_transport_error", message: error.message });

	await mcpServer.connect(transport);
	try {
		const response = await transport.handleRequest(request, { parsedBody });
		const headers: Record<string, string> = {};
		for (const [name, value] of response.headers) headers[name] = value;
		res.writeHead(response.status, headers);
		if (response.body === null) {
			res.end();
		} else {
			res.end(Buffer.from(await response.arrayBuffer()));
		}
	} finally {
		await Promise.allSettled([transport.close(), mcpServer.close()]);
	}
}

export async function startBridgeServer(options: BridgeOptions): Promise<BridgeHandle> {
	const root = options.workspaceRoot;
	const secret = options.secret ?? randomBytes(32).toString("base64url");
	const host = options.host ?? "127.0.0.1";
	const allowWrite = Boolean(options.allowWrite);
	const sessions = new BridgeSessionManager(root, allowWrite ? "auto" : "read_only", options.accessScope ?? "workspace");
	const mode = options.mode ?? "local";
	const authMode: BridgeAuthMode = options.authMode ?? "capability_url";
	const browserOriginPolicy = normalizeBrowserOriginPolicy(options.browserOriginPolicy);
	const tunnelOptions = normalizeTunnelOptions(options.tunnel);
	validateBridgeAuthConfiguration(mode, authMode, options.oauth, tunnelOptions.kind, secret);
	if (authMode === "oauth" && options.oauth?.resource) {
		const configuredResource = new URL(options.oauth.resource);
		if (configuredResource.pathname.replace(/\/$/, "") !== `/mcp/${secret}`) {
			throw new Error(`OAuth resource path must target /mcp/${secret}`);
		}
	}
	const log: BridgeLog = options.log ?? ((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
	const dirtyPathKeys = new Set<string>();
	const dirtyKey = (value: string): string => {
		const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
		return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
	};
	const patcher = new WorkspacePatchService(root, {
		dirtyChecker: async (paths) => paths.filter((path) => dirtyPathKeys.has(dirtyKey(path))),
		accessScope: () => sessions.accessScope,
	});
	const recovery = await patcher.recoverPendingTransactions();
	if (recovery.recovery_required.length > 0) {
		throw new Error(`MoonCode patch recovery requires manual intervention: ${recovery.recovery_required.join(", ")}`);
	}
	if (recovery.recovered > 0) log({ type: "bridge.patch_recovered", count: recovery.recovered });
	const gateway = new ToolGateway();
	const commands = new CommandManager(root, { ...options.commandOptions, accessScope: () => sessions.accessScope });
	const tasks = new BridgeTaskStore(log);
	const ide = options.ide;
	let oauthVerifier: BridgeTokenVerifier | undefined;
	let oauthResource: string | undefined;
	let oauthMetadataUrl: string | undefined;
	let oauthReady = authMode !== "oauth";
	const mcpHandler = createMcpHandler(
		(ctx) => createBridgeMcpServer(gateway, root, patcher, ide, commands, tasks, sessions, log, ctx.authInfo),
		{
			legacy: "reject",
			responseMode: "auto",
			onerror: (error) => log({ type: "bridge.protocol_error", message: error.message }),
		},
	);
	const nodeMcpHandler = toNodeHandler(mcpHandler, {
		onerror: (error) => log({ type: "bridge.adapter_error", message: error.message }),
	});

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${host}`);
		applyBrowserMcpCors(req, res, browserOriginPolicy);
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "allow": "GET, POST, DELETE, OPTIONS" });
			res.end();
			return;
		}
		if (url.pathname === "/health") {
			json(res, 200, { ok: true, product: "mooncode-bridge" });
			return;
		}
		if (oauthMetadataUrl && url.pathname === new URL(oauthMetadataUrl).pathname) {
			if (req.method !== "GET") {
				res.writeHead(405, { "allow": "GET" });
				res.end();
				return;
			}
			json(res, 200, oauthVerifier?.metadata() ?? { error: "oauth_not_ready" });
			return;
		}
		const prefix = `/mcp/${secret}`;
		const sessionPath = `${prefix}/session`;
		const isSessionPath = url.pathname === sessionPath || url.pathname === `${sessionPath}/`;
		if (url.pathname !== prefix && url.pathname !== `${prefix}/` && !isSessionPath) {
			json(res, 404, { error: "not found" });
			return;
		}
		if (authMode === "oauth" && !oauthReady) {
			json(res, 503, { error: "oauth initialization in progress" }, { "retry-after": "1" });
			return;
		}
		let authContext: BridgeAuthContext | undefined;
		let sdkAuthInfo: AuthInfo | undefined;
		if (oauthVerifier && oauthMetadataUrl) {
			try {
				authContext = await oauthVerifier.verify(req.headers.authorization);
				const authorizationSession = sessions.resolve(authContext);
				sdkAuthInfo = sessions.toSdkAuthInfo(authContext, authorizationSession);
				(req as IncomingMessage & { auth?: AuthInfo }).auth = sdkAuthInfo;
				res.setHeader("mooncode-session-id", authorizationSession.id);
			} catch (error) {
				const authError = error instanceof BridgeAuthError
					? error
					: new BridgeAuthError(401, "invalid_token", "access token validation failed");
				json(res, authError.status, { error: authError.oauthError }, {
					"www-authenticate": oauthChallenge(oauthMetadataUrl, authError),
				});
				return;
			}
		}

		if (isSessionPath) {
			if (!oauthVerifier || !authContext || !sdkAuthInfo || !oauthMetadataUrl) {
				json(res, 404, { error: "not found" });
				return;
			}
			if (req.method === "GET") {
				const current = sessions.getSessionForCredential(authContext.credentialId);
				if (!current || current.revokedAt) {
					json(res, 401, { error: "invalid_token" }, {
						"www-authenticate": oauthChallenge(oauthMetadataUrl, new BridgeAuthError(401, "invalid_token", "MoonCode authorization session is not active")),
					});
					return;
				}
				json(res, 200, {
					id: current.id,
					subject: current.subject,
					deviceId: current.deviceId,
					resourceId: current.resourceId,
					endpointGeneration: current.endpointGeneration,
					workspaceRoot: current.workspaceRoot,
					permissionMode: sessions.permissionMode,
					createdAt: current.createdAt,
					lastSeenAt: current.lastSeenAt,
				});
				return;
			}
			if (req.method === "DELETE") {
				sessions.revokeCredential(authContext.credentialId, "session deleted by authenticated client");
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(405, { allow: "GET, DELETE" });
			res.end();
			return;
		}
		// Compatibility for the pre-SDK MoonCode Bridge client, which did not
		// send an Accept header. Explicit Accept values are never rewritten: the
		// SDK remains authoritative for protocol/content negotiation.
		if (!req.headers.accept || req.headers.accept.trim() === "*/*") {
			req.headers.accept = "application/json, text/event-stream";
		}
		try {
			if (req.method === "POST") {
				let parsedBody: unknown;
				try {
					parsedBody = JSON.parse(await readBody(req));
				} catch (error) {
					if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
						json(res, 413, { error: "request body exceeds 2 MiB" });
					} else {
						json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
					}
					return;
				}
				if (oauthVerifier && authContext && oauthMetadataUrl) {
					try {
						for (const scope of requiredOAuthScopes(parsedBody)) oauthVerifier.assertScope(authContext, scope);
					} catch (error) {
						const authError = error instanceof BridgeAuthError
							? error
							: new BridgeAuthError(403, "insufficient_scope", "OAuth scope rejected");
						json(res, authError.status, { error: authError.oauthError }, {
							"www-authenticate": oauthChallenge(oauthMetadataUrl, authError),
						});
						return;
					}
				}
				const webRequest = await toWebRequest(req, parsedBody);
				if (await isLegacyRequest(webRequest, parsedBody)) {
					await handleLegacyJsonRequest(webRequest, res, parsedBody, gateway, root, patcher, ide, commands, tasks, sessions, log, sdkAuthInfo);
				} else {
					await nodeMcpHandler(req, res, parsedBody);
				}
			} else {
				if (oauthVerifier && authContext && oauthMetadataUrl) {
					try {
						oauthVerifier.assertScope(authContext, "bridge.read");
					} catch (error) {
						const authError = error instanceof BridgeAuthError
							? error
							: new BridgeAuthError(403, "insufficient_scope", "OAuth scope rejected");
						json(res, authError.status, { error: authError.oauthError }, {
							"www-authenticate": oauthChallenge(oauthMetadataUrl, authError),
						});
						return;
					}
				}
				const webRequest = await toWebRequest(req);
				if (await isLegacyRequest(webRequest)) {
					await handleLegacyJsonRequest(webRequest, res, undefined, gateway, root, patcher, ide, commands, tasks, sessions, log, sdkAuthInfo);
				} else {
					await nodeMcpHandler(req, res);
				}
			}
		} catch (error) {
			log({ type: "bridge.http_error", message: error instanceof Error ? error.message : String(error) });
			if (!res.headersSent) json(res, 500, { error: "internal bridge error" });
			else res.end();
		}
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.listen(options.port ?? 0, host, () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("listen failed"));
				return;
			}
			resolve(addr.port);
		});
		server.on("error", reject);
	});

	const origin = `http://${host}:${port}`;
	const localUrl = `${origin}/mcp/${secret}`;
	log({ type: "bridge.status", state: "listening", authMode, allowWrite, permissionMode: sessions.permissionMode });

	const configureOAuthResource = (resource: string): void => {
		if (authMode !== "oauth" || !options.oauth) return;
		oauthResource = resource;
		oauthMetadataUrl = protectedResourceMetadataUrl(oauthResource);
		oauthVerifier = new BridgeTokenVerifier({ ...options.oauth, resource: oauthResource });
		oauthReady = true;
		log({
			type: "bridge.oauth",
			state: "ready",
			resource: oauthResource,
			protectedResourceMetadataUrl: oauthMetadataUrl,
		});
	};

	const tunnel = new BridgeTunnelManager(tunnelOptions, log, options.tunnelDependencies);
	const tunnelFetch = createTunnelFetch(tunnelOptions.proxyUrl);
	tunnel.markLocalReady(localUrl);
	let publicUrl: string | undefined;
	if (authMode === "oauth" && options.oauth && (tunnelOptions.kind === "none" || !options.oauth.resource)) {
		configureOAuthResource(options.oauth.resource ?? localUrl);
	}
	let publicTunnelPromise: Promise<BridgeTunnelStatus> | undefined;
	const connectPublicTunnel = (): Promise<BridgeTunnelStatus> => {
		if (tunnelOptions.kind === "none") return Promise.resolve(tunnel.status);
		if (publicTunnelPromise) return publicTunnelPromise;
		publicTunnelPromise = (async () => {
			try {
				const status = await tunnel.start({
					localOrigin: origin,
					onPublicOrigin(publicOrigin) {
						const candidate = `${publicOrigin}/mcp/${secret}`;
						publicUrl = candidate;
						if (authMode === "oauth") {
							const resource = options.oauth?.resource ?? candidate;
							const resourceUrl = new URL(resource);
							if (resourceUrl.origin !== publicOrigin || resourceUrl.pathname.replace(/\/$/, "") !== `/mcp/${secret}`) {
								throw new Error("OAuth resource must use the active tunnel HTTPS origin and current Bridge MCP path");
							}
							configureOAuthResource(resource);
						}
					},
					async healthCheck(publicOrigin, signal) {
						if (authMode === "oauth") {
							if (!oauthResource || !oauthMetadataUrl || !oauthVerifier) throw new Error("published Bridge OAuth metadata is not ready");
							await verifyPublishedBridgeHealth(tunnelFetch.fetch, publicOrigin, oauthResource, oauthMetadataUrl, signal);
							return;
						}
						await verifyPublishedCapabilityBridgeHealth(tunnelFetch.fetch, publicOrigin, `${publicOrigin}/mcp/${secret}`, secret, signal);
					},
				});
				if (status.state !== "public_ready" || !status.publicOrigin || !publicUrl) {
					throw new Error("tunnel provider returned without reaching public_ready");
				}
				log({ type: "bridge.status", state: "public_ready", authMode, provider: tunnelOptions.kind });
				return status;
			} catch (error) {
				publicUrl = undefined;
				if (authMode === "oauth" && options.oauth && !options.oauth.resource) configureOAuthResource(localUrl);
				log({ type: "bridge.status", state: "tunnel-failed", provider: tunnelOptions.kind, message: error instanceof Error ? error.message : String(error) });
				return tunnel.status;
			} finally {
				publicTunnelPromise = undefined;
			}
		})();
		return publicTunnelPromise;
	};

	let closePromise: Promise<void> | undefined;
	return {
		port,
		secret,
		localUrl,
		get publicUrl() {
			const status = tunnel.status;
			return status.state === "public_ready" && status.publicOrigin
				? `${status.publicOrigin}/mcp/${secret}`
				: undefined;
		},
		allowWrite,
		get permissionMode() {
			return sessions.permissionMode;
		},
		get accessScope() {
			return sessions.accessScope;
		},
		authMode,
		browserOriginMode: browserOriginPolicy.mode,
		oauthResource,
		protectedResourceMetadataUrl: oauthMetadataUrl,
		get tunnelStatus() {
			return tunnel.status;
		},
		setPermissionMode(nextMode) {
			sessions.setPermissionMode(nextMode);
			log({ type: "bridge.permission_mode", mode: nextMode });
		},
		setAccessScope(scope) {
			sessions.setAccessScope(scope);
			log({ type: "bridge.access_scope_changed", accessScope: scope });
		},
		revokeDevice(deviceId, reason = "device authorization revoked") {
			const count = sessions.revokeDevice(deviceId, reason);
			log({ type: "bridge.device_revoked", deviceId, count, reason });
			return count;
		},
		revokeSubject(subject, reason = "principal authorization revoked") {
			const count = sessions.revokeSubject(subject, reason);
			log({ type: "bridge.subject_revoked", subject, count, reason });
			return count;
		},
		revokeAll(reason = "Bridge authorization revoked") {
			const count = sessions.revokeAll(reason);
			log({ type: "bridge.sessions_revoked", count, reason });
			return count;
		},
		setDirtyPaths(paths) {
			dirtyPathKeys.clear();
			for (const path of paths) {
				if (typeof path !== "string" || !path || path.length > 4096) continue;
				dirtyPathKeys.add(dirtyKey(path));
			}
			log({ type: "bridge.dirty_paths", count: dirtyPathKeys.size });
		},
		getCommandOutput(commandId, offset = 0, maxBytes = 32 * 1024) {
			return commands.getOutput(commandId, offset, maxBytes);
		},
		connectPublicTunnel,
		async checkTunnelHealth() {
			return await tunnel.health(async (publicOrigin, signal) => {
				if (authMode === "oauth") {
					if (!oauthResource || !oauthMetadataUrl || !oauthVerifier) throw new Error("published Bridge OAuth metadata is not ready");
					await verifyPublishedBridgeHealth(tunnelFetch.fetch, publicOrigin, oauthResource, oauthMetadataUrl, signal);
					return;
				}
				await verifyPublishedCapabilityBridgeHealth(tunnelFetch.fetch, publicOrigin, `${publicOrigin}/mcp/${secret}`, secret, signal);
			});
		},
		close() {
			if (closePromise) return closePromise;
			closePromise = (async () => {
				sessions.setPermissionMode("read_only");
				sessions.revokeAll("Bridge stopped");
				const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
				server.closeIdleConnections?.();
				const drained = await sessions.waitForCriticalSections();
				if (!drained) log({ type: "bridge.critical_drain_timeout" });
				const commandDrained = await commands.close("Bridge stopped");
				if (!commandDrained) log({ type: "bridge.command_drain_timeout" });
				gateway.close("Bridge stopped");
				await tunnel.stop();
				await tunnelFetch.close();
				await mcpHandler.close();
				await serverClosed;
			})();
			return closePromise;
		},
	};
}

export async function serveBridgeFromArgv(argv: string[]): Promise<void> {
	const arg = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const workspace = arg("--workspace") ?? process.cwd();
	const port = Number(arg("--port") ?? "48271");
	const tunnelProviderArg = argv.includes("--no-tunnel") ? "none" : (arg("--tunnel-provider") ?? "cloudflare-quick");
	if (tunnelProviderArg !== "none" && tunnelProviderArg !== "cloudflare-quick" && tunnelProviderArg !== "cloudflare-named" && tunnelProviderArg !== "ngrok") {
		throw new Error(`invalid Bridge tunnel provider: ${tunnelProviderArg}`);
	}
	const tunnelStartupTimeoutMs = Number(arg("--tunnel-startup-timeout-ms") ?? "10000");
	const tunnelMaxAttempts = Number(arg("--tunnel-max-attempts") ?? "1");
	const tunnel: BridgeTunnelOptions = {
		kind: tunnelProviderArg,
		executable: arg("--tunnel-executable"),
		publicUrl: arg("--tunnel-public-url"),
		proxyUrl: arg("--tunnel-proxy-url"),
		startupTimeoutMs: Number.isFinite(tunnelStartupTimeoutMs) ? tunnelStartupTimeoutMs : undefined,
		maxAttempts: Number.isFinite(tunnelMaxAttempts) ? tunnelMaxAttempts : undefined,
		token: tunnelProviderArg === "cloudflare-named"
			? process.env.MOONCODE_CLOUDFLARE_TUNNEL_TOKEN
			: tunnelProviderArg === "ngrok"
				? process.env.MOONCODE_NGROK_AUTHTOKEN
				: undefined,
	};
	const modeArg = arg("--mode") ?? process.env.MOONCODE_ENV ?? "local";
	if (modeArg !== "local" && modeArg !== "development" && modeArg !== "production") {
		throw new Error(`invalid Bridge mode: ${modeArg}`);
	}
	const authModeArg = arg("--auth-mode") ?? "capability_url";
	if (authModeArg !== "capability_url" && authModeArg !== "oauth") {
		throw new Error(`invalid Bridge auth mode: ${authModeArg}`);
	}
	const accessScopeArg = arg("--access-scope") ?? "workspace";
	if (accessScopeArg !== "workspace" && accessScopeArg !== "computer") {
		throw new Error(`invalid Bridge access scope: ${accessScopeArg}`);
	}
	const browserOriginModeArg = arg("--browser-origin-mode") ?? "universal_https";
	if (browserOriginModeArg !== "known" && browserOriginModeArg !== "custom" && browserOriginModeArg !== "universal_https") {
		throw new Error(`invalid browser Origin mode: ${browserOriginModeArg}`);
	}
	let browserOrigins: string[] = [];
	const browserOriginsJson = arg("--browser-origins-json");
	if (browserOriginsJson) {
		const parsed = JSON.parse(browserOriginsJson) as unknown;
		if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error("--browser-origins-json must be a JSON string array");
		browserOrigins = parsed as string[];
	}
	const oauthIssuer = arg("--oauth-issuer");
	const oauthJwksUri = arg("--oauth-jwks-uri");
	const oauthResourceId = arg("--oauth-resource-id");
	const oauthGeneration = Number(arg("--oauth-endpoint-generation") ?? "NaN");
	const oauth = oauthIssuer && oauthJwksUri && oauthResourceId && Number.isSafeInteger(oauthGeneration)
		? {
			issuer: oauthIssuer,
			jwksUri: oauthJwksUri,
			resource: arg("--oauth-resource"),
			resourceId: oauthResourceId,
			endpointGeneration: oauthGeneration,
		}
		: undefined;
	const ideBroker = new BridgeIdeBroker((event) => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	});
	const handle = await startBridgeServer({
		workspaceRoot: workspace,
		accessScope: accessScopeArg,
		port: Number.isFinite(port) ? port : 48271,
		secret: arg("--secret"),
		allowWrite: argv.includes("--allow-write"),
		tunnel,
		mode: modeArg,
		authMode: authModeArg,
		oauth,
		browserOriginPolicy: { mode: browserOriginModeArg, origins: browserOrigins },
		ide: ideBroker,
	});
	process.stdout.write(`${JSON.stringify({
		type: "bridge.ready",
		localUrl: handle.localUrl,
		publicUrl: handle.publicUrl ?? null,
		port: handle.port,
		allowWrite: handle.allowWrite,
		permissionMode: handle.permissionMode,
		accessScope: handle.accessScope,
		authMode: handle.authMode,
		browserOriginMode: handle.browserOriginMode,
		oauthResource: handle.oauthResource ?? null,
		protectedResourceMetadataUrl: handle.protectedResourceMetadataUrl ?? null,
		tunnelStatus: handle.tunnelStatus,
	})}\n`);
	if (tunnelProviderArg !== "none") {
		void handle.connectPublicTunnel().then(
			status => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_connect_result", status })}\n`),
			error => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_connect_result", status: handle.tunnelStatus, error: error instanceof Error ? error.message : String(error) })}\n`),
		);
	}

	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	let stopPromise: Promise<void> | undefined;
	const stop = (reason: string): Promise<void> => {
		if (!stopPromise) {
			stopPromise = (async () => {
				ideBroker.close(reason);
				handle.revokeAll(reason);
				await handle.close();
				process.stdout.write(`${JSON.stringify({ type: "bridge.stopped", reason })}\n`);
				input.close();
			})();
		}
		return stopPromise;
	};

	input.on("line", (line) => {
		if (!line.trim()) return;
		let message: {
			type?: unknown;
			mode?: unknown;
			accessScope?: unknown;
			reason?: unknown;
			deviceId?: unknown;
			subject?: unknown;
			paths?: unknown;
			commandId?: unknown;
			offset?: unknown;
			maxBytes?: unknown;
			requestId?: unknown;
			ok?: unknown;
			result?: unknown;
			error?: unknown;
		};
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_JSON" })}\n`);
			return;
		}
		if (message.type === "bridge.ide_response") {
			if (typeof message.requestId !== "string" || typeof message.ok !== "boolean") {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_IDE_RESPONSE" })}\n`);
				return;
			}
			ideBroker.handleResponse({
				type: "bridge.ide_response",
				requestId: message.requestId,
				ok: message.ok,
				result: message.result,
				error: message.error && typeof message.error === "object"
					? message.error as BridgeIdeResponseMessage["error"]
					: undefined,
			});
			return;
		}
		if (message.type === "bridge.setMode") {
			if (message.mode !== "read_only" && message.mode !== "auto") {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_MODE" })}\n`);
				return;
			}
			handle.setPermissionMode(message.mode);
			process.stdout.write(`${JSON.stringify({ type: "bridge.mode_changed", mode: handle.permissionMode })}\n`);
			return;
		}
		if (message.type === "bridge.setAccessScope") {
			if (message.accessScope !== "workspace" && message.accessScope !== "computer") {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_ACCESS_SCOPE" })}\n`);
				return;
			}
			handle.setAccessScope(message.accessScope);
			return;
		}
		if (message.type === "bridge.setDirtyPaths") {
			if (!Array.isArray(message.paths) || message.paths.length > 5_000 || message.paths.some((path) => typeof path !== "string" || !path || path.length > 4096)) {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_DIRTY_PATHS" })}\n`);
				return;
			}
			handle.setDirtyPaths(message.paths as string[]);
			process.stdout.write(`${JSON.stringify({ type: "bridge.dirty_paths_synced", count: message.paths.length })}\n`);
			return;
		}
		if (message.type === "bridge.getCommandOutput") {
			const requestId = typeof message.requestId === "string" ? message.requestId : "";
			const commandId = typeof message.commandId === "string" ? message.commandId : "";
			const offset = message.offset === undefined ? 0 : Number(message.offset);
			const maxBytes = message.maxBytes === undefined ? 32 * 1024 : Number(message.maxBytes);
			if (!requestId || requestId.length > 160 || !commandId || commandId.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) {
				process.stdout.write(`${JSON.stringify({ type: "bridge.command_output_response", requestId, ok: false, error: { code: "INVALID_ARGUMENT", message: "invalid command output request" } })}\n`);
				return;
			}
			try {
				const output = JSON.parse(commandOutputText(handle.getCommandOutput(commandId, offset, maxBytes))) as Record<string, unknown>;
				process.stdout.write(`${JSON.stringify({ type: "bridge.command_output_response", requestId, ok: true, output })}\n`);
			} catch (error) {
				const rawCode = (error as { code?: unknown })?.code;
				process.stdout.write(`${JSON.stringify({ type: "bridge.command_output_response", requestId, ok: false, error: { code: typeof rawCode === "string" ? rawCode : "NOT_FOUND", message: error instanceof Error ? error.message.slice(0, 500) : "command output unavailable" } })}\n`);
			}
			return;
		}
		if (message.type === "bridge.checkTunnel") {
			void handle.checkTunnelHealth().then(
				status => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_health", status })}\n`),
				error => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_health", status: handle.tunnelStatus, error: error instanceof Error ? error.message : String(error) })}\n`),
			);
			return;
		}
		if (message.type === "bridge.retryPublicTunnel") {
			void handle.connectPublicTunnel().then(
				status => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_retry_result", status })}\n`),
				error => process.stdout.write(`${JSON.stringify({ type: "bridge.tunnel_retry_result", status: handle.tunnelStatus, error: error instanceof Error ? error.message : String(error) })}\n`),
			);
			return;
		}
		if (message.type === "bridge.revokeAll") {
			const reason = typeof message.reason === "string" && message.reason ? message.reason : "local authorization revoked";
			const count = handle.revokeAll(reason);
			process.stdout.write(`${JSON.stringify({ type: "bridge.revoked", count, reason })}\n`);
			return;
		}
		if (message.type === "bridge.revokeDevice") {
			if (typeof message.deviceId !== "string" || !message.deviceId) {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_DEVICE" })}\n`);
				return;
			}
			const reason = typeof message.reason === "string" && message.reason ? message.reason : "device authorization revoked";
			const count = handle.revokeDevice(message.deviceId, reason);
			process.stdout.write(`${JSON.stringify({ type: "bridge.device_revoked", deviceId: message.deviceId, count, reason })}\n`);
			return;
		}
		if (message.type === "bridge.revokeSubject") {
			if (typeof message.subject !== "string" || !message.subject) {
				process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "INVALID_SUBJECT" })}\n`);
				return;
			}
			const reason = typeof message.reason === "string" && message.reason ? message.reason : "principal authorization revoked";
			const count = handle.revokeSubject(message.subject, reason);
			process.stdout.write(`${JSON.stringify({ type: "bridge.subject_revoked", subject: message.subject, count, reason })}\n`);
			return;
		}
		if (message.type === "bridge.stop") {
			const reason = typeof message.reason === "string" && message.reason ? message.reason : "local Bridge stop";
			void stop(reason).then(() => process.exit(0));
			return;
		}
		process.stdout.write(`${JSON.stringify({ type: "bridge.control_error", code: "UNKNOWN_CONTROL_MESSAGE" })}\n`);
	});

	process.on("SIGINT", () => { void stop("SIGINT").then(() => process.exit(0)); });
	process.on("SIGTERM", () => { void stop("SIGTERM").then(() => process.exit(0)); });
}
