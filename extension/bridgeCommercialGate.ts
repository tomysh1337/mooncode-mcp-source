export type BridgeCommercialAccountStatus = 'unconfigured' | 'signed_out' | 'signing_in' | 'signed_in' | 'error';

export interface BridgeCommercialGateInput {
	configured: boolean;
	status: BridgeCommercialAccountStatus;
	hasEntitlement: boolean;
	deviceAuthorized: boolean;
	authorizationValidUntil?: string;
}

export type BridgeCommercialGateResult =
	| { allowed: true; mode: 'online' | 'offline_lease' }
	| { allowed: false; mode: 'denied'; reason: string };

export function bridgeAuthorizationLeaseActive(input: Pick<BridgeCommercialGateInput, 'deviceAuthorized' | 'authorizationValidUntil'>, nowMs = Date.now()): boolean {
	if (!input.deviceAuthorized || !input.authorizationValidUntil) return false;
	const expiresAt = Date.parse(input.authorizationValidUntil);
	return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

export function evaluateBridgeCommercialGate(input: BridgeCommercialGateInput, nowMs = Date.now()): BridgeCommercialGateResult {
	const leaseActive = bridgeAuthorizationLeaseActive(input, nowMs);
	if (input.status === 'signed_in' && input.hasEntitlement && input.deviceAuthorized && leaseActive) {
		return { allowed: true, mode: 'online' };
	}
	if (input.status === 'error' && input.hasEntitlement && input.deviceAuthorized && leaseActive) {
		return { allowed: true, mode: 'offline_lease' };
	}
	if (!input.configured || input.status === 'unconfigured') {
		return { allowed: false, mode: 'denied', reason: 'MoonCode Cloud API 尚未配置；正式产品不允许绕过登录、套餐和设备授权启动 Bridge。' };
	}
	if (input.status === 'signed_out') {
		return { allowed: false, mode: 'denied', reason: 'MoonCode Cloud 登录已失效。' };
	}
	if (input.status === 'signing_in') {
		return { allowed: false, mode: 'denied', reason: 'MoonCode Cloud 尚未完成登录。' };
	}
	if (!input.hasEntitlement) {
		return { allowed: false, mode: 'denied', reason: '当前 MoonCode 账号没有有效套餐/授权。' };
	}
	if (!input.deviceAuthorized) {
		return { allowed: false, mode: 'denied', reason: '当前设备未获得 MoonCode Cloud 授权。' };
	}
	if (!leaseActive) {
		return {
			allowed: false,
			mode: 'denied',
			reason: input.status === 'error'
				? 'MoonCode Cloud 无法确认授权，最近一次设备租约已超过 5 分钟或已到期。'
				: '当前设备的 MoonCode Cloud 授权租约无效或已到期。',
		};
	}
	return { allowed: false, mode: 'denied', reason: 'MoonCode Cloud 当前无法确认 Bridge 商业授权。' };
}
