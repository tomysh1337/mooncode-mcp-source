import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { AgentViewProvider } from './agentViewProvider';
import {
	BridgeViewProvider,
	type BridgeAccountUiState,
	type BridgeBrowserShortcut,
	type BridgeLegacyCardState,
	type BridgeOAuthUiSettings,
	type BridgeTaskUiState,
	type BridgeTunnelDependencyUiState,
	type BridgeTunnelUiSettings,
	type BridgeViewMessage,
} from './bridgeViewProvider';
import {
	BridgeClient,
	BridgeControlError,
	type BridgeAccessScope,
	type BridgeOAuthLaunchSettings,
	type BridgeBrowserOriginMode,
	type BridgePermissionMode,
	type BridgeTunnelLaunchSettings,
	type BridgeTunnelProvider,
	type BridgeTunnelStatus,
} from './bridgeClient';
import { handleBridgeIdeRequest } from './ideAdapter';
import { resolveRuntime } from './resolveRuntime';
import { RuntimeClient } from './runtimeClient';
import { BridgeUiStateStore, type PaymentState } from './bridgeUiState';
import { BridgeReviewProvider } from './bridgeReviewProvider';
import { deriveAccountScopedDeviceId, loadMoonCodeDeviceIdentity, type MoonCodeDeviceIdentity } from './deviceIdentity';
import { resolveCloudDeviceAuthorizationAction, resolveCloudDeviceRecoverySelection } from './cloudDeviceRecovery';
import { evaluateBridgeCommercialGate } from './bridgeCommercialGate';
import { CloudAuthorizationLeaseRequestError, requestCloudAuthorizationLease } from './cloudAuthorizationLease';
import { describeCloudFailure, fetchCloudWithPolicy } from './cloudNetwork';
import { formatCloudDurationSeconds } from './cloudDuration';
import { normalizeExternalSalesUrl } from './externalSales';
import { MoonCodeAgentActivityTerminal } from './agentActivityTerminal';
import { resolveAutomaticTunnelProxyWithSource } from './tunnelProxy';
import { parseMoonCodePackagedProductConfig } from './productConfig';
import {
	classifyWindowsInstallerExitCode,
	cloudflaredCommonWindowsCandidates,
	isNormalCloudflaredVersionOutput,
	selectOfficialCloudflaredWindowsMsi,
} from './cloudflaredEnvironment';

const BRIDGE_TASK_STATE_KEY = 'mooncode.bridge.taskState.v1';
const BRIDGE_SHORTCUTS_KEY = 'mooncode.bridge.browserShortcuts.v1';
const BRIDGE_REVIEWED_PATCHES_KEY = 'mooncode.bridge.reviewedPatches.v1';
const BRIDGE_SELECTED_WORKSPACE_KEY = 'mooncode.bridge.selectedWorkspace.v1';
const BRIDGE_PRODUCT_TUNNEL_DEFAULTS_MIGRATION_KEY = 'mooncode.bridge.productTunnelDefaults.v1';
const BRIDGE_NETWORK_COMPAT_DEFAULTS_MIGRATION_KEY = 'mooncode.bridge.networkCompatDefaults.v1';
const BRIDGE_UI_DIFF_LIMIT = 120_000;
const CLOUDFLARE_TUNNEL_TOKEN_SECRET = 'mooncode.bridge.tunnel.cloudflareToken';
const NGROK_AUTHTOKEN_SECRET = 'mooncode.bridge.tunnel.ngrokAuthtoken';
const MOONCODE_ACCOUNT_SESSION_SECRET = 'mooncode.cloud.accountSession';
const CLOUDFLARE_INSTALL_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
const CLOUDFLARE_UPDATE_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/';
const CLOUDFLARE_RELEASES_URL = 'https://github.com/cloudflare/cloudflared/releases';
const CLOUDFLARE_RELEASE_API_URL = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const NGROK_INSTALL_URL = 'https://ngrok.com/download/windows';
const CHATGPT_URL = 'https://chatgpt.com/';
const OPENAI_MCP_GUIDE_URL = 'https://developers.openai.com/api/docs/guides/developer-mode';
const BUILTIN_BROWSER_SHORTCUTS: BridgeBrowserShortcut[] = [
	{
		id: 'chatgpt',
		label: 'ChatGPT',
		url: CHATGPT_URL,
		openMode: 'integrated',
		compatibility: 'target-pending',
		note: 'MoonCode 首个目标客户端；完整 MCP/OAuth 闭环在 BRIDGE-011 用真实账户验收。',
		builtin: true,
	},
	{
		id: 'openai-mcp-guide',
		label: 'OpenAI MCP / Developer Mode 文档',
		url: OPENAI_MCP_GUIDE_URL,
		openMode: 'external',
		compatibility: 'reference',
		note: '公开参考资料；站点页面本身不是 MoonCode 连接状态。',
		builtin: true,
	},
];

function normalizeTunnelProvider(value: unknown): BridgeTunnelProvider {
	return value === 'cloudflare-quick' || value === 'cloudflare-named' || value === 'ngrok' ? value : 'none';
}

function normalizeBrowserOriginMode(value: unknown): BridgeBrowserOriginMode {
	return value === 'known' || value === 'custom' ? value : 'universal_https';
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
}

function readBridgeOAuthSettings(): BridgeOAuthLaunchSettings | undefined {
	const config = vscode.workspace.getConfiguration('mooncode.bridge.oauth');
	const issuer = config.get<string>('issuer', '').trim();
	const jwksUri = config.get<string>('jwksUri', '').trim();
	const resourceId = config.get<string>('resourceId', '').trim();
	const endpointGeneration = boundedInteger(config.get<number>('endpointGeneration', 1), 1, 1, Number.MAX_SAFE_INTEGER);
	const resource = config.get<string>('resource', '').trim();
	if (!issuer || !jwksUri || !resourceId) return undefined;
	return { issuer, jwksUri, resourceId, endpointGeneration, resource: resource || undefined };
}

function readBridgeOAuthUiSettings(): BridgeOAuthUiSettings {
	const config = vscode.workspace.getConfiguration('mooncode.bridge.oauth');
	const issuer = config.get<string>('issuer', '').trim();
	const jwksUri = config.get<string>('jwksUri', '').trim();
	const resourceId = config.get<string>('resourceId', '').trim();
	const endpointGeneration = boundedInteger(config.get<number>('endpointGeneration', 1), 1, 1, Number.MAX_SAFE_INTEGER);
	const resource = config.get<string>('resource', '').trim();
	return {
		issuer,
		jwksUri,
		resourceId,
		endpointGeneration,
		resource,
		configured: Boolean(issuer && jwksUri && resourceId),
		accountStatus: '状态见上方 MoonCode 账号区；Bridge OAuth Resource 配置与账号登录相互独立。',
	};
}

function normalizeCloudApiUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error('Cloud API 必须是有效 URL。');
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
		throw new Error('Cloud API 必须填写 origin，不允许凭据、路径、查询参数或 fragment。');
	}
	const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
		throw new Error('Cloud API 必须使用 HTTPS；仅 localhost/127.0.0.1 开发环境允许 HTTP。');
	}
	return parsed.origin;
}

function readPackagedCloudApiConfig(): { apiUrl: string; error?: string } {
	try {
		const productPath = join(vscode.env.appRoot, 'product.json');
		const product = parseMoonCodePackagedProductConfig(readFileSync(productPath, 'utf8'));
		return { apiUrl: normalizeCloudApiUrl(product.mooncodeCloudApiUrl) };
	} catch (error) {
		const detail = redactText(error instanceof Error ? error.message : String(error), 220);
		return { apiUrl: '', error: `MoonCode Cloud 初始化异常 · ${detail}` };
	}
}

function parseHttpUrl(value: string, label: string, allowEmpty = false): string {
	const trimmed = value.trim();
	if (allowEmpty && !trimmed) return '';
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${label} 必须是有效的 HTTP/HTTPS URL`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`${label} 只允许 HTTP/HTTPS URL`);
	}
	return parsed.toString();
}

function redactText(value: string, limit = 500): string {
	return value
		.slice(0, limit)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
		.replace(/\b(token|secret|authorization|cookie|authtoken)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
		.replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){1,2}\b/g, '[REDACTED-JWT]');
}

function sanitizeBridgeArgs(tool: string, args: unknown): Record<string, unknown> | undefined {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
	const source = args as Record<string, unknown>;
	if (tool === 'apply_patch' || tool === 'write_file') {
		return { payload: '[PATCH CONTENT OMITTED]' };
	}
	if (tool === 'send_command_input') {
		return {
			command_id: typeof source.command_id === 'string' ? source.command_id.slice(0, 100) : undefined,
			input: '[INPUT OMITTED]',
			append_newline: typeof source.append_newline === 'boolean' ? source.append_newline : undefined,
		};
	}
	const safe: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source).slice(0, 20)) {
		if (/token|secret|authorization|cookie|credential|content|patch|input/i.test(key)) {
			safe[key] = '[REDACTED]';
			continue;
		}
		if (typeof value === 'string') safe[key] = redactText(value, key === 'command' ? 300 : 220);
		else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
		else if (Array.isArray(value)) safe[key] = `[${Math.min(value.length, 999)} item(s)]`;
		else if (typeof value === 'object') safe[key] = '[OBJECT]';
	}
	return safe;
}

function sanitizeBridgeEventForUi(event: Record<string, unknown>): Record<string, unknown> {
	const type = typeof event.type === 'string' ? event.type : 'bridge.event';
	if (type === 'bridge.call') {
		const tool = typeof event.tool === 'string' ? event.tool : 'unknown';
		return {
			type,
			callId: typeof event.callId === 'string' ? event.callId.slice(0, 160) : undefined,
			tool,
			args: sanitizeBridgeArgs(tool, event.args),
			startedAt: typeof event.startedAt === 'string' ? event.startedAt.slice(0, 80) : undefined,
			todoId: typeof event.todoId === 'string' ? event.todoId.slice(0, 80) : undefined,
		};
	}
	if (type === 'bridge.result') {
		return {
			type,
			callId: typeof event.callId === 'string' ? event.callId.slice(0, 160) : undefined,
			tool: typeof event.tool === 'string' ? event.tool : 'unknown',
			ok: event.ok === true,
			startedAt: typeof event.startedAt === 'string' ? event.startedAt.slice(0, 80) : undefined,
			endedAt: typeof event.endedAt === 'string' ? event.endedAt.slice(0, 80) : undefined,
			durationMs: Number.isSafeInteger(event.durationMs) ? event.durationMs : undefined,
			resultSummary: typeof event.resultSummary === 'string' ? redactText(event.resultSummary, 500) : undefined,
			errorCode: typeof event.errorCode === 'string' ? event.errorCode.slice(0, 160) : undefined,
			transactionId: typeof event.transactionId === 'string' ? event.transactionId.slice(0, 200) : undefined,
			commandId: typeof event.commandId === 'string' ? event.commandId.slice(0, 200) : undefined,
			commandStatus: typeof event.commandStatus === 'string' ? event.commandStatus.slice(0, 80) : undefined,
			commandSummary: typeof event.commandSummary === 'string' ? redactText(event.commandSummary, 500) : undefined,
			cwd: typeof event.cwd === 'string' ? redactText(event.cwd, 4_096) : undefined,
			exitCode: event.exitCode === null || Number.isSafeInteger(event.exitCode) ? event.exitCode : undefined,
			earliestOffset: Number.isSafeInteger(event.earliestOffset) ? event.earliestOffset : undefined,
			nextOffset: Number.isSafeInteger(event.nextOffset) ? event.nextOffset : undefined,
			outputLost: event.outputLost === true,
		};
	}
	const safe: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event).slice(0, 40)) {
		if (/token|secret|authorization|cookie|credential|preview|sessionid/i.test(key)) {
			safe[key] = '[REDACTED]';
			continue;
		}
		if (key === 'diff' && type === 'bridge.patch_result') {
			safe[key] = typeof value === 'string' ? value.slice(0, BRIDGE_UI_DIFF_LIMIT) : '';
			continue;
		}
		if (typeof value === 'string') safe[key] = redactText(value, 2_000);
		else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
		else if (Array.isArray(value)) safe[key] = value.slice(0, 50);
		else if (value && typeof value === 'object') {
			const nested: Record<string, unknown> = {};
			for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
				if (/token|secret|authorization|cookie|credential|preview|sessionid/i.test(nestedKey)) nested[nestedKey] = '[REDACTED]';
				else if (typeof nestedValue === 'string') nested[nestedKey] = redactText(nestedValue, 1_000);
				else if (typeof nestedValue === 'number' || typeof nestedValue === 'boolean' || nestedValue === null) nested[nestedKey] = nestedValue;
			}
			safe[key] = nested;
		}
	}
	if (type === 'bridge.patch_result' && typeof event.diff === 'string' && event.diff.length > BRIDGE_UI_DIFF_LIMIT) safe.diffTruncated = true;
	return safe;
}

function normalizeStoredShortcut(raw: unknown): BridgeBrowserShortcut | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const candidate = raw as Partial<BridgeBrowserShortcut>;
	if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 100) return undefined;
	if (typeof candidate.label !== 'string' || !candidate.label.trim() || candidate.label.length > 60) return undefined;
	if (typeof candidate.url !== 'string' || candidate.url.length > 2048) return undefined;
	let url: string;
	try { url = parseHttpUrl(candidate.url, '快捷入口'); } catch { return undefined; }
	return {
		id: candidate.id,
		label: candidate.label.trim(),
		url,
		openMode: candidate.openMode === 'external' ? 'external' : 'integrated',
		compatibility: 'custom',
		note: '用户自定义；MoonCode 不声明该站点支持 MCP/OAuth。',
		builtin: false,
	};
}

function legacyPromptFor(url: string, allowWrite: boolean): string {
	return [
		'Connect to my local MoonCode workspace over MCP.',
		'MCP Streamable HTTP URL: ' + url,
		'Tools: list_directory, read_file, write_file. Paths are relative to the opened folder.',
		allowWrite
			? 'Writes are enabled. Only write files I name.'
			: 'Start with list_directory then read_file. Do not write_file unless I ask.',
	].join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
	const agentProvider = new AgentViewProvider();
	const bridgeProvider = new BridgeViewProvider(context.extensionUri);
	const bridgeReviewProvider = new BridgeReviewProvider(context.extensionUri);
	const agentActivityTerminal = new MoonCodeAgentActivityTerminal();
	context.subscriptions.push(agentActivityTerminal);
	bridgeProvider.onPost = payload => bridgeReviewProvider.post(payload);
	const bridgeUiState = new BridgeUiStateStore();
	bridgeUiState.restoreReviewedPatches(context.workspaceState.get(BRIDGE_REVIEWED_PATCHES_KEY));
	const publishBridgeUiSnapshot = (): void => bridgeProvider.setUiSnapshot(bridgeUiState.snapshot());
	const initialFolder = vscode.workspace.workspaceFolders?.[0];
	const storedWorkspace = context.globalState.get<{ name?: unknown; path?: unknown }>(BRIDGE_SELECTED_WORKSPACE_KEY);
	let selectedBridgeWorkspace: { name: string; path: string } | undefined = storedWorkspace && typeof storedWorkspace.name === 'string' && typeof storedWorkspace.path === 'string' && storedWorkspace.path
		? { name: storedWorkspace.name || basename(storedWorkspace.path), path: storedWorkspace.path }
		: initialFolder ? { name: initialFolder.name, path: initialFolder.uri.fsPath } : undefined;
	const syncBridgeUiWorkspace = (): void => {
		bridgeUiState.setWorkspace(selectedBridgeWorkspace?.name ?? '', selectedBridgeWorkspace?.path ?? '');
		publishBridgeUiSnapshot();
	};
	const selectBridgeWorkspace = async (): Promise<void> => {
		const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: selectedBridgeWorkspace ? '更换工作区' : '选择工作区' });
		if (!picked?.[0]) return;
		const canonical = await realpath(picked[0].fsPath);
		const info = await stat(canonical);
		if (!info.isDirectory()) throw new Error('所选工作区不是有效目录。');
		selectedBridgeWorkspace = { name: basename(canonical), path: canonical };
		await context.globalState.update(BRIDGE_SELECTED_WORKSPACE_KEY, selectedBridgeWorkspace);
		syncBridgeUiWorkspace();
	};
	let bridgeTaskState = context.workspaceState.get<BridgeTaskUiState>(BRIDGE_TASK_STATE_KEY) ?? {
		version: 0,
		todos: [],
		updated_at: '',
		progress: [],
	};
	bridgeProvider.setTaskState(bridgeTaskState);
	bridgeUiState.setTaskState(bridgeTaskState);
	syncBridgeUiWorkspace();
	let runtimeClient: RuntimeClient | undefined;
	let bridgeClient: BridgeClient | undefined;
	let currentRequestId: string | undefined;
	let bridgeReady: { localUrl: string; publicUrl: string | null; permissionMode: BridgePermissionMode; accessScope: BridgeAccessScope; tunnelStatus: BridgeTunnelStatus } | undefined;
	let activeBridgeUiRunId: string | undefined;
	let activeBridgeWorkspaceRoot: string | undefined;
	const bridgeRunWorkspaceRoots = new Map<string, string>();
	let bridgeStartPending = false;
	let bridgeStartCancelled = false;
	let bridgeStopPending: Promise<void> | undefined;
	let mcpHealthStartedAt: number | undefined;
	let pendingAccessScope: { scope: BridgeAccessScope; timer: ReturnType<typeof setTimeout> } | undefined;
	const finishAccessScopeOperation = (ok: boolean, message?: string): void => {
		if (!pendingAccessScope) return;
		clearTimeout(pendingAccessScope.timer);
		pendingAccessScope = undefined;
		bridgeProvider.post({ kind: 'operationResult', operation: 'setAccessScope', ok, message });
	};
	const markBridgeUiStopped = (reason?: string): void => {
		finishAccessScopeOperation(false, reason || 'Bridge 已停止');
		mcpHealthStartedAt = undefined;
		bridgeProvider.setPublicMcpUrl(undefined);
		bridgeUiState.setStopped(activeBridgeUiRunId ?? null, reason);
		activeBridgeUiRunId = undefined;
		activeBridgeWorkspaceRoot = undefined;
		publishBridgeUiSnapshot();
		agentActivityTerminal.accept({ type: 'bridge.stopped', reason });
	};
	const stopActiveBridge = (reason: string): Promise<void> => {
		if (bridgeStartPending) bridgeStartCancelled = true;
		if (bridgeStopPending) return bridgeStopPending;
		const stoppingRunId = activeBridgeUiRunId;
		bridgeReady = undefined;
		mcpHealthStartedAt = undefined;
		bridgeProvider.setPublicMcpUrl(undefined);
		finishAccessScopeOperation(false, reason);
		if (stoppingRunId) bridgeUiState.setStopping(stoppingRunId, reason);
		publishBridgeUiSnapshot();
		bridgeProvider.post({ kind: 'event', event: { type: 'bridge.stopping', reason } });
		agentActivityTerminal.accept({ type: 'bridge.stopping', reason });
		const client = bridgeClient;
		bridgeStopPending = (async () => {
			try {
				if (client?.running) {
					client.setPermissionMode('read_only');
					client.revokeAll(reason);
					await client.stop(reason);
				}
				markBridgeUiStopped(reason);
				bridgeProvider.post({ kind: 'stopped', reason });
			} catch (error) {
				const message = redactText(error instanceof Error ? error.message : String(error), 1_000);
				if (stoppingRunId) bridgeUiState.setError(stoppingRunId, message, 'BRIDGE_STOP_FAILED');
				publishBridgeUiSnapshot();
				bridgeProvider.post({ kind: 'error', message });
				throw error;
			} finally {
				bridgeStopPending = undefined;
			}
		})();
		return bridgeStopPending;
	};
	let dirtySyncTimer: ReturnType<typeof setTimeout> | undefined;
	let accountLoginGeneration = 0;
	const packagedCloudApiConfig = readPackagedCloudApiConfig();
	const packagedCloudApiUrl = packagedCloudApiConfig.apiUrl;
	const configuredCloudApiUrl = normalizeCloudApiUrl(vscode.workspace.getConfiguration('mooncode.cloud').get<string>('apiUrl', ''));
	const initialCloudApiUrl = configuredCloudApiUrl || packagedCloudApiUrl;
	const initialCloudConfigError = initialCloudApiUrl ? undefined : packagedCloudApiConfig.error;
	let cloudAccountState: BridgeAccountUiState = {
		apiUrl: initialCloudApiUrl,
		configured: Boolean(initialCloudApiUrl),
		status: initialCloudApiUrl ? 'signed_out' : initialCloudConfigError ? 'error' : 'unconfigured',
		statusText: initialCloudApiUrl ? '正在连接 MoonCode Cloud…' : initialCloudConfigError ?? '当前构建尚未配置 MoonCode Cloud 服务入口',
		providers: [],
		identities: [],
	};
	let purchaseOperationRunning = false;
	const setPaymentUiState = (state: Omit<PaymentState, 'updatedAt'>): void => {
		bridgeUiState.setPaymentState(state);
		publishBridgeUiSnapshot();
	};

	const readTunnelUiSettings = async (): Promise<BridgeTunnelUiSettings> => {
		const config = vscode.workspace.getConfiguration('mooncode.bridge.tunnel');
		let provider = normalizeTunnelProvider(config.get<string>('provider', 'cloudflare-quick'));
		if (context.extensionMode === vscode.ExtensionMode.Production && context.globalState.get<boolean>(BRIDGE_PRODUCT_TUNNEL_DEFAULTS_MIGRATION_KEY) !== true) {
			if (provider === 'none') {
				await config.update('provider', 'cloudflare-quick', vscode.ConfigurationTarget.Global);
				provider = 'cloudflare-quick';
			}
			await context.globalState.update(BRIDGE_PRODUCT_TUNNEL_DEFAULTS_MIGRATION_KEY, true);
		}
		if (context.extensionMode === vscode.ExtensionMode.Production && context.globalState.get<boolean>(BRIDGE_NETWORK_COMPAT_DEFAULTS_MIGRATION_KEY) !== true) {
			const timeoutInspect = config.inspect<number>('startupTimeoutMs');
			const attemptsInspect = config.inspect<number>('maxAttempts');
			if (timeoutInspect?.globalValue === 10_000) await config.update('startupTimeoutMs', 20_000, vscode.ConfigurationTarget.Global);
			if (attemptsInspect?.globalValue === 1) await config.update('maxAttempts', 2, vscode.ConfigurationTarget.Global);
			await context.globalState.update(BRIDGE_NETWORK_COMPAT_DEFAULTS_MIGRATION_KEY, true);
		}
		const configuredProxyUrl = config.get<string>('proxyUrl', '').trim();
		const automaticProxy = configuredProxyUrl
			? { url: '', source: 'none' as const }
			: resolveAutomaticTunnelProxyWithSource(vscode.workspace.getConfiguration('http').get<string>('proxy', ''));
		return {
			authMode: config.get<string>('authMode', 'capability_url') === 'oauth' ? 'oauth' : 'capability_url',
			browserOriginMode: normalizeBrowserOriginMode(config.get<string>('browserOriginMode', 'universal_https')),
			browserOrigins: config.get<string[]>('browserOrigins', []).map(value => value.trim()).filter(Boolean).slice(0, 100),
			provider,
			publicUrl: config.get<string>('publicUrl', '').trim(),
			executable: config.get<string>('executable', '').trim(),
			proxyUrl: configuredProxyUrl || automaticProxy.url,
			proxySource: configuredProxyUrl ? 'manual' : automaticProxy.source,
			startupTimeoutMs: boundedInteger(config.get<number>('startupTimeoutMs', 20_000), 20_000, 1_000, 120_000),
			maxAttempts: boundedInteger(config.get<number>('maxAttempts', 2), 2, 1, 5),
			localPort: boundedInteger(config.get<number>('localPort', 48_271), 48_271, 1, 65_535),
			persistentMode: config.get<boolean>('persistentMode', false),
			quickLinks: config.get<boolean>('quickLinks', true),
			cloudflareTokenConfigured: Boolean(await context.secrets.get(CLOUDFLARE_TUNNEL_TOKEN_SECRET)),
			ngrokTokenConfigured: Boolean(await context.secrets.get(NGROK_AUTHTOKEN_SECRET)),
			oauthConfigured: Boolean(readBridgeOAuthSettings()),
		};
	};

	const refreshTunnelUiSettings = async (): Promise<BridgeTunnelUiSettings> => {
		const settings = await readTunnelUiSettings();
		bridgeProvider.setTunnelSettings(settings);
		return settings;
	};

	const refreshOAuthUiSettings = (): BridgeOAuthUiSettings => {
		const settings = readBridgeOAuthUiSettings();
		bridgeProvider.setOAuthSettings(settings);
		return settings;
	};

	const publishCloudAccountState = (state: BridgeAccountUiState): BridgeAccountUiState => {
		cloudAccountState = state;
		bridgeUiState.setCommercialState(state);
		publishBridgeUiSnapshot();
		bridgeProvider.setAccountState(state);
		return state;
	};

	const readCloudApiUrl = (): string => {
		const configured = normalizeCloudApiUrl(vscode.workspace.getConfiguration('mooncode.cloud').get<string>('apiUrl', ''));
		return configured || packagedCloudApiUrl;
	};
	const unavailableCloudState = (): Pick<BridgeAccountUiState, 'status' | 'statusText'> => packagedCloudApiConfig.error
		? { status: 'error', statusText: packagedCloudApiConfig.error }
		: { status: 'unconfigured', statusText: '当前构建尚未配置 MoonCode Cloud 服务入口' };
	const allowTunnelConfiguration = (): boolean => {
		if (cloudAccountState.status === 'signed_in' || Boolean(cloudAccountState.accountId)) return true;
		bridgeProvider.post({ kind: 'error', message: '请先使用 GitHub 登录，再配置 Cloudflare Tunnel。' });
		return false;
	};

	let deviceIdentityPromise: Promise<MoonCodeDeviceIdentity> | undefined;
	const getCloudDeviceIdentity = async (): Promise<MoonCodeDeviceIdentity> => {
		if (!deviceIdentityPromise) {
			deviceIdentityPromise = loadMoonCodeDeviceIdentity(context.secrets).catch(error => {
				deviceIdentityPromise = undefined;
				throw error;
			});
		}
		return deviceIdentityPromise;
	};
	const getCloudDeviceIdentityForAccount = async (
		accountId: string,
		accountDevices: ReadonlyArray<{ id?: unknown; revokedAt?: unknown; revoked_at?: unknown }> = [],
	): Promise<MoonCodeDeviceIdentity> => {
		const base = await getCloudDeviceIdentity();
		const { deviceId } = resolveCloudDeviceRecoverySelection(base.deviceId, accountId, accountDevices);
		return deviceId === base.deviceId ? base : { ...base, deviceId };
	};

	const responseJson = async (response: Response): Promise<Record<string, any>> => {
		try {
			const value = await response.json();
			return value && typeof value === 'object' ? value as Record<string, any> : {};
		} catch {
			return {};
		}
	};
	const cloudFetch: typeof fetch = (input, init) => fetchCloudWithPolicy(input, init ?? {});
	let pendingToolCallUsage = 0;
	let usageFlushInFlight = false;
	const recordToolCallUsage = (): void => {
		if (cloudAccountState.status !== 'signed_in' || !cloudAccountState.accountId) return;
		pendingToolCallUsage = Math.min(1_000_000, pendingToolCallUsage + 1);
	};
	const flushToolCallUsage = async (): Promise<void> => {
		if (usageFlushInFlight || pendingToolCallUsage <= 0) return;
		usageFlushInFlight = true;
		try {
			const apiUrl = readCloudApiUrl();
			const token = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
			if (!apiUrl || !token) return;
			const count = pendingToolCallUsage;
			const response = await cloudFetch(`${apiUrl}/api/v1/usage/tool-calls`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ count }),
			});
			if (response.ok) pendingToolCallUsage = Math.max(0, pendingToolCallUsage - count);
		} catch {
			// OPS-002 is best-effort operational telemetry: never block Bridge/tools on reporting.
		} finally {
			usageFlushInFlight = false;
		}
	};

	class CloudDeviceProofRejectedError extends Error {
		constructor(readonly statusCode: number, readonly cloudCode: string, message: string) {
			super(message);
			this.name = 'CloudDeviceProofRejectedError';
		}
	}

	class CloudDeviceAuthorizationRejectedError extends Error {
		constructor(readonly statusCode: number, readonly cloudCode: string, message: string) {
			super(message);
			this.name = 'CloudDeviceAuthorizationRejectedError';
		}
	}

	const deviceProofHttpError = (stage: string, response: Response, payload: Record<string, any>): Error => {
		const cloudCode = typeof payload.error === 'string' ? payload.error : '';
		const message = `${stage} (${response.status} ${cloudCode})`;
		return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
			? new CloudDeviceProofRejectedError(response.status, cloudCode, message)
			: new Error(message);
	};

	const ensureCloudDeviceProof = async (apiUrl: string, token: string, identity: MoonCodeDeviceIdentity): Promise<MoonCodeDeviceIdentity> => {
		const jsonHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
		const identityResponse = await cloudFetch(`${apiUrl}/api/v1/device-identities/register`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				device_id: identity.deviceId,
				public_key: identity.publicKey,
				key_algorithm: identity.keyAlgorithm,
				key_version: identity.keyVersion,
			}),
		});
		const identityPayload = await responseJson(identityResponse);
		if (!identityResponse.ok) throw deviceProofHttpError('设备身份登记失败', identityResponse, identityPayload);

		const challengeResponse = await cloudFetch(`${apiUrl}/api/v1/device-identities/${encodeURIComponent(identity.deviceId)}/challenge`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		});
		const challengePayload = await responseJson(challengeResponse);
		if (!challengeResponse.ok) throw deviceProofHttpError('设备证明 challenge 获取失败', challengeResponse, challengePayload);
		const challengeId = typeof challengePayload.challenge_id === 'string' ? challengePayload.challenge_id : '';
		const challenge = typeof challengePayload.challenge === 'string' ? challengePayload.challenge : '';
		if (!challengeId || !challenge) throw new Error('Cloud 返回的设备 challenge 不完整。');

		const proofResponse = await cloudFetch(`${apiUrl}/api/v1/device-identities/${encodeURIComponent(identity.deviceId)}/prove`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ challenge_id: challengeId, challenge, signature: identity.signChallenge(challengeId, challenge) }),
		});
		const proofPayload = await responseJson(proofResponse);
		if (!proofResponse.ok) throw deviceProofHttpError('设备身份验证失败', proofResponse, proofPayload);
		return identity;
	};

	const registerCloudDeviceAuthorization = async (apiUrl: string, token: string, identity: MoonCodeDeviceIdentity): Promise<Record<string, any>> => {
		const provenIdentity = await ensureCloudDeviceProof(apiUrl, token, identity);
		const response = await cloudFetch(`${apiUrl}/api/v1/devices/register`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ device_id: provenIdentity.deviceId, device_name: 'MoonCode Desktop' }),
		});
		const payload = await responseJson(response);
		if (!response.ok) {
			const cloudCode = typeof payload.error === 'string' ? payload.error : '';
			if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
				throw new CloudDeviceAuthorizationRejectedError(
					response.status,
					cloudCode,
					cloudCode === 'DEVICE_LIMIT_REACHED' ? '设备额度已满，当前设备无法授权。' : `设备授权失败 (${response.status}${cloudCode ? ` ${cloudCode}` : ''})`,
				);
			}
			throw new Error(`设备授权失败 (${response.status}${cloudCode ? ` ${cloudCode}` : ''})`);
		}
		return payload;
	};

	const refreshCloudAccountState = async (): Promise<BridgeAccountUiState> => {
		const apiUrl = readCloudApiUrl();
		if (!apiUrl) {
			return publishCloudAccountState({ apiUrl: '', configured: false, ...unavailableCloudState(), providers: [], identities: [] });
		}
		try {
			const [providerResponse, plansResponse] = await Promise.all([
				cloudFetch(`${apiUrl}/api/v1/auth/providers`),
				cloudFetch(`${apiUrl}/api/v1/purchase-plans`),
			]);
			if (!providerResponse.ok) throw new Error(`Cloud provider discovery failed (${providerResponse.status})`);
			if (plansResponse.status !== 404 && !plansResponse.ok) throw new Error(`Cloud plan discovery failed (${plansResponse.status})`);
			const providerPayload = await responseJson(providerResponse);
			const providers = Array.isArray(providerPayload.providers)
				? providerPayload.providers.map((item: any) => typeof item?.id === 'string' ? item.id : '').filter(Boolean)
				: [];
			const plansPayload = plansResponse.ok ? await responseJson(plansResponse) : {};
			const purchasePlans: NonNullable<BridgeAccountUiState['purchasePlans']> = Array.isArray(plansPayload.plans)
				? plansPayload.plans.map((item: any) => ({
					code: typeof item?.code === 'string' ? item.code : '',
					displayName: typeof item?.displayName === 'string' ? item.displayName : (typeof item?.display_name === 'string' ? item.display_name : ''),
					priceCents: Number(item?.priceCents ?? item?.price_cents),
					durationSeconds: Number(item?.defaultDurationSeconds ?? item?.duration_seconds),
					deviceLimit: Number(item?.deviceLimit ?? item?.device_limit),
					externalSalesUrl: typeof item?.externalSalesUrl === 'string' ? item.externalSalesUrl : (typeof item?.external_sales_url === 'string' ? item.external_sales_url : undefined),
				})).filter((item: { code: string; priceCents: number; durationSeconds: number; deviceLimit: number }) => Boolean(item.code) && Number.isSafeInteger(item.priceCents) && item.priceCents > 0 && Number.isSafeInteger(item.durationSeconds) && item.durationSeconds > 0 && Number.isSafeInteger(item.deviceLimit) && item.deviceLimit > 0)
				: [];
			const token = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
			if (!token) {
				return publishCloudAccountState({ apiUrl, configured: true, status: 'signed_out', statusText: providers.length ? '未登录' : 'Cloud 已连接，但未配置 GitHub/Gitee provider', providers, identities: [], purchasePlans });
			}
			const accountResponse = await cloudFetch(`${apiUrl}/api/v1/account`, {
				headers: { authorization: `Bearer ${token}` },
			});
			if (accountResponse.status === 401) {
				await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
				return publishCloudAccountState({ apiUrl, configured: true, status: 'signed_out', statusText: '登录已失效，请重新登录', providers, identities: [], purchasePlans });
			}
			if (!accountResponse.ok) throw new Error(`Cloud account lookup failed (${accountResponse.status})`);
			const payload = await responseJson(accountResponse);
			const account = payload.account && typeof payload.account === 'object' ? payload.account : {};
			const accountId = typeof account.id === 'string' ? account.id : '';
			if (!accountId) throw new Error('Cloud account lookup returned no account id.');
			const identities = Array.isArray(payload.identities) ? payload.identities.map((item: any) => ({
				id: typeof item?.id === 'string' ? item.id : '',
				provider: typeof item?.provider === 'string' ? item.provider : 'unknown',
				username: typeof item?.username === 'string' ? item.username : undefined,
				displayName: typeof item?.displayName === 'string' ? item.displayName : undefined,
			})).filter((item: { id: string }) => Boolean(item.id)) : [];
			const headers = { authorization: `Bearer ${token}` };
			const [entitlementResponse, devicesResponse] = await Promise.all([
				cloudFetch(`${apiUrl}/api/v1/entitlement`, { headers }),
				cloudFetch(`${apiUrl}/api/v1/devices`, { headers }),
			]);
			if (entitlementResponse.status !== 404 && !entitlementResponse.ok) throw new Error(`Cloud entitlement lookup failed (${entitlementResponse.status})`);
			if (!devicesResponse.ok) throw new Error(`Cloud device lookup failed (${devicesResponse.status})`);
			const entitlementPayload = entitlementResponse.ok ? await responseJson(entitlementResponse) : {};
			const devicesPayload = await responseJson(devicesResponse);
			const entitlementRecord = entitlementPayload.entitlement && typeof entitlementPayload.entitlement === 'object' ? entitlementPayload.entitlement : undefined;
			const plan = entitlementPayload.plan && typeof entitlementPayload.plan === 'object' ? entitlementPayload.plan : undefined;
			const entitlement = entitlementRecord && plan ? {
				planId: typeof plan.id === 'string' ? plan.id : '',
				planCode: typeof plan.code === 'string' ? plan.code : '',
				planName: typeof plan.displayName === 'string' ? plan.displayName : (typeof plan.code === 'string' ? plan.code : 'MoonCode'),
				expiresAt: typeof entitlementRecord.expiresAt === 'string' ? entitlementRecord.expiresAt : undefined,
				deviceLimit: Number.isSafeInteger(plan.deviceLimit) ? Number(plan.deviceLimit) : 0,
			} : undefined;
			const devices = Array.isArray(devicesPayload.devices) ? devicesPayload.devices : [];
			const recoverySelection = resolveCloudDeviceRecoverySelection((await getCloudDeviceIdentity()).deviceId, accountId, devices);
			const currentIdentity = await getCloudDeviceIdentityForAccount(accountId, devices);
			const deviceId = currentIdentity.deviceId;
			const activeDevices = devices.filter((item: any) => item && !item.revokedAt);
			let activeDeviceCount = activeDevices.length;
			const currentDevice = recoverySelection.record;
			let deviceState: BridgeAccountUiState['device'] = currentDevice ? {
				id: deviceId,
				authorized: Boolean(!currentDevice.revokedAt && entitlement),
				lastSeenAt: typeof currentDevice.lastSeenAt === 'string' ? currentDevice.lastSeenAt : undefined,
			} : { id: deviceId, authorized: false };
			let deviceProofRejected = false;
			let deviceAuthorizationNote = '';
			if (deviceState.authorized && entitlement) {
				try {
					await ensureCloudDeviceProof(apiUrl, token, currentIdentity);
				} catch (error) {
					if (!(error instanceof CloudDeviceProofRejectedError)) throw error;
					if (error.statusCode === 401 && !error.cloudCode.startsWith('DEVICE_')) {
						await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
						return publishCloudAccountState({ apiUrl, configured: true, status: 'signed_out', statusText: '登录已失效，请重新登录', providers, identities: [], purchasePlans });
					}
					deviceProofRejected = true;
					deviceState = { id: deviceId, authorized: false, lastSeenAt: deviceState.lastSeenAt };
				}
				if (!deviceProofRejected) {
					const heartbeat = await cloudFetch(`${apiUrl}/api/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
						method: 'POST', headers,
					});
					if (heartbeat.status === 401) {
						await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
						return publishCloudAccountState({ apiUrl, configured: true, status: 'signed_out', statusText: '登录已失效，请重新登录', providers, identities: [], purchasePlans });
					}
					if (heartbeat.status === 403) {
						deviceState = { id: deviceId, authorized: false, lastSeenAt: deviceState.lastSeenAt };
					} else if (!heartbeat.ok) {
						throw new Error(`Cloud device heartbeat failed (${heartbeat.status})`);
					} else {
						const heartbeatPayload = await responseJson(heartbeat);
						deviceState = {
							id: deviceId,
							authorized: true,
							lastSeenAt: typeof heartbeatPayload.device?.lastSeenAt === 'string' ? heartbeatPayload.device.lastSeenAt : deviceState.lastSeenAt,
							authorizationValidUntil: typeof heartbeatPayload.authorizationValidUntil === 'string' ? heartbeatPayload.authorizationValidUntil : undefined,
						};
					}
				}
			}
			if (!deviceState.authorized && entitlement) {
				const action = resolveCloudDeviceAuthorizationAction(recoverySelection, activeDeviceCount, entitlement.deviceLimit);
				if (action === 'quota_full') {
					deviceAuthorizationNote = '设备额度已满，当前设备无法授权。';
				} else if (action === 'auto_authorize') {
					try {
						const registration = await registerCloudDeviceAuthorization(apiUrl, token, currentIdentity);
						const registeredDevice = registration.device && typeof registration.device === 'object' ? registration.device : {};
						deviceState = {
							id: deviceId,
							authorized: true,
							lastSeenAt: typeof registeredDevice.lastSeenAt === 'string' ? registeredDevice.lastSeenAt : undefined,
							authorizationValidUntil: typeof registration.authorizationValidUntil === 'string' ? registration.authorizationValidUntil : undefined,
						};
						activeDeviceCount += 1;
					} catch (error) {
						if (error instanceof CloudDeviceAuthorizationRejectedError && error.cloudCode === 'DEVICE_LIMIT_REACHED') {
							deviceAuthorizationNote = '设备额度已满，当前设备无法授权。';
						} else if (error instanceof CloudDeviceProofRejectedError) {
							deviceAuthorizationNote = '设备身份验证失败，当前设备未授权。';
						} else {
							deviceAuthorizationNote = `当前设备自动授权未完成 · ${redactText(describeCloudFailure(error), 220)}`;
						}
					}
				}
			}
			return publishCloudAccountState({
				apiUrl,
				configured: true,
				status: 'signed_in',
				statusText: `已登录${typeof account.displayName === 'string' && account.displayName ? ` · ${account.displayName}` : ''}${deviceProofRejected ? ' · 设备身份验证失败' : ''}${deviceAuthorizationNote ? ` · ${deviceAuthorizationNote}` : ''}`,
				providers,
				accountId,
				displayName: typeof account.displayName === 'string' ? account.displayName : undefined,
				identities,
				entitlement,
				device: deviceState,
				activeDeviceCount,
				deviceActionRequired: Boolean(entitlement && !deviceState.authorized),
				purchasePlans,
			});
		} catch (error) {
			const previous = cloudAccountState;
			return publishCloudAccountState({
				...previous,
				apiUrl,
				configured: true,
				status: 'error',
				statusText: redactText(describeCloudFailure(error), 300),
			});
		}
	};

	const refreshCloudAuthorizationLease = async (): Promise<BridgeAccountUiState> => {
		const apiUrl = readCloudApiUrl();
		const previous = cloudAccountState;
		if (!apiUrl) {
			return publishCloudAccountState({ ...previous, apiUrl: '', configured: false, ...unavailableCloudState() });
		}
		const token = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
		if (!token) {
			return publishCloudAccountState({ ...previous, apiUrl, configured: true, status: 'signed_out', statusText: '登录已失效，请重新登录', accountId: undefined, displayName: undefined, identities: [], entitlement: undefined, device: undefined, activeDeviceCount: undefined, deviceActionRequired: false });
		}
		const accountId = previous.accountId;
		const deviceId = previous.device?.id;
		if (!accountId || !deviceId || !previous.entitlement || !previous.device?.authorized) {
			return publishCloudAccountState({
				...previous,
				apiUrl,
				configured: true,
				status: previous.status === 'signed_out' ? 'signed_out' : 'signed_in',
				statusText: 'Cloud 运行授权状态不完整，Bridge 将 fail closed。',
				device: deviceId ? { ...previous.device!, authorized: false, authorizationValidUntil: undefined } : previous.device,
				deviceActionRequired: Boolean(previous.entitlement),
			});
		}
		try {
			const identity = await getCloudDeviceIdentityForAccount(accountId, [{ id: deviceId }]);
			if (identity.deviceId !== deviceId) throw new Error('当前设备身份与运行中的 Cloud device id 不一致。');
			const lease = await requestCloudAuthorizationLease({ apiUrl, sessionToken: token, identity, fetcher: cloudFetch });
			return publishCloudAccountState({
				...previous,
				apiUrl,
				configured: true,
				status: 'signed_in',
				statusText: `已登录${previous.displayName ? ` · ${previous.displayName}` : ''}`,
				entitlement: previous.entitlement ? { ...previous.entitlement, expiresAt: lease.entitlementExpiresAt ?? previous.entitlement.expiresAt } : previous.entitlement,
				device: {
					...previous.device!,
					authorized: true,
					lastSeenAt: lease.lastSeenAt ?? previous.device?.lastSeenAt,
					authorizationValidUntil: lease.authorizationValidUntil,
				},
				deviceActionRequired: false,
			});
		} catch (error) {
			if (error instanceof CloudAuthorizationLeaseRequestError) {
				if (error.statusCode === 401 && !error.cloudCode.startsWith('DEVICE_')) {
					await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
					return publishCloudAccountState({ ...previous, apiUrl, configured: true, status: 'signed_out', statusText: '登录已失效，请重新登录', accountId: undefined, displayName: undefined, identities: [], entitlement: undefined, device: undefined, activeDeviceCount: undefined, deviceActionRequired: false });
				}
				const hardAuthorizationFailure = error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408 && error.statusCode !== 429;
				if (hardAuthorizationFailure) {
					const entitlement = error.cloudCode === 'ENTITLEMENT_REQUIRED' ? undefined : previous.entitlement;
					return publishCloudAccountState({
						...previous,
						apiUrl,
						configured: true,
						status: 'signed_in',
						statusText: `Cloud 已拒绝运行授权${error.cloudCode ? ` · ${error.cloudCode}` : ''}`,
						entitlement,
						device: { ...previous.device!, authorized: false, authorizationValidUntil: undefined },
						deviceActionRequired: Boolean(entitlement),
					});
				}
			}
			return publishCloudAccountState({
				...previous,
				apiUrl,
				configured: true,
				status: 'error',
				statusText: `Cloud 授权检查暂时不可达 · ${redactText(describeCloudFailure(error), 300)}`,
			});
		}
	};

	const activateCloudDevice = async (options: { notify?: boolean } = {}): Promise<void> => {
		const apiUrl = readCloudApiUrl();
		const token = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
		if (!apiUrl || !token) throw new Error('请先登录 MoonCode Cloud。');
		await refreshCloudAccountState();
		if (cloudAccountState.status !== 'signed_in') throw new Error('当前 Cloud 账号不可用，请刷新或重新登录。');
		if (!cloudAccountState.entitlement) throw new Error('当前账号没有有效套餐/授权。');
		if (cloudAccountState.device?.authorized) return;
		if ((cloudAccountState.activeDeviceCount ?? 0) >= cloudAccountState.entitlement.deviceLimit) {
			throw new Error('设备额度已满，当前设备无法授权。');
		}
		const accountId = cloudAccountState.accountId;
		if (!accountId) throw new Error('当前 Cloud 账号缺少 account id，请刷新或重新登录。');
		const baseIdentity = await getCloudDeviceIdentity();
		const resolvedDeviceId = cloudAccountState.device?.id || deriveAccountScopedDeviceId(baseIdentity.deviceId, accountId);
		const identity = resolvedDeviceId === baseIdentity.deviceId ? baseIdentity : { ...baseIdentity, deviceId: resolvedDeviceId };
		await registerCloudDeviceAuthorization(apiUrl, token, identity);
		await refreshCloudAccountState();
		if (options.notify === false) return;
		void vscode.window.showInformationMessage('MoonCode：此设备已授权。');
	};

	const purchaseCloudPlan = async (planCode: string): Promise<void> => {
		if (purchaseOperationRunning) {
			void vscode.window.showInformationMessage('MoonCode：正在打开商品页，请稍候。');
			return;
		}
		purchaseOperationRunning = true;
		setPaymentUiState({ status: 'creating', planCode, message: '正在打开外部商品页…' });
		try {
			const apiUrl = readCloudApiUrl();
			const sessionToken = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
			if (!apiUrl || !sessionToken) throw new Error('请先登录 MoonCode Cloud。');
			await refreshCloudAccountState();
			if (cloudAccountState.status !== 'signed_in') throw new Error('当前 Cloud 账号不可用，请刷新或重新登录。');
			await requireCloudflareTunnelReady('购买或续费套餐');
			const selected = cloudAccountState.purchasePlans?.find(plan => plan.code === planCode);
			if (!selected) throw new Error('所选套餐当前不可购买，请刷新套餐列表。');
			const externalSalesUrl = normalizeExternalSalesUrl(selected.externalSalesUrl);
			const opened = await vscode.env.openExternal(vscode.Uri.parse(externalSalesUrl));
			if (!opened) throw new Error('商品页未能自动打开，请稍后重试。');
			setPaymentUiState({ status: 'idle', planCode: selected.code, message: '商品页已打开。付款完成后复制平台发放的 MoonCode 激活码，返回 MoonCode 兑换。' });
			void vscode.window.showInformationMessage(`MoonCode：已打开 ${selected.displayName} 商品页。付款后请复制平台发放的激活码，并回到 MoonCode 兑换。`);
		} catch (error) {
			setPaymentUiState({ status: 'failed', planCode, errorCode: 'EXTERNAL_SALES_OPEN_FAILED', message: error instanceof Error ? error.message : String(error) });
			throw error;
		} finally {
			purchaseOperationRunning = false;
		}
	};

	const redeemCloudActivationCode = async (rawCode: string): Promise<void> => {
		const apiUrl = readCloudApiUrl();
		const sessionToken = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
		if (!apiUrl || !sessionToken) throw new Error('请先登录 MoonCode Cloud。');
		const activationCode = rawCode.trim();
		if (!activationCode || activationCode.length > 128) throw new Error('请输入有效的 MoonCode 激活码。');
		await refreshCloudAccountState();
		if (cloudAccountState.status !== 'signed_in') throw new Error('当前 Cloud 账号不可用，请刷新或重新登录。');
		await requireCloudflareTunnelReady('兑换激活码');
		const response = await cloudFetch(`${apiUrl}/api/v1/activation/redeem`, {
			method: 'POST',
			headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ code: activationCode }),
		});
		const payload = await responseJson(response);
		if (!response.ok) {
			if (response.status === 401) {
				await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
				await refreshCloudAccountState();
				throw new Error('MoonCode Cloud 登录已失效，请重新登录后兑换。');
			}
			const code = typeof payload.error === 'string' ? payload.error : '';
			const message = code === 'ACTIVATION_CODE_ALREADY_REDEEMED' ? '该激活码已被兑换。'
				: code === 'ACTIVATION_CODE_REVOKED' ? '该激活码已被撤销。'
					: code === 'ACTIVATION_CODE_EXPIRED' ? '该激活码已过期。'
						: code === 'ACTIVATION_CODE_NOT_FOUND' || code === 'ACTIVATION_CODE_INVALID' ? '激活码无效。'
							: `激活码兑换失败 (${response.status}${code ? ` ${code}` : ''})`;
			throw new Error(message);
		}
		const redemption = payload.redemption && typeof payload.redemption === 'object' ? payload.redemption as Record<string, unknown> : {};
		const renewal = redemption.kind === 'renewal';
		const durationSeconds = Number(redemption.durationSeconds ?? 0);
		const addedDuration = formatCloudDurationSeconds(durationSeconds);
		const responseExpiry = typeof redemption.expiresAt === 'string' ? redemption.expiresAt : undefined;
		let deviceActivationError = '';
		await refreshCloudAccountState();
		if (cloudAccountState.entitlement && !cloudAccountState.device?.authorized) {
			try {
				await activateCloudDevice({ notify: false });
			} catch (error) {
				deviceActivationError = redactText(error instanceof Error ? error.message : String(error), 500);
			}
			await refreshCloudAccountState();
		}
		const expiry = cloudAccountState.entitlement?.expiresAt ?? responseExpiry;
		const actionLabel = renewal ? '续费成功' : '激活成功';
		const durationLabel = addedDuration ? `，本次增加 ${addedDuration}` : '';
		if (cloudAccountState.device?.authorized) {
			void vscode.window.showInformationMessage(`MoonCode：${actionLabel}${durationLabel}${expiry ? `；新到期时间 ${expiry}` : ''}；当前设备已授权。`);
		} else {
			const deviceNote = deviceActivationError ? `设备授权未完成：${deviceActivationError}` : '当前设备尚未授权；权益充值不受影响，可稍后点击“激活此设备”。';
			void vscode.window.showWarningMessage(`MoonCode：${actionLabel}${durationLabel}${expiry ? `；新到期时间 ${expiry}` : ''}。${deviceNote}`);
		}
	};

	const saveCloudAccountSettings = async (raw: BridgeViewMessage['account']): Promise<void> => {
		const current = readCloudApiUrl();
		const next = normalizeCloudApiUrl(typeof raw?.apiUrl === 'string' ? raw.apiUrl : current);
		if (next !== current) {
			accountLoginGeneration += 1;
			await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
		}
		await vscode.workspace.getConfiguration('mooncode.cloud').update('apiUrl', next, vscode.ConfigurationTarget.Global);
		await refreshCloudAccountState();
	};

	const startCloudAccountLogin = async (provider: 'github' | 'gitee'): Promise<void> => {
		const apiUrl = readCloudApiUrl();
		if (!apiUrl) throw new Error('当前构建尚未配置 MoonCode Cloud 服务入口，请先在 Bridge 设置 → 账号中配置开发/测试 Cloud。');
		await refreshCloudAccountState();
		if (!cloudAccountState.providers.includes(provider)) throw new Error(`Cloud 尚未配置 ${provider} provider。`);
		const providerLabel = provider === 'github' ? 'GitHub' : 'Gitee';
		const generation = ++accountLoginGeneration;
		publishCloudAccountState({ ...cloudAccountState, status: 'signing_in', statusText: `正在准备 ${providerLabel} 授权…`, loginProvider: provider, loginPhase: 'preparing' });
		try {
			const startResponse = await cloudFetch(`${apiUrl}/api/v1/auth/${provider}/start`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// Login discovers the account; device authorization happens only after the account is known.
				body: JSON.stringify({ purpose: 'login', desktop_handoff: true }),
			});
			const startPayload = await responseJson(startResponse);
			if (!startResponse.ok) throw new Error(`Cloud login start failed (${startResponse.status} ${String(startPayload.error || '')})`);
			if (accountLoginGeneration !== generation) return;
			const authorizationUrl = typeof startPayload.authorization_url === 'string' ? startPayload.authorization_url : '';
			const handoffId = typeof startPayload.handoff_id === 'string' ? startPayload.handoff_id : '';
			const handoffSecret = typeof startPayload.handoff_secret === 'string' ? startPayload.handoff_secret : '';
			if (!authorizationUrl || !handoffId || handoffSecret.length < 32) throw new Error('Cloud 返回的 desktop handoff 不完整。');
			publishCloudAccountState({ ...cloudAccountState, status: 'signing_in', statusText: `正在打开 ${providerLabel} 官方授权页面…`, loginProvider: provider, loginPhase: 'opening_browser' });
			const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
			if (!opened) throw new Error('无法打开系统浏览器进行账号授权。');
			if (accountLoginGeneration !== generation) return;
			publishCloudAccountState({ ...cloudAccountState, status: 'signing_in', statusText: `${providerLabel} 官方授权页面已打开，等待授权完成…`, loginProvider: provider, loginPhase: 'waiting_callback' });
			const deadline = Date.now() + 10 * 60_000;
			while (accountLoginGeneration === generation && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 1_000));
				const exchangeResponse = await cloudFetch(`${apiUrl}/api/v1/auth/handoffs/${encodeURIComponent(handoffId)}/exchange`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ secret: handoffSecret }),
				});
				if (accountLoginGeneration !== generation) return;
				if (exchangeResponse.status === 202) continue;
				const exchangePayload = await responseJson(exchangeResponse);
				if (!exchangeResponse.ok) throw new Error(`Cloud login handoff failed (${exchangeResponse.status} ${String(exchangePayload.error || '')})`);
				const sessionToken = typeof exchangePayload.session_token === 'string' ? exchangePayload.session_token : '';
				if (!sessionToken) throw new Error('Cloud handoff 未返回 MoonCode session。');
				await context.secrets.store(MOONCODE_ACCOUNT_SESSION_SECRET, sessionToken);
				await refreshCloudAccountState();
				void vscode.window.showInformationMessage(`MoonCode：${providerLabel} 登录成功。`);
				return;
			}
			if (accountLoginGeneration === generation) throw new Error('账号授权超时，请重新登录。');
		} catch (error) {
			if (accountLoginGeneration === generation) {
				publishCloudAccountState({
					...cloudAccountState,
					status: 'signed_out',
					statusText: `${providerLabel} 登录未完成 · ${redactText(error instanceof Error ? error.message : String(error), 220)}`,
					loginProvider: provider,
					loginPhase: 'failed',
				});
			}
			throw error;
		}
	};

	const cancelCloudAccountLogin = (): void => {
		if (cloudAccountState.status !== 'signing_in') return;
		const provider = cloudAccountState.loginProvider === 'gitee' ? 'gitee' : 'github';
		const providerLabel = provider === 'github' ? 'GitHub' : 'Gitee';
		accountLoginGeneration += 1;
		publishCloudAccountState({ ...cloudAccountState, status: 'signed_out', statusText: `已取消 ${providerLabel} 登录。`, loginProvider: provider, loginPhase: 'cancelled' });
	};

	const logoutCloudAccount = async (): Promise<void> => {
		accountLoginGeneration += 1;
		setPaymentUiState({ status: 'idle' });
		await stopActiveBridge('account logout');
		void flushToolCallUsage();
		const apiUrl = readCloudApiUrl();
		const token = await context.secrets.get(MOONCODE_ACCOUNT_SESSION_SECRET);
		if (!apiUrl || !token) {
			pendingToolCallUsage = 0;
			await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
			await refreshCloudAccountState();
			return;
		}
		const response = await cloudFetch(`${apiUrl}/api/v1/auth/logout`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		});
		if (response.status !== 204 && response.status !== 401) throw new Error(`Cloud logout failed (${response.status}); 本地 session 保留以便重试撤销。`);
		pendingToolCallUsage = 0;
		await context.secrets.delete(MOONCODE_ACCOUNT_SESSION_SECRET);
		await refreshCloudAccountState();
	};

	const saveOAuthSettings = async (raw: BridgeViewMessage['oauth']): Promise<BridgeOAuthUiSettings> => {
		if (bridgeClient?.running) throw new Error('请先停止 Bridge，再修改 OAuth 配置。');
		const current = readBridgeOAuthUiSettings();
		const issuer = parseHttpUrl(typeof raw?.issuer === 'string' ? raw.issuer : current.issuer, 'Issuer', true);
		const jwksUri = parseHttpUrl(typeof raw?.jwksUri === 'string' ? raw.jwksUri : current.jwksUri, 'JWKS URI', true);
		const resourceId = typeof raw?.resourceId === 'string' ? raw.resourceId.trim().slice(0, 240) : current.resourceId;
		const endpointGeneration = boundedInteger(raw?.endpointGeneration, current.endpointGeneration, 1, Number.MAX_SAFE_INTEGER);
		const resource = parseHttpUrl(typeof raw?.resource === 'string' ? raw.resource : current.resource, 'MCP Resource URL', true);
		const config = vscode.workspace.getConfiguration('mooncode.bridge.oauth');
		await Promise.all([
			config.update('issuer', issuer, vscode.ConfigurationTarget.Global),
			config.update('jwksUri', jwksUri, vscode.ConfigurationTarget.Global),
			config.update('resourceId', resourceId, vscode.ConfigurationTarget.Global),
			config.update('endpointGeneration', endpointGeneration, vscode.ConfigurationTarget.Global),
			config.update('resource', resource, vscode.ConfigurationTarget.Global),
		]);
		await refreshTunnelUiSettings();
		return refreshOAuthUiSettings();
	};

	const rotateEndpoint = async (): Promise<void> => {
		if (bridgeClient?.running) {
			await stopActiveBridge('endpoint rotated');
		}
		const current = readBridgeOAuthUiSettings();
		const next = Math.min(Number.MAX_SAFE_INTEGER, current.endpointGeneration + 1);
		await vscode.workspace.getConfiguration('mooncode.bridge.oauth').update('endpointGeneration', next, vscode.ConfigurationTarget.Global);
		refreshOAuthUiSettings();
		await refreshTunnelUiSettings();
		void vscode.window.showInformationMessage(`MoonCode：Bridge 端点代次已轮换到 ${next}；旧授权不会被新端点接受。`);
	};

	const readBrowserShortcuts = (): BridgeBrowserShortcut[] => {
		const stored = context.globalState.get<unknown[]>(BRIDGE_SHORTCUTS_KEY, []);
		const custom = stored.map(normalizeStoredShortcut).filter((item): item is BridgeBrowserShortcut => Boolean(item)).slice(0, 12);
		return [...BUILTIN_BROWSER_SHORTCUTS.map(shortcut => ({ ...shortcut })), ...custom];
	};

	const refreshBrowserShortcuts = (): BridgeBrowserShortcut[] => {
		const shortcuts = readBrowserShortcuts();
		bridgeProvider.setBrowserShortcuts(shortcuts);
		return shortcuts;
	};

	const addBrowserShortcut = async (raw: BridgeViewMessage['shortcut']): Promise<void> => {
		const label = typeof raw?.label === 'string' ? raw.label.trim().slice(0, 60) : '';
		if (!label) throw new Error('快捷入口名称不能为空。');
		const url = parseHttpUrl(typeof raw?.url === 'string' ? raw.url : '', '快捷入口 URL');
		const custom = readBrowserShortcuts().filter(shortcut => !shortcut.builtin);
		if (custom.length >= 12) throw new Error('自定义快捷入口最多 12 个。');
		custom.push({
			id: `custom-${randomUUID()}`,
			label,
			url,
			openMode: raw?.openMode === 'external' ? 'external' : 'integrated',
			compatibility: 'custom',
			note: '用户自定义；MoonCode 不声明该站点支持 MCP/OAuth。',
			builtin: false,
		});
		await context.globalState.update(BRIDGE_SHORTCUTS_KEY, custom);
		refreshBrowserShortcuts();
	};

	const removeBrowserShortcut = async (id: string): Promise<void> => {
		const custom = readBrowserShortcuts().filter(shortcut => !shortcut.builtin && shortcut.id !== id);
		await context.globalState.update(BRIDGE_SHORTCUTS_KEY, custom);
		refreshBrowserShortcuts();
	};

	const openBrowserShortcut = async (id: string): Promise<void> => {
		const shortcut = readBrowserShortcuts().find(item => item.id === id);
		if (!shortcut) throw new Error('快捷入口不存在或已被删除。');
		const url = parseHttpUrl(shortcut.url, '快捷入口 URL');
		if (shortcut.openMode === 'external') {
			await vscode.env.openExternal(vscode.Uri.parse(url));
			return;
		}
		const commands = await vscode.commands.getCommands(true);
		if (commands.includes('workbench.action.browser.open')) {
			await vscode.commands.executeCommand('workbench.action.browser.open', url);
			return;
		}
		if (commands.includes('simpleBrowser.show')) {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
			return;
		}
		void vscode.window.showWarningMessage('MoonCode：集成浏览器当前不可用，已改用系统浏览器。');
		await vscode.env.openExternal(vscode.Uri.parse(url));
	};

	const inspectLegacyCards = async (): Promise<BridgeLegacyCardState> => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) return { present: false, canClean: false, message: '请先打开一个工作区。' };
		const urlPath = join(root, 'BRIDGE-URL.txt');
		const promptPath = join(root, 'BRIDGE-PROMPT.txt');
		let urlText: string | undefined;
		let promptText: string | undefined;
		try { urlText = await readFile(urlPath, 'utf8'); } catch { /* absent or unreadable */ }
		try { promptText = await readFile(promptPath, 'utf8'); } catch { /* absent or unreadable */ }
		if (urlText === undefined && promptText === undefined) {
			return { present: false, canClean: false, message: '未发现旧版本连接卡片；当前版本也不会自动生成它们。' };
		}
		if (urlText === undefined || promptText === undefined || urlText.length > 4096 || promptText.length > 16_384) {
			return { present: true, canClean: false, message: '发现同名文件，但无法证明它们是一对未修改的旧 MoonCode 卡片；不会删除。' };
		}
		const url = urlText.trim();
		let parsed: URL;
		try { parsed = new URL(url); } catch {
			return { present: true, canClean: false, message: '发现同名文件，但 URL 内容不是旧 MoonCode 可识别格式；不会删除。' };
		}
		if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.pathname.includes('/mcp/')) {
			return { present: true, canClean: false, message: '发现同名文件，但 URL 不是旧 Bridge MCP 地址；不会删除。' };
		}
		const normalizedPrompt = promptText.replace(/\r\n/g, '\n').trim();
		const exactReadOnly = legacyPromptFor(url, false);
		const exactWrite = legacyPromptFor(url, true);
		const canClean = normalizedPrompt === exactReadOnly || normalizedPrompt === exactWrite;
		return canClean
			? { present: true, canClean: true, message: '已确认这两份文件与旧 MoonCode 自动生成模板完全一致，可安全清理。' }
			: { present: true, canClean: false, message: '发现同名文件，但内容已改变或不是旧 MoonCode 自动生成模板；不会删除。' };
	};

	const refreshLegacyCards = async (): Promise<BridgeLegacyCardState> => {
		const state = await inspectLegacyCards();
		bridgeProvider.setLegacyCards(state);
		return state;
	};

	const cleanLegacyCards = async (): Promise<void> => {
		const state = await inspectLegacyCards();
		if (!state.canClean) {
			bridgeProvider.setLegacyCards(state);
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) return;
		await unlink(join(root, 'BRIDGE-URL.txt'));
		await unlink(join(root, 'BRIDGE-PROMPT.txt'));
		bridgeProvider.setLegacyCards({ present: false, canClean: false, message: '旧版本自动生成的连接卡片已安全清理。' });
	};

	const saveTunnelSettings = async (raw: BridgeViewMessage['tunnel']): Promise<BridgeTunnelUiSettings> => {
		const current = await readTunnelUiSettings();
		const config = vscode.workspace.getConfiguration('mooncode.bridge.tunnel');
		const next = {
			authMode: raw?.authMode === 'oauth' ? 'oauth' as const : raw?.authMode === 'capability_url' ? 'capability_url' as const : current.authMode,
			browserOriginMode: normalizeBrowserOriginMode(raw?.browserOriginMode ?? current.browserOriginMode),
			browserOrigins: Array.isArray(raw?.browserOrigins) ? raw.browserOrigins.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean).slice(0, 100) : current.browserOrigins,
			provider: normalizeTunnelProvider(raw?.provider ?? current.provider),
			publicUrl: typeof raw?.publicUrl === 'string' ? raw.publicUrl.trim() : current.publicUrl,
			executable: typeof raw?.executable === 'string' ? raw.executable.trim() : current.executable,
			proxyUrl: typeof raw?.proxyUrl === 'string' ? raw.proxyUrl.trim() : current.proxyUrl,
			startupTimeoutMs: boundedInteger(raw?.startupTimeoutMs, current.startupTimeoutMs, 1_000, 120_000),
			maxAttempts: boundedInteger(raw?.maxAttempts, current.maxAttempts, 1, 5),
			localPort: boundedInteger(raw?.localPort, current.localPort, 1, 65_535),
			persistentMode: typeof raw?.persistentMode === 'boolean' ? raw.persistentMode : current.persistentMode,
			quickLinks: typeof raw?.quickLinks === 'boolean' ? raw.quickLinks : current.quickLinks,
		};
		await Promise.all([
			config.update('authMode', next.authMode, vscode.ConfigurationTarget.Global),
			config.update('browserOriginMode', next.browserOriginMode, vscode.ConfigurationTarget.Global),
			config.update('browserOrigins', next.browserOrigins, vscode.ConfigurationTarget.Global),
			config.update('provider', next.provider, vscode.ConfigurationTarget.Global),
			config.update('publicUrl', next.publicUrl, vscode.ConfigurationTarget.Global),
			config.update('executable', next.executable, vscode.ConfigurationTarget.Global),
			config.update('proxyUrl', next.proxyUrl, vscode.ConfigurationTarget.Global),
			config.update('startupTimeoutMs', next.startupTimeoutMs, vscode.ConfigurationTarget.Global),
			config.update('maxAttempts', next.maxAttempts, vscode.ConfigurationTarget.Global),
			config.update('localPort', next.localPort, vscode.ConfigurationTarget.Global),
			config.update('persistentMode', next.persistentMode, vscode.ConfigurationTarget.Global),
			config.update('quickLinks', next.quickLinks, vscode.ConfigurationTarget.Global),
		]);
		return await refreshTunnelUiSettings();
	};

	const resolveTunnelLaunchSettings = async (settings: BridgeTunnelUiSettings): Promise<BridgeTunnelLaunchSettings> => {
		let token: string | undefined;
		if (settings.provider === 'cloudflare-named') token = await context.secrets.get(CLOUDFLARE_TUNNEL_TOKEN_SECRET);
		if (settings.provider === 'ngrok') token = await context.secrets.get(NGROK_AUTHTOKEN_SECRET);
		if ((settings.provider === 'cloudflare-named' || settings.provider === 'ngrok') && !settings.publicUrl) {
			throw new Error(`${settings.provider} requires a stable public HTTPS origin`);
		}
		if ((settings.provider === 'cloudflare-named' || settings.provider === 'ngrok') && !token) {
			throw new Error(`${settings.provider} credential is missing; use Set credential`);
		}
		return {
			provider: settings.provider,
			publicUrl: settings.publicUrl || undefined,
			executable: settings.executable || undefined,
			proxyUrl: settings.proxyUrl || undefined,
			startupTimeoutMs: settings.startupTimeoutMs,
			maxAttempts: settings.maxAttempts,
			localPort: settings.localPort,
			token,
		};
	};

	type ProcessProbeResult = { ok: boolean; code: number | null; output: string; error?: string; errorCode?: string };
	const runProcessProbe = async (executable: string, args: string[], timeoutMs = 5_000, env?: NodeJS.ProcessEnv, maxOutput = 32_000): Promise<ProcessProbeResult> => await new Promise(resolve => {
		let settled = false;
		let output = '';
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ProcessProbeResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
		} catch (error) {
			const candidate = error as NodeJS.ErrnoException;
			finish({ ok: false, code: null, output, error: candidate.message, errorCode: candidate.code });
			return;
		}
		const onData = (buffer: Buffer) => { output = (output + buffer.toString()).slice(-maxOutput); };
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.once('error', error => {
			const candidate = error as NodeJS.ErrnoException;
			finish({ ok: false, code: null, output, error: candidate.message, errorCode: candidate.code });
		});
		child.once('exit', code => finish({ ok: code === 0, code, output, error: code === 0 ? undefined : `process exited ${String(code)}` }));
		timer = setTimeout(() => {
			try { child.kill(); } catch { /* already exited */ }
			finish({ ok: false, code: null, output, error: `process timed out after ${timeoutMs} ms`, errorCode: 'ETIMEDOUT' });
		}, timeoutMs);
		timer.unref?.();
	});

	const dependencyState = (provider: BridgeTunnelProvider, status: BridgeTunnelDependencyUiState['status'], patch: Partial<BridgeTunnelDependencyUiState> = {}): BridgeTunnelDependencyUiState => ({
		provider,
		status,
		installed: status === 'available' || status === 'path_hidden' || status === 'not_required',
		executable: provider === 'ngrok' ? 'ngrok' : provider === 'none' ? '' : 'cloudflared',
		...patch,
	});

	const probeCloudflaredExecutable = async (executable: string, timeoutMs = 5_000): Promise<ProcessProbeResult & { version?: string; versionNormal?: boolean }> => {
		const probe = await runProcessProbe(executable, ['--version'], timeoutMs);
		const version = probe.output.trim().split(/\r?\n/).find(Boolean)?.slice(0, 300);
		return { ...probe, version, versionNormal: probe.ok ? isNormalCloudflaredVersionOutput(probe.output) : false };
	};

	const resolveCloudflaredPathFromPath = async (): Promise<string> => {
		if (process.platform !== 'win32') return 'cloudflared';
		const where = await runProcessProbe('where.exe', ['cloudflared'], 2_000);
		if (!where.ok) return 'cloudflared';
		return where.output.split(/\r?\n/).map(value => value.trim()).find(value => /^[a-z]:[\\/]/i.test(value)) || 'cloudflared';
	};

	const tunnelProxySummary = (source: BridgeTunnelUiSettings['proxySource']): string => ({
		manual: 'MoonCode 手动配置',
		environment: '系统环境变量',
		vscode: 'MoonCode HTTP Proxy',
		windows: 'Windows 系统代理',
		none: '未使用代理',
	}[source ?? 'none']);

	const inspectTunnelDependency = async (provider: BridgeTunnelProvider, suppliedSettings?: BridgeTunnelUiSettings): Promise<BridgeTunnelDependencyUiState> => {
		if (provider === 'none') return dependencyState(provider, 'not_required', { version: 'not required' });
		const settings = suppliedSettings ?? await readTunnelUiSettings();
		const state = (status: BridgeTunnelDependencyUiState['status'], patch: Partial<BridgeTunnelDependencyUiState> = {}) => dependencyState(provider, status, { proxySummary: tunnelProxySummary(settings.proxySource), ...patch });
		if (provider === 'ngrok') {
			const executable = settings.executable || 'ngrok';
			const probe = await runProcessProbe(executable, ['version']);
			const version = probe.output.trim().split(/\r?\n/).find(Boolean)?.slice(0, 300);
			return probe.ok
				? state('available', { executable, resolvedExecutable: executable, version: version || 'version command succeeded' })
				: state(probe.errorCode === 'ENOENT' ? 'missing' : 'broken', { executable, error: probe.error ?? 'ngrok version check failed', version });
		}

		if (settings.executable) {
			let probe = await probeCloudflaredExecutable(settings.executable);
			if (!probe.ok && probe.errorCode === 'ETIMEDOUT') {
				probe = await probeCloudflaredExecutable(settings.executable, 15_000);
			}
			if (!probe.ok) return state('broken', { executable: settings.executable, resolvedExecutable: settings.executable, error: probe.error ?? 'cloudflared version check failed', version: probe.version });
			if (!probe.versionNormal) return state('version_abnormal', { executable: settings.executable, resolvedExecutable: settings.executable, error: 'cloudflared --version 返回了无法识别的版本信息。', version: probe.version });
			return state('available', { executable: settings.executable, resolvedExecutable: settings.executable, version: probe.version });
		}

		const pathProbe = await probeCloudflaredExecutable('cloudflared');
		if (pathProbe.ok) {
			if (!pathProbe.versionNormal) return state('version_abnormal', { error: 'PATH 中的 cloudflared 返回了无法识别的版本信息。', version: pathProbe.version });
			return state('available', { resolvedExecutable: await resolveCloudflaredPathFromPath(), version: pathProbe.version });
		}
		if (pathProbe.errorCode !== 'ENOENT') return state('broken', { error: pathProbe.error ?? 'PATH 中的 cloudflared 无法执行。', version: pathProbe.version });

		for (const candidate of cloudflaredCommonWindowsCandidates()) {
			const probe = await probeCloudflaredExecutable(candidate);
			if (probe.ok && probe.versionNormal) return state('path_hidden', { executable: candidate, resolvedExecutable: candidate, version: probe.version });
			if (probe.ok && !probe.versionNormal) return state('version_abnormal', { executable: candidate, resolvedExecutable: candidate, version: probe.version, error: '检测到 cloudflared.exe，但版本输出异常。' });
			if (probe.errorCode && probe.errorCode !== 'ENOENT') return state('broken', { executable: candidate, resolvedExecutable: candidate, error: probe.error ?? '检测到 cloudflared.exe，但无法执行。', version: probe.version });
		}
		return state('missing', { error: '当前未检测到 Cloudflare Tunnel 环境' });
	};

	const publishTunnelDependency = (state: BridgeTunnelDependencyUiState): BridgeTunnelDependencyUiState => {
		bridgeProvider.setTunnelDependency(state);
		bridgeProvider.post({ kind: 'event', event: { type: 'bridge.tunnel_dependency', ...state } });
		return state;
	};

	const reportTunnelDependency = async (provider: BridgeTunnelProvider, suppliedSettings?: BridgeTunnelUiSettings): Promise<BridgeTunnelDependencyUiState> => {
		publishTunnelDependency(dependencyState(provider, 'checking'));
		return publishTunnelDependency(await inspectTunnelDependency(provider, suppliedSettings));
	};

	const requireCloudflareTunnelReady = async (action: string): Promise<void> => {
		const settings = await readTunnelUiSettings();
		if (settings.provider !== 'cloudflare-quick' && settings.provider !== 'cloudflare-named') return;
		const dependency = await reportTunnelDependency(settings.provider, settings);
		if (!dependency.installed) throw new Error(`${action}前请先完成 Cloudflare Tunnel 配置。`);
	};

	const chooseTunnelExecutable = async (provider: BridgeTunnelProvider): Promise<void> => {
		if (provider === 'none') return;
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: provider === 'ngrok' ? 'Use ngrok executable' : 'Use cloudflared executable',
		});
		if (!picked?.[0]) return;
		const config = vscode.workspace.getConfiguration('mooncode.bridge.tunnel');
		await config.update('executable', picked[0].fsPath, vscode.ConfigurationTarget.Global);
		const settings = await refreshTunnelUiSettings();
		await reportTunnelDependency(provider, settings);
	};

	const openTunnelInstallPage = async (provider: BridgeTunnelProvider): Promise<void> => {
		if (provider === 'none') {
			void vscode.window.showInformationMessage('Local-only Bridge does not require a tunnel helper.');
			return;
		}
		const url = provider === 'ngrok' ? NGROK_INSTALL_URL : CLOUDFLARE_INSTALL_URL;
		await vscode.env.openExternal(vscode.Uri.parse(url));
	};

	const cloudflareGuideCommands: Record<NonNullable<BridgeViewMessage['guideCommand']>, string> = {
		'install-msi': 'msiexec.exe /i cloudflared-windows-amd64.msi',
		'version': 'cloudflared --version',
		'where': 'where.exe cloudflared',
		'get-command': 'Get-Command cloudflared -ErrorAction SilentlyContinue',
		'update': 'cloudflared update',
	};
	const cloudflareGuideLinks: Record<NonNullable<BridgeViewMessage['guideLink']>, string> = {
		downloads: CLOUDFLARE_INSTALL_URL,
		update: CLOUDFLARE_UPDATE_URL,
		releases: CLOUDFLARE_RELEASES_URL,
	};

	let cloudflaredInstallPending = false;
	const installCloudflaredDependency = async (provider: BridgeTunnelProvider): Promise<void> => {
		if (provider !== 'cloudflare-quick' && provider !== 'cloudflare-named') {
			await openTunnelInstallPage(provider);
			return;
		}
		if (cloudflaredInstallPending) return;
		if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前一键安装仅支持本轮 Windows x64 Release。');
		cloudflaredInstallPending = true;
		publishTunnelDependency(dependencyState(provider, 'installing'));
		let tempRoot = '';
		try {
			const settings = await readTunnelUiSettings();
			const proxyUrl = settings.proxyUrl || '';
			const transportEnv: NodeJS.ProcessEnv = { ...process.env, MOONCODE_CLOUDFLARED_PROXY: proxyUrl };
			const metadataScript = [
				"$ErrorActionPreference='Stop'",
				"$ProgressPreference='SilentlyContinue'",
				`$uri='${CLOUDFLARE_RELEASE_API_URL}'`,
				"$headers=@{Accept='application/vnd.github+json';'User-Agent'='MoonCode-Cloudflared-Installer'}",
				"if($env:MOONCODE_CLOUDFLARED_PROXY){$r=Invoke-RestMethod -Uri $uri -Headers $headers -Proxy $env:MOONCODE_CLOUDFLARED_PROXY -TimeoutSec 20}else{$r=Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 20}",
				"$r | ConvertTo-Json -Depth 8 -Compress",
			].join(';');
			const metadataResult = await runProcessProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', metadataScript], 30_000, transportEnv, 512_000);
			if (!metadataResult.ok) throw new Error(`获取 Cloudflare 官方 Release 信息失败：${metadataResult.error ?? metadataResult.output.trim()}`);
			let metadata: unknown;
			try { metadata = JSON.parse(metadataResult.output.trim()); } catch { throw new Error('Cloudflare 官方 Release 信息不是有效 JSON。'); }
			const asset = selectOfficialCloudflaredWindowsMsi(metadata);
			tempRoot = await mkdtemp(join(tmpdir(), 'mooncode-cloudflared-'));
			const msiPath = join(tempRoot, asset.name);
			const downloadEnv: NodeJS.ProcessEnv = { ...transportEnv, MOONCODE_CLOUDFLARED_DOWNLOAD_URL: asset.downloadUrl, MOONCODE_CLOUDFLARED_DOWNLOAD_PATH: msiPath };
			const downloadScript = [
				"$ErrorActionPreference='Stop'",
				"$ProgressPreference='SilentlyContinue'",
				"if($env:MOONCODE_CLOUDFLARED_PROXY){Invoke-WebRequest -UseBasicParsing -Uri $env:MOONCODE_CLOUDFLARED_DOWNLOAD_URL -OutFile $env:MOONCODE_CLOUDFLARED_DOWNLOAD_PATH -Proxy $env:MOONCODE_CLOUDFLARED_PROXY -TimeoutSec 120}else{Invoke-WebRequest -UseBasicParsing -Uri $env:MOONCODE_CLOUDFLARED_DOWNLOAD_URL -OutFile $env:MOONCODE_CLOUDFLARED_DOWNLOAD_PATH -TimeoutSec 120}",
			].join(';');
			const downloadResult = await runProcessProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', downloadScript], 150_000, downloadEnv, 16_000);
			if (!downloadResult.ok) throw new Error(`Cloudflare 安装包下载失败：${downloadResult.error ?? downloadResult.output.trim()}`);
			const msi = await readFile(msiPath);
			if (msi.byteLength !== asset.size) throw new Error(`Cloudflare 安装包大小校验失败（expected ${asset.size}, got ${msi.byteLength}）。`);
			const digest = createHash('sha256').update(msi).digest('hex');
			if (digest !== asset.sha256) throw new Error('Cloudflare 安装包 SHA-256 与官方 Release 摘要不一致，已拒绝执行。');
			const installerResult = await runProcessProbe('msiexec.exe', ['/i', msiPath, '/passive', '/norestart'], 10 * 60_000, process.env, 16_000);
			const installerOutcome = classifyWindowsInstallerExitCode(installerResult.code);
			if (installerOutcome === 'cancelled') {
				publishTunnelDependency(dependencyState(provider, 'install_cancelled', { error: 'Cloudflare 安装已由用户取消。' }));
				return;
			}
			if (installerOutcome === 'failed') throw new Error(`Cloudflare Windows Installer 失败（exit ${String(installerResult.code)}）。`);
			await new Promise(resolve => setTimeout(resolve, 1_000));
			const detected = await reportTunnelDependency(provider, await readTunnelUiSettings());
			if (!detected.installed) throw new Error('Cloudflare 安装程序已完成，但 MoonCode 重新检测仍未找到可用的 cloudflared。请使用手动配置安装指南或选择 cloudflared.exe。');
			void vscode.window.showInformationMessage(`MoonCode：Cloudflare Tunnel 环境安装完成${installerOutcome === 'success_restart_required' ? '（Windows 提示需要重启）' : ''}。`);
		} catch (error) {
			publishTunnelDependency(dependencyState(provider, 'install_failed', { error: redactText(error instanceof Error ? error.message : String(error), 700) }));
			throw error;
		} finally {
			cloudflaredInstallPending = false;
			if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	};

	void refreshTunnelUiSettings().then(settings => reportTunnelDependency(settings.provider, settings)).catch(error => {
		bridgeProvider.setTunnelDependency(dependencyState('cloudflare-quick', 'broken', { error: redactText(error instanceof Error ? error.message : String(error), 500) }));
	});

	const persistBridgeTaskEvent = (event: Record<string, unknown>): void => {
		if (event.type === 'bridge.todos') {
			const todos: BridgeTaskUiState['todos'] = [];
			for (const raw of Array.isArray(event.todos) ? event.todos.slice(0, 24) : []) {
				if (!raw || typeof raw !== 'object') continue;
				const todo = raw as { id?: unknown; content?: unknown; status?: unknown };
				if (typeof todo.id !== 'string' || !todo.id || todo.id.length > 80) continue;
				if (typeof todo.content !== 'string' || !todo.content || todo.content.length > 400) continue;
				if (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') continue;
				todos.push({ id: todo.id, content: todo.content, status: todo.status });
			}
			bridgeTaskState = {
				...bridgeTaskState,
				version: Number.isSafeInteger(event.version) ? Number(event.version) : bridgeTaskState.version + 1,
				todos,
				updated_at: typeof event.updated_at === 'string' ? event.updated_at.slice(0, 80) : new Date().toISOString(),
			};
		} else if (event.type === 'bridge.progress') {
			const seq = Number.isSafeInteger(event.seq) ? Number(event.seq) : undefined;
			const message = typeof event.message === 'string' ? event.message.slice(0, 2_000) : undefined;
			const todoId = event.todo_id === null ? null : typeof event.todo_id === 'string' ? event.todo_id.slice(0, 80) : undefined;
			const createdAt = typeof event.created_at === 'string' ? event.created_at.slice(0, 80) : undefined;
			if (seq === undefined || !message || todoId === undefined || !createdAt) return;
			bridgeTaskState = {
				...bridgeTaskState,
				progress: [...bridgeTaskState.progress, { seq, todo_id: todoId, message, created_at: createdAt }].slice(-100),
			};
		} else {
			return;
		}
		bridgeProvider.setTaskState(bridgeTaskState);
		bridgeUiState.setTaskState(bridgeTaskState);
		publishBridgeUiSnapshot();
		void context.workspaceState.update(BRIDGE_TASK_STATE_KEY, bridgeTaskState);
	};

	const currentBridgeDirtyPaths = (): string[] => {
		const root = activeBridgeWorkspaceRoot;
		if (!root) return [];
		const paths = new Set<string>();
		for (const document of vscode.workspace.textDocuments) {
			if (!document.isDirty || document.uri.scheme !== 'file') continue;
			const rel = relative(root, document.uri.fsPath);
			if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
			paths.add(rel.replace(/\\/g, '/'));
		}
		return [...paths].sort();
	};

	const syncDirtyPaths = (): void => {
		if (!bridgeReady || !bridgeClient?.running) return;
		bridgeClient.setDirtyPaths(currentBridgeDirtyPaths());
	};

	const scheduleDirtySync = (): void => {
		if (!bridgeReady) return;
		if (dirtySyncTimer) clearTimeout(dirtySyncTimer);
		dirtySyncTimer = setTimeout(() => {
			dirtySyncTimer = undefined;
			syncDirtyPaths();
		}, 50);
	};

	const getRuntimeClient = (): RuntimeClient => {
		if (!runtimeClient) {
			const loc = resolveRuntime(context.extensionPath);
			runtimeClient = new RuntimeClient(loc.entry, loc.cwd);
			context.subscriptions.push({ dispose: () => runtimeClient?.dispose() });
		}
		return runtimeClient;
	};

	const getBridgeClient = (): BridgeClient => {
		if (!bridgeClient) {
			const loc = resolveRuntime(context.extensionPath);
			bridgeClient = new BridgeClient(loc.entry, loc.cwd);
			context.subscriptions.push({ dispose: () => { void bridgeClient?.stop('extension disposed'); } });
		}
		return bridgeClient;
	};

	const enforceCloudBridgeAuthorization = async (forStart = false): Promise<boolean> => {
		let apiUrl = '';
		try {
			apiUrl = readCloudApiUrl();
		} catch (error) {
			if (forStart) throw error;
			apiUrl = 'invalid';
		}
		if (apiUrl && apiUrl !== 'invalid') {
			try {
				await getCloudDeviceIdentity();
			} catch (error) {
				const detail = redactText(error instanceof Error ? error.message : String(error), 220);
				const reason = `当前设备身份不可用，Bridge 已拒绝授权${detail ? `：${detail}` : '。'}`;
				if (forStart) throw new Error(reason);
				if (bridgeClient?.running) {
					await stopActiveBridge(reason);
					void vscode.window.showWarningMessage(`MoonCode Bridge 已停止：${reason}`);
				}
				return false;
			}
		}
		const state = forStart ? await refreshCloudAccountState() : await refreshCloudAuthorizationLease();
		const gate = evaluateBridgeCommercialGate({
			configured: state.configured,
			status: state.status,
			hasEntitlement: Boolean(state.entitlement),
			deviceAuthorized: Boolean(state.device?.authorized),
			authorizationValidUntil: state.device?.authorizationValidUntil,
		});
		if (gate.allowed) return true;
		const reason = gate.reason;
		if (forStart) throw new Error(reason);
		if (bridgeClient?.running) {
			await stopActiveBridge(reason);
			void vscode.window.showWarningMessage(`MoonCode Bridge 已停止：${reason}`);
		}
		return false;
	};

	const runPrompt = async (prompt: string): Promise<void> => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			void vscode.window.showWarningMessage('MoonCode：请先打开一个工作区。');
			return;
		}
		const eventFile = join(context.globalStorageUri.fsPath, 'events.jsonl');
		await mkdir(context.globalStorageUri.fsPath, { recursive: true });
		try {
			const session = getRuntimeClient().run(
				prompt,
				root,
				eventFile,
				event => agentProvider.onEvent(event),
				approval => agentProvider.askApproval(approval),
			);
			currentRequestId = session.requestId;
			const result = await session.done;
			agentProvider.post({ kind: 'result', state: result.state, response: result.response });
		} catch (error) {
			agentProvider.post({ kind: 'error', message: String(error) });
		} finally {
			currentRequestId = undefined;
		}
	};

	const startBridge = async (_requestedAutoMode: boolean, requestedTunnel?: BridgeViewMessage['tunnel'], silentNoWorkspace = false): Promise<void> => {
		const requestedRoot = selectedBridgeWorkspace?.path;
		if (!requestedRoot) {
			if (!silentNoWorkspace) void vscode.window.showWarningMessage('MoonCode：请先选择一个工作区。');
			return;
		}
		if (bridgeStartPending || bridgeStopPending) return;
		if (bridgeClient?.running) {
			if (!silentNoWorkspace) void vscode.window.showInformationMessage('MoonCode：当前 Bridge 已在运行；请先停止，再重新启动。');
			return;
		}
		bridgeStartPending = true;
		bridgeStartCancelled = false;
		let runId: string | undefined;
		try {
			const root = await realpath(requestedRoot);
			const rootInfo = await stat(root);
			if (!rootInfo.isDirectory()) throw new Error('所选工作区不可用，请重新选择。');
			await enforceCloudBridgeAuthorization(true);
			if (bridgeStartCancelled) throw new Error('BRIDGE_START_CANCELLED');
			const settings = requestedTunnel ? await saveTunnelSettings(requestedTunnel) : await readTunnelUiSettings();
			if (bridgeStartCancelled) throw new Error('BRIDGE_START_CANCELLED');
			let launchSettings = settings;
			if (settings.provider === 'cloudflare-quick' || settings.provider === 'cloudflare-named') {
				const dependency = await reportTunnelDependency(settings.provider, settings);
				if (!dependency.installed) throw new Error('未配置 Cloudflare Tunnel。请先完成 Cloudflare Tunnel 配置。');
				if (dependency.installed && !settings.executable && dependency.resolvedExecutable && dependency.resolvedExecutable !== 'cloudflared') {
					launchSettings = { ...settings, executable: dependency.resolvedExecutable };
				}
			}
			if (bridgeStartCancelled) throw new Error('BRIDGE_START_CANCELLED');
			const tunnel = await resolveTunnelLaunchSettings(launchSettings);
			const oauth = settings.authMode === 'oauth' ? readBridgeOAuthSettings() : undefined;
			if (settings.authMode === 'oauth' && !oauth) throw new Error('OAuth 模式需要先完成 Issuer、JWKS URI 和 Resource ID 配置。');
			runId = randomUUID();
			activeBridgeUiRunId = runId;
			activeBridgeWorkspaceRoot = root;
			bridgeRunWorkspaceRoots.set(runId, root);
			while (bridgeRunWorkspaceRoots.size > 5) bridgeRunWorkspaceRoots.delete(bridgeRunWorkspaceRoots.keys().next().value as string);
			syncBridgeUiWorkspace();
			bridgeUiState.startRun(runId, settings.authMode, tunnel.provider, { name: basename(root), path: root }, 'workspace');
			agentActivityTerminal.beginRun();
			agentActivityTerminal.accept({ type: 'bridge.starting' });
			bridgeProvider.setPublicMcpUrl(undefined);
			publishBridgeUiSnapshot();
			bridgeProvider.post({ kind: 'event', event: { type: 'bridge.starting', permissionMode: 'auto', accessScope: 'workspace', authMode: settings.authMode, provider: tunnel.provider } });
			const info = await getBridgeClient().start({
				workspace: root,
				allowWrite: true,
				accessScope: 'workspace',
				authMode: settings.authMode,
				browserOriginMode: settings.browserOriginMode,
				browserOrigins: settings.browserOrigins,
				tunnel,
				oauth,
				onEvent: event => {
					agentActivityTerminal.accept(event);
					if (event.type === 'bridge.call') recordToolCallUsage();
					const uiEvent = sanitizeBridgeEventForUi(event);
					const activeEvent = activeBridgeUiRunId === runId;
					if (event.type === 'bridge.tunnel_health' && activeEvent) {
						uiEvent.latencyMs = mcpHealthStartedAt === undefined ? undefined : Math.max(0, Date.now() - mcpHealthStartedAt);
						mcpHealthStartedAt = undefined;
					}
					if (event.type === 'bridge.access_scope_changed' && pendingAccessScope) {
						const scope = event.accessScope === 'computer' ? 'computer' : event.accessScope === 'workspace' ? 'workspace' : undefined;
						if (scope && scope === pendingAccessScope.scope) {
							if (bridgeReady) bridgeReady.accessScope = scope;
							finishAccessScopeOperation(true);
						}
					}
					if (activeEvent && bridgeReady && event.type === 'bridge.tunnel_status') {
						const state = typeof event.state === 'string' ? event.state : '';
						bridgeReady.tunnelStatus = {
							...bridgeReady.tunnelStatus,
							...event,
						} as BridgeTunnelStatus;
						if (state === 'public_ready' && typeof event.publicOrigin === 'string') {
							const path = new URL(bridgeReady.localUrl).pathname;
							bridgeReady.publicUrl = `${new URL(event.publicOrigin).origin}${path}`;
						} else if (state === 'degraded' || state === 'error' || state === 'stopped' || state === 'stopping') {
							bridgeReady.publicUrl = null;
						}
						bridgeProvider.setPublicMcpUrl(bridgeReady.publicUrl ?? undefined);
					}
					if (activeEvent && bridgeReady && event.type === 'bridge.tunnel_health' && event.status && typeof event.status === 'object') {
						const status = event.status as Record<string, unknown>;
						bridgeReady.tunnelStatus = {
							...bridgeReady.tunnelStatus,
							...status,
						} as BridgeTunnelStatus;
						if (status.state === 'public_ready' && typeof status.publicOrigin === 'string') {
							const path = new URL(bridgeReady.localUrl).pathname;
							bridgeReady.publicUrl = `${new URL(status.publicOrigin).origin}${path}`;
						} else if (status.state !== 'public_ready') {
							bridgeReady.publicUrl = null;
						}
						bridgeProvider.setPublicMcpUrl(bridgeReady.publicUrl ?? undefined);
					}
					persistBridgeTaskEvent(event);
					bridgeUiState.ingestEvent(runId!, uiEvent);
					publishBridgeUiSnapshot();
					bridgeProvider.post({ kind: 'event', event: uiEvent });
				},
				onIdeRequest: (request, signal) => handleBridgeIdeRequest(root, request.kind, request.args, signal),
			});
			bridgeReady = { localUrl: info.localUrl, publicUrl: info.publicUrl, permissionMode: info.permissionMode, accessScope: info.accessScope, tunnelStatus: info.tunnelStatus };
			bridgeProvider.setPublicMcpUrl(info.publicUrl ?? undefined);
			bridgeUiState.setReady(runId, {
				provider: info.tunnelStatus.provider,
				authMode: settings.authMode,
				publicReady: Boolean(info.publicUrl),
				localAvailable: true,
				permissionMode: info.permissionMode,
				accessScope: info.accessScope,
			});
			publishBridgeUiSnapshot();
			getBridgeClient().setDirtyPaths(currentBridgeDirtyPaths());
			bridgeProvider.post({ kind: 'ready', ...bridgeReady });
		} catch (error) {
			const cancelled = bridgeStartCancelled || (error instanceof Error && error.message === 'BRIDGE_START_CANCELLED');
			const message = cancelled ? '启动已取消' : redactText(error instanceof Error ? error.message : String(error), 1_000);
			agentActivityTerminal.accept(cancelled ? { type: 'bridge.cancelled', tool: 'Bridge' } : { type: 'bridge.extension_error', message });
			if (runId) {
				if (cancelled) bridgeUiState.setStopped(runId, message);
				else bridgeUiState.setError(runId, message);
				if (activeBridgeUiRunId === runId) activeBridgeUiRunId = undefined;
				if (bridgeRunWorkspaceRoots.get(runId) === activeBridgeWorkspaceRoot) activeBridgeWorkspaceRoot = undefined;
				publishBridgeUiSnapshot();
			}
			if (cancelled) bridgeProvider.post({ kind: 'stopped', reason: message });
			else bridgeProvider.post({ kind: 'error', message });
		} finally {
			bridgeStartPending = false;
			bridgeStartCancelled = false;
		}
	};

	agentProvider.onUserMessage = message => {
		if (message.type === 'run' && message.prompt) {
			void runPrompt(message.prompt);
		} else if (message.type === 'cancel') {
			void vscode.commands.executeCommand('mooncode.cancelAgent');
		}
	};
	const postUiOperationResult = (message: BridgeViewMessage, operation: string, ok: boolean, displayMessage?: string, requiresRestart = false): void => {
		const operationId = typeof message.operationId === 'string' && message.operationId.length <= 80 ? message.operationId : undefined;
		bridgeProvider.post({ kind: 'operationResult', operationId, operation, ok, message: displayMessage, requiresRestart });
	};
	const validUiIdentifier = (value: unknown, max = 240): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
	const openReviewedWorkspaceFile = async (message: BridgeViewMessage): Promise<void> => {
		const runId = validUiIdentifier(message.runId);
		const patchId = validUiIdentifier(message.patchId);
		const requestedPath = validUiIdentifier(message.path, 4_096);
		if (!runId || !patchId || !requestedPath || requestedPath.includes('\0') || isAbsolute(requestedPath)) throw new Error('无效的审阅文件路径。');
		const patch = bridgeUiState.patchDetail(runId, patchId);
		if (!patch) throw new Error('该 Patch 审阅记录已过期或不可用。');
		const file = patch.files.find(item => item.path === requestedPath);
		if (!file) throw new Error('该文件不属于当前 Patch 批次。');
		if (file.action === 'delete') throw new Error('该文件已在此 Patch 中删除，MoonCode 不会为审阅重新创建它。');
		const root = bridgeRunWorkspaceRoots.get(runId);
		if (!root) throw new Error('该运行对应的工作区根目录已不在本地审阅保留范围。');
		const lexicalTarget = join(root, requestedPath);
		const lexicalRelative = relative(root, lexicalTarget);
		if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new Error('文件路径超出当前工作区。');
		const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(lexicalTarget)]);
		const realRelative = relative(rootReal, targetReal);
		if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) throw new Error('文件真实路径超出当前工作区。');
		const info = await stat(targetReal);
		if (!info.isFile()) throw new Error('目标不是可打开的普通文件。');
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetReal));
		await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
	};

	bridgeProvider.onUserMessage = message => {
		if (message.type === 'selectWorkspace') {
			void selectBridgeWorkspace().catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'openReview') {
			bridgeReviewProvider.open({ route: 'review', tab: message.tab ?? 'activity', targetId: message.targetId });
		} else if (message.type === 'openSettings') {
			bridgeReviewProvider.openSettings(message.settingsGroup ?? 'connection');
		} else if (message.type === 'requestPatchDetail') {
			const runId = validUiIdentifier(message.runId);
			const patchId = validUiIdentifier(message.patchId);
			if (!runId || !patchId) {
				bridgeProvider.post({ kind: 'patchDetail', runId, patchId, detail: null, expired: true });
				return;
			}
			const detail = bridgeUiState.patchDetail(runId, patchId);
			bridgeProvider.post({ kind: 'patchDetail', runId, patchId, detail: detail ?? null, expired: !detail });
		} else if (message.type === 'requestCommandOutput') {
			const runId = validUiIdentifier(message.runId);
			const commandId = validUiIdentifier(message.commandId);
			const offset = Number.isSafeInteger(message.offset) && Number(message.offset) >= 0 ? Number(message.offset) : 0;
			const maxBytes = Number.isSafeInteger(message.maxBytes) ? Math.max(1, Math.min(128 * 1024, Number(message.maxBytes))) : 32 * 1024;
			const commandKnown = Boolean(runId && commandId && bridgeUiState.snapshot().commands.some(command => command.runId === runId && command.commandId === commandId));
			if (!runId || !commandId || !commandKnown || runId !== activeBridgeUiRunId || !bridgeClient?.running) {
				bridgeProvider.post({ kind: 'commandOutput', ok: false, runId, commandId, expired: true, errorCode: 'OUTPUT_EXPIRED', message: '该命令输出已不属于当前运行，或 Runtime 已停止。历史元数据仍可阅读，但正文不可伪造恢复。' });
				return;
			}
			void bridgeClient.getCommandOutput(commandId, offset, maxBytes).then(output => {
				bridgeUiState.updateCommandOutput(runId, commandId, output);
				publishBridgeUiSnapshot();
				bridgeProvider.post({ kind: 'commandOutput', ok: true, runId, commandId, requestedOffset: offset, output });
			}, error => {
				const rawMessage = error instanceof Error ? error.message : String(error);
				const errorCode = error instanceof BridgeControlError ? error.code : 'COMMAND_OUTPUT_ERROR';
				const earliestMatch = /earliest_offset\s+(\d+)/i.exec(rawMessage);
				bridgeProvider.post({
					kind: 'commandOutput', ok: false, runId, commandId, requestedOffset: offset, errorCode,
					expired: errorCode === 'OUTPUT_EXPIRED' || errorCode === 'NOT_FOUND',
					earliestOffset: earliestMatch ? Number(earliestMatch[1]) : undefined,
					message: redactText(rawMessage, 500),
				});
			});
		} else if (message.type === 'markReviewed') {
			const runId = validUiIdentifier(message.runId);
			const patchId = validUiIdentifier(message.patchId);
			const reviewed = message.reviewed === true;
			if (!runId || !patchId || !bridgeUiState.markPatchReviewed(runId, patchId, reviewed)) {
				bridgeProvider.post({ kind: 'reviewResult', ok: false, runId, patchId, message: '该 Patch 审阅记录已过期或不可用。' });
				return;
			}
			void context.workspaceState.update(BRIDGE_REVIEWED_PATCHES_KEY, bridgeUiState.reviewedPatchesSnapshot());
			publishBridgeUiSnapshot();
			bridgeProvider.post({ kind: 'reviewResult', ok: true, runId, patchId, reviewed });
		} else if (message.type === 'openWorkspaceFile') {
			void openReviewedWorkspaceFile(message).then(
				() => bridgeProvider.post({ kind: 'openFileResult', ok: true, runId: message.runId, patchId: message.patchId, path: message.path }),
				error => bridgeProvider.post({ kind: 'openFileResult', ok: false, runId: message.runId, patchId: message.patchId, path: message.path, message: redactText(error instanceof Error ? error.message : String(error), 500) }),
			);
		} else if (message.type === 'start') {
			void startBridge(false, message.tunnel);
		} else if (message.type === 'saveAccountSettings') {
			void saveCloudAccountSettings(message.account).then(
				() => postUiOperationResult(message, 'saveAccountSettings', true, 'Cloud API 配置已保存。'),
				error => postUiOperationResult(message, 'saveAccountSettings', false, redactText(error instanceof Error ? error.message : String(error), 1_000)),
			);
		} else if (message.type === 'loginAccount' && (message.accountProvider === 'github' || message.accountProvider === 'gitee')) {
			void startCloudAccountLogin(message.accountProvider).catch(error => {
				bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) });
			});
		} else if (message.type === 'cancelAccountLogin') {
			cancelCloudAccountLogin();
		} else if (message.type === 'refreshAccount') {
			void refreshCloudAccountState();
		} else if (message.type === 'activateDevice') {
			void activateCloudDevice().catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'purchasePlan' && typeof message.planCode === 'string') {
			void purchaseCloudPlan(message.planCode).catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'redeemActivation' && typeof message.activationCode === 'string') {
			void redeemCloudActivationCode(message.activationCode).then(
				() => postUiOperationResult(message, 'redeemActivation', true, '激活码兑换成功，账号权益已更新。'),
				error => postUiOperationResult(message, 'redeemActivation', false, redactText(error instanceof Error ? error.message : String(error), 1_000)),
			);
		} else if (message.type === 'logoutAccount') {
			void logoutCloudAccount().then(
				() => vscode.window.showInformationMessage('MoonCode：账号已退出并撤销当前 Cloud session。'),
				error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }),
			);
		} else if (message.type === 'saveOAuthSettings') {
			void saveOAuthSettings(message.oauth).then(
				() => postUiOperationResult(message, 'saveOAuthSettings', true, 'OAuth Resource 配置已保存。'),
				error => postUiOperationResult(message, 'saveOAuthSettings', false, redactText(error instanceof Error ? error.message : String(error), 1_000)),
			);
		} else if (message.type === 'saveAdvancedSettings') {
			if (bridgeClient?.running) {
				postUiOperationResult(message, 'saveAdvancedSettings', false, '请先停止 Bridge，再修改 OAuth 高级配置。');
				return;
			}
			void (async () => {
				await saveOAuthSettings(message.oauth);
				const settings = await saveTunnelSettings(message.tunnel);
				await reportTunnelDependency(settings.provider, settings);
			})().then(
				() => postUiOperationResult(message, 'saveAdvancedSettings', true, '高级设置已保存。'),
				error => postUiOperationResult(message, 'saveAdvancedSettings', false, redactText(error instanceof Error ? error.message : String(error), 1_000)),
			);
		} else if (message.type === 'rotateEndpoint') {
			void rotateEndpoint().catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'saveTunnelSettings') {
			void saveTunnelSettings(message.tunnel).then(async settings => {
				await reportTunnelDependency(settings.provider, settings);
				postUiOperationResult(message, 'saveTunnelSettings', true, 'Bridge 设置已保存。', Boolean(bridgeClient?.running));
			},
				error => postUiOperationResult(message, 'saveTunnelSettings', false, redactText(error instanceof Error ? error.message : String(error), 1_000)),
			);
		} else if (message.type === 'setTunnelCredential') {
			const provider = normalizeTunnelProvider(message.provider);
			if (provider !== 'cloudflare-named' && provider !== 'ngrok') {
				void vscode.window.showInformationMessage('This tunnel provider does not require a stored transport credential.');
				return;
			}
			void vscode.window.showInputBox({
				prompt: provider === 'cloudflare-named' ? 'Cloudflare Named Tunnel token' : 'ngrok authtoken',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'Stored only in VS Code SecretStorage',
			}).then(async value => {
				if (!value) return;
				await context.secrets.store(provider === 'cloudflare-named' ? CLOUDFLARE_TUNNEL_TOKEN_SECRET : NGROK_AUTHTOKEN_SECRET, value.trim());
				await refreshTunnelUiSettings();
				void vscode.window.showInformationMessage('MoonCode tunnel credential stored in SecretStorage.');
			});
		} else if (message.type === 'clearTunnelCredential') {
			const provider = normalizeTunnelProvider(message.provider);
			if (provider !== 'cloudflare-named' && provider !== 'ngrok') return;
			void context.secrets.delete(provider === 'cloudflare-named' ? CLOUDFLARE_TUNNEL_TOKEN_SECRET : NGROK_AUTHTOKEN_SECRET).then(async () => {
				await refreshTunnelUiSettings();
				void vscode.window.showInformationMessage('MoonCode tunnel credential cleared.');
			});
		} else if (message.type === 'checkTunnelDependency') {
			if (!allowTunnelConfiguration()) return;
			void reportTunnelDependency(normalizeTunnelProvider(message.provider));
		} else if (message.type === 'chooseTunnelExecutable') {
			if (!allowTunnelConfiguration()) return;
			void chooseTunnelExecutable(normalizeTunnelProvider(message.provider));
		} else if (message.type === 'installTunnelDependency') {
			if (!allowTunnelConfiguration()) return;
			void installCloudflaredDependency(normalizeTunnelProvider(message.provider)).catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'openTunnelInstallPage') {
			if (!allowTunnelConfiguration()) return;
			void openTunnelInstallPage(normalizeTunnelProvider(message.provider));
		} else if (message.type === 'copyTunnelGuideCommand' && message.guideCommand && cloudflareGuideCommands[message.guideCommand]) {
			if (!allowTunnelConfiguration()) return;
			void vscode.env.clipboard.writeText(cloudflareGuideCommands[message.guideCommand]).then(
				() => bridgeProvider.post({ kind: 'guideCopyResult', ok: true, guideCommand: message.guideCommand }),
				error => bridgeProvider.post({ kind: 'guideCopyResult', ok: false, guideCommand: message.guideCommand, message: redactText(error instanceof Error ? error.message : String(error), 300) }),
			);
		} else if (message.type === 'openTunnelGuideLink' && message.guideLink && cloudflareGuideLinks[message.guideLink]) {
			if (!allowTunnelConfiguration()) return;
			void vscode.env.openExternal(vscode.Uri.parse(cloudflareGuideLinks[message.guideLink]));
		} else if (message.type === 'checkTunnel') {
			if (!bridgeClient?.running) {
				void vscode.window.showWarningMessage('MoonCode：请先启动 Bridge。');
				return;
			}
			if (mcpHealthStartedAt !== undefined) return;
			mcpHealthStartedAt = Date.now();
			bridgeUiState.setMcpHealthChecking();
			publishBridgeUiSnapshot();
			bridgeClient.checkTunnelHealth();
		} else if (message.type === 'retryPublicTunnel') {
			if (!bridgeClient?.running || !activeBridgeUiRunId || !bridgeReady) {
				bridgeProvider.post({ kind: 'operationResult', operation: 'retryPublicTunnel', ok: false, message: '请先启动 Bridge。' });
				return;
			}
			if (bridgeReady.tunnelStatus.provider === 'none') {
				bridgeProvider.post({ kind: 'operationResult', operation: 'retryPublicTunnel', ok: false, message: '当前是仅本机 Bridge，不需要重试公网连接。' });
				return;
			}
			bridgeReady.publicUrl = null;
			bridgeProvider.setPublicMcpUrl(undefined);
			bridgeUiState.ingestEvent(activeBridgeUiRunId, {
				type: 'bridge.tunnel_status',
				state: 'connecting',
				provider: bridgeReady.tunnelStatus.provider,
				message: '正在重试公网连接…',
			});
			publishBridgeUiSnapshot();
			bridgeClient.retryPublicTunnel();
			bridgeProvider.post({ kind: 'operationResult', operation: 'retryPublicTunnel', ok: true, message: '已开始重试公网连接。' });
		} else if (message.type === 'setAccessScope') {
			const scope: BridgeAccessScope = message.accessScope === 'computer' ? 'computer' : 'workspace';
			if (!bridgeClient?.running || !activeBridgeUiRunId) {
				bridgeProvider.post({ kind: 'operationResult', operation: 'setAccessScope', ok: false, message: '请先启动 Bridge。' });
				return;
			}
			if (pendingAccessScope) {
				bridgeProvider.post({ kind: 'operationResult', operation: 'setAccessScope', ok: false, message: '权限范围正在切换，请稍候。' });
				return;
			}
			void (async () => {
				if (scope === 'computer') {
					const choice = await vscode.window.showWarningMessage(
						'MoonCode：整台电脑权限允许远端 AI 访问本机其他位置，并允许执行终端命令。只应在你信任当前连接和会话时开启。',
						{ modal: true },
						'允许访问整台电脑',
					);
					if (choice !== '允许访问整台电脑') {
						bridgeProvider.post({ kind: 'operationResult', operation: 'setAccessScope', ok: false, message: '已取消权限切换。' });
						return;
					}
				}
				pendingAccessScope = {
					scope,
					timer: setTimeout(() => finishAccessScopeOperation(false, '权限范围切换超时，仍保持 Runtime 最后确认的状态。'), 5_000),
				};
				pendingAccessScope.timer.unref?.();
				bridgeClient!.setAccessScope(scope);
			})().catch(error => bridgeProvider.post({ kind: 'operationResult', operation: 'setAccessScope', ok: false, message: redactText(error instanceof Error ? error.message : String(error), 500) }));
		} else if (message.type === 'stop') {
			void stopActiveBridge('stopped by local user').catch(() => undefined);
		} else if (message.type === 'copy') {
			const value = message.which === 'public' ? bridgeReady?.publicUrl : bridgeReady?.localUrl;
			if (value) {
				void vscode.env.clipboard.writeText(value).then(
					() => {
						bridgeUiState.setMcpCopyState(true);
						publishBridgeUiSnapshot();
						bridgeProvider.post({ kind: 'copyResult', ok: true, which: message.which });
					},
					error => bridgeProvider.post({ kind: 'copyResult', ok: false, which: message.which, message: redactText(error instanceof Error ? error.message : String(error), 300) }),
				);
			} else {
				bridgeProvider.post({ kind: 'copyResult', ok: false, which: message.which, message: '当前连接地址不可复制。' });
			}
		} else if (message.type === 'copyPrompt') {
			const url = bridgeReady?.publicUrl;
			if (!url) {
				bridgeProvider.post({ kind: 'copyResult', ok: false, which: 'prompt', message: '只有公网隧道达到 public_ready 后才能复制远端连接说明。' });
				return;
			}
			void vscode.env.clipboard.writeText([
				'请通过 MCP 连接我的本机 MoonCode 工作区。',
				'MCP Streamable HTTP 地址：' + url,
				'可用工具：list_directory, find_files, read_files, search_files, apply_patch, lsp, get_diagnostics, run_command, get_command_output, send_command_input, wait, set_todos, report_progress, read_file, write_file。路径相对于已打开的文件夹。',
				'先使用只读工具确认上下文；需要写入时优先 apply_patch，并携带 read_files 返回的 expected_versions。',
				'公网连接不等于自动写入授权；MoonCode 每次启动默认只读，写入和终端还需要本机显式开启以及 OAuth scope 同时允许。',
			].join('\n')).then(
				() => bridgeProvider.post({ kind: 'copyResult', ok: true, which: 'prompt' }),
				error => bridgeProvider.post({ kind: 'copyResult', ok: false, which: 'prompt', message: redactText(error instanceof Error ? error.message : String(error), 300) }),
			);
		} else if (message.type === 'openShortcut' && typeof message.shortcutId === 'string') {
			void openBrowserShortcut(message.shortcutId).catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'addShortcut') {
			void addBrowserShortcut(message.shortcut).catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'removeShortcut' && typeof message.shortcutId === 'string') {
			void removeBrowserShortcut(message.shortcutId).catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'checkLegacyCards') {
			void refreshLegacyCards().catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		} else if (message.type === 'cleanLegacyCards') {
			void cleanLegacyCards().catch(error => bridgeProvider.post({ kind: 'error', message: redactText(error instanceof Error ? error.message : String(error), 1_000) }));
		}
	};
	bridgeReviewProvider.onUserMessage = bridgeProvider.onUserMessage;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(AgentViewProvider.viewId, agentProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerWebviewViewProvider(BridgeViewProvider.viewId, bridgeProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('mooncode.openAgent', async () => {
			agentProvider.reveal();
			const prompt = await vscode.window.showInputBox({
				prompt: 'MoonCode Agent Task',
				value: '读取 README.md',
			});
			if (prompt) await runPrompt(prompt);
		}),
		vscode.commands.registerCommand('mooncode.cancelAgent', () => {
			if (currentRequestId) getRuntimeClient().cancel(currentRequestId);
		}),
		vscode.commands.registerCommand('mooncode.openBridge', () => bridgeProvider.reveal()),
		vscode.commands.registerCommand('mooncode.startBridge', () => startBridge(false)),
		vscode.commands.registerCommand('mooncode.stopBridge', () => {
			void stopActiveBridge('stopped by command').catch(() => undefined);
		}),
		vscode.commands.registerCommand('mooncode.copyMcpUrl', async () => {
			const provider = bridgeReady?.tunnelStatus.provider;
			const value = provider === 'none' ? bridgeReady?.localUrl : bridgeReady?.publicUrl;
			if (value) {
				await vscode.env.clipboard.writeText(value);
				bridgeUiState.setMcpCopyState(true);
				publishBridgeUiSnapshot();
			}
			else void vscode.window.showWarningMessage('MoonCode：公网 Bridge 尚未达到 public_ready。');
		}),
		vscode.commands.registerCommand('mooncode.rotateBridgeEndpoint', () => rotateEndpoint()),
		vscode.commands.registerCommand('mooncode.openChatGPT', () => openBrowserShortcut('chatgpt')),
		vscode.window.registerWebviewPanelSerializer(BridgeReviewProvider.viewType, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				bridgeReviewProvider.attachPanel(panel, 'review');
			},
		}),
		vscode.window.registerWebviewPanelSerializer(BridgeReviewProvider.settingsViewType, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				bridgeReviewProvider.attachPanel(panel, 'settings');
			},
		}),
		vscode.window.registerWebviewPanelSerializer('mooncode.bridgePanel', {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				bridgeReviewProvider.attachPanel(panel, 'review');
			},
		}),
		vscode.workspace.onDidOpenTextDocument(() => scheduleDirtySync()),
		vscode.workspace.onDidChangeTextDocument(() => scheduleDirtySync()),
		vscode.workspace.onDidSaveTextDocument(() => scheduleDirtySync()),
		vscode.workspace.onDidCloseTextDocument(() => scheduleDirtySync()),
		{ dispose: () => { if (dirtySyncTimer) clearTimeout(dirtySyncTimer); } },
	);

	const cloudAuthorizationTimer = setInterval(() => {
		if (!bridgeClient?.running) return;
		void enforceCloudBridgeAuthorization(false).catch(async error => {
			if (!bridgeClient?.running) return;
			await stopActiveBridge('Cloud authorization watchdog failed closed');
			void vscode.window.showWarningMessage(`MoonCode Bridge 已停止：${redactText(error instanceof Error ? error.message : String(error), 300)}`);
		});
	}, 60_000);
	cloudAuthorizationTimer.unref?.();
	context.subscriptions.push({ dispose: () => clearInterval(cloudAuthorizationTimer) });
	const usageFlushTimer = setInterval(() => {
		void flushToolCallUsage();
	}, 10 * 60 * 1000);
	usageFlushTimer.unref?.();
	context.subscriptions.push({ dispose: () => clearInterval(usageFlushTimer) });

	void vscode.commands.executeCommand('workbench.view.extension.mooncode');
	void (async () => {
		refreshOAuthUiSettings();
		refreshBrowserShortcuts();
		await refreshLegacyCards();
		await refreshCloudAccountState();
		const settings = await refreshTunnelUiSettings();
		if (!settings.persistentMode || settings.provider === 'none') return;
		// BRIDGE-003 invariant: persistent transport recovery never restores auto
		// write/exec authority. startBridge always launches Runtime read-only.
		await startBridge(false, undefined, true);
	})();
}

export function deactivate(): void { }
