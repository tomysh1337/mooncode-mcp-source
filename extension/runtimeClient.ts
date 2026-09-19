import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export interface RuntimeEvent {
	seq: number;
	type: string;
	payload: unknown;
	runId: string;
}

export interface RuntimeResult {
	runId: string;
	state: string;
	response: string;
}

export interface ApprovalRequestPayload {
	approvalId: string;
	runId: string;
	capabilityId: string;
	tool: string;
	effect: string;
	reason: string;
	createdAt: string;
}

export type ApprovalDecision = 'ALLOW' | 'DENY';
export type ApprovalHandler = (approval: ApprovalRequestPayload) => Promise<ApprovalDecision>;

type RuntimeMessage =
	| { type: 'run.event'; requestId: string; event: RuntimeEvent }
	| ({ type: 'run.completed'; requestId: string } & RuntimeResult)
	| { type: 'approval.needed'; requestId: string; approval: ApprovalRequestPayload }
	| { type: 'error'; requestId?: string; code: string; message?: string };

interface PendingRun {
	onEvent?: (event: RuntimeEvent) => void;
	onApproval?: ApprovalHandler;
	resolve: (result: RuntimeResult) => void;
	reject: (error: Error) => void;
}

export class RuntimeClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, PendingRun>();

	constructor(
		private readonly entry: string,
		private readonly cwd: string,
	) { }

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.process && !this.process.killed) {
			return this.process;
		}
		const stderrChunks: string[] = [];
		const child = spawn(process.execPath, [this.entry], {
			cwd: this.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
			},
		});
		this.process = child;
		child.stderr.on('data', (buf: Buffer) => {
			stderrChunks.push(buf.toString());
			if (stderrChunks.length > 40) {
				stderrChunks.splice(0, stderrChunks.length - 20);
			}
		});
		const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
		input.on('line', line => this.onLine(line));
		child.on('exit', (code) => {
			const detail = stderrChunks.join('').trim();
			const err = new Error(`MoonCode runtime exited (${code ?? 'null'})${detail ? `: ${detail.slice(-800)}` : ''}`);
			for (const [id, pending] of this.pending) {
				this.pending.delete(id);
				pending.reject(err);
			}
			this.process = undefined;
		});
		child.on('error', (error) => {
			for (const [id, pending] of this.pending) {
				this.pending.delete(id);
				pending.reject(error);
			}
		});
		return child;
	}

	private onLine(line: string): void {
		if (!line.trim()) {
			return;
		}
		let message: RuntimeMessage;
		try {
			message = JSON.parse(line) as RuntimeMessage;
		} catch {
			return;
		}
		const pending = message.requestId ? this.pending.get(message.requestId) : undefined;
		if (!pending) {
			return;
		}
		if (message.type === 'run.event') {
			pending.onEvent?.(message.event);
			return;
		}
		if (message.type === 'approval.needed') {
			const handle = pending.onApproval ?? (async () => 'DENY' as const);
			void handle(message.approval)
				.then(decision => this.write({
					type: 'approval.decide',
					requestId: message.requestId,
					approvalId: message.approval.approvalId,
					decision,
				}))
				.catch(() => this.write({
					type: 'approval.decide',
					requestId: message.requestId,
					approvalId: message.approval.approvalId,
					decision: 'DENY',
				}));
			return;
		}
		if (message.requestId) {
			this.pending.delete(message.requestId);
		}
		if (message.type === 'run.completed') {
			pending.resolve(message);
			return;
		}
		pending.reject(new Error(`${message.code}: ${message.message ?? 'Runtime error'}`));
	}

	private write(payload: unknown): void {
		this.ensureProcess().stdin.write(JSON.stringify(payload) + '\n');
	}

	run(
		prompt: string,
		workspaceRoot: string,
		eventFile: string,
		onEvent?: (event: RuntimeEvent) => void,
		onApproval?: ApprovalHandler,
	): { requestId: string; done: Promise<RuntimeResult> } {
		const requestId = randomUUID();
		const done = new Promise<RuntimeResult>((resolve, reject) => {
			this.pending.set(requestId, { onEvent, onApproval, resolve, reject });
			this.write({ type: 'run.start', requestId, prompt, workspaceRoot, eventFile });
		});
		return { requestId, done };
	}

	cancel(requestId: string): void {
		this.write({ type: 'run.cancel', requestId });
	}

	dispose(): void {
		this.process?.kill();
		this.process = undefined;
	}
}
