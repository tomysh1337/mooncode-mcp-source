import { join } from 'node:path';

export type CloudflaredDependencyStatus =
	| 'checking'
	| 'available'
	| 'path_hidden'
	| 'missing'
	| 'broken'
	| 'version_abnormal'
	| 'installing'
	| 'install_cancelled'
	| 'install_failed'
	| 'not_required';

export interface CloudflaredReleaseAsset {
	tag: string;
	name: 'cloudflared-windows-amd64.msi';
	downloadUrl: string;
	sha256: string;
	size: number;
}

export interface CloudflaredDependencyResult {
	status: CloudflaredDependencyStatus;
	installed: boolean;
	executable: string;
	resolvedExecutable?: string;
	version?: string;
	error?: string;
}

const WINDOWS_AMD64_MSI = 'cloudflared-windows-amd64.msi';

function envValue(env: NodeJS.ProcessEnv, key: string): string {
	const direct = env[key];
	if (direct) return direct;
	const match = Object.keys(env).find(candidate => candidate.toLowerCase() === key.toLowerCase());
	return match ? env[match] ?? '' : '';
}

export function cloudflaredCommonWindowsCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const candidates = new Set<string>();
	const programFilesX86 = envValue(env, 'ProgramFiles(x86)');
	const programFiles = envValue(env, 'ProgramFiles');
	const localAppData = envValue(env, 'LOCALAPPDATA');
	const userProfile = envValue(env, 'USERPROFILE');
	if (programFilesX86) candidates.add(join(programFilesX86, 'cloudflared', 'cloudflared.exe'));
	if (programFiles) candidates.add(join(programFiles, 'cloudflared', 'cloudflared.exe'));
	if (localAppData) candidates.add(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
	if (userProfile) candidates.add(join(userProfile, 'scoop', 'apps', 'cloudflared', 'current', 'cloudflared.exe'));
	return [...candidates];
}

export function isNormalCloudflaredVersionOutput(output: string): boolean {
	return /\bcloudflared\s+version\s+\d{4}\.\d+(?:\.\d+)?\b/i.test(output.trim());
}

export function selectOfficialCloudflaredWindowsMsi(payload: unknown): CloudflaredReleaseAsset {
	if (!payload || typeof payload !== 'object') throw new Error('Cloudflare release metadata is not an object');
	const release = payload as { tag_name?: unknown; assets?: unknown };
	const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
	if (!/^\d{4}\.\d+(?:\.\d+)?$/.test(tag)) throw new Error('Cloudflare release tag is invalid');
	if (!Array.isArray(release.assets)) throw new Error('Cloudflare release assets are missing');
	const raw = release.assets.find(item => item && typeof item === 'object' && (item as { name?: unknown }).name === WINDOWS_AMD64_MSI) as {
		name?: unknown;
		browser_download_url?: unknown;
		digest?: unknown;
		size?: unknown;
	} | undefined;
	if (!raw) throw new Error('Cloudflare Windows x64 MSI asset is missing');
	const downloadUrl = typeof raw.browser_download_url === 'string' ? raw.browser_download_url : '';
	const digest = typeof raw.digest === 'string' ? raw.digest.toLowerCase() : '';
	const size = typeof raw.size === 'number' && Number.isSafeInteger(raw.size) ? raw.size : 0;
	if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Cloudflare release asset has no trusted SHA-256 digest');
	if (size < 1_000_000 || size > 100_000_000) throw new Error('Cloudflare release asset size is outside the expected range');
	let parsed: URL;
	try { parsed = new URL(downloadUrl); } catch { throw new Error('Cloudflare release asset URL is invalid'); }
	if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') throw new Error('Cloudflare release asset URL is not an official GitHub HTTPS URL');
	const segments = parsed.pathname.split('/').filter(Boolean).map(value => decodeURIComponent(value));
	if (segments.length !== 6 || segments[0] !== 'cloudflare' || segments[1] !== 'cloudflared' || segments[2] !== 'releases' || segments[3] !== 'download' || segments[4] !== tag || segments[5] !== WINDOWS_AMD64_MSI) {
		throw new Error('Cloudflare release asset URL does not match the official cloudflare/cloudflared release path');
	}
	return { tag, name: WINDOWS_AMD64_MSI, downloadUrl, sha256: digest.slice('sha256:'.length), size };
}

export function classifyWindowsInstallerExitCode(code: number | null): 'success' | 'success_restart_required' | 'cancelled' | 'failed' {
	if (code === 0) return 'success';
	if (code === 3010) return 'success_restart_required';
	if (code === 1602) return 'cancelled';
	return 'failed';
}
