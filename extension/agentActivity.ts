export type AgentActivityLevel = 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface AgentActivityLine {
	level: AgentActivityLevel;
	message: string;
	current?: number;
	total?: number;
	phase?: number;
	phaseTotal?: number;
}

const TOOL_LABELS: Record<string, string> = {
	apply_patch: '修改文件', write_file: '写入文件', run_command: '执行终端任务', lsp: '代码语义分析',
	get_diagnostics: '检查代码诊断', list_directory: '读取目录', find_files: '查找文件', read_files: '读取文件',
	read_file: '读取文件', search_files: '搜索代码',
};
const ANSI: Record<AgentActivityLevel, string> = { info: '\x1b[0m', progress: '\x1b[36m', success: '\x1b[32m', warning: '\x1b[33m', danger: '\x1b[31m' };

function finiteInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function sanitizeAgentActivityText(value: unknown, max = 180): string {
	let text = typeof value === 'string' ? value : value == null ? '' : String(value);
	text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
		.replace(/https?:\/\/\S+/gi, '[URL 已隐藏]').replace(/\bMC-[A-Z0-9-]{6,}\b/gi, '[激活码已隐藏]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [凭据已隐藏]')
		.replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function progressFields(event: Record<string, unknown>): Pick<AgentActivityLine, 'current' | 'total' | 'phase' | 'phaseTotal'> {
	const current = finiteInteger(event.current), total = finiteInteger(event.total), phase = finiteInteger(event.phase), phaseTotal = finiteInteger(event.phaseTotal ?? event.phase_total);
	return {
		...(current !== undefined && total !== undefined && total > 0 && current <= total ? { current, total } : {}),
		...(phase !== undefined && phaseTotal !== undefined && phaseTotal > 0 && phase > 0 && phase <= phaseTotal ? { phase, phaseTotal } : {}),
	};
}

function toolLabel(value: unknown): string {
	const tool = typeof value === 'string' ? value : '';
	return TOOL_LABELS[tool] ?? (tool ? sanitizeAgentActivityText(tool, 60) : '任务');
}

export function bridgeEventToAgentActivity(event: Record<string, unknown>): AgentActivityLine | undefined {
	const type = typeof event.type === 'string' ? event.type : '';
	if (!type) return undefined;
	if (type === 'bridge.starting') return { level: 'progress', message: '正在启动 Bridge' };
	if (type === 'bridge.stopping') return { level: 'progress', message: '正在停止 Bridge' };
	if (type === 'bridge.stopped') return { level: 'success', message: 'Bridge 已停止' };
	if (type === 'bridge.todos') {
		const todos = Array.isArray(event.todos) ? event.todos.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
		if (!todos.length) return undefined;
		const completed = todos.filter(item => item.status === 'completed').length;
		const active = todos.find(item => item.status === 'in_progress') ?? todos.find(item => item.status === 'pending');
		if (!active) return { level: 'success', message: '任务清单已完成', phase: todos.length, phaseTotal: todos.length };
		return { level: 'progress', message: `任务：${sanitizeAgentActivityText(active.content, 140) || '进行中'}`, phase: Math.min(todos.length, completed + 1), phaseTotal: todos.length };
	}
	if (type === 'bridge.progress') {
		const message = sanitizeAgentActivityText(event.message, 160);
		return message ? { level: 'progress', message, ...progressFields(event) } : undefined;
	}
	if (type === 'bridge.call') {
		if (event.tool === 'apply_patch' || event.tool === 'write_file') return { level: 'warning', message: `正在${toolLabel(event.tool)}` };
		if (event.tool === 'run_command') return { level: 'warning', message: '正在执行终端任务' };
		return undefined;
	}
	if (type === 'bridge.result') {
		const durationMs = finiteInteger(event.durationMs);
		if (event.ok !== true) {
			const code = sanitizeAgentActivityText(event.errorCode, 60);
			return { level: 'danger', message: `${toolLabel(event.tool)}失败${code ? ` · ${code}` : ''}` };
		}
		if (event.tool === 'apply_patch' || event.tool === 'write_file' || event.tool === 'run_command') return { level: 'success', message: `${toolLabel(event.tool)}完成${durationMs !== undefined && durationMs >= 1_000 ? ` · ${(durationMs / 1_000).toFixed(1)}s` : ''}` };
		if (durationMs !== undefined && durationMs >= 5_000) return { level: 'success', message: `耗时任务完成：${toolLabel(event.tool)} · ${(durationMs / 1_000).toFixed(1)}s` };
		return undefined;
	}
	if (type === 'bridge.patch_result') {
		if (event.recoveryRequired === true || event.recovery_required === true) return { level: 'danger', message: '文件修改需要人工恢复' };
		if (event.applied === true) return { level: 'success', message: `文件修改已应用${Array.isArray(event.files) && event.files.length ? ` · ${event.files.length} 个文件` : ''}` };
		return undefined;
	}
	if (type === 'bridge.access_scope_changed') return event.accessScope === 'computer' ? { level: 'danger', message: '高权限：已允许访问整台电脑' } : { level: 'success', message: '权限已恢复为当前工作区' };
	if (type === 'bridge.tunnel_status') {
		const state = typeof event.state === 'string' ? event.state : '';
		const attempt = Number.isSafeInteger(event.attempt) && Number(event.attempt) > 0 ? Number(event.attempt) : undefined;
		if (state === 'connecting' || state === 'starting') return { level: 'progress', message: `正在建立公网 MCP 连接${attempt ? ` · 第 ${attempt} 次尝试` : ''}` };
		if (state === 'public_ready') return { level: 'success', message: '公网 MCP 连接已就绪' };
		if (state === 'degraded') return { level: 'warning', message: `公网连接异常${event.message ? ` · ${sanitizeAgentActivityText(event.message, 100)}` : ''}` };
		if (state === 'error' && event.errorCode === 'TIMEOUT') return { level: 'danger', message: `公网连接超时${attempt ? ` · 已尝试 ${attempt} 次` : ''} · Cloudflare Quick Tunnel 未在等待窗口内就绪` };
		if (state === 'error') return { level: 'danger', message: `公网连接失败${event.message ? ` · ${sanitizeAgentActivityText(event.message, 100)}` : ''}` };
		return undefined;
	}
	if (type === 'bridge.cancelled') return { level: 'warning', message: `${toolLabel(event.tool)}已取消` };
	if (type.endsWith('_error') || type === 'bridge.extension_error') return { level: 'danger', message: sanitizeAgentActivityText(event.message, 160) || 'MoonCode Agent 执行失败' };
	return undefined;
}

function progressSuffix(line: AgentActivityLine): string {
	if (line.current !== undefined && line.total !== undefined && line.total > 0) return `  ${line.current} / ${line.total} · ${Math.round((line.current / line.total) * 100)}%`;
	if (line.phase !== undefined && line.phaseTotal !== undefined && line.phaseTotal > 0) return `  阶段 ${line.phase} / ${line.phaseTotal}`;
	return '';
}

export function renderAgentActivityAnsi(line: AgentActivityLine, at = new Date()): string {
	const p = (value: number) => String(value).padStart(2, '0');
	return `${ANSI[line.level]}${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}  ${sanitizeAgentActivityText(line.message, 180)}${progressSuffix(line)}\x1b[0m\r\n`;
}
