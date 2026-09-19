import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createHash } from "node:crypto";

export type BridgeRuntimeMode = "local" | "development" | "production";
export type BridgeAuthMode = "capability_url" | "oauth";

export interface BridgeOAuthOptions {
	issuer: string;
	jwksUri: string;
	/** Public MCP resource identifier. Omit in local/dev mode to bind to the resolved Bridge endpoint. */
	resource?: string;
	resourceId: string;
	endpointGeneration: number;
}

export interface BridgeAuthContext {
	token: string;
	credentialId: string;
	resource: string;
	subject: string;
	deviceId: string;
	resourceId: string;
	endpointGeneration: number;
	clientId?: string;
	scopes: ReadonlySet<string>;
	payload: JWTPayload;
}

export class BridgeAuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		readonly oauthError: "invalid_token" | "insufficient_scope",
		message: string,
		readonly requiredScope?: string,
	) {
		super(message);
		this.name = "BridgeAuthError";
	}
}

function parseBearer(authorization: string | undefined): string {
	if (!authorization) throw new BridgeAuthError(401, "invalid_token", "Bearer access token is required");
	const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
	if (!match) throw new BridgeAuthError(401, "invalid_token", "Authorization header must use Bearer scheme");
	return match[1];
}

function scopeSet(payload: JWTPayload): ReadonlySet<string> {
	if (typeof payload.scope !== "string") return new Set();
	return new Set(payload.scope.split(/\s+/).filter(Boolean));
}

export function protectedResourceMetadataUrl(resource: string): string {
	const parsed = new URL(resource);
	if (parsed.hash) throw new Error("OAuth resource must not contain a fragment");
	const resourcePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
	const metadata = new URL(`/.well-known/oauth-protected-resource${resourcePath}`, parsed.origin);
	if (parsed.search) metadata.search = parsed.search;
	return metadata.href;
}

export class BridgeTokenVerifier {
	private readonly jwks;

	constructor(
		private readonly options: Required<Pick<BridgeOAuthOptions, "issuer" | "jwksUri" | "resource" | "resourceId" | "endpointGeneration">>,
	) {
		if (!Number.isSafeInteger(options.endpointGeneration) || options.endpointGeneration <= 0) {
			throw new Error("OAuth endpointGeneration must be a positive safe integer");
		}
		this.jwks = createRemoteJWKSet(new URL(options.jwksUri));
	}

	metadata(): {
		resource: string;
		authorization_servers: string[];
		scopes_supported: string[];
		bearer_methods_supported: ["header"];
	} {
		return {
			resource: this.options.resource,
			authorization_servers: [this.options.issuer],
			scopes_supported: ["bridge.read", "bridge.write", "bridge.exec"],
			bearer_methods_supported: ["header"],
		};
	}

	async verify(authorization: string | undefined): Promise<BridgeAuthContext> {
		const token = parseBearer(authorization);
		let payload: JWTPayload;
		try {
			const verified = await jwtVerify(token, this.jwks, {
				issuer: this.options.issuer,
				audience: this.options.resource,
			});
			if (verified.protectedHeader.typ !== "at+jwt") throw new Error("access token typ must be at+jwt");
			payload = verified.payload;
		} catch (error) {
			throw new BridgeAuthError(401, "invalid_token", error instanceof Error ? error.message : "access token validation failed");
		}

		if (typeof payload.exp !== "number") throw new BridgeAuthError(401, "invalid_token", "access token exp claim is required");
		if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new BridgeAuthError(401, "invalid_token", "access token sub claim is required");
		if (typeof payload.device_id !== "string" || payload.device_id.length === 0) throw new BridgeAuthError(401, "invalid_token", "access token device_id claim is required");
		if (payload.resource_id !== this.options.resourceId) throw new BridgeAuthError(401, "invalid_token", "access token resource_id does not match this Bridge");
		if (payload.endpoint_generation !== this.options.endpointGeneration) throw new BridgeAuthError(401, "invalid_token", "access token endpoint_generation is stale");
		if (payload.mooncode_entitlement_id !== undefined) {
			if (typeof payload.mooncode_entitlement_id !== "string" || !payload.mooncode_entitlement_id) {
				throw new BridgeAuthError(401, "invalid_token", "MoonCode entitlement id claim is invalid");
			}
			if (typeof payload.mooncode_plan_id !== "string" || !payload.mooncode_plan_id || payload.mooncode_device_authorized !== true) {
				throw new BridgeAuthError(401, "invalid_token", "MoonCode device entitlement is not authorized");
			}
			if (typeof payload.mooncode_entitlement_checked_at !== "number") {
				throw new BridgeAuthError(401, "invalid_token", "MoonCode entitlement check timestamp is missing");
			}
			if (payload.mooncode_entitlement_expires_at !== undefined) {
				if (typeof payload.mooncode_entitlement_expires_at !== "number" || payload.mooncode_entitlement_expires_at <= Math.floor(Date.now() / 1000)) {
					throw new BridgeAuthError(401, "invalid_token", "MoonCode entitlement has expired");
				}
			}
		}

		return {
			token,
			credentialId: createHash("sha256").update(token, "utf8").digest("base64url"),
			resource: this.options.resource,
			subject: payload.sub,
			deviceId: payload.device_id,
			resourceId: payload.resource_id,
			endpointGeneration: payload.endpoint_generation,
			clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
			scopes: scopeSet(payload),
			payload,
		};
	}

	assertScope(context: BridgeAuthContext, requiredScope: string): void {
		if (!context.scopes.has(requiredScope)) {
			throw new BridgeAuthError(403, "insufficient_scope", `access token is missing ${requiredScope}`, requiredScope);
		}
	}
}

export function validateProductionOAuthConfiguration(
	mode: BridgeRuntimeMode,
	oauth: BridgeOAuthOptions | undefined,
	tunnel: "none" | "cloudflare-quick" | "cloudflare-named" | "ngrok" | undefined,
): void {
	if (tunnel && tunnel !== "none" && !oauth) {
		throw new Error("published Bridge requires OAuth; anonymous tunnel publication is forbidden");
	}
	if (mode !== "production") return;
	if (!oauth) throw new Error("production Bridge requires OAuth; unauthenticated publish is forbidden");
	if (!oauth.resource) throw new Error("production Bridge requires an explicit public OAuth resource URL");
	for (const [name, raw] of [["issuer", oauth.issuer], ["jwksUri", oauth.jwksUri], ["resource", oauth.resource]] as const) {
		const url = new URL(raw);
		if (url.protocol !== "https:") throw new Error(`production OAuth ${name} must use https`);
	}
	if (tunnel === "cloudflare-quick") throw new Error("production Bridge cannot use an ephemeral Cloudflare Quick Tunnel");
}

export function validateBridgeAuthConfiguration(
	mode: BridgeRuntimeMode,
	authMode: BridgeAuthMode,
	oauth: BridgeOAuthOptions | undefined,
	tunnel: "none" | "cloudflare-quick" | "cloudflare-named" | "ngrok" | undefined,
	secret: string,
): void {
	if (authMode === "oauth") {
		if (!oauth) throw new Error("oauth Bridge requires OAuth verifier settings");
		validateProductionOAuthConfiguration(mode, oauth, tunnel);
		return;
	}
	if (oauth) throw new Error("capability_url Bridge must not also configure OAuth verifier settings");
	if (mode === "production") {
		throw new Error("production Bridge requires OAuth; capability_url is for local/personal compatibility only");
	}
	if (tunnel && tunnel !== "none" && !/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
		throw new Error("published capability_url Bridge requires a 256-bit-or-stronger base64url endpoint secret");
	}
}
