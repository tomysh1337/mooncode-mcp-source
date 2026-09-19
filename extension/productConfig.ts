export type MoonCodeProductConfigErrorCode = 'PRODUCT_JSON_INVALID' | 'PRODUCT_CLOUD_URL_MISSING';

export class MoonCodeProductConfigError extends Error {
	constructor(readonly code: MoonCodeProductConfigErrorCode, message: string) {
		super(message);
		this.name = 'MoonCodeProductConfigError';
	}
}

export interface MoonCodePackagedProductConfig {
	mooncodeCloudApiUrl: string;
}

export function parseMoonCodePackagedProductConfig(rawText: string): MoonCodePackagedProductConfig {
	const normalizedText = rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText;
	let parsed: object;
	try {
		const value = JSON.parse(normalizedText);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('product root must be a JSON object');
		}
		parsed = value;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new MoonCodeProductConfigError('PRODUCT_JSON_INVALID', `MoonCode product.json 解析失败：${detail}`);
	}

	const cloudApiUrl = (parsed as { mooncodeCloudApiUrl?: object | string | number | boolean | null }).mooncodeCloudApiUrl;
	if (typeof cloudApiUrl !== 'string' || !cloudApiUrl.trim()) {
		throw new MoonCodeProductConfigError('PRODUCT_CLOUD_URL_MISSING', 'MoonCode product.json 缺少有效的 mooncodeCloudApiUrl。');
	}
	return { mooncodeCloudApiUrl: cloudApiUrl };
}
