export function formatCloudDurationSeconds(value: number): string | undefined {
	if (!Number.isSafeInteger(value) || value <= 0) return undefined;
	if (value % 86_400 === 0) return `${value / 86_400} 天`;
	if (value % 3_600 === 0) return `${value / 3_600} 小时`;
	if (value % 60 === 0) return `${value / 60} 分钟`;
	return `${value} 秒`;
}
