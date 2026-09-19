import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHub, normalizePublicOrigin } from '../manager.mjs';
import { connect } from '../client.mjs';
import { readProjectSkills } from '../skills.mjs';
import { WebOrchestrator, parseAction } from '../orchestrator.mjs';
import { startWebService } from '../web-server.mjs';
import { listen } from '../http.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mooncode-hub-test-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'hello fixture');
  const hub = await startHub({ port: 0, ...options });
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, hub };
}
const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

test('independent MCP links enforce read-only, route isolation, expiry and revocation', async t => {
  const { workspace, hub } = await fixture(t);
  const a = await hub.create({ workspace, name: 'reader', ttl: 1 });
  const b = await hub.create({ workspace, name: 'writer', allowWrite: true });
  assert.notEqual(a.url, b.url);
  const ca = await connect(a.url), cb = await connect(b.url);
  t.after(async () => { await ca.close(); await cb.close(); });
  assert.equal((await ca.listTools()).tools.length, 15);
  assert.match(text(await ca.callTool({ name: 'read_file', arguments: { path: 'README.md' } })), /hello fixture/);
  assert.equal((await ca.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 'no' } })).isError, true);
  assert.equal((await cb.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 'yes' } })).isError, false);
  assert.equal((await fetch(`${hub.origin}/links`)).status, 404);
  assert.equal((await fetch(`${hub.adminOrigin}/links`)).status, 401);
  const read = await fetch(`${hub.adminOrigin}/links`, { headers: { authorization: `Bearer ${hub.adminToken}` } });
  assert.equal((await read.json()).length, 2);
  await delay(1100);
  assert.equal((await fetch(a.url)).status, 404);
  await hub.revoke(b.id);
  assert.equal((await fetch(b.url)).status, 404);
});

test('parallel creation respects capacity; repeated create/revoke has no lifetime quota', async t => {
  const { workspace, hub } = await fixture(t, { maxActive: 2 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => hub.create({ workspace })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  for (const link of hub.list()) await hub.revoke(link.id);
  for (let n = 0; n < 10; n++) { const link = await hub.create({ workspace }); await hub.revoke(link.id); }
  assert.equal(hub.list().length, 0);
  assert.equal(normalizePublicOrigin('https://mcp.example.com/'), 'https://mcp.example.com');
  assert.throws(() => normalizePublicOrigin('https://mcp.example.com/admin'));
});

test('subagent stdio relay discovers and calls actual remote tools', async t => {
  const { workspace, hub } = await fixture(t);
  const link = await hub.create({ workspace });
  const client = new Client({ name: 'relay-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'relay', '--url', link.url], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 15);
  assert.match(text(await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } })), /hello fixture/);
});

test('project skill discovery excludes external symlinks and oversized files', async t => {
  const { workspace, root } = await fixture(t);
  await mkdir(join(workspace, 'skills', 'one'), { recursive: true });
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'SKILL.md'), 'private outside');
  await writeFile(join(workspace, 'skills', 'one', 'SKILL.md'), '---\nname: fixture\n---\nRead README first');
  await writeFile(join(workspace, 'AGENTS.md'), 'Use the project conventions');
  await symlink(join(root, 'outside'), join(workspace, 'skills', 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const skills = await readProjectSkills(workspace);
  assert.equal(skills.length, 2);
  assert.ok(skills.some(s => s.name === 'fixture'));
  assert.ok(skills.every(s => !s.content.includes('private outside')));
});

test('subagent actions connect real MCP workers and clean up all links', async t => {
  const { workspace, hub } = await fixture(t);
  const turns = new Map();
  const prompts = [];
  const adapter = { async *stream(prompt, { agentId }) {
    prompts.push(prompt);
    const round = turns.get(agentId) ?? 0;
    turns.set(agentId, round + 1);
    const first = [...turns.keys()][0] === agentId;
    let response;
    if (first && round === 0) response = '```mooncode-action\n{"id":"spawn","type":"spawn_agent","kind":"workspace","task":"Read README","skills":[]}\n```';
    else if (!first && round === 0) response = '```mooncode-action\n{"id":"read","type":"tool_call","name":"read_file","arguments":{"path":"README.md"}}\n```';
    else response = 'The README says hello fixture';
    yield { type: 'delta', text: response }; yield { type: 'done', text: response };
  } };
  const events = [];
  for await (const e of new WebOrchestrator({ hub, workspace, adapter }).run('Delegate a README read')) events.push(e);
  assert.equal(events.filter(e => e.type === 'agent.started').length, 2);
  assert.ok(prompts.some(p => p.includes('hello fixture')));
  assert.equal(hub.list().length, 0);
  assert.throws(() => parseAction('```mooncode-action\n{"id":"x","type":"unknown"}\n```'));
});

test('web API streams responses, requires token and rejects cross-origin requests', async t => {
  const { workspace, hub } = await fixture(t);
  const adapter = { async *stream() { yield { type: 'delta', text: 'hello' }; yield { type: 'done', text: 'hello' }; } };
  const web = await startWebService({ hub, adapter, workspace, port: 0 });
  t.after(() => web.close());
  assert.equal((await fetch(`${web.origin}/api/skills`)).status, 401);
  assert.equal((await fetch(`${web.origin}/api/skills`, { headers: { authorization: `Bearer ${web.token}`, origin: 'https://evil.example' } })).status, 401);
  const response = await fetch(`${web.origin}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${web.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /event: delta/);
  assert.match(stream, /event: agent.done/);
  assert.equal(hub.list().length, 0);
});

test('native PTY command execution on Linux', { skip: process.platform !== 'linux' }, async t => {
  const { workspace, hub } = await fixture(t);
  const link = await hub.create({ workspace, allowWrite: true, allowExec: true });
  const client = await connect(link.url);
  t.after(() => client.close());
  const result = await client.callTool({ name: 'run_command', arguments: { command: 'printf mooncode-linux-pty', background: false, timeout_ms: 10000 } });
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /mooncode-linux-pty/);
});

test('headless browsers isolate cookies and support form interactions and screenshots', async t => {
  const { hub } = await fixture(t);
  const website = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Fixture</h1><input id="name"><button id="save" onclick="document.cookie=\'hello=1\';document.querySelector(\'h1\').textContent=document.querySelector(\'#name\').value">Save</button><button id="cookie" onclick="document.querySelector(\'h1\').textContent=document.cookie||\'empty-cookie\'">Cookie</button>'); });
  t.after(() => website.close());
  const a = await hub.create({ kind: 'browser' }), b = await hub.create({ kind: 'browser' });
  const ca = await connect(a.url), cb = await connect(b.url);
  t.after(async () => { await ca.close(); await cb.close(); });
  assert.equal((await ca.listTools()).tools.length, 6);
  for (const c of [ca, cb]) {
    const result = await c.callTool({ name: 'browser_navigate', arguments: { url: website.origin } });
    assert.equal(result.isError, undefined, text(result));
  }
  await ca.callTool({ name: 'browser_fill', arguments: { selector: '#name', value: 'agent-a' } });
  assert.match(text(await ca.callTool({ name: 'browser_click', arguments: { selector: '#save' } })), /agent-a/);
  assert.match(text(await cb.callTool({ name: 'browser_click', arguments: { selector: '#cookie' } })), /empty-cookie/);
  const screenshot = await ca.callTool({ name: 'browser_screenshot', arguments: {} });
  assert.equal(screenshot.content[0].type, 'image');
  assert.equal(Buffer.from(screenshot.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('Linux virtual desktop starts and receives keyboard and mouse input', { skip: process.platform !== 'linux' }, async t => {
  const { hub } = await fixture(t);
  const link = await hub.create({ kind: 'desktop' });
  const client = await connect(link.url);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 10);
  for (const [name, args] of [['computer_click', { x: 300, y: 300 }], ['computer_key', { key: 'ctrl+l' }], ['computer_type', { text: 'about:blank' }], ['computer_key', { key: 'Return' }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, text(result));
  }
  const result = await client.callTool({ name: 'computer_screenshot', arguments: {} });
  assert.equal(result.content[0].type, 'image', text(result));
});
