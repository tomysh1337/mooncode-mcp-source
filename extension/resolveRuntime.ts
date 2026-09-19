import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeLocation {
	entry: string;
	cwd: string;
}

/**
 * Resolution order:
 * 1. MOONCODE_RUNTIME_ENTRY (absolute path to cli.js)
 * 2. Self-contained bundled deployment: runtime/dist/cli.js
 * 3. Dev tree: ../../../最小mvp落地方案/apps/agent-runtime/dist/cli.js
 */
export function resolveRuntime(extensionPath: string): RuntimeLocation {
	const fromEnv = process.env.MOONCODE_RUNTIME_ENTRY;
	if (fromEnv && existsSync(fromEnv)) {
		return { entry: fromEnv, cwd: join(fromEnv, '..', '..') };
	}

	const bundled = join(extensionPath, 'runtime', 'dist', 'cli.js');
	if (existsSync(bundled)) {
		return { entry: bundled, cwd: join(extensionPath, 'runtime') };
	}

	const devRoot = join(extensionPath, '..', '..', '..', '最小mvp落地方案', 'apps', 'agent-runtime');
	const devEntry = join(devRoot, 'dist', 'cli.js');
	if (existsSync(devEntry)) {
		return { entry: devEntry, cwd: devRoot };
	}

	throw new Error(
		'MoonCode Agent Runtime not found. Build the runtime (npx tsc -b) or set MOONCODE_RUNTIME_ENTRY.',
	);
}
