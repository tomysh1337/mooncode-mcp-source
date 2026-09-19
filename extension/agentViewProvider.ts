import * as vscode from 'vscode';
import type { ApprovalDecision, ApprovalRequestPayload, RuntimeEvent } from './runtimeClient';

export class AgentViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'mooncode.agentView';
	private view: vscode.WebviewView | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private approvalWaiter: ((decision: ApprovalDecision) => void) | undefined;
	onUserMessage: ((message: { type?: string; prompt?: string }) => void) | undefined;

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.bind(webviewView.webview);
		webviewView.show?.(true);
	}

	reveal(): void {
		void vscode.commands.executeCommand('mooncode.agentView.focus');
		this.ensurePanel();
	}

	ensurePanel(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'mooncode.agentPanel',
			'MoonCode Agent',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.bind(this.panel.webview);
		this.panel.onDidDispose(() => { this.panel = undefined; });
	}

	post(payload: unknown): void {
		void this.view?.webview.postMessage(payload);
		void this.panel?.webview.postMessage(payload);
	}

	onEvent(event: RuntimeEvent): void {
		this.post({ kind: 'event', eventType: event.type, payload: event.payload });
	}

	askApproval(approval: ApprovalRequestPayload): Promise<ApprovalDecision> {
		this.post({ kind: 'approval', tool: approval.tool, effect: approval.effect, reason: approval.reason });
		return new Promise(resolve => {
			this.approvalWaiter = resolve;
		});
	}

	private bind(webview: vscode.Webview): void {
		webview.options = { enableScripts: true };
		webview.html = this.html();
		webview.onDidReceiveMessage((message: { type?: string }) => {
			if (message.type === 'allow') {
				this.approvalWaiter?.('ALLOW');
				this.approvalWaiter = undefined;
			} else if (message.type === 'deny') {
				this.approvalWaiter?.('DENY');
				this.approvalWaiter = undefined;
			} else {
				this.onUserMessage?.(message);
			}
		});
	}

	private html(): string {
		return [
			'<!DOCTYPE html><html><head><meta charset="UTF-8">',
			'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">',
			'<style>',
			'body{font-family:Segoe UI,sans-serif;font-size:13px;margin:0;padding:12px;color:#ddd;background:#1e1e1e}',
			'h1{font-size:13px;margin:0 0 8px}',
			'textarea{width:100%;min-height:72px;box-sizing:border-box;background:#252526;color:#ddd;border:1px solid #3c3c3c;padding:6px}',
			'button{margin:6px 6px 0 0;cursor:pointer;background:#0e639c;color:#fff;border:0;padding:4px 10px}',
			'#log{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:12px;margin-top:10px}',
			'.approval{border:1px solid var(--vscode-inputValidation-warningBorder);padding:8px;margin-top:8px}',
			'.hidden{display:none}',
			'</style></head><body>',
			'<h1>MoonCode Agent</h1>',
			'<textarea id="prompt">读取 README.md</textarea>',
			'<div><button id="run">Run</button><button id="cancel">Cancel</button></div>',
			'<div id="approval" class="approval hidden"><div id="approvalText"></div><button id="allow">Allow</button><button id="deny">Deny</button></div>',
			'<div id="log"></div>',
			'<script>',
			'const vscode=acquireVsCodeApi();',
			'const logEl=document.getElementById("log");',
			'function append(t){const d=document.createElement("div");d.textContent=t;logEl.appendChild(d);}',
			'document.getElementById("run").onclick=()=>{logEl.textContent="";vscode.postMessage({type:"run",prompt:document.getElementById("prompt").value});};',
			'document.getElementById("cancel").onclick=()=>vscode.postMessage({type:"cancel"});',
			'document.getElementById("allow").onclick=()=>{document.getElementById("approval").classList.add("hidden");vscode.postMessage({type:"allow"});};',
			'document.getElementById("deny").onclick=()=>{document.getElementById("approval").classList.add("hidden");vscode.postMessage({type:"deny"});};',
			'window.addEventListener("message",e=>{const m=e.data||{};',
			'if(m.kind==="event"){if(m.eventType==="model.delta"&&m.payload&&m.payload.text){append(m.payload.text);}else{append(m.eventType+(m.payload?" "+JSON.stringify(m.payload).slice(0,240):""));}}',
			'else if(m.kind==="result"){append("--- "+m.state+" ---");append(m.response||"");}',
			'else if(m.kind==="error"){append("ERROR: "+m.message);}',
			'else if(m.kind==="approval"){document.getElementById("approvalText").textContent="Approve "+m.tool+" ("+m.effect+"): "+m.reason;document.getElementById("approval").classList.remove("hidden");}',
			'});',
			'</script></body></html>'
		].join('');
	}
}
