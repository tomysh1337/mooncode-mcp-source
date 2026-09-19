import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const root = resolve(process.argv[2]);
const { startHub } = await import(pathToFileURL(join(root, 'hub/manager.mjs')).href);
const { connect } = await import(pathToFileURL(join(root, 'hub/client.mjs')).href);
const workspace = await mkdtemp(join(tmpdir(), 'mooncode-relocated-'));
await writeFile(join(workspace, 'README.md'), 'relocated Linux package');
const hub = await startHub({ port: 0 });
const clients = [];
try {
  const link = await hub.create({ workspace, allowWrite: true, allowExec: true });
  const client = await connect(link.url); clients.push(client);
  const read = await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } });
  assert.match(read.content[0].text, /relocated Linux package/);
  const command = await client.callTool({ name: 'run_command', arguments: { command: 'printf relocated-pty', background: false, timeout_ms: 10000 } });
  assert.equal(command.isError, false, JSON.stringify(command));
  const browser = await hub.create({ kind: 'browser' });
  const browserClient = await connect(browser.url); clients.push(browserClient);
  const screenshot = await browserClient.callTool({ name: 'browser_screenshot', arguments: {} });
  assert.equal(screenshot.content[0].type, 'image', JSON.stringify(screenshot));
  console.log('Relocated artifact: file read, native Linux PTY and Chromium screenshot passed');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  await hub.close();
  await rm(workspace, { recursive: true, force: true });
}
