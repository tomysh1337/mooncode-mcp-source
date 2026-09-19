export function normalizeExternalSalesUrl(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error('该套餐尚未配置外部商品地址。');
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		throw new Error('外部商品地址无效。');
	}
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
		throw new Error('外部商品地址必须使用不含凭据的 HTTPS URL。');
	}
	return parsed.toString();
}
