#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { startHub } from './manager.mjs';
import { connect, relay } from './client.mjs';
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' },
  port: { type: 'string', default: '48271' }, 'max-active': { type: 'string', default: '16' },
  ttl: { type: 'string', default: '3600' }, 'public-origin': { type: 'string' },
  'state-file': { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' },
  'browser-executable': { type: 'string' }, url: { type: 'string' }, tool: { type: 'string' },
  args: { type: 'string', default: '{}' }, help: { type: 'boolean' },
} });
const [command, id] = positionals;
const stateFile = resolve(args['state-file'] ?? join(homedir(), '.local/state/mooncode-hub/admin.json'));
const print = value => console.log(JSON.stringify(value, null, 2));
async function admin(method, path, body) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const response = await fetch(`${state.origin}${path}`, { method, headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
async function main() {
  if (args.help || !command) {
    console.log(`MoonCode Linux MCP Hub 0.2.0
serve    --workspace PATH [--public-origin https://mcp.example.com] [--port 48271]
create   --kind workspace|browser|desktop [--workspace PATH] [--name NAME] [--ttl SECONDS]
         [--allow-write --allow-exec]
list
revoke   ID
config   ID                       Print generic HTTP MCP client JSON
relay    --url URL                 Expose any link through MCP stdio
call     --url URL [--tool NAME --args JSON]  List tools or call one tool
All admin commands accept --state-file PATH. Default TTL 3600; 0 lasts until revoke/stop.
No tunnel is started. Reverse proxy only the MCP gateway port, never the admin port.`);
    return;
  }
  if (command === 'serve') {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    // An exclusive state file prevents a second Hub from replacing the first Hub's control token.
    await writeFile(stateFile, '', { flag: 'wx', mode: 0o600 });
    let hub;
    let closing;
    const close = () => closing ??= (async () => { await hub?.close(); await unlink(stateFile).catch(() => {}); })();
    try {
      hub = await startHub({ port: Number(args.port), maxActive: Number(args['max-active']), publicOrigin: args['public-origin'], browserExecutable: args['browser-executable'] });
      await writeFile(stateFile, JSON.stringify({ origin: hub.adminOrigin, token: hub.adminToken }));
      await chmod(stateFile, 0o600);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close().then(() => process.exit(0)));
      const first = await hub.create({ kind: args.kind ?? 'workspace', workspace: args.kind && args.kind !== 'workspace' ? undefined : resolve(args.workspace ?? process.cwd()),
        name: args.name ?? 'main', ttl: Number(args.ttl), allowWrite: Boolean(args['allow-write']), allowExec: Boolean(args['allow-exec']) });
      print({ event: 'hub.ready', gateway: hub.origin, stateFile, link: first });
      console.error('Hub running. Use create/list/revoke in another terminal; Ctrl+C stops all links.');
    } catch (error) { await close(); throw error; }
    return;
  }
  if (command === 'create') return print(await admin('POST', '/links', { kind: args.kind ?? 'workspace', name: args.name,
    workspace: args.kind && args.kind !== 'workspace' ? undefined : resolve(args.workspace ?? process.cwd()), ttl: Number(args.ttl), allowWrite: Boolean(args['allow-write']), allowExec: Boolean(args['allow-exec']) }));
  if (command === 'list') return print(await admin('GET', '/links'));
  if (command === 'revoke') {
    if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('revoke requires link ID');
    return print(await admin('DELETE', `/links/${id}`));
  }
  if (command === 'config') {
    const link = (await admin('GET', '/links')).find(link => link.id === id);
    if (!link) throw new Error('Link not found');
    return print({ mcpServers: { [link.name]: { type: 'http', url: link.url } } });
  }
  if (command === 'relay') return relay(args.url ?? process.env.MOONCODE_MCP_URL);
  if (command === 'call') {
    const client = await connect(args.url ?? process.env.MOONCODE_MCP_URL);
    try { print(args.tool ? await client.callTool({ name: args.tool, arguments: JSON.parse(args.args) }) : await client.listTools()); }
    finally { await client.close(); }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
