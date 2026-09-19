import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';

export async function readProjectSkills(workspace) {
  const root = await realpath(workspace);
  const results = [];
  const visited = new Set();
  let total = 0;
  async function visit(path, depth) {
    if (depth > 4 || results.length >= 48) return;
    let actual;
    try { actual = await realpath(path); } catch { return; }
    const rel = relative(root, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || visited.has(actual)) return;
    visited.add(actual);
    const info = await stat(actual);
    if (info.isDirectory()) {
      for (const entry of (await readdir(actual)).sort()) if (!['node_modules', '.git'].includes(entry)) await visit(join(actual, entry), depth + 1);
    } else if (['SKILL.md', 'AGENTS.md'].includes(actual.split(sep).at(-1)) && info.size <= 32768 && total + info.size <= 262144) {
      const content = await readFile(actual, 'utf8');
      total += info.size;
      const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.replace(/^['"]|['"]$/g, '') ?? relative(root, actual).replaceAll(sep, '/');
      results.push({ name, path: relative(root, actual).replaceAll(sep, '/'), content });
    }
  }
  await visit(join(root, 'AGENTS.md'), 0);
  for (const folder of ['skills', '.agents/skills', '.codex/skills']) await visit(join(root, folder), 0);
  return results;
}
