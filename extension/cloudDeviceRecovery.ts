import { deriveAccountScopedDeviceId } from './deviceIdentity';

export interface CloudDeviceRecoveryRecord {
	id?: unknown;
	revokedAt?: unknown;
	revoked_at?: unknown;
	lastSeenAt?: unknown;
	last_seen_at?: unknown;
}

export interface CloudDeviceRecoverySelection {
	deviceId: string;
	record?: CloudDeviceRecoveryRecord;
	source: 'active_scoped' | 'active_legacy' | 'revoked_scoped' | 'revoked_legacy' | 'new_scoped';
}

export type CloudDeviceAuthorizationAction = 'none' | 'auto_authorize' | 'quota_full';

function normalizedDeviceId(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized || undefined;
}

function isActive(record: CloudDeviceRecoveryRecord): boolean {
	return !Boolean(record.revokedAt ?? record.revoked_at);
}

/**
 * Resolve the Cloud device row that represents this physical Windows device for one account.
 *
 * HF-001 introduced account-scoped device ids while preserving already-authorized legacy
 * physical ids. Recovery must prefer an ACTIVE compatible row. Merely preferring a scoped id
 * because a historical/revoked row exists can make an already-authorized machine look new after
 * restart and incorrectly push the user toward another activation-code redemption.
 */
export function resolveCloudDeviceRecoverySelection(
	baseDeviceId: string,
	accountId: string,
	devices: readonly CloudDeviceRecoveryRecord[],
): CloudDeviceRecoverySelection {
	const normalizedBase = normalizedDeviceId(baseDeviceId);
	if (!normalizedBase) throw new Error('MOONCODE_DEVICE_ID_INVALID');
	const scopedDeviceId = deriveAccountScopedDeviceId(normalizedBase, accountId);

	let activeScoped: CloudDeviceRecoveryRecord | undefined;
	let activeLegacy: CloudDeviceRecoveryRecord | undefined;
	let revokedScoped: CloudDeviceRecoveryRecord | undefined;
	let revokedLegacy: CloudDeviceRecoveryRecord | undefined;

	for (const record of devices) {
		const id = normalizedDeviceId(record.id);
		if (!id) continue;
		if (id === scopedDeviceId) {
			if (isActive(record)) activeScoped ??= record;
			else revokedScoped ??= record;
		} else if (id === normalizedBase) {
			if (isActive(record)) activeLegacy ??= record;
			else revokedLegacy ??= record;
		}
	}

	if (activeScoped) return { deviceId: scopedDeviceId, record: activeScoped, source: 'active_scoped' };
	if (activeLegacy) return { deviceId: normalizedBase, record: activeLegacy, source: 'active_legacy' };
	if (revokedScoped) return { deviceId: scopedDeviceId, record: revokedScoped, source: 'revoked_scoped' };
	if (revokedLegacy) return { deviceId: normalizedBase, record: revokedLegacy, source: 'revoked_legacy' };
	return { deviceId: scopedDeviceId, source: 'new_scoped' };
}

/**
 * New physical/account combinations with an active entitlement should authorize automatically
 * when the account still has a free device slot. Historical revoked rows remain fail-closed.
 */
export function resolveCloudDeviceAuthorizationAction(
	selection: CloudDeviceRecoverySelection,
	activeDeviceCount: number,
	deviceLimit: number,
): CloudDeviceAuthorizationAction {
	if (selection.source !== 'new_scoped') return 'none';
	if (!Number.isSafeInteger(deviceLimit) || deviceLimit <= 0) return 'none';
	const active = Number.isSafeInteger(activeDeviceCount) && activeDeviceCount > 0 ? activeDeviceCount : 0;
	return active >= deviceLimit ? 'quota_full' : 'auto_authorize';
}
