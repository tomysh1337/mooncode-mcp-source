import { createHash } from 'node:crypto';

export type BridgeUiCallStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type BridgeUiPermissionMode = 'read_only' | 'auto';
export type BridgeUiAccessScope = 'workspace' | 'computer';
export type BridgeUiConnectionPhase = 'stopped' | 'starting' | 'local_ready' | 'connecting' | 'public_ready' | 'degraded' | 'stopping' | 'error';
export type BridgeProductFlowPhase = 'stopped' | 'starting' | 'connecting' | 'public_ready' | 'degraded' | 'stopping' | 'error';

export interface SelectedWorkspaceState { name: string; path: string; available: boolean; updatedAt: string; }
export interface ActiveBridgeWorkspace { runId: string | null; name: string; path: string; boundAt?: string; }
export interface AccountState {
	configured: boolean;
	status: 'unconfigured' | 'signed_out' | 'signing_in' | 'signed_in' | 'error';
	accountId?: string;
	displayName?: string;
	identities: Array<{ id: string; provider: string; username?: string; displayName?: string }>;
	updatedAt: string;
}
export interface EntitlementState { status: 'unknown' | 'none' | 'active' | 'expired'; planId?: string; planCode?: string; planName?: string; expiresAt?: string; deviceLimit?: number; updatedAt: string; }
export interface DeviceState { status: 'unknown' | 'unauthorized' | 'authorized'; id?: string; lastSeenAt?: string; authorizationValidUntil?: string; activeDeviceCount?: number; actionRequired: boolean; updatedAt: string; }
export interface PaymentState { status: 'idle' | 'creating' | 'pending' | 'paid' | 'expired' | 'failed'; planCode?: string; orderId?: string; expiresAt?: string; errorCode?: string; message?: string; updatedAt: string; }
export interface BridgeState { runId: string | null; phase: BridgeProductFlowPhase; provider: BridgeUiConnection['provider']; authMode: BridgeUiConnection['authMode']; permissionMode: BridgeUiPermissionMode; accessScope: BridgeUiAccessScope; updatedAt: string; }
export interface McpCopyState { status: 'idle' | 'copied'; copiedAt?: string; updatedAt: string; }
export interface McpHealthState { status: 'idle' | 'checking' | 'healthy' | 'degraded'; checkedAt?: string; latencyMs?: number; errorCode?: string; message?: string; updatedAt: string; }
export interface BridgeProductFlowState {
	selectedWorkspace: SelectedWorkspaceState;
	activeBridgeWorkspace: ActiveBridgeWorkspace;
	account: AccountState;
	entitlement: EntitlementState;
	device: DeviceState;
	payment: PaymentState;
	bridge: BridgeState;
	mcpCopy: McpCopyState;
	mcpHealth: McpHealthState;
}
export interface BridgeUiCommercialStateInput {
	configured: boolean;
	status: AccountState['status'];
	accountId?: string;
	displayName?: string;
	identities?: AccountState['identities'];
	entitlement?: { planId: string; planCode: string; planName: string; expiresAt?: string; deviceLimit: number };
	device?: { id: string; authorized: boolean; lastSeenAt?: string; authorizationValidUntil?: string };
	activeDeviceCount?: number;
	deviceActionRequired?: boolean;
}

export interface BridgeUiTaskTodo {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
}

export interface BridgeUiTaskProgress {
	seq: number;
	todo_id: string | null;
	message: string;
	created_at: string;
}

export interface BridgeUiTaskState {
	version: number;
	todos: BridgeUiTaskTodo[];
	updated_at: string;
	progress: BridgeUiTaskProgress[];
}

export interface BridgeUiConnection {
	phase: BridgeUiConnectionPhase;
	provider: 'none' | 'cloudflare-quick' | 'cloudflare-named' | 'ngrok';
	authMode: 'capability_url' | 'oauth';
	localAvailable: boolean;
	publicReady: boolean;
	attempt?: number;
	message?: string;
	errorCode?: string;
	updatedAt: string;
}

export interface BridgeUiCall {
	runId: string;
	callId: string;
	tool: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	status: BridgeUiCallStatus;
	targetSummary?: string;
	resultSummary?: string;
	todoId?: string;
	commandId?: string;
	transactionId?: string;
	errorCode?: string;
}

export interface BridgeUiPatchFile {
	path: string;
	action: 'add' | 'update' | 'delete' | 'move' | 'unknown';
	oldPath?: string;
	beforeVersion?: string | null;
	version?: string;
}

export interface BridgeUiPatch {
	runId: string;
	id: string;
	callId: string;
	transactionId?: string;
	createdAt: string;
	files: BridgeUiPatchFile[];
	applied: boolean;
	rolledBack: boolean;
	recoveryRequired: boolean;
	diffTruncated: boolean;
	errorCode?: string;
	reviewVersion: string;
	reviewed: boolean;
	bodyExpired?: boolean;
}

export interface BridgeUiPatchDetail extends BridgeUiPatch {
	diff: string;
}

export interface BridgeUiReviewedPatch {
	runId: string;
	patchId: string;
	reviewVersion: string;
}

export interface BridgeUiCommand {
	runId: string;
	commandId: string;
	callId: string;
	commandSummary?: string;
	cwd?: string;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	status: 'running' | 'completed' | 'failed' | 'unknown';
	exitCode?: number | null;
	earliestOffset?: number;
	nextOffset?: number;
	outputLost?: boolean;
}

export interface BridgeUiLogEntry {
	id: number;
	runId: string | null;
	at: string;
	level: 'info' | 'warning' | 'error';
	type: string;
	message: string;
	callId?: string;
}

export interface BridgeUiSnapshot {
	revision: number;
	runId: string | null;
	workspaceName: string;
	workspacePath: string;
	connection: BridgeUiConnection;
	permissionMode: BridgeUiPermissionMode;
	tasks: BridgeUiTaskState;
	calls: BridgeUiCall[];
	patches: BridgeUiPatch[];
	commands: BridgeUiCommand[];
	logs: BridgeUiLogEntry[];
	productFlow: BridgeProductFlowState;
	retention: {
		retainedRuns: number;
		maxRuns: number;
		metadataCount: number;
		maxMetadata: number;
		metadataEvicted: number;
		bodyBytes: number;
		maxBodyBytes: number;
		bodyEvicted: number;
	};
}

const EMPTY_TASKS: BridgeUiTaskState = { version: 0, todos: [], updated_at: '', progress: [] };
const MAX_RUNS = 5;
const MAX_METADATA = 1_000;
const MAX_REVIEWED_PATCHES = 500;
const MAX_DIFF_CHARS = 120_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function nowIso(): string {
	return new Date().toISOString();
}

function stringValue(value: unknown, max = 2_000): string | undefined {
	return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function integerValue(value: unknown): number | undefined {
	return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function emptyProductFlowState(): BridgeProductFlowState {
	const at = nowIso();
	return {
		selectedWorkspace: { name: '', path: '', available: false, updatedAt: at },
		activeBridgeWorkspace: { runId: null, name: '', path: '' },
		account: { configured: false, status: 'unconfigured', identities: [], updatedAt: at },
		entitlement: { status: 'unknown', updatedAt: at },
		device: { status: 'unknown', actionRequired: false, updatedAt: at },
		payment: { status: 'idle', updatedAt: at },
		bridge: { runId: null, phase: 'stopped', provider: 'none', authMode: 'capability_url', permissionMode: 'read_only', accessScope: 'workspace', updatedAt: at },
		mcpCopy: { status: 'idle', updatedAt: at },
		mcpHealth: { status: 'idle', updatedAt: at },
	};
}

function copyProductFlowState(state: BridgeProductFlowState): BridgeProductFlowState {
	return {
		selectedWorkspace: { ...state.selectedWorkspace }, activeBridgeWorkspace: { ...state.activeBridgeWorkspace },
		account: { ...state.account, identities: state.account.identities.map(identity => ({ ...identity })) }, entitlement: { ...state.entitlement }, device: { ...state.device },
		payment: { ...state.payment }, bridge: { ...state.bridge }, mcpCopy: { ...state.mcpCopy }, mcpHealth: { ...state.mcpHealth },
	};
}

function patchAction(raw: unknown): BridgeUiPatchFile['action'] {
	if (raw === 'add' || raw === 'update' || raw === 'delete' || raw === 'move') return raw;
	return 'unknown';
}

function copyTaskState(state: BridgeUiTaskState): BridgeUiTaskState {
	return {
		version: state.version,
		todos: state.todos.map(todo => ({ ...todo })),
		updated_at: state.updated_at,
		progress: state.progress.map(item => ({ ...item })),
	};
}

function parsePatchFiles(value: unknown): BridgeUiPatchFile[] {
	if (!Array.isArray(value)) return [];
	const files: BridgeUiPatchFile[] = [];
	for (const raw of value.slice(0, 500)) {
		if (!raw || typeof raw !== 'object') continue;
		const item = raw as Record<string, unknown>;
		const path = stringValue(item.path, 4_096) ?? stringValue(item.new_path, 4_096) ?? stringValue(item.newPath, 4_096);
		if (!path) continue;
		files.push({
			path,
			action: patchAction(item.action ?? item.kind ?? item.operation),
			oldPath: stringValue(item.source_path, 4_096) ?? stringValue(item.old_path, 4_096) ?? stringValue(item.oldPath, 4_096),
			beforeVersion: item.before_version === null ? null : stringValue(item.before_version, 200) ?? stringValue(item.beforeVersion, 200),
			version: stringValue(item.after_version, 200) ?? stringValue(item.version, 200) ?? stringValue(item.new_version, 200),
		});
	}
	return files;
}

function patchReviewVersion(files: readonly BridgeUiPatchFile[], diffTruncated: boolean): string {
	return `sha256:${createHash('sha256').update(JSON.stringify({
		files: files.map(file => ({ action: file.action, path: file.path, oldPath: file.oldPath, beforeVersion: file.beforeVersion, version: file.version })),
		diffTruncated,
	})).digest('hex')}`;
}

function commandStatus(value: unknown, exitCode: number | null | undefined, ok: boolean): BridgeUiCommand['status'] {
	if (value === 'running') return 'running';
	if (value === 'completed' || value === 'exited' || value === 'done') return exitCode === 0 || exitCode === null || exitCode === undefined ? 'completed' : 'failed';
	if (!ok) return 'failed';
	return exitCode === undefined ? 'unknown' : exitCode === 0 || exitCode === null ? 'completed' : 'failed';
}

/** Extension-Host-owned, redacted metadata shared by the Bridge sidebar and review panel. */
export class BridgeUiStateStore {
	private revision = 0;
	private runId: string | null = null;
	private workspaceName = '';
	private workspacePath = '';
	private permissionMode: BridgeUiPermissionMode = 'read_only';
	private accessScope: BridgeUiAccessScope = 'workspace';
	private connection: BridgeUiConnection = { phase: 'stopped', provider: 'none', authMode: 'capability_url', localAvailable: false, publicReady: false, updatedAt: nowIso() };
	private tasks: BridgeUiTaskState = copyTaskState(EMPTY_TASKS);
	private readonly calls = new Map<string, BridgeUiCall>();
	private readonly patches = new Map<string, BridgeUiPatchDetail>();
	private readonly commands = new Map<string, BridgeUiCommand>();
	private readonly reviewedPatches = new Map<string, string>();
	private readonly retainedRuns: string[] = [];
	private logs: BridgeUiLogEntry[] = [];
	private nextLogId = 1;
	private bodyBytes = 0;
	private metadataEvicted = 0;
	private bodyEvicted = 0;
	private productFlow = emptyProductFlowState();

	setWorkspace(name: string, path: string): void {
		if (this.workspaceName === name && this.workspacePath === path) return;
		this.workspaceName = name;
		this.workspacePath = path;
		this.productFlow.selectedWorkspace = { name, path, available: Boolean(path), updatedAt: nowIso() };
		this.bump();
	}

	setCommercialState(input: BridgeUiCommercialStateInput): void {
		const at = nowIso();
		this.productFlow.account = { configured: input.configured, status: input.status, accountId: input.accountId, displayName: input.displayName, identities: (input.identities ?? []).map(identity => ({ ...identity })), updatedAt: at };
		if (!input.configured || input.status !== 'signed_in') {
			this.productFlow.entitlement = { status: input.configured ? 'none' : 'unknown', updatedAt: at };
			this.productFlow.device = { status: 'unknown', actionRequired: false, updatedAt: at };
		} else {
			const expires = input.entitlement?.expiresAt ? Date.parse(input.entitlement.expiresAt) : Number.NaN;
			this.productFlow.entitlement = input.entitlement ? { status: Number.isFinite(expires) && expires <= Date.now() ? 'expired' : 'active', ...input.entitlement, updatedAt: at } : { status: 'none', updatedAt: at };
			this.productFlow.device = input.device ? { status: input.device.authorized ? 'authorized' : 'unauthorized', id: input.device.id, lastSeenAt: input.device.lastSeenAt, authorizationValidUntil: input.device.authorizationValidUntil, activeDeviceCount: input.activeDeviceCount, actionRequired: input.deviceActionRequired === true, updatedAt: at } : { status: 'unknown', activeDeviceCount: input.activeDeviceCount, actionRequired: input.deviceActionRequired === true, updatedAt: at };
		}
		this.bump();
	}

	setPaymentState(patch: Omit<PaymentState, 'updatedAt'>): void { this.productFlow.payment = { ...patch, updatedAt: nowIso() }; this.bump(); }
	setMcpCopyState(copied: boolean): void { const at = nowIso(); this.productFlow.mcpCopy = copied ? { status: 'copied', copiedAt: at, updatedAt: at } : { status: 'idle', updatedAt: at }; this.bump(); }
	setMcpHealthChecking(): void { this.productFlow.mcpHealth = { status: 'checking', updatedAt: nowIso() }; this.bump(); }

	startRun(runId: string, authMode: BridgeUiConnection['authMode'], provider: BridgeUiConnection['provider'], activeWorkspace?: { name: string; path: string }, accessScope: BridgeUiAccessScope = 'workspace'): void {
		if (!runId) throw new Error('Bridge UI runId is required');
		this.runId = runId;
		this.permissionMode = 'read_only';
		this.accessScope = accessScope;
		this.connection = { phase: 'starting', provider, authMode, localAvailable: false, publicReady: false, updatedAt: nowIso() };
		const at = nowIso();
		this.productFlow.activeBridgeWorkspace = { runId, name: activeWorkspace?.name ?? this.workspaceName, path: activeWorkspace?.path ?? this.workspacePath, boundAt: at };
		this.productFlow.bridge = { runId, phase: 'starting', provider, authMode, permissionMode: 'read_only', accessScope, updatedAt: at };
		this.productFlow.mcpCopy = { status: 'idle', updatedAt: at };
		this.productFlow.mcpHealth = { status: 'idle', updatedAt: at };
		this.retainedRuns.push(runId);
		while (this.retainedRuns.length > MAX_RUNS) {
			const dropped = this.retainedRuns.shift();
			if (dropped) this.dropRun(dropped, true);
		}
		this.appendLog(runId, 'info', 'bridge.starting', '正在启动 Bridge');
		this.bump();
	}

	setReady(runId: string, input: { provider: BridgeUiConnection['provider']; authMode: BridgeUiConnection['authMode']; publicReady: boolean; localAvailable: boolean; permissionMode: BridgeUiPermissionMode; accessScope: BridgeUiAccessScope }): void {
		if (runId !== this.runId) return;
		this.permissionMode = input.permissionMode;
		this.accessScope = input.accessScope;
		const tunnelFailurePhase = this.connection.phase === 'error' || this.connection.phase === 'degraded' ? this.connection.phase : undefined;
		const phase = input.publicReady ? 'public_ready' : tunnelFailurePhase ?? (input.provider === 'none' ? 'local_ready' : 'connecting');
		this.connection = {
			...this.connection,
			phase,
			provider: input.provider, authMode: input.authMode, localAvailable: input.localAvailable, publicReady: input.publicReady, updatedAt: nowIso(),
		};
		this.productFlow.bridge = { runId, phase: this.connection.phase === 'local_ready' ? 'connecting' : this.connection.phase, provider: input.provider, authMode: input.authMode, permissionMode: input.permissionMode, accessScope: input.accessScope, updatedAt: nowIso() };
		this.bump();
	}

	setStopping(runId: string | null, reason?: string): void {
		if (runId && this.runId && runId !== this.runId) return;
		this.permissionMode = 'read_only';
		this.accessScope = 'workspace';
		const at = nowIso();
		this.connection = { ...this.connection, phase: 'stopping', localAvailable: false, publicReady: false, message: reason, updatedAt: at };
		this.productFlow.bridge = { ...this.productFlow.bridge, runId: runId ?? this.productFlow.bridge.runId, phase: 'stopping', permissionMode: 'read_only', accessScope: 'workspace', updatedAt: at };
		this.productFlow.mcpCopy = { status: 'idle', updatedAt: at };
		this.productFlow.mcpHealth = { status: 'idle', updatedAt: at };
		if (this.runId) this.appendLog(this.runId, 'info', 'bridge.stopping', reason || '正在停止 Bridge');
		this.bump();
	}

	setStopped(runId: string | null, reason?: string): void {
		if (runId && this.runId && runId !== this.runId) return;
		this.permissionMode = 'read_only';
		this.accessScope = 'workspace';
		this.connection = { ...this.connection, phase: 'stopped', localAvailable: false, publicReady: false, message: reason, updatedAt: nowIso() };
		const at = nowIso();
		this.productFlow.bridge = { ...this.productFlow.bridge, runId: null, phase: 'stopped', permissionMode: 'read_only', accessScope: 'workspace', updatedAt: at };
		this.productFlow.activeBridgeWorkspace = { runId: null, name: '', path: '' };
		this.productFlow.mcpCopy = { status: 'idle', updatedAt: at };
		this.productFlow.mcpHealth = { status: 'idle', updatedAt: at };
		if (this.runId) this.appendLog(this.runId, 'info', 'bridge.stopped', reason || 'Bridge 已停止');
		this.bump();
	}

	setError(runId: string, message: string, errorCode?: string): void {
		if (runId !== this.runId) return;
		this.connection = { ...this.connection, phase: 'error', localAvailable: false, publicReady: false, message: message.slice(0, 500), errorCode, updatedAt: nowIso() };
		this.productFlow.bridge = { ...this.productFlow.bridge, runId, phase: 'error', updatedAt: nowIso() };
		this.productFlow.activeBridgeWorkspace = { runId: null, name: '', path: '' };
		this.appendLog(runId, 'error', 'bridge.error', message.slice(0, 1_000));
		this.bump();
	}

	setPermission(runId: string, mode: BridgeUiPermissionMode): void {
		if (runId !== this.runId) return;
		this.permissionMode = mode;
		this.productFlow.bridge = { ...this.productFlow.bridge, permissionMode: mode, updatedAt: nowIso() };
		this.bump();
	}

	setAccessScope(runId: string, scope: BridgeUiAccessScope): void {
		if (runId !== this.runId) return;
		this.accessScope = scope;
		this.productFlow.bridge = { ...this.productFlow.bridge, accessScope: scope, updatedAt: nowIso() };
		this.bump();
	}

	setTaskState(state: BridgeUiTaskState): void {
		this.tasks = copyTaskState(state);
		this.bump();
	}

	restoreReviewedPatches(value: unknown): void {
		if (!Array.isArray(value)) return;
		for (const raw of value.slice(-MAX_REVIEWED_PATCHES)) {
			if (!raw || typeof raw !== 'object') continue;
			const item = raw as Record<string, unknown>;
			const runId = stringValue(item.runId, 200);
			const patchId = stringValue(item.patchId, 200);
			const reviewVersion = stringValue(item.reviewVersion, 200);
			if (!runId || !patchId || !reviewVersion || !/^sha256:[0-9a-f]{64}$/.test(reviewVersion)) continue;
			this.reviewedPatches.set(`${runId}:${patchId}`, reviewVersion);
		}
		this.trimReviewedPatches();
	}

	reviewedPatchesSnapshot(): BridgeUiReviewedPatch[] {
		return [...this.reviewedPatches.entries()].map(([key, reviewVersion]) => {
			const separator = key.indexOf(':');
			return { runId: key.slice(0, separator), patchId: key.slice(separator + 1), reviewVersion };
		});
	}

	ingestEvent(runId: string, event: Record<string, unknown>): void {
		if (!runId) return;
		const type = stringValue(event.type, 160) ?? 'bridge.event';
		const callId = stringValue(event.callId, 160);
		const at = stringValue(event.endedAt, 80) ?? stringValue(event.startedAt, 80) ?? nowIso();
		if (runId === this.runId && (type === 'bridge.permission_mode' || type === 'bridge.mode_changed')) {
			const mode = event.mode === 'auto' ? 'auto' : event.mode === 'read_only' ? 'read_only' : undefined;
			if (mode) { this.permissionMode = mode; this.productFlow.bridge = { ...this.productFlow.bridge, permissionMode: mode, updatedAt: at }; }
			this.appendLog(runId, 'info', type, mode === 'auto' ? '权限已切换为自动' : '权限已切换为只读', callId, at);
			this.bump();
			return;
		}
		if (runId === this.runId && type === 'bridge.access_scope_changed') {
			const scope = event.accessScope === 'computer' ? 'computer' : event.accessScope === 'workspace' ? 'workspace' : undefined;
			if (scope) {
				this.accessScope = scope;
				this.productFlow.bridge = { ...this.productFlow.bridge, accessScope: scope, updatedAt: at };
				this.appendLog(runId, 'info', type, scope === 'computer' ? '权限范围已切换为整台电脑' : '权限范围已切换为当前工作区', callId, at);
				this.bump();
			}
			return;
		}
		if (type === 'bridge.call' && callId) {
			const tool = stringValue(event.tool, 160) ?? 'unknown';
			this.calls.set(`${runId}:${callId}`, { runId, callId, tool, startedAt: stringValue(event.startedAt, 80) ?? at, status: 'running', targetSummary: stringValue(event.targetSummary, 500), todoId: stringValue(event.todoId, 80) });
			this.appendLog(runId, 'info', type, `${tool} · 已开始`, callId, at);
			this.trimMetadata(); this.bump(); return;
		}
		if ((type === 'bridge.result' || type === 'bridge.cancelled') && callId) {
			const key = `${runId}:${callId}`;
			const existing = this.calls.get(key);
			const ok = event.ok === true;
			const cancelled = type === 'bridge.cancelled';
			const tool = stringValue(event.tool, 160) ?? existing?.tool ?? 'unknown';
			const endedAt = stringValue(event.endedAt, 80) ?? at;
			const commandId = stringValue(event.commandId, 200) ?? existing?.commandId;
			this.calls.set(key, {
				...(existing ?? { runId, callId, tool, startedAt: endedAt, status: 'running' as const }), tool, endedAt,
				durationMs: integerValue(event.durationMs) ?? existing?.durationMs,
				status: cancelled ? 'cancelled' : ok ? 'succeeded' : 'failed',
				resultSummary: stringValue(event.resultSummary, 500) ?? existing?.resultSummary,
				errorCode: stringValue(event.errorCode, 160),
				transactionId: stringValue(event.transactionId, 200) ?? existing?.transactionId,
				commandId,
			});
			if (commandId) this.upsertCommand(runId, callId, event, existing?.startedAt ?? endedAt, endedAt, ok);
			this.appendLog(runId, cancelled ? 'warning' : ok ? 'info' : 'error', type, `${tool} · ${cancelled ? '已取消' : ok ? '已完成' : '失败'}`, callId, endedAt);
			this.trimMetadata(); this.bump(); return;
		}
		if (type === 'bridge.patch_result') {
			const patchCallId = callId ?? 'unknown';
			const transactionId = stringValue(event.transactionId, 200);
			const id = transactionId ?? patchCallId;
			const existing = this.patches.get(`${runId}:${id}`);
			const files = parsePatchFiles(event.files);
			const rawDiff = typeof event.diff === 'string' ? event.diff : '';
			const diffTruncated = event.diffTruncated === true || rawDiff.length > MAX_DIFF_CHARS;
			const reviewVersion = patchReviewVersion(files, diffTruncated);
			const nestedError = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
			const detail: BridgeUiPatchDetail = {
				runId, id, callId: patchCallId, transactionId, createdAt: stringValue(event.endedAt, 80) ?? existing?.createdAt ?? at,
				files, applied: event.applied === true, rolledBack: event.rolledBack === true, recoveryRequired: event.recoveryRequired === true,
				diffTruncated, errorCode: stringValue(event.errorCode, 160) ?? stringValue(nestedError?.code, 160), reviewVersion,
				reviewed: existing?.reviewVersion === reviewVersion ? existing.reviewed : this.reviewedPatches.get(`${runId}:${id}`) === reviewVersion,
				diff: rawDiff.slice(0, MAX_DIFF_CHARS), bodyExpired: false,
			};
			if (existing && !existing.bodyExpired) this.bodyBytes -= Buffer.byteLength(existing.diff, 'utf8');
			this.bodyBytes += Buffer.byteLength(detail.diff, 'utf8');
			this.patches.set(`${runId}:${id}`, detail);
			this.trimBodies();
			const call = this.calls.get(`${runId}:${patchCallId}`);
			if (call) this.calls.set(`${runId}:${patchCallId}`, { ...call, transactionId });
			this.appendLog(runId, detail.recoveryRequired ? 'error' : detail.applied ? 'info' : 'warning', type, `文件变更 · ${detail.applied ? '已应用' : detail.recoveryRequired ? '需要恢复' : detail.rolledBack ? '已回滚' : '已拒绝'}`, patchCallId, detail.createdAt);
			this.trimMetadata(); this.bump(); return;
		}
		if (runId === this.runId && (type === 'bridge.tunnel_status' || type === 'bridge.tunnel_health')) {
			const source = type === 'bridge.tunnel_health' && event.status && typeof event.status === 'object' ? event.status as Record<string, unknown> : event;
			const state = stringValue(source.state, 80);
			const healthError = type === 'bridge.tunnel_health' ? stringValue(event.error, 500) : undefined;
			const localWasReady = this.connection.localAvailable || this.connection.phase === 'local_ready' || this.connection.phase === 'connecting' || this.connection.phase === 'public_ready' || this.connection.phase === 'degraded';
			const phase = this.connection.phase === 'stopping'
				? 'stopping'
				: state === 'public_ready' ? 'public_ready' : state === 'error' ? (localWasReady ? 'degraded' : 'error') : state === 'degraded' ? 'degraded' : state === 'local_ready' ? 'local_ready' : state === 'stopping' ? 'stopping' : state === 'stopped' ? 'stopped' : 'connecting';
			this.connection = {
				...this.connection,
				phase,
				publicReady: phase === 'public_ready', localAvailable: phase !== 'stopping' && phase !== 'stopped' && (localWasReady || state === 'local_ready' || state === 'public_ready'), attempt: integerValue(source.attempt), message: healthError ?? stringValue(source.message, 500), errorCode: stringValue(source.errorCode, 160), updatedAt: at,
			};
			this.productFlow.bridge = { ...this.productFlow.bridge, phase: this.connection.phase === 'local_ready' ? 'connecting' : this.connection.phase, updatedAt: at };
			if (type === 'bridge.tunnel_health' && phase !== 'stopping') {
				const latencyMs = integerValue(event.latencyMs);
				this.productFlow.mcpHealth = state === 'public_ready' || state === 'local_ready'
					? { status: 'healthy', checkedAt: at, latencyMs, updatedAt: at }
					: { status: 'degraded', checkedAt: at, latencyMs, errorCode: stringValue(source.errorCode, 160), message: healthError ?? stringValue(source.message, 500), updatedAt: at };
			}
		}
		const level: BridgeUiLogEntry['level'] = type.includes('error') || type.includes('stderr') ? 'error' : type.includes('cancel') || type.includes('degraded') ? 'warning' : 'info';
		this.appendLog(runId, level, type, stringValue(event.message, 800) ?? stringValue(event.line, 800) ?? type, callId, at);
		this.bump();
	}

	markPatchReviewed(runId: string, patchId: string, reviewed: boolean): boolean {
		const key = `${runId}:${patchId}`;
		const patch = this.patches.get(key);
		if (!patch) return false;
		if (reviewed) this.reviewedPatches.set(key, patch.reviewVersion);
		else this.reviewedPatches.delete(key);
		this.trimReviewedPatches();
		this.patches.set(key, { ...patch, reviewed }); this.bump(); return true;
	}

	patchDetail(runId: string, patchId: string): BridgeUiPatchDetail | undefined {
		const detail = this.patches.get(`${runId}:${patchId}`);
		return detail && !detail.bodyExpired ? { ...detail, files: detail.files.map(file => ({ ...file })) } : undefined;
	}

	updateCommandOutput(runId: string, commandId: string, output: { status?: unknown; exit_code?: unknown; earliest_offset?: unknown; next_offset?: unknown; output_lost?: unknown }): boolean {
		const key = `${runId}:${commandId}`;
		const command = this.commands.get(key);
		if (!command) return false;
		const exitCode = output.exit_code === null ? null : integerValue(output.exit_code);
		const status = commandStatus(output.status, exitCode, true);
		this.commands.set(key, {
			...command,
			status,
			exitCode,
			endedAt: status === 'running' ? undefined : command.endedAt ?? nowIso(),
			earliestOffset: integerValue(output.earliest_offset) ?? command.earliestOffset,
			nextOffset: integerValue(output.next_offset) ?? command.nextOffset,
			outputLost: typeof output.output_lost === 'boolean' ? output.output_lost : command.outputLost,
		});
		this.bump();
		return true;
	}

	snapshot(): BridgeUiSnapshot {
		return {
			revision: this.revision, runId: this.runId, workspaceName: this.workspaceName, workspacePath: this.workspacePath,
			connection: { ...this.connection }, permissionMode: this.permissionMode, tasks: copyTaskState(this.tasks),
			calls: [...this.calls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(call => ({ ...call })),
			patches: [...this.patches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ diff: _diff, ...patch }) => ({ ...patch, files: patch.files.map(file => ({ ...file })) })),
			commands: [...this.commands.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(command => ({ ...command })), logs: this.logs.map(log => ({ ...log })), productFlow: copyProductFlowState(this.productFlow),
			retention: {
				retainedRuns: this.retainedRuns.length, maxRuns: MAX_RUNS, metadataCount: this.metadataCount(), maxMetadata: MAX_METADATA,
				metadataEvicted: this.metadataEvicted, bodyBytes: this.bodyBytes, maxBodyBytes: MAX_BODY_BYTES, bodyEvicted: this.bodyEvicted,
			},
		};
	}

	private upsertCommand(runId: string, callId: string, event: Record<string, unknown>, startedAt: string, endedAt: string, ok: boolean): void {
		const commandId = stringValue(event.commandId, 200); if (!commandId) return;
		const key = `${runId}:${commandId}`; const previous = this.commands.get(key); const exitCode = event.exitCode === null ? null : integerValue(event.exitCode);
		this.commands.set(key, {
			runId, commandId, callId: previous?.callId ?? callId, commandSummary: stringValue(event.commandSummary, 500) ?? previous?.commandSummary, cwd: stringValue(event.cwd, 4_096) ?? previous?.cwd,
			startedAt: previous?.startedAt ?? startedAt, endedAt: event.commandStatus === 'running' ? undefined : endedAt, durationMs: integerValue(event.durationMs) ?? previous?.durationMs,
			status: commandStatus(event.commandStatus, exitCode, ok), exitCode, earliestOffset: integerValue(event.earliestOffset) ?? previous?.earliestOffset,
			nextOffset: integerValue(event.nextOffset) ?? previous?.nextOffset, outputLost: typeof event.outputLost === 'boolean' ? event.outputLost : previous?.outputLost,
		});
	}

	private appendLog(runId: string | null, level: BridgeUiLogEntry['level'], type: string, message: string, callId?: string, at = nowIso()): void {
		this.logs.push({ id: this.nextLogId++, runId, at, level, type, message: message.slice(0, 1_000), callId });
		this.trimMetadata();
	}

	private trimMetadata(): void {
		while (this.metadataCount() > MAX_METADATA) {
			const candidates: Array<{ kind: 'call' | 'patch' | 'command' | 'log'; key: string | number; at: string }> = [];
			for (const [key, call] of this.calls) if (call.status !== 'running') candidates.push({ kind: 'call', key, at: call.endedAt ?? call.startedAt });
			for (const [key, patch] of this.patches) candidates.push({ kind: 'patch', key, at: patch.createdAt });
			for (const [key, command] of this.commands) if (command.status !== 'running') candidates.push({ kind: 'command', key, at: command.endedAt ?? command.startedAt });
			for (const log of this.logs) candidates.push({ kind: 'log', key: log.id, at: log.at });
			if (!candidates.length) break;
			candidates.sort((a, b) => a.at.localeCompare(b.at) || String(a.key).localeCompare(String(b.key)));
			const victim = candidates[0];
			if (victim.kind === 'call') this.calls.delete(String(victim.key));
			else if (victim.kind === 'patch') this.deletePatch(String(victim.key));
			else if (victim.kind === 'command') this.commands.delete(String(victim.key));
			else this.logs = this.logs.filter(log => log.id !== victim.key);
			this.metadataEvicted += 1;
		}
	}

	private metadataCount(): number {
		return this.calls.size + this.patches.size + this.commands.size + this.logs.length;
	}

	private trimBodies(): void {
		if (this.bodyBytes <= MAX_BODY_BYTES) return;
		for (const [key, patch] of this.patches) {
			if (this.bodyBytes <= MAX_BODY_BYTES) break;
			if (patch.bodyExpired || !patch.diff) continue;
			const bytes = Buffer.byteLength(patch.diff, 'utf8');
			this.bodyBytes = Math.max(0, this.bodyBytes - bytes);
			this.patches.set(key, { ...patch, diff: '', bodyExpired: true });
			this.bodyEvicted += 1;
		}
	}

	private deletePatch(key: string): boolean {
		const patch = this.patches.get(key);
		if (!patch) return false;
		if (!patch.bodyExpired) this.bodyBytes = Math.max(0, this.bodyBytes - Buffer.byteLength(patch.diff, 'utf8'));
		this.patches.delete(key);
		return true;
	}

	private trimReviewedPatches(): void {
		while (this.reviewedPatches.size > MAX_REVIEWED_PATCHES) {
			const first = this.reviewedPatches.keys().next().value as string | undefined;
			if (!first) break;
			this.reviewedPatches.delete(first);
		}
	}

	private dropRun(runId: string, countEviction = false): void {
		let removed = 0;
		for (const key of [...this.calls.keys()]) if (key.startsWith(`${runId}:`)) { this.calls.delete(key); removed += 1; }
		for (const key of [...this.patches.keys()]) if (key.startsWith(`${runId}:`)) { if (this.deletePatch(key)) removed += 1; }
		for (const key of [...this.commands.keys()]) if (key.startsWith(`${runId}:`)) { this.commands.delete(key); removed += 1; }
		const beforeLogs = this.logs.length;
		this.logs = this.logs.filter(entry => entry.runId !== runId);
		removed += beforeLogs - this.logs.length;
		for (const key of [...this.reviewedPatches.keys()]) if (key.startsWith(`${runId}:`)) this.reviewedPatches.delete(key);
		if (countEviction) this.metadataEvicted += removed;
	}

	private bump(): void { this.revision += 1; }
}
