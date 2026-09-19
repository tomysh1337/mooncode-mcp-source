import * as vscode from 'vscode';
import { bridgeEventToAgentActivity, renderAgentActivityAnsi, type AgentActivityLine } from './agentActivity';

const MAX_HISTORY = 200;

export class MoonCodeAgentActivityTerminal implements vscode.Disposable {
	private terminal: vscode.Terminal | undefined;
	private writeEmitter: vscode.EventEmitter<string> | undefined;
	private readonly history: string[] = [];
	private closedByUser = false;
	private readonly closeSubscription: vscode.Disposable;

	constructor() {
		this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal !== this.terminal) return;
			this.terminal = undefined;
			this.writeEmitter?.dispose();
			this.writeEmitter = undefined;
			this.closedByUser = true;
		});
	}

	beginRun(): void {
		this.closedByUser = false;
		this.write({ level: 'info', message: '—— 新的 MoonCode Agent 会话 ——' });
		this.ensureTerminal()?.show(true);
	}

	accept(event: Record<string, unknown>): void {
		const activity = bridgeEventToAgentActivity(event);
		if (activity) this.write(activity);
	}

	write(activity: AgentActivityLine): void {
		const line = renderAgentActivityAnsi(activity);
		this.history.push(line);
		if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
		if (this.closedByUser) return;
		const existed = Boolean(this.terminal);
		this.ensureTerminal();
		if (existed) this.writeEmitter?.fire(line);
	}

	dispose(): void {
		this.closeSubscription.dispose();
		this.terminal?.dispose();
		this.writeEmitter?.dispose();
		this.terminal = undefined;
		this.writeEmitter = undefined;
	}

	private ensureTerminal(): vscode.Terminal | undefined {
		if (this.terminal) return this.terminal;
		if (this.closedByUser) return undefined;
		const emitter = new vscode.EventEmitter<string>();
		this.writeEmitter = emitter;
		const pty: vscode.Pseudoterminal = {
			onDidWrite: emitter.event,
			open: () => {
				emitter.fire('\x1b[36mMoonCode Agent\x1b[0m  活动终端（只读）\r\n');
				emitter.fire('仅显示关键任务、真实进度、警告和结果；不会写入你的 PowerShell 会话。\r\n\r\n');
				for (const line of this.history) emitter.fire(line);
			},
			close: () => undefined,
			handleInput: () => undefined,
		};
		this.terminal = vscode.window.createTerminal({ name: 'MoonCode Agent', pty });
		return this.terminal;
	}
}
