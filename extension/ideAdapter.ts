import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';

export type IdeRequestKind = 'lsp' | 'get_diagnostics';
export type IdeProviderState = 'ready' | 'unavailable' | 'not_ready' | 'project_mismatch';

export class IdeAdapterError extends Error {
	constructor(readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'CANCELLED' | 'PROVIDER_UNAVAILABLE' | 'INTERNAL_ERROR', message: string) {
		super(message);
		this.name = 'IdeAdapterError';
	}
}

type RangeJson = { start: { line: number; column: number }; end: { line: number; column: number } };

const abortIfNeeded = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new IdeAdapterError('CANCELLED', 'IDE request was cancelled');
};

const normalizeCase = (value: string): string => process.platform === 'win32' ? value.toLocaleLowerCase() : value;

async function safeFileUri(workspaceRoot: string, requestedPath: string, signal?: AbortSignal): Promise<{ uri: vscode.Uri; path: string }> {
	abortIfNeeded(signal);
	if (!requestedPath || isAbsolute(requestedPath) || requestedPath.includes('\0')) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'path must be a non-empty workspace-relative file path');
	}
	const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
	const lexical = resolve(root, requestedPath);
	const lexicalRel = relative(root, lexical);
	if (lexicalRel === '..' || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'path escapes the selected workspace');
	}
	let actual: string;
	try {
		actual = await realpath(lexical);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') throw new IdeAdapterError('NOT_FOUND', `file not found: ${requestedPath}`);
		throw error;
	}
	const actualRel = relative(root, actual);
	if (actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'resolved file path leaves the selected workspace');
	}
	const canonicalRoot = normalizeCase(root.endsWith(sep) ? root : `${root}${sep}`);
	const canonicalActual = normalizeCase(actual);
	if (canonicalActual !== normalizeCase(root) && !canonicalActual.startsWith(canonicalRoot)) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'resolved file path leaves the selected workspace');
	}
	return { uri: vscode.Uri.file(actual), path: actualRel.replace(/\\/g, '/') };
}

function rangeJson(range: vscode.Range): RangeJson {
	return {
		start: { line: range.start.line + 1, column: range.start.character + 1 },
		end: { line: range.end.line + 1, column: range.end.character + 1 },
	};
}

function positionFromArgs(args: Record<string, unknown>): vscode.Position {
	const line = args.line;
	const column = args.column;
	if (!Number.isInteger(line) || Number(line) < 1 || !Number.isInteger(column) || Number(column) < 1) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'line and column must be 1-based positive integers');
	}
	return new vscode.Position(Number(line) - 1, Number(column) - 1);
}

function maxResults(args: Record<string, unknown>): number {
	const raw = args.max_results;
	if (raw === undefined) return 100;
	if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > 500) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'max_results must be an integer from 1 to 500');
	}
	return Number(raw);
}

function relativeUri(workspaceRoot: string, uri: vscode.Uri): string | null {
	if (uri.scheme !== 'file') return uri.toString();
	const rel = relative(workspaceRoot, uri.fsPath);
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return rel.replace(/\\/g, '/');
}

function kindName(kind: vscode.SymbolKind): string {
	return vscode.SymbolKind[kind] ?? String(kind);
}

function serializeLocation(workspaceRoot: string, location: vscode.Location): Record<string, unknown> {
	return {
		path: relativeUri(workspaceRoot, location.uri),
		uri: location.uri.toString(),
		range: rangeJson(location.range),
	};
}

function isLocationLink(value: vscode.Location | vscode.LocationLink): value is vscode.LocationLink {
	return 'targetUri' in value;
}

function serializeLocationLike(workspaceRoot: string, value: vscode.Location | vscode.LocationLink): Record<string, unknown> {
	if (!isLocationLink(value)) return serializeLocation(workspaceRoot, value);
	return {
		path: relativeUri(workspaceRoot, value.targetUri),
		uri: value.targetUri.toString(),
		target_range: rangeJson(value.targetRange),
		target_selection_range: value.targetSelectionRange ? rangeJson(value.targetSelectionRange) : undefined,
		origin_selection_range: value.originSelectionRange ? rangeJson(value.originSelectionRange) : undefined,
	};
}

function markdownText(content: vscode.MarkdownString | vscode.MarkedString): string {
	if (typeof content === 'string') return content;
	return content.value;
}

function providerStateForUndefined(document?: vscode.TextDocument): { provider_state: IdeProviderState; provider_state_reason: string } {
	if (!document) return { provider_state: 'unavailable', provider_state_reason: 'provider command returned no result' };
	const languageId = document.languageId;
	const languageExtensions = vscode.extensions.all.filter(extension => {
		const languages = (extension.packageJSON as { contributes?: { languages?: Array<{ id?: unknown }> } }).contributes?.languages;
		return Array.isArray(languages) && languages.some(language => language.id === languageId);
	});
	if (languageId === 'plaintext' || languageExtensions.length === 0) {
		return { provider_state: 'project_mismatch', provider_state_reason: `no matching language provider contribution for ${languageId}` };
	}
	if (languageExtensions.some(extension => !extension.isActive)) {
		return { provider_state: 'not_ready', provider_state_reason: `matching ${languageId} extension is not active` };
	}
	return { provider_state: 'unavailable', provider_state_reason: `active ${languageId} extensions returned no provider result` };
}

function baseResult(
	state: IdeProviderState,
	reason: string,
	document: vscode.TextDocument | undefined,
	projectAnchor: string,
	projectAnchorSource: 'requested_path' | 'workspace',
): Record<string, unknown> {
	return {
		provider_state: state,
		provider_state_reason: reason,
		project_anchor: projectAnchor,
		project_anchor_source: projectAnchorSource,
		warmup_performed: Boolean(document),
		semantic_result_inconclusive: state !== 'ready',
		...(document ? {
			document_path: relativeUri(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', document.uri),
			document_version: document.version,
			document_dirty: document.isDirty,
			language_id: document.languageId,
		} : {}),
	};
}

async function runLsp(workspaceRoot: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	abortIfNeeded(signal);
	const operation = args.operation;
	if (!['workspace_symbols', 'document_symbols', 'definition', 'references', 'implementation', 'hover'].includes(String(operation))) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'unsupported lsp operation');
	}
	const limit = maxResults(args);
	let document: vscode.TextDocument | undefined;
	let path = '';
	if (operation !== 'workspace_symbols' || typeof args.path === 'string') {
		if (typeof args.path !== 'string' || !args.path) throw new IdeAdapterError('INVALID_ARGUMENT', 'path is required for this lsp operation');
		const safe = await safeFileUri(workspaceRoot, args.path, signal);
		path = safe.path;
		document = await vscode.workspace.openTextDocument(safe.uri);
		abortIfNeeded(signal);
	}

	const anchor = path || '.';
	const anchorSource = document ? 'requested_path' as const : 'workspace' as const;
	let raw: unknown;
	if (operation === 'workspace_symbols') {
		if (typeof args.query !== 'string') throw new IdeAdapterError('INVALID_ARGUMENT', 'query is required for workspace_symbols');
		raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', args.query);
	} else if (operation === 'document_symbols') {
		raw = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', document!.uri);
	} else if (operation === 'definition') {
		raw = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', document!.uri, positionFromArgs(args));
	} else if (operation === 'references') {
		raw = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document!.uri, positionFromArgs(args), { includeDeclaration: args.include_declaration !== false });
	} else if (operation === 'implementation') {
		raw = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeImplementationProvider', document!.uri, positionFromArgs(args));
	} else {
		raw = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document!.uri, positionFromArgs(args));
	}
	abortIfNeeded(signal);
	if (raw === undefined || raw === null) {
		return { ...baseResult(...Object.values(providerStateForUndefined(document)) as [IdeProviderState, string], document, anchor, anchorSource), operation, results: [], truncated: false };
	}

	const results: Record<string, unknown>[] = [];
	if (operation === 'workspace_symbols') {
		for (const symbol of raw as vscode.SymbolInformation[]) {
			results.push({ name: symbol.name, kind: symbol.kind, kind_name: kindName(symbol.kind), container_name: symbol.containerName, location: serializeLocation(workspaceRoot, symbol.location) });
		}
	} else if (operation === 'document_symbols') {
		const walk = (symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, parent?: string): void => {
			for (const symbol of symbols) {
				if (symbol instanceof vscode.DocumentSymbol) {
					results.push({ name: symbol.name, detail: symbol.detail, kind: symbol.kind, kind_name: kindName(symbol.kind), parent, range: rangeJson(symbol.range), selection_range: rangeJson(symbol.selectionRange), path });
					if (results.length < limit) walk(symbol.children, symbol.name);
				} else {
					results.push({ name: symbol.name, kind: symbol.kind, kind_name: kindName(symbol.kind), container_name: symbol.containerName, location: serializeLocation(workspaceRoot, symbol.location) });
				}
				if (results.length >= limit) return;
			}
		};
		walk(raw as Array<vscode.DocumentSymbol | vscode.SymbolInformation>);
	} else if (operation === 'definition' || operation === 'references' || operation === 'implementation') {
		for (const location of raw as Array<vscode.Location | vscode.LocationLink>) results.push(serializeLocationLike(workspaceRoot, location));
	} else {
		for (const hover of raw as vscode.Hover[]) {
			results.push({ contents: hover.contents.map(markdownText), range: hover.range ? rangeJson(hover.range) : undefined });
		}
	}
	const truncated = results.length > limit;
	return {
		...baseResult('ready', 'provider invocation completed', document, anchor, anchorSource),
		operation,
		results: results.slice(0, limit),
		truncated,
		max_results: limit,
	};
}

const severityName = (severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'information' | 'hint' => {
	if (severity === vscode.DiagnosticSeverity.Error) return 'error';
	if (severity === vscode.DiagnosticSeverity.Warning) return 'warning';
	if (severity === vscode.DiagnosticSeverity.Information) return 'information';
	return 'hint';
};

async function getDiagnostics(workspaceRoot: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
	abortIfNeeded(signal);
	const limit = maxResults(args);
	const severityFilter = args.severity === undefined
		? undefined
		: Array.isArray(args.severity) && args.severity.every(value => ['error', 'warning', 'information', 'hint'].includes(String(value)))
			? new Set(args.severity.map(String))
			: (() => { throw new IdeAdapterError('INVALID_ARGUMENT', 'severity must contain error/warning/information/hint'); })();
	let document: vscode.TextDocument | undefined;
	let groups: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
	let anchor = '.';
	let anchorSource: 'requested_path' | 'workspace' = 'workspace';
	if (typeof args.path === 'string' && args.path) {
		const safe = await safeFileUri(workspaceRoot, args.path, signal);
		document = await vscode.workspace.openTextDocument(safe.uri);
		anchor = safe.path;
		anchorSource = 'requested_path';
		groups = [[safe.uri, vscode.languages.getDiagnostics(safe.uri)]];
	} else if (args.path !== undefined) {
		throw new IdeAdapterError('INVALID_ARGUMENT', 'path must be a non-empty string when provided');
	} else {
		groups = vscode.languages.getDiagnostics();
	}
	abortIfNeeded(signal);
	const results: Record<string, unknown>[] = [];
	let matchingCount = 0;
	for (const [uri, diagnostics] of groups) {
		const path = relativeUri(workspaceRoot, uri);
		if (path === null) continue;
		for (const diagnostic of diagnostics) {
			const severity = severityName(diagnostic.severity);
			if (severityFilter && !severityFilter.has(severity)) continue;
			matchingCount += 1;
			if (results.length >= limit) continue;
			results.push({
				path,
				uri: uri.toString(),
				severity,
				message: diagnostic.message,
				range: rangeJson(diagnostic.range),
				source: diagnostic.source,
				code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
				related_information: diagnostic.relatedInformation?.map(item => ({ message: item.message, location: serializeLocation(workspaceRoot, item.location) })),
			});
		}
	}
	return {
		...baseResult('ready', 'vscode.languages.getDiagnostics completed', document, anchor, anchorSource),
		results,
		truncated: matchingCount > results.length,
		total_matching: matchingCount,
		max_results: limit,
	};
}

export async function handleBridgeIdeRequest(
	workspaceRoot: string,
	kind: IdeRequestKind,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		if (kind === 'lsp') return await runLsp(workspaceRoot, args, signal);
		if (kind === 'get_diagnostics') return await getDiagnostics(workspaceRoot, args, signal);
		throw new IdeAdapterError('INVALID_ARGUMENT', `unknown IDE request kind: ${kind}`);
	} catch (error) {
		if (error instanceof IdeAdapterError) throw error;
		if (signal?.aborted) throw new IdeAdapterError('CANCELLED', 'IDE request was cancelled');
		const message = error instanceof Error ? error.message : String(error);
		if (/not ready|initializ|loading|starting/i.test(message)) throw new IdeAdapterError('PROVIDER_UNAVAILABLE', `provider not ready: ${message}`);
		throw new IdeAdapterError('INTERNAL_ERROR', message);
	}
}
