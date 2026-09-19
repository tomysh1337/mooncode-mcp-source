export type BridgeTodoStatus = "pending" | "in_progress" | "completed";

export interface BridgeTodoItem {
	id: string;
	content: string;
	status: BridgeTodoStatus;
}

export interface BridgeTaskSnapshot {
	version: number;
	todos: BridgeTodoItem[];
	updated_at: string;
}

export interface BridgeProgressRecord {
	seq: number;
	todo_id: string | null;
	message: string;
	created_at: string;
	current?: number;
	total?: number;
	phase?: number;
	phase_total?: number;
}

export class BridgeTaskError extends Error {
	constructor(readonly code: "INVALID_ARGUMENT" | "NOT_FOUND", message: string) {
		super(message);
		this.name = "BridgeTaskError";
	}
}

type SessionTaskState = {
	version: number;
	todos: BridgeTodoItem[];
	updatedAt: string;
	progressSeq: number;
	progress: BridgeProgressRecord[];
};

const MAX_TODOS = 24;
const MAX_TODO_ID = 80;
const MAX_TODO_CONTENT = 400;
const MAX_PROGRESS_MESSAGE = 2_000;
const MAX_PROGRESS_HISTORY = 100;

export class BridgeTaskStore {
	private readonly sessions = new Map<string, SessionTaskState>();

	constructor(private readonly emit: (event: Record<string, unknown>) => void = () => undefined) {}

	setTodos(sessionKey: string, input: { todos: BridgeTodoItem[] }): BridgeTaskSnapshot {
		this.assertSessionKey(sessionKey);
		if (!input || !Array.isArray(input.todos) || input.todos.length > MAX_TODOS) {
			throw new BridgeTaskError("INVALID_ARGUMENT", `todos must be an array with at most ${MAX_TODOS} items`);
		}
		const seen = new Set<string>();
		let inProgressCount = 0;
		const todos = input.todos.map((todo, index) => {
			if (!todo || typeof todo !== "object") throw new BridgeTaskError("INVALID_ARGUMENT", `todos[${index}] must be an object`);
			if (typeof todo.id !== "string" || todo.id.length < 1 || todo.id.length > MAX_TODO_ID) {
				throw new BridgeTaskError("INVALID_ARGUMENT", `todos[${index}].id must contain 1-${MAX_TODO_ID} characters`);
			}
			if (seen.has(todo.id)) throw new BridgeTaskError("INVALID_ARGUMENT", `duplicate todo id: ${todo.id}`);
			seen.add(todo.id);
			if (typeof todo.content !== "string" || todo.content.length < 1 || todo.content.length > MAX_TODO_CONTENT) {
				throw new BridgeTaskError("INVALID_ARGUMENT", `todos[${index}].content must contain 1-${MAX_TODO_CONTENT} characters`);
			}
			if (todo.status !== "pending" && todo.status !== "in_progress" && todo.status !== "completed") {
				throw new BridgeTaskError("INVALID_ARGUMENT", `todos[${index}].status is invalid`);
			}
			if (todo.status === "in_progress") inProgressCount += 1;
			return { id: todo.id, content: todo.content, status: todo.status };
		});
		if (inProgressCount > 1) throw new BridgeTaskError("INVALID_ARGUMENT", "at most one todo may be in_progress");

		const state = this.stateFor(sessionKey);
		state.version += 1;
		state.todos = todos;
		state.updatedAt = new Date().toISOString();
		const snapshot = this.snapshot(state);
		this.emit({ type: "bridge.todos", ...snapshot });
		return snapshot;
	}

	reportProgress(sessionKey: string, input: { message: string; todo_id?: string; current?: number; total?: number; phase?: number; phase_total?: number }): BridgeProgressRecord {
		this.assertSessionKey(sessionKey);
		if (!input || typeof input.message !== "string" || input.message.length < 1 || input.message.length > MAX_PROGRESS_MESSAGE) {
			throw new BridgeTaskError("INVALID_ARGUMENT", `message must contain 1-${MAX_PROGRESS_MESSAGE} characters`);
		}
		const hasMeasured = input.current !== undefined || input.total !== undefined;
		if (hasMeasured && (!Number.isSafeInteger(input.current) || !Number.isSafeInteger(input.total) || input.current! < 0 || input.total! < 1 || input.current! > input.total! || input.total! > 1_000_000_000_000)) {
			throw new BridgeTaskError("INVALID_ARGUMENT", "current and total must be safe integers supplied together with 0 <= current <= total");
		}
		const hasPhase = input.phase !== undefined || input.phase_total !== undefined;
		if (hasPhase && (!Number.isSafeInteger(input.phase) || !Number.isSafeInteger(input.phase_total) || input.phase! < 1 || input.phase_total! < 1 || input.phase! > input.phase_total! || input.phase_total! > 10_000)) {
			throw new BridgeTaskError("INVALID_ARGUMENT", "phase and phase_total must be safe integers supplied together with 1 <= phase <= phase_total");
		}
		const state = this.stateFor(sessionKey);
		let todoId: string | null = null;
		if (input.todo_id !== undefined) {
			if (typeof input.todo_id !== "string" || input.todo_id.length < 1 || input.todo_id.length > MAX_TODO_ID) {
				throw new BridgeTaskError("INVALID_ARGUMENT", `todo_id must contain 1-${MAX_TODO_ID} characters`);
			}
			if (!state.todos.some((todo) => todo.id === input.todo_id)) {
				throw new BridgeTaskError("NOT_FOUND", `todo_id was not found in the current MoonCode authorization session: ${input.todo_id}`);
			}
			todoId = input.todo_id;
		} else {
			todoId = state.todos.find((todo) => todo.status === "in_progress")?.id ?? null;
		}

		const record: BridgeProgressRecord = {
			seq: ++state.progressSeq,
			todo_id: todoId,
			message: input.message,
			created_at: new Date().toISOString(),
			...(hasMeasured ? { current: input.current!, total: input.total! } : {}),
			...(hasPhase ? { phase: input.phase!, phase_total: input.phase_total! } : {}),
		};
		state.progress.push(record);
		if (state.progress.length > MAX_PROGRESS_HISTORY) state.progress.splice(0, state.progress.length - MAX_PROGRESS_HISTORY);
		this.emit({ type: "bridge.progress", ...record });
		return { ...record };
	}

	getSnapshot(sessionKey: string): BridgeTaskSnapshot {
		this.assertSessionKey(sessionKey);
		return this.snapshot(this.stateFor(sessionKey));
	}

	getProgress(sessionKey: string): BridgeProgressRecord[] {
		this.assertSessionKey(sessionKey);
		return this.stateFor(sessionKey).progress.map((record) => ({ ...record }));
	}

	private stateFor(sessionKey: string): SessionTaskState {
		let state = this.sessions.get(sessionKey);
		if (!state) {
			const now = new Date().toISOString();
			state = { version: 0, todos: [], updatedAt: now, progressSeq: 0, progress: [] };
			this.sessions.set(sessionKey, state);
		}
		return state;
	}

	private snapshot(state: SessionTaskState): BridgeTaskSnapshot {
		return {
			version: state.version,
			todos: state.todos.map((todo) => ({ ...todo })),
			updated_at: state.updatedAt,
		};
	}

	private assertSessionKey(sessionKey: string): void {
		if (typeof sessionKey !== "string" || !sessionKey) throw new BridgeTaskError("INVALID_ARGUMENT", "MoonCode task session key is required");
	}
}
