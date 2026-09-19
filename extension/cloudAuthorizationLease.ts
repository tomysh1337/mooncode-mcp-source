import { randomUUID } from 'node:crypto';
import type { MoonCodeDeviceIdentity } from './deviceIdentity';

export interface CloudAuthorizationLeaseResult {
	deviceId: string;
	authorizationValidUntil: string;
	entitlementExpiresAt?: string;
	proofValidUntil?: string;
	lastSeenAt?: string;
}

export class CloudAuthorizationLeaseRequestError extends Error {
	constructor(readonly statusCode: number, readonly cloudCode: string) {
		super(`Cloud authorization lease failed (${statusCode}${cloudCode ? ` ${cloudCode}` : ''})`);
		this.name = 'CloudAuthorizationLeaseRequestError';
	}
}

export async function requestCloudAuthorizationLease(input: {
	apiUrl: string;
	sessionToken: string;
	identity: MoonCodeDeviceIdentity;
	fetcher?: typeof fetch;
	now?: () => Date;
	nonce?: () => string;
}): Promise<CloudAuthorizationLeaseResult> {
	const fetcher = input.fetcher ?? fetch;
	const signedAt = (input.now ?? (() => new Date()))().toISOString();
	const nonce = (input.nonce ?? randomUUID)();
	const response = await fetcher(`${input.apiUrl}/api/v1/bridge/authorization-lease`, {
		method: 'POST',
		headers: { authorization: `Bearer ${input.sessionToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			device_id: input.identity.deviceId,
			signed_at: signedAt,
			nonce,
			signature: input.identity.signAuthorizationLease(input.identity.deviceId, signedAt, nonce),
		}),
		signal: AbortSignal.timeout(15_000),
	});
	let payload: Record<string, unknown> = {};
	try {
		const value = await response.json();
		if (value && typeof value === 'object') payload = value as Record<string, unknown>;
	} catch {}
	const cloudCode = typeof payload.error === 'string' ? payload.error : '';
	if (!response.ok) throw new CloudAuthorizationLeaseRequestError(response.status, cloudCode);
	const deviceId = typeof payload.device_id === 'string' ? payload.device_id : '';
	const authorizationValidUntil = typeof payload.authorization_valid_until === 'string' ? payload.authorization_valid_until : '';
	if (!deviceId || deviceId !== input.identity.deviceId || !authorizationValidUntil || !Number.isFinite(Date.parse(authorizationValidUntil))) {
		throw new Error('Cloud authorization lease response is incomplete.');
	}
	return {
		deviceId,
		authorizationValidUntil,
		entitlementExpiresAt: typeof payload.entitlement_expires_at === 'string' ? payload.entitlement_expires_at : undefined,
		proofValidUntil: typeof payload.proof_valid_until === 'string' ? payload.proof_valid_until : undefined,
		lastSeenAt: typeof payload.last_seen_at === 'string' ? payload.last_seen_at : undefined,
	};
}
