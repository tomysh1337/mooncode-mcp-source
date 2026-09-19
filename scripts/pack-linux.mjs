import { mkdir, readdir, readFile, writeFile, cp, chmod, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = process.argv.includes('--bundle');
if (bundled && process.platform !== 'linux') throw new Error('--bundle must run on Linux to build native dependencies');
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, 'stage-'));
const label = bundled ? `mooncode-linux-${process.arch}` : 'mooncode-linux-bootstrap';
const stage = join(work, label);
await mkdir(stage);
const packages = ['contracts', 'event-store', 'model-fake', 'model-openai', 'tool-gateway', 'runtime', 'hub'];
for (const name of packages) {
  const folder = join(stage, name);
  await mkdir(folder);
  const manifest = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'));
  for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) if (version === 'workspace:*') manifest.dependencies[dep] = '*';
  delete manifest.devDependencies;
  await writeFile(join(folder, 'package.json'), JSON.stringify(manifest, null, 2));
  if (name === 'hub') await cp(join(root, name), folder, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes(`${name}/test`) && !path.includes(`${name}\\test`) });
  else await cp(join(root, name, 'dist'), join(folder, 'dist'), { recursive: true, filter: path => !/\.(map|tsbuildinfo)$/.test(path) && !path.endsWith('.d.ts') });
  // cp of hub includes its original manifest; restore the workspace-compatible one.
  await writeFile(join(folder, 'package.json'), JSON.stringify(manifest, null, 2));
}
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: label, version: '0.2.0', private: true, type: 'module', workspaces: packages, engines: { node: '>=22.12' } }, null, 2));
for (const file of ['start.sh', 'start-browser.sh', 'start-web.sh', 'setup.sh']) {
  await cp(join(root, 'linux', file), join(stage, file));
  await chmod(join(stage, file), 0o755);
}
await cp(join(root, 'docs'), join(stage, 'docs'), { recursive: true });
await cp(join(root, 'linux', 'nginx.conf.example'), join(stage, 'nginx.conf.example'));
await cp(join(root, 'docs', 'linux.md'), join(stage, 'README.md'));
if (bundled) {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  await mkdir(join(stage, 'bin'));
  await cp(process.execPath, join(stage, 'bin/node'));
  await cp(join(dirname(process.execPath), '../LICENSE'), join(stage, 'bin/NODE-LICENSE'));
  execFileSync(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], { cwd: stage, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(stage, 'browsers') } });
}
// Drop maps in dependencies from the archive without modifying the installed working tree.
const archive = join(artifacts, `${label}.tar.gz`);
execFileSync('tar', ['--exclude=*.map', '--exclude=*.tsbuildinfo', '-czf', archive, '-C', work, label], { stdio: 'inherit' });
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${hash}  ${label}.tar.gz\n`);
console.log(JSON.stringify({ archive, sha256: hash, bundled }));
