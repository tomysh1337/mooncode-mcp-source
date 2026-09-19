import { randomUUID } from "node:crypto";
import type { BridgePublicErrorCode } from "@mooncode/contracts";

export type BridgeIdeRequestKind = "lsp" | "get_diagnostics";

export interface BridgeIdeService {
	request(kind: BridgeIdeRequestKind, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export class BridgeIdeError extends Error {
	constructor(readonly code: BridgePublicErrorCode, message: string) {
		super(message);
		this.name = "BridgeIdeError";
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface BridgeIdeResponseMessage {
	type: "bridge.ide_response";
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
}

const IDE_ERROR_CODES = new Set<BridgePublicErrorCode>([
	"INVALID_ARGUMENT",
	"CANCELLED",
	"TIMEOUT",
	"PROVIDER_UNAVAILABLE",
	"NOT_FOUND",
	"INTERNAL_ERROR",
]);

export class BridgeIdeBroker implements BridgeIdeService {
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;

	constructor(
		private readonly send: (event: Record<string, unknown>) => void,
		private readonly timeoutMs = 10_000,
	) {}

	request(kind: BridgeIdeRequestKind, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) return Promise.reject(new BridgeIdeError("PROVIDER_UNAVAILABLE", "Extension Host IDE bridge is closed"));
		if (signal?.aborted) return Promise.reject(new BridgeIdeError("CANCELLED", "IDE request was cancelled"));
		const requestId = randomUUID();
		return new Promise<unknown>((resolve, reject) => {
			const finish = (entry: PendingRequest, error?: Error, value?: unknown): void => {
				if (!this.pending.delete(requestId)) return;
				clearTimeout(entry.timer);
				if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
				if (error) reject(error);
				else resolve(value);
			};
			const entry: PendingRequest = {
				resolve: (value) => finish(entry, undefined, value),
				reject: (error) => finish(entry, error),
				timer: setTimeout(() => {
					this.send({ type: "bridge.ide_cancel", requestId, reason: "timeout" });
					finish(entry, new BridgeIdeError("TIMEOUT", `Extension Host IDE request exceeded ${this.timeoutMs} ms`));
				}, this.timeoutMs),
				signal,
			};
			entry.timer.unref?.();
			if (signal) {
				entry.onAbort = () => {
					this.send({ type: "bridge.ide_cancel", requestId, reason: "cancelled" });
					finish(entry, new BridgeIdeError("CANCELLED", "IDE request was cancelled"));
				};
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.pending.set(requestId, entry);
			this.send({ type: "bridge.ide_request", requestId, kind, args });
		});
	}

	handleResponse(message: BridgeIdeResponseMessage): boolean {
		const entry = this.pending.get(message.requestId);
		if (!entry) return false;
		if (message.ok) {
			entry.resolve(message.result);
			return true;
		}
		const rawCode = typeof message.error?.code === "string" ? message.error.code : "INTERNAL_ERROR";
		const code = IDE_ERROR_CODES.has(rawCode as BridgePublicErrorCode)
			? rawCode as BridgePublicErrorCode
			: "INTERNAL_ERROR";
		const text = typeof message.error?.message === "string" && message.error.message
			? message.error.message
			: "Extension Host IDE request failed";
		entry.reject(new BridgeIdeError(code, text));
		return true;
	}

	close(reason = "Bridge stopped"): void {
		if (this.closed) return;
		this.closed = true;
		for (const [requestId, entry] of [...this.pending]) {
			this.send({ type: "bridge.ide_cancel", requestId, reason: "bridge_stopped" });
			entry.reject(new BridgeIdeError("CANCELLED", reason));
		}
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}
