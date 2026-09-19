import * as vscode from 'vscode';
import { bridgeReviewHtml, bridgeSettingsHtml } from './bridgeUiTemplates';
import type {
	BridgeAccountUiState,
	BridgeBrowserShortcut,
	BridgeLegacyCardState,
	BridgeOAuthUiSettings,
	BridgeTunnelUiSettings,
	BridgeViewMessage,
} from './bridgeViewProvider';
import type { BridgeUiSnapshot } from './bridgeUiState';

export interface BridgeReviewNavigation {
	route?: 'review' | 'settings';
	tab?: 'activity' | 'patches' | 'commands' | 'logs';
	targetId?: string;
	settingsGroup?: 'connection' | 'compat' | 'advanced' | 'account' | 'maintenance';
}

const ALLOWED_MESSAGE_TYPES = new Set([
	'uiReady', 'requestUiSnapshot', 'requestPatchDetail', 'requestCommandOutput', 'markReviewed', 'openWorkspaceFile',
	'saveTunnelSettings', 'saveAdvancedSettings', 'setTunnelCredential', 'clearTunnelCredential', 'checkTunnelDependency', 'chooseTunnelExecutable',
	'installTunnelDependency', 'openTunnelInstallPage', 'checkTunnel', 'saveOAuthSettings', 'rotateEndpoint', 'openShortcut', 'addShortcut', 'removeShortcut',
	'checkLegacyCards', 'cleanLegacyCards', 'saveAccountSettings', 'loginAccount', 'refreshAccount', 'activateDevice',
	'purchasePlan', 'redeemActivation', 'logoutAccount',
]);

export class BridgeReviewProvider {
	static readonly viewType = 'mooncode.bridgeReview';
	static readonly settingsViewType = 'mooncode.bridgeSettings';
	constructor(private readonly extensionUri: vscode.Uri) {}
	private reviewPanel: vscode.WebviewPanel | undefined;
	private settingsPanel: vscode.WebviewPanel | undefined;
	private snapshot: BridgeUiSnapshot | undefined;
	private tunnelSettings: BridgeTunnelUiSettings | undefined;
	private oauthSettings: BridgeOAuthUiSettings | undefined;
	private accountState: BridgeAccountUiState | undefined;
	private shortcuts: BridgeBrowserShortcut[] = [];
	private legacyCards: BridgeLegacyCardState | undefined;
	private pendingReviewNavigation: BridgeReviewNavigation | undefined;
	private pendingSettingsNavigation: BridgeReviewNavigation | undefined;
	onUserMessage: ((message: BridgeViewMessage) => void) | undefined;

	open(navigation: BridgeReviewNavigation = {}): void {
		if (navigation.route === 'settings') {
			this.openSettings(navigation.settingsGroup);
			return;
		}
		this.pendingReviewNavigation = { ...navigation, route: 'review' };
		if (this.reviewPanel) {
			this.reviewPanel.reveal(vscode.ViewColumn.One, true);
			this.postNavigation(this.pendingReviewNavigation, this.reviewPanel.webview);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			BridgeReviewProvider.viewType,
			'Bridge 审阅',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.attachPanel(panel, 'review');
	}

	openSettings(settingsGroup: BridgeReviewNavigation['settingsGroup'] = 'connection'): void {
		this.pendingSettingsNavigation = { route: 'settings', settingsGroup };
		if (this.settingsPanel) {
			this.settingsPanel.reveal(vscode.ViewColumn.One, true);
			this.postNavigation(this.pendingSettingsNavigation, this.settingsPanel.webview);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			BridgeReviewProvider.settingsViewType,
			'Bridge 设置',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.attachPanel(panel, 'settings');
	}

	attachPanel(panel: vscode.WebviewPanel, surface: 'review' | 'settings' = 'review'): void {
		if (surface === 'settings') this.settingsPanel = panel;
		else this.reviewPanel = panel;
		const resourcesRoot = vscode.Uri.joinPath(this.extensionUri, 'resources');
		panel.webview.options = { enableScripts: true, localResourceRoots: [resourcesRoot] };
		const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(resourcesRoot, 'codicon.ttf')).toString();
		panel.webview.html = surface === 'settings'
			? bridgeSettingsHtml(codiconUri, panel.webview.cspSource)
			: bridgeReviewHtml(codiconUri, panel.webview.cspSource);
		this.bind(panel.webview, surface);
		panel.onDidDispose(() => {
			if (surface === 'settings' && this.settingsPanel === panel) this.settingsPanel = undefined;
			if (surface === 'review' && this.reviewPanel === panel) this.reviewPanel = undefined;
		});
	}

	post(payload: unknown): void {
		this.remember(payload);
		void this.reviewPanel?.webview.postMessage(payload);
		void this.settingsPanel?.webview.postMessage(payload);
	}

	private remember(payload: unknown): void {
		if (!payload || typeof payload !== 'object') return;
		const message = payload as Record<string, unknown>;
		if (message.kind === 'uiSnapshot' && message.snapshot && typeof message.snapshot === 'object') {
			this.snapshot = message.snapshot as BridgeUiSnapshot;
		} else if (message.kind === 'tunnelSettings' && message.settings && typeof message.settings === 'object') {
			this.tunnelSettings = message.settings as BridgeTunnelUiSettings;
		} else if (message.kind === 'oauthSettings' && message.settings && typeof message.settings === 'object') {
			this.oauthSettings = message.settings as BridgeOAuthUiSettings;
		} else if (message.kind === 'accountState' && message.state && typeof message.state === 'object') {
			this.accountState = message.state as BridgeAccountUiState;
		} else if (message.kind === 'browserShortcuts' && Array.isArray(message.shortcuts)) {
			this.shortcuts = message.shortcuts as BridgeBrowserShortcut[];
		} else if (message.kind === 'legacyCards' && message.state && typeof message.state === 'object') {
			this.legacyCards = message.state as BridgeLegacyCardState;
		}
	}

	private bind(webview: vscode.Webview, surface: 'review' | 'settings'): void {
		webview.onDidReceiveMessage((message: unknown) => {
			if (!message || typeof message !== 'object') return;
			const candidate = message as BridgeViewMessage;
			if (typeof candidate.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(candidate.type)) return;
			if (candidate.type === 'uiReady') {
				this.replay(webview);
				if (surface === 'settings') {
					this.postNavigation(this.pendingSettingsNavigation ?? { route: 'settings', settingsGroup: 'connection' }, webview);
					this.pendingSettingsNavigation = undefined;
				} else {
					this.postNavigation(this.pendingReviewNavigation ?? { route: 'review', tab: 'activity' }, webview);
					this.pendingReviewNavigation = undefined;
				}
				return;
			}
			if (candidate.type === 'requestUiSnapshot') {
				if (this.snapshot) void webview.postMessage({ kind: 'uiSnapshot', snapshot: this.snapshot });
				return;
			}
			this.onUserMessage?.(candidate);
		});
	}

	private replay(webview: vscode.Webview): void {
		if (this.snapshot) void webview.postMessage({ kind: 'uiSnapshot', snapshot: this.snapshot });
		if (this.tunnelSettings) void webview.postMessage({ kind: 'tunnelSettings', settings: this.tunnelSettings });
		if (this.oauthSettings) void webview.postMessage({ kind: 'oauthSettings', settings: this.oauthSettings });
		if (this.accountState) void webview.postMessage({ kind: 'accountState', state: this.accountState });
		void webview.postMessage({ kind: 'browserShortcuts', shortcuts: this.shortcuts });
		if (this.legacyCards) void webview.postMessage({ kind: 'legacyCards', state: this.legacyCards });
	}

	private postNavigation(navigation: BridgeReviewNavigation, webview?: vscode.Webview): void {
		if (!webview) return;
		void webview.postMessage({
			kind: 'navigateReview',
			route: navigation.route ?? 'review',
			tab: navigation.tab,
			targetId: navigation.targetId,
			settingsGroup: navigation.settingsGroup,
		});
	}
}
