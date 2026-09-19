export type CloudNetworkErrorKind = 'timeout' | 'dns' | 'tls' | 'refused' | 'reset' | 'aborted' | 'network';

export const CLOUD_REQUEST_TIMEOUT_MS = 15_000;
export const CLOUD_READ_MAX_ATTEMPTS = 2;

function errorChain(error: unknown): Array<{ name: string; message: string; code: string }> {
	const result: Array<{ name: string; message: string; code: string }> = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
		const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
		result.push({
			name: typeof value.name === 'string' ? value.name : '',
			message: typeof value.message === 'string' ? value.message : '',
			code: typeof value.code === 'string' ? value.code : '',
		});
		current = value.cause;
	}
	return result;
}

export function classifyCloudNetworkError(error: unknown, callerAborted = false): CloudNetworkErrorKind {
	const chain = errorChain(error);
	const text = chain.map(item => `${item.name} ${item.code} ${item.message}`).join(' ').toLowerCase();
	if (callerAborted || (/\baborterror\b/.test(text) && !/timeout|timed out/.test(text))) return 'aborted';
	if (/timeout|timed out|etimedout|und_err_connect_timeout|the operation was aborted due to timeout/.test(text)) return 'timeout';
	if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) return 'dns';
	if (/econnrefused|connection refused/.test(text)) return 'refused';
	if (/econnreset|socket hang up|und_err_socket|connection reset/.test(text)) return 'reset';
	if (/certificate|cert_|tls|ssl|unable_to_verify|self signed/.test(text)) return 'tls';
	return 'network';
}

function diagnostic(kind: CloudNetworkErrorKind, attempts: number, timeoutMs: number): string {
	const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
	const attemptText = attempts > 1 ? `，已尝试 ${attempts} 次` : '';
	if (kind === 'timeout') return `MoonCode Cloud 连接超时（单次 ${seconds} 秒${attemptText}）。未收到服务端响应，请检查本机网络、VPN 或代理后重试。`;
	if (kind === 'dns') return `无法解析 MoonCode Cloud 域名${attemptText}。请检查 DNS、VPN 或代理后重试。`;
	if (kind === 'tls') return `MoonCode Cloud HTTPS/TLS 握手失败${attemptText}。请检查系统时间、证书拦截、VPN 或代理。`;
	if (kind === 'refused') return `MoonCode Cloud 连接被拒绝${attemptText}。请检查本机网络、防火墙或代理。`;
	if (kind === 'reset') return `MoonCode Cloud 连接被中途重置${attemptText}。请检查网络、VPN 或代理后重试。`;
	if (kind === 'aborted') return 'MoonCode Cloud 请求已取消。';
	return `MoonCode Cloud 网络请求失败${attemptText}。请检查本机网络、VPN 或代理后重试。`;
}

export class CloudNetworkRequestError extends Error {
	constructor(
		readonly kind: CloudNetworkErrorKind,
		readonly attempts: number,
		readonly timeoutMs: number,
		readonly upstream?: unknown,
	) {
		super(diagnostic(kind, attempts, timeoutMs));
		this.name = 'CloudNetworkRequestError';
	}
}

export function describeCloudFailure(error: unknown): string {
	if (error instanceof CloudNetworkRequestError) return error.message;
	const message = error instanceof Error ? error.message : String(error);
	const status = /\((\d{3})(?:\s|\))/.exec(message)?.[1];
	if (status) {
		const code = Number(status);
		if (code >= 500) return `MoonCode Cloud 返回 HTTP ${code}，服务暂时异常，请稍后重试。`;
		if (code === 429) return 'MoonCode Cloud 请求过于频繁，请稍后重试。';
	}
	return message;
}

export async function fetchCloudWithPolicy(
	input: Parameters<typeof fetch>[0],
	init: RequestInit = {},
	options: {
		fetcher?: typeof fetch;
		timeoutMs?: number;
		maxAttempts?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<Response> {
	const fetcher = options.fetcher ?? fetch;
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, Math.round(options.timeoutMs!)) : CLOUD_REQUEST_TIMEOUT_MS;
	const method = String(init.method || 'GET').toUpperCase();
	const idempotent = method === 'GET' || method === 'HEAD';
	const maxAttempts = Math.max(1, Math.min(2, Math.round(options.maxAttempts ?? (idempotent ? CLOUD_READ_MAX_ATTEMPTS : 1))));
	const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const callerSignal = init.signal;
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		try {
			return await fetcher(input, { ...init, signal });
		} catch (error) {
			lastError = error;
			const callerAborted = Boolean(callerSignal?.aborted);
			const kind = classifyCloudNetworkError(error, callerAborted);
			if (!idempotent || kind === 'aborted' || attempt >= maxAttempts) {
				throw new CloudNetworkRequestError(kind, attempt, timeoutMs, error);
			}
			await sleep(250 * attempt);
		}
	}
	throw new CloudNetworkRequestError(classifyCloudNetworkError(lastError), maxAttempts, timeoutMs, lastError);
}
