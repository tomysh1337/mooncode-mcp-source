import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { BridgeAuthError, type BridgeAuthContext } from "./bridge-auth.js";

export type BridgePermissionMode = "read_only" | "auto";
export type BridgeAccessScope = "workspace" | "computer";

export interface BridgeAuthorizationSession {
	id: string;
	credentialId: string;
	subject: string;
	deviceId: string;
	resourceId: string;
	endpointGeneration: number;
	workspaceRoot: string;
	createdAt: string;
	lastSeenAt: string;
	revision: number;
	revokedAt?: string;
	revokedReason?: string;
}

export interface BridgeWriteLease {
	sessionId?: string;
	sessionRevision?: number;
	modeRevision: number;
}

export interface BridgeCommandLease {
	id: string;
	signal: AbortSignal;
	detachRequest(): void;
	finish(): void;
}

export class BridgeSessionPermissionError extends Error {
	constructor(
		readonly code: "UNAUTHENTICATED" | "PERMISSION_DENIED",
		message: string,
	) {
		super(message);
		this.name = "BridgeSessionPermissionError";
	}
}

function requiredScopeForTool(tool: string): "bridge.read" | "bridge.write" | "bridge.exec" {
	if (tool === "write_file" || tool === "apply_patch") return "bridge.write";
	if (tool === "run_command" || tool === "send_command_input") return "bridge.exec";
	return "bridge.read";
}

export class BridgeSessionManager {
	private readonly workspaceRoot: string;
	private readonly sessionsByCredential = new Map<string, BridgeAuthorizationSession>();
	private readonly sessionsById = new Map<string, BridgeAuthorizationSession>();
	private readonly revokedCredentials = new Map<string, string>();
	private readonly revokedSubjects = new Map<string, string>();
	private readonly revokedDevices = new Map<string, string>();
	private activeCriticalSections = 0;
	private readonly criticalDrainWaiters = new Set<() => void>();
	private readonly activeCommands = new Map<string, {
		sessionId?: string;
		controller: AbortController;
		detachParent?: () => void;
	}>();
	private modeRevision = 1;
	private permissionModeValue: BridgePermissionMode;
	private accessScopeValue: BridgeAccessScope;

	constructor(workspaceRoot: string, initialMode: BridgePermissionMode = "read_only", initialAccessScope: BridgeAccessScope = "workspace") {
		this.workspaceRoot = resolve(workspaceRoot);
		this.permissionModeValue = initialMode;
		this.accessScopeValue = initialAccessScope;
	}

	get permissionMode(): BridgePermissionMode {
		return this.permissionModeValue;
	}

	get accessScope(): BridgeAccessScope {
		return this.accessScopeValue;
	}

	setPermissionMode(mode: BridgePermissionMode): void {
		if (mode === this.permissionModeValue) return;
		this.permissionModeValue = mode;
		this.modeRevision += 1;
		if (mode === "read_only") this.abortCommands(() => true, "Bridge permission mode changed to read-only");
	}

	setAccessScope(scope: BridgeAccessScope): void {
		if (scope === this.accessScopeValue) return;
		this.accessScopeValue = scope;
		this.modeRevision += 1;
		if (scope === "workspace") this.abortCommands(() => true, "Bridge access scope changed to current workspace");
	}

	resolve(context: BridgeAuthContext): BridgeAuthorizationSession {
		const credentialRevocation = this.revokedCredentials.get(context.credentialId);
		if (credentialRevocation) {
			throw new BridgeAuthError(401, "invalid_token", `MoonCode authorization session revoked: ${credentialRevocation}`);
		}
		const subjectRevocation = this.revokedSubjects.get(context.subject);
		if (subjectRevocation) {
			throw new BridgeAuthError(401, "invalid_token", `MoonCode principal revoked: ${subjectRevocation}`);
		}
		const deviceRevocation = this.revokedDevices.get(context.deviceId);
		if (deviceRevocation) {
			throw new BridgeAuthError(401, "invalid_token", `MoonCode device revoked: ${deviceRevocation}`);
		}

		const existing = this.sessionsByCredential.get(context.credentialId);
		if (existing) {
			this.assertIdentity(existing, context);
			if (existing.revokedAt) {
				throw new BridgeAuthError(401, "invalid_token", `MoonCode authorization session revoked: ${existing.revokedReason ?? "revoked"}`);
			}
			existing.lastSeenAt = new Date().toISOString();
			return existing;
		}

		const now = new Date().toISOString();
		const session: BridgeAuthorizationSession = {
			id: randomUUID(),
			credentialId: context.credentialId,
			subject: context.subject,
			deviceId: context.deviceId,
			resourceId: context.resourceId,
			endpointGeneration: context.endpointGeneration,
			workspaceRoot: this.workspaceRoot,
			createdAt: now,
			lastSeenAt: now,
			revision: 1,
		};
		this.sessionsByCredential.set(context.credentialId, session);
		this.sessionsById.set(session.id, session);
		return session;
	}

	toSdkAuthInfo(context: BridgeAuthContext, session: BridgeAuthorizationSession): AuthInfo {
		return {
			token: context.token,
			clientId: context.clientId ?? context.subject,
			scopes: [...context.scopes],
			expiresAt: typeof context.payload.exp === "number" ? context.payload.exp : undefined,
			resource: new URL(context.resource),
			extra: {
				mooncodeSessionId: session.id,
				mooncodeCredentialId: context.credentialId,
				mooncodeSubject: context.subject,
				mooncodeDeviceId: context.deviceId,
				mooncodeResourceId: context.resourceId,
				mooncodeEndpointGeneration: context.endpointGeneration,
				mooncodeWorkspaceRoot: this.workspaceRoot,
			},
		};
	}

	assertToolPermission(tool: string, authInfo?: AuthInfo): void {
		const requiredScope = requiredScopeForTool(tool);
		if (authInfo) {
			if (!authInfo.scopes.includes(requiredScope)) {
				throw new BridgeSessionPermissionError("PERMISSION_DENIED", `OAuth scope ${requiredScope} is required`);
			}
			const session = this.sessionFromAuthInfo(authInfo);
			this.assertSessionActive(session);
		}
		if ((requiredScope === "bridge.write" || requiredScope === "bridge.exec") && this.permissionModeValue !== "auto") {
			throw new BridgeSessionPermissionError("PERMISSION_DENIED", "local Bridge permission mode is read-only");
		}
		if (requiredScope === "bridge.exec" && this.accessScopeValue !== "computer") {
			throw new BridgeSessionPermissionError("PERMISSION_DENIED", "terminal execution requires whole-computer access");
		}
	}

	beginWrite(authInfo?: AuthInfo): BridgeWriteLease {
		this.assertToolPermission("write_file", authInfo);
		const session = authInfo ? this.sessionFromAuthInfo(authInfo) : undefined;
		return {
			sessionId: session?.id,
			sessionRevision: session?.revision,
			modeRevision: this.modeRevision,
		};
	}

	assertWriteLease(lease: BridgeWriteLease): void {
		if (this.permissionModeValue !== "auto" || lease.modeRevision !== this.modeRevision) {
			throw new BridgeSessionPermissionError("PERMISSION_DENIED", "Bridge write permission changed before commit");
		}
		if (!lease.sessionId) return;
		const session = this.sessionsById.get(lease.sessionId);
		if (!session || session.revision !== lease.sessionRevision) {
			throw new BridgeSessionPermissionError("UNAUTHENTICATED", "Bridge authorization session changed before commit");
		}
		this.assertSessionActive(session);
	}

	enterWriteCriticalSection(lease: BridgeWriteLease): () => void {
		// This check and the increment are intentionally synchronous. JavaScript cannot
		// interleave a revoke/mode-change between them, so a mutation either enters
		// before revocation (and may finish consistently) or is rejected afterwards.
		this.assertWriteLease(lease);
		this.activeCriticalSections += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeCriticalSections -= 1;
			if (this.activeCriticalSections === 0) {
				for (const resolve of this.criticalDrainWaiters) resolve();
				this.criticalDrainWaiters.clear();
			}
		};
	}

	async waitForCriticalSections(timeoutMs = 5_000): Promise<boolean> {
		if (this.activeCriticalSections === 0) return true;
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const done = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.criticalDrainWaiters.delete(onDrain);
				resolve(value);
			};
			const onDrain = () => done(true);
			const timer = setTimeout(() => done(false), timeoutMs);
			timer.unref?.();
			this.criticalDrainWaiters.add(onDrain);
		});
	}

	get activeCommandCount(): number {
		return this.activeCommands.size;
	}

	beginCommand(authInfo?: AuthInfo, parentSignal?: AbortSignal): BridgeCommandLease {
		this.assertToolPermission("run_command", authInfo);
		const session = authInfo ? this.sessionFromAuthInfo(authInfo) : undefined;
		const id = randomUUID();
		const controller = new AbortController();
		let detachParent: (() => void) | undefined;
		if (parentSignal) {
			const onAbort = () => controller.abort(parentSignal.reason ?? new Error("parent request aborted"));
			if (parentSignal.aborted) onAbort();
			else {
				parentSignal.addEventListener("abort", onAbort, { once: true });
				detachParent = () => parentSignal.removeEventListener("abort", onAbort);
			}
		}
		this.activeCommands.set(id, { sessionId: session?.id, controller, detachParent });
		let finished = false;
		return {
			id,
			signal: controller.signal,
			detachRequest: () => {
				const active = this.activeCommands.get(id);
				active?.detachParent?.();
				if (active) active.detachParent = undefined;
			},
			finish: () => {
				if (finished) return;
				finished = true;
				const active = this.activeCommands.get(id);
				active?.detachParent?.();
				this.activeCommands.delete(id);
			},
		};
	}

	getSessionId(authInfo?: AuthInfo): string | undefined {
		if (!authInfo) return undefined;
		const session = this.sessionFromAuthInfo(authInfo);
		this.assertSessionActive(session);
		return session.id;
	}

	getSessionForCredential(credentialId: string): BridgeAuthorizationSession | undefined {
		return this.sessionsByCredential.get(credentialId);
	}

	revokeCredential(credentialId: string, reason = "session deleted"): boolean {
		this.revokedCredentials.set(credentialId, reason);
		const session = this.sessionsByCredential.get(credentialId);
		if (!session) return false;
		this.revokeSession(session, reason);
		return true;
	}

	revokeSubject(subject: string, reason = "principal revoked"): number {
		this.revokedSubjects.set(subject, reason);
		return this.revokeWhere((session) => session.subject === subject, reason);
	}

	revokeDevice(deviceId: string, reason = "device revoked"): number {
		this.revokedDevices.set(deviceId, reason);
		return this.revokeWhere((session) => session.deviceId === deviceId, reason);
	}

	revokeAll(reason = "Bridge stopped"): number {
		this.abortCommands(() => true, reason);
		return this.revokeWhere(() => true, reason);
	}

	private revokeWhere(predicate: (session: BridgeAuthorizationSession) => boolean, reason: string): number {
		let count = 0;
		for (const session of this.sessionsById.values()) {
			if (!session.revokedAt && predicate(session)) {
				this.revokeSession(session, reason);
				count += 1;
			}
		}
		return count;
	}

	private revokeSession(session: BridgeAuthorizationSession, reason: string): void {
		session.revokedAt = new Date().toISOString();
		session.revokedReason = reason;
		session.revision += 1;
		this.abortCommands((active) => active.sessionId === session.id, reason);
	}

	private abortCommands(
		predicate: (active: { sessionId?: string; controller: AbortController; detachParent?: () => void }) => boolean,
		reason: string,
	): void {
		for (const active of this.activeCommands.values()) {
			if (predicate(active) && !active.controller.signal.aborted) active.controller.abort(new Error(reason));
		}
	}

	private sessionFromAuthInfo(authInfo: AuthInfo): BridgeAuthorizationSession {
		const sessionId = authInfo.extra?.mooncodeSessionId;
		if (typeof sessionId !== "string") {
			throw new BridgeSessionPermissionError("UNAUTHENTICATED", "MoonCode authorization session is missing");
		}
		const session = this.sessionsById.get(sessionId);
		if (!session) throw new BridgeSessionPermissionError("UNAUTHENTICATED", "MoonCode authorization session is unknown");
		return session;
	}

	private assertSessionActive(session: BridgeAuthorizationSession): void {
		if (session.workspaceRoot !== this.workspaceRoot) {
			throw new BridgeSessionPermissionError("PERMISSION_DENIED", "Bridge session is bound to another workspace");
		}
		if (session.revokedAt) {
			throw new BridgeSessionPermissionError("UNAUTHENTICATED", `Bridge session revoked: ${session.revokedReason ?? "revoked"}`);
		}
	}

	private assertIdentity(session: BridgeAuthorizationSession, context: BridgeAuthContext): void {
		if (
			session.subject !== context.subject
			|| session.deviceId !== context.deviceId
			|| session.resourceId !== context.resourceId
			|| session.endpointGeneration !== context.endpointGeneration
			|| session.workspaceRoot !== this.workspaceRoot
		) {
			this.revokeSession(session, "identity/resource binding changed");
			throw new BridgeAuthError(401, "invalid_token", "MoonCode authorization session binding mismatch");
		}
	}
}
