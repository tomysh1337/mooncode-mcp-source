#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { ChatGPTPageAdapter } from './chatgpt.mjs';
import { startHub } from './manager.mjs';
import { startWebService } from './web-server.mjs';
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string' }, profile: { type: 'string' }, port: { type: 'string', default: '48400' },
  'mcp-port': { type: 'string', default: '48271' }, 'public-origin': { type: 'string' },
  'connect-config': { type: 'string' }, selectors: { type: 'string' }, headed: { type: 'boolean' },
  'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, help: { type: 'boolean' },
} });
async function main() {
  const command = positionals[0] ?? 'serve';
  if (args.help) {
    console.log('web.mjs login --profile PATH (requires a visible Linux display)\nweb.mjs serve --workspace PATH [--public-origin https://mcp.example.com] [--connect-config FILE] [--selectors FILE] [--headed]\nDefault web port 48400, MCP port 48271. Profile is separate from your normal browser.');
    return;
  }
  if (!['login', 'serve'].includes(command)) throw new Error('Expected login or serve');
  if (args['allow-exec'] && !args['allow-write']) throw new Error('--allow-exec also requires --allow-write');
  const profile = resolve(args.profile ?? join(homedir(), '.local/state/mooncode-hub/chatgpt-profile'));
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const adapter = new ChatGPTPageAdapter({ profile, headed: command === 'login' || args.headed,
    selectors: args.selectors ? JSON.parse(await readFile(args.selectors, 'utf8')) : {} });
  let hub, web, shutdown;
  const close = () => shutdown ??= (async () => { await web?.close(); await adapter.close(); await hub?.close(); })();
  try {
    await adapter.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close().then(() => process.exit(0)));
    if (command === 'login') {
      await adapter.login();
      console.log('Log in to ChatGPT in the opened browser, then Ctrl+C here. Reuse the same --profile for serve.');
      return;
    }
    hub = await startHub({ port: Number(args['mcp-port']), publicOrigin: args['public-origin'] });
    web = await startWebService({ hub, adapter, workspace: resolve(args.workspace ?? process.cwd()), port: Number(args.port),
      connectSteps: args['connect-config'] ? JSON.parse(await readFile(args['connect-config'], 'utf8')).steps : undefined,
      allowWrite: Boolean(args['allow-write']), allowExec: Boolean(args['allow-exec']) });
    console.log(`MoonCode Web: ${web.url}`);
    console.log(`MCP gateway: ${hub.origin}`);
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
