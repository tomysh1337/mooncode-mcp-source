import { spawnSync } from 'node:child_process';

export type AutomaticTunnelProxySource = 'environment' | 'vscode' | 'windows' | 'none';

export interface AutomaticTunnelProxyResolution {
	url: string;
	source: AutomaticTunnelProxySource;
}

function normalizedProxyUrl(value: unknown): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return '';
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	try {
		const url = new URL(candidate);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname || !url.port) return '';
		return url.toString().replace(/\/$/, '');
	} catch {
		return '';
	}
}

export function parseWindowsProxyServer(value: unknown): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return '';
	if (!raw.includes('=')) return normalizedProxyUrl(raw);
	const entries = new Map<string, string>();
	for (const part of raw.split(';')) {
		const separator = part.indexOf('=');
		if (separator <= 0) continue;
		entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
	}
	return normalizedProxyUrl(entries.get('https') || entries.get('http') || '');
}

function windowsInternetProxy(): string {
	if (process.platform !== 'win32') return '';
	const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
	const enabled = spawnSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 2_000 });
	if (enabled.status !== 0 || !/REG_DWORD\s+0x1(?:\s|$)/i.test(String(enabled.stdout || ''))) return '';
	const server = spawnSync('reg.exe', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 2_000 });
	if (server.status !== 0) return '';
	const match = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(String(server.stdout || ''));
	return parseWindowsProxyServer(match?.[1]);
}

export function resolveAutomaticTunnelProxyWithSource(vscodeHttpProxy = '', env: NodeJS.ProcessEnv = process.env): AutomaticTunnelProxyResolution {
	for (const [source, candidate] of [
		['environment', env.HTTPS_PROXY],
		['environment', env.https_proxy],
		['environment', env.HTTP_PROXY],
		['environment', env.http_proxy],
		['vscode', vscodeHttpProxy],
	] as const) {
		const normalized = normalizedProxyUrl(candidate);
		if (normalized) return { url: normalized, source };
	}
	const windows = windowsInternetProxy();
	return windows ? { url: windows, source: 'windows' } : { url: '', source: 'none' };
}

export function resolveAutomaticTunnelProxy(vscodeHttpProxy = '', env: NodeJS.ProcessEnv = process.env): string {
	return resolveAutomaticTunnelProxyWithSource(vscodeHttpProxy, env).url;
}
