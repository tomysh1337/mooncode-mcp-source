import * as vscode from 'vscode';
import type { BridgeUiSnapshot } from './bridgeUiState';
import { bridgeSidebarHtml } from './bridgeUiTemplates';

export interface BridgeTaskUiTodo {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
}

export interface BridgeTaskUiProgress {
	seq: number;
	todo_id: string | null;
	message: string;
	created_at: string;
}

export interface BridgeTaskUiState {
	version: number;
	todos: BridgeTaskUiTodo[];
	updated_at: string;
	progress: BridgeTaskUiProgress[];
}

export type BridgeTunnelProvider = 'none' | 'cloudflare-quick' | 'cloudflare-named' | 'ngrok';
export type BridgeAuthMode = 'capability_url' | 'oauth';
export type BridgeBrowserOriginMode = 'known' | 'custom' | 'universal_https';

export interface BridgeTunnelUiSettings {
	authMode: BridgeAuthMode;
	browserOriginMode: BridgeBrowserOriginMode;
	browserOrigins: string[];
	provider: BridgeTunnelProvider;
	publicUrl: string;
	executable: string;
	proxyUrl: string;
	proxySource?: 'manual' | 'environment' | 'vscode' | 'windows' | 'none';
	startupTimeoutMs: number;
	maxAttempts: number;
	localPort: number;
	persistentMode: boolean;
	quickLinks: boolean;
	cloudflareTokenConfigured: boolean;
	ngrokTokenConfigured: boolean;
	oauthConfigured: boolean;
}

export interface BridgeTunnelDependencyUiState {
	provider: BridgeTunnelProvider;
	status: 'checking' | 'available' | 'path_hidden' | 'missing' | 'broken' | 'version_abnormal' | 'installing' | 'install_cancelled' | 'install_failed' | 'not_required';
	installed: boolean;
	executable: string;
	resolvedExecutable?: string;
	version?: string;
	proxySummary?: string;
	error?: string;
}

export interface BridgeOAuthUiSettings {
	issuer: string;
	jwksUri: string;
	resourceId: string;
	endpointGeneration: number;
	resource: string;
	configured: boolean;
	accountStatus: string;
}

export interface BridgeAccountUiState {
	apiUrl: string;
	configured: boolean;
	status: 'unconfigured' | 'signed_out' | 'signing_in' | 'signed_in' | 'error';
	statusText: string;
	loginProvider?: 'github' | 'gitee';
	loginPhase?: 'preparing' | 'opening_browser' | 'waiting_callback' | 'failed' | 'cancelled';
	providers: string[];
	accountId?: string;
	displayName?: string;
	identities: Array<{ id: string; provider: string; username?: string; displayName?: string }>;
	entitlement?: { planId: string; planCode: string; planName: string; expiresAt?: string; deviceLimit: number };
	device?: { id: string; authorized: boolean; lastSeenAt?: string; authorizationValidUntil?: string };
	activeDeviceCount?: number;
	deviceActionRequired?: boolean;
	purchasePlans?: Array<{ code: string; displayName: string; priceCents: number; durationSeconds: number; deviceLimit: number; externalSalesUrl?: string }>;
}

export interface BridgeBrowserShortcut {
	id: string;
	label: string;
	url: string;
	openMode: 'integrated' | 'external';
	compatibility: 'target-pending' | 'reference' | 'custom';
	note: string;
	builtin: boolean;
}

export interface BridgeLegacyCardState {
	present: boolean;
	canClean: boolean;
	message: string;
}

export interface BridgeViewMessage {
	type?: string;
	which?: string;
	accessScope?: 'workspace' | 'computer';
	provider?: BridgeTunnelProvider;
	shortcutId?: string;
	shortcut?: { label?: string; url?: string; openMode?: 'integrated' | 'external' };
	account?: { apiUrl?: string };
	accountProvider?: 'github' | 'gitee';
	planCode?: string;
	activationCode?: string;
	operationId?: string;
	runId?: string;
	patchId?: string;
	commandId?: string;
	offset?: number;
	maxBytes?: number;
	reviewed?: boolean;
	path?: string;
	tab?: 'activity' | 'patches' | 'commands' | 'logs';
	targetId?: string;
	settingsGroup?: 'connection' | 'compat' | 'advanced' | 'account' | 'maintenance';
	guideCommand?: 'install-msi' | 'version' | 'where' | 'get-command' | 'update';
	guideLink?: 'downloads' | 'update' | 'releases';
	oauth?: Partial<Pick<BridgeOAuthUiSettings, 'issuer' | 'jwksUri' | 'resourceId' | 'endpointGeneration' | 'resource'>>;
	tunnel?: Partial<Pick<BridgeTunnelUiSettings, 'authMode' | 'browserOriginMode' | 'browserOrigins' | 'provider' | 'publicUrl' | 'executable' | 'proxyUrl' | 'startupTimeoutMs' | 'maxAttempts' | 'localPort' | 'persistentMode' | 'quickLinks'>>;
}

const ALLOWED_MESSAGE_TYPES = new Set([
	'uiReady', 'selectWorkspace', 'start', 'stop', 'setAccessScope', 'saveTunnelSettings', 'setTunnelCredential',
	'clearTunnelCredential', 'checkTunnelDependency', 'chooseTunnelExecutable',
	'installTunnelDependency', 'openTunnelInstallPage', 'copyTunnelGuideCommand', 'openTunnelGuideLink', 'checkTunnel', 'retryPublicTunnel', 'copy', 'copyPrompt', 'saveOAuthSettings',
	'rotateEndpoint', 'openShortcut', 'addShortcut', 'removeShortcut', 'checkLegacyCards',
	'cleanLegacyCards', 'saveAccountSettings', 'loginAccount', 'refreshAccount', 'activateDevice', 'purchasePlan', 'redeemActivation', 'logoutAccount',
	'requestUiSnapshot', 'openReview', 'openSettings',
]);

export class BridgeViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'mooncode.bridgeView';
	constructor(private readonly extensionUri: vscode.Uri) {}
	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private taskState: BridgeTaskUiState | undefined;
	private tunnelSettings: BridgeTunnelUiSettings | undefined;
	private tunnelDependency: BridgeTunnelDependencyUiState | undefined;
	private oauthSettings: BridgeOAuthUiSettings | undefined;
	private accountState: BridgeAccountUiState | undefined;
	private shortcuts: BridgeBrowserShortcut[] = [];
	private legacyCards: BridgeLegacyCardState | undefined;
	private uiSnapshot: BridgeUiSnapshot | undefined;
	private publicMcpUrl = '';
	onUserMessage: ((message: BridgeViewMessage) => void) | undefined;
	onPost: ((payload: unknown) => void) | undefined;

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.bind(webviewView.webview);
		webviewView.show?.(true);
	}

	reveal(): void {
		void vscode.commands.executeCommand('mooncode.bridgeView.focus');
	}

	attachPanel(panel: vscode.WebviewPanel): void {
		this.panel = panel;
		this.bind(panel.webview);
		panel.onDidDispose(() => {
			if (this.panel === panel) this.panel = undefined;
		});
	}

	post(payload: unknown): void {
		void this.view?.webview.postMessage(payload);
		void this.panel?.webview.postMessage(payload);
		this.onPost?.(payload);
	}

	setUiSnapshot(snapshot: BridgeUiSnapshot): void {
		this.uiSnapshot = snapshot;
		this.post({ kind: 'uiSnapshot', snapshot });
	}

	setPublicMcpUrl(url?: string): void {
		this.publicMcpUrl = typeof url === 'string' ? url : '';
		this.post({ kind: 'mcpAddress', url: this.publicMcpUrl });
	}

	setTaskState(state: BridgeTaskUiState): void {
		this.taskState = {
			version: state.version,
			todos: state.todos.map(todo => ({ ...todo })),
			updated_at: state.updated_at,
			progress: state.progress.map(progress => ({ ...progress })),
		};
		this.post({ kind: 'taskState', state: this.taskState });
	}

	setTunnelSettings(settings: BridgeTunnelUiSettings): void {
		this.tunnelSettings = { ...settings };
		this.post({ kind: 'tunnelSettings', settings: this.tunnelSettings });
	}

	setTunnelDependency(state: BridgeTunnelDependencyUiState): void {
		this.tunnelDependency = { ...state };
		this.post({ kind: 'tunnelDependency', state: this.tunnelDependency });
	}

	setOAuthSettings(settings: BridgeOAuthUiSettings): void {
		this.oauthSettings = { ...settings };
		this.post({ kind: 'oauthSettings', settings: this.oauthSettings });
	}

	setAccountState(state: BridgeAccountUiState): void {
		this.accountState = { ...state, providers: [...state.providers], identities: state.identities.map(identity => ({ ...identity })), entitlement: state.entitlement ? { ...state.entitlement } : undefined, device: state.device ? { ...state.device } : undefined, purchasePlans: state.purchasePlans?.map(plan => ({ ...plan })) };
		this.post({ kind: 'accountState', state: this.accountState });
	}

	setBrowserShortcuts(shortcuts: BridgeBrowserShortcut[]): void {
		this.shortcuts = shortcuts.map(shortcut => ({ ...shortcut }));
		this.post({ kind: 'browserShortcuts', shortcuts: this.shortcuts });
	}

	setLegacyCards(state: BridgeLegacyCardState): void {
		this.legacyCards = { ...state };
		this.post({ kind: 'legacyCards', state: this.legacyCards });
	}

	private bind(webview: vscode.Webview): void {
		const resourcesRoot = vscode.Uri.joinPath(this.extensionUri, 'resources');
		webview.options = { enableScripts: true, localResourceRoots: [resourcesRoot] };
		const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(resourcesRoot, 'codicon.ttf')).toString();
		webview.html = bridgeSidebarHtml(codiconUri, webview.cspSource);
		webview.onDidReceiveMessage((message: unknown) => {
			if (!message || typeof message !== 'object') return;
			const candidate = message as BridgeViewMessage;
			if (typeof candidate.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(candidate.type)) return;
			if (candidate.type === 'uiReady') {
				if (this.uiSnapshot) void webview.postMessage({ kind: 'uiSnapshot', snapshot: this.uiSnapshot });
				void webview.postMessage({ kind: 'mcpAddress', url: this.publicMcpUrl });
				if (this.taskState) void webview.postMessage({ kind: 'taskState', state: this.taskState });
				if (this.tunnelSettings) void webview.postMessage({ kind: 'tunnelSettings', settings: this.tunnelSettings });
				if (this.tunnelDependency) void webview.postMessage({ kind: 'tunnelDependency', state: this.tunnelDependency });
				if (this.oauthSettings) void webview.postMessage({ kind: 'oauthSettings', settings: this.oauthSettings });
				if (this.accountState) void webview.postMessage({ kind: 'accountState', state: this.accountState });
				void webview.postMessage({ kind: 'browserShortcuts', shortcuts: this.shortcuts });
				if (this.legacyCards) void webview.postMessage({ kind: 'legacyCards', state: this.legacyCards });
				return;
			}
			if (candidate.type === 'requestUiSnapshot') {
				if (this.uiSnapshot) void webview.postMessage({ kind: 'uiSnapshot', snapshot: this.uiSnapshot });
				return;
			}
			this.onUserMessage?.(candidate);
		});
	}

}
