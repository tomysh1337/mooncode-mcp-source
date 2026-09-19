import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MOONCODE_DEVICE_PRIVATE_KEY_SECRET = 'mooncode.cloud.devicePrivateKey.ed25519.v1';
export const MOONCODE_DEVICE_KEY_ALGORITHM = 'Ed25519' as const;
export const MOONCODE_DEVICE_KEY_VERSION = 1 as const;

export interface DeviceSecretStore {
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
}

export interface WindowsDeviceMaterials {
	machineGuid?: string;
	smbiosUuid?: string;
}

export interface MoonCodeDeviceIdentity {
	deviceId: string;
	publicKey: string;
	keyAlgorithm: typeof MOONCODE_DEVICE_KEY_ALGORITHM;
	keyVersion: typeof MOONCODE_DEVICE_KEY_VERSION;
	signChallenge(challengeId: string, challenge: string): string;
	signAuthorizationLease(deviceId: string, signedAt: string, nonce: string): string;
}

function normalizedIdentifier(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim().replace(/[{}]/g, '').replace(/\s+/g, '').toLowerCase();
	if (!normalized) return undefined;
	if (/^(?:0+|f+)$/u.test(normalized.replace(/-/g, ''))) return undefined;
	if (normalized.includes('tobefilledbyo.e.m') || normalized.includes('defaultstring') || normalized.includes('systemserialnumber')) return undefined;
	return normalized;
}

function uuidFromSha256(digest: Buffer): string {
	const bytes = Buffer.from(digest.subarray(0, 16));
	// RFC 9562 UUIDv8: implementation-defined payload with the normal RFC variant.
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveStableDeviceId(materials: WindowsDeviceMaterials): string {
	const machineGuid = normalizedIdentifier(materials.machineGuid);
	const smbiosUuid = normalizedIdentifier(materials.smbiosUuid);
	if (!machineGuid && !smbiosUuid) throw new Error('MOONCODE_DEVICE_IDENTITY_UNAVAILABLE');
	const material = [
		'mooncode-device-fingerprint-v1',
		`machine-guid=${machineGuid ?? '-'}`,
		`smbios-uuid=${smbiosUuid ?? '-'}`,
	].join('\n');
	return uuidFromSha256(createHash('sha256').update(material, 'utf8').digest());
}

export function deriveAccountScopedDeviceId(baseDeviceId: string, accountId: string): string {
	const normalizeUuid = (value: string, errorCode: string): string => {
		const normalized = value.trim().toLowerCase();
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) throw new Error(errorCode);
		return normalized;
	};
	const device = normalizeUuid(baseDeviceId, 'MOONCODE_DEVICE_ID_INVALID');
	const account = normalizeUuid(accountId, 'MOONCODE_ACCOUNT_ID_INVALID');
	const material = [
		'mooncode-account-device-v1',
		`account-id=${account}`,
		`base-device-id=${device}`,
	].join('\n');
	return uuidFromSha256(createHash('sha256').update(material, 'utf8').digest());
}

async function readMachineGuid(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
			windowsHide: true,
			timeout: 5_000,
			encoding: 'utf8',
		});
		const match = /MachineGuid\s+REG_[A-Z0-9_]+\s+([^\r\n]+)/iu.exec(String(stdout));
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

async function readSmbiosUuid(): Promise<string | undefined> {
	const commands = [
		'$v=(Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID; if($v){[Console]::Out.Write($v)}',
		'$v=(Get-WmiObject -Class Win32_ComputerSystemProduct -ErrorAction Stop).UUID; if($v){[Console]::Out.Write($v)}',
	];
	for (const command of commands) {
		try {
			const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
				windowsHide: true,
				timeout: 7_000,
				encoding: 'utf8',
			});
			const value = String(stdout).trim();
			if (value) return value;
		} catch {}
	}
	return undefined;
}

export async function readWindowsDeviceMaterials(): Promise<WindowsDeviceMaterials> {
	if (process.platform !== 'win32') throw new Error('MOONCODE_WINDOWS_DEVICE_IDENTITY_REQUIRED');
	const [machineGuid, smbiosUuid] = await Promise.all([readMachineGuid(), readSmbiosUuid()]);
	if (!normalizedIdentifier(machineGuid) && !normalizedIdentifier(smbiosUuid)) throw new Error('MOONCODE_DEVICE_IDENTITY_UNAVAILABLE');
	return { machineGuid, smbiosUuid };
}

function validatePrivateKey(privateKeyPem: string): { privateKeyPem: string; publicKey: string } {
	const privateKey = createPrivateKey(privateKeyPem);
	if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('MOONCODE_DEVICE_PRIVATE_KEY_INVALID');
	const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
	return { privateKeyPem, publicKey };
}

export async function getOrCreateDeviceKey(secretStore: DeviceSecretStore): Promise<{ privateKeyPem: string; publicKey: string }> {
	const existing = await secretStore.get(MOONCODE_DEVICE_PRIVATE_KEY_SECRET);
	if (existing) return validatePrivateKey(existing);
	const pair = generateKeyPairSync('ed25519');
	const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
	await secretStore.store(MOONCODE_DEVICE_PRIVATE_KEY_SECRET, privateKeyPem);
	return { privateKeyPem, publicKey };
}

export function deviceProofMessage(challengeId: string, challenge: string): Buffer {
	if (!challengeId.trim() || !challenge.trim()) throw new Error('MOONCODE_DEVICE_CHALLENGE_INVALID');
	return Buffer.from(`mooncode-device-proof-v1\n${challengeId}\n${challenge}`, 'utf8');
}

export function deviceAuthorizationLeaseMessage(deviceId: string, signedAt: string, nonce: string): Buffer {
	if (!deviceId.trim() || !signedAt.trim() || !nonce.trim()) throw new Error('MOONCODE_DEVICE_AUTHORIZATION_LEASE_INVALID');
	return Buffer.from(`mooncode-device-authorization-lease-v1\n${deviceId}\n${signedAt}\n${nonce}`, 'utf8');
}

export async function loadMoonCodeDeviceIdentity(
	secretStore: DeviceSecretStore,
	readMaterials: () => Promise<WindowsDeviceMaterials> = readWindowsDeviceMaterials,
): Promise<MoonCodeDeviceIdentity> {
	const deviceId = deriveStableDeviceId(await readMaterials());
	const { privateKeyPem, publicKey } = await getOrCreateDeviceKey(secretStore);
	return {
		deviceId,
		publicKey,
		keyAlgorithm: MOONCODE_DEVICE_KEY_ALGORITHM,
		keyVersion: MOONCODE_DEVICE_KEY_VERSION,
		signChallenge(challengeId: string, challenge: string): string {
			return sign(null, deviceProofMessage(challengeId, challenge), privateKeyPem).toString('base64url');
		},
		signAuthorizationLease(leaseDeviceId: string, signedAt: string, nonce: string): string {
			return sign(null, deviceAuthorizationLeaseMessage(leaseDeviceId, signedAt, nonce), privateKeyPem).toString('base64url');
		},
	};
}
