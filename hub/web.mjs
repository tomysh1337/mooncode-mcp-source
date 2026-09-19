#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ChatGPTPageAdapter } from './chatgpt.mjs';
import { startHub } from './manager.mjs';
import { startWebService } from './web-server.mjs';
import { openSettings, writePrivateJson } from './settings.mjs';
import { openAccountStore } from './accounts.mjs';
import { ApiAdapter } from './api-adapter.mjs';
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string' }, profile: { type: 'string' }, port: { type: 'string', default: '48400' },
  'mcp-port': { type: 'string', default: '48271' }, 'public-origin': { type: 'string' },
  'connect-config': { type: 'string' }, selectors: { type: 'string' }, headed: { type: 'boolean' },
  'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, help: { type: 'boolean' },
  'data-dir': { type: 'string' }, 'cpa-url': { type: 'string' }, 'cpa-auth-dir': { type: 'string' },
  provider: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' },
  'mcp-host': { type: 'string', default: '127.0.0.1' }, 'web-origin': { type: 'string' }, 'access-file': { type: 'string' },
} });
async function main() {
  const command = positionals[0] ?? 'serve';
  if (args.help) {
    console.log('web.mjs login --profile PATH (requires a visible Linux display)\nweb.mjs serve --workspace PATH [--public-origin https://mcp.example.com] [--connect-config FILE] [--selectors FILE] [--headed]\nAccount mode: --provider cpa --cpa-url http://127.0.0.1:8318/v1 --cpa-auth-dir PATH; set MOONCODE_CPA_API_KEY.\nPersistent settings: --data-dir PATH. Deployment: --host IP --mcp-host IP --web-origin https://console.example.com --access-file PATH.\nDefault web port 48400, MCP port 48271. Profile is separate from your normal browser.');
    return;
  }
  if (!['login', 'serve'].includes(command)) throw new Error('Expected login or serve');
  if (args['allow-exec'] && !args['allow-write']) throw new Error('--allow-exec also requires --allow-write');
  const dataDir = resolve(args['data-dir'] ?? join(homedir(), '.local/state/mooncode-hub'));
  const profile = resolve(args.profile ?? join(dataDir, 'chatgpt-profile'));
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const adapter = new ChatGPTPageAdapter({ profile, headed: command === 'login' || args.headed,
    selectors: args.selectors ? JSON.parse(await readFile(args.selectors, 'utf8')) : {} });
  const apiAdapter = args['cpa-url'] ? new ApiAdapter({ baseUrl: args['cpa-url'], apiKey: process.env.MOONCODE_CPA_API_KEY }) : undefined;
  let hub, web, shutdown;
  const close = () => shutdown ??= (async () => { await web?.close(); await adapter.close(); await apiAdapter?.close(); await hub?.close(); })();
  try {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close().then(() => process.exit(0)));
    if (command === 'login') {
      await adapter.login();
      console.log('Log in to ChatGPT in the opened browser, then Ctrl+C here. Reuse the same --profile for serve.');
      return;
    }
    const settings = await openSettings(join(dataDir, 'settings.json'), args.provider ? { provider: args.provider } : {});
    if (settings.get().provider === 'cpa' && !apiAdapter) throw new Error('Account mode requires --cpa-url and MOONCODE_CPA_API_KEY');
    let token;
    try { token = JSON.parse(await readFile(join(dataDir, 'web-token.json'), 'utf8')).token; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('base64url');
      await writePrivateJson(join(dataDir, 'web-token.json'), { token });
    }
    if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid persisted web token');
    const accounts = args['cpa-auth-dir'] ? await openAccountStore(resolve(args['cpa-auth-dir'])) : undefined;
    hub = await startHub({ port: Number(args['mcp-port']), host: args['mcp-host'], publicOrigin: args['public-origin'], maxActive: settings.get().maxActive });
    web = await startWebService({ hub, adapter, workspace: resolve(args.workspace ?? process.cwd()), port: Number(args.port),
      apiAdapter, accounts, settings, token, host: args.host, webOrigin: args['web-origin'],
      connectSteps: args['connect-config'] ? JSON.parse(await readFile(args['connect-config'], 'utf8')).steps : undefined,
      allowWrite: Boolean(args['allow-write']), allowExec: Boolean(args['allow-exec']) });
    if (args['access-file']) {
      await writePrivateJson(resolve(args['access-file']), { url: web.url });
      console.log(`MoonCode Web ready on port ${args.port}; access URL saved to the configured private file`);
    } else console.log(`MoonCode Web: ${web.url}`);
    console.log(`MCP gateway: ${hub.origin}`);
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
