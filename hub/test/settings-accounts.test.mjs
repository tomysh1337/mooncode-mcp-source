import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccountStore } from '../accounts.mjs';
import { openSettings } from '../settings.mjs';
import { ApiAdapter } from '../api-adapter.mjs';
import { startHub } from '../manager.mjs';
import { startWebService } from '../web-server.mjs';
import { WebOrchestrator } from '../orchestrator.mjs';
import { listen, readJson } from '../http.mjs';
import { chromium } from 'playwright';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mooncode-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'account fixture project');
  return { root, workspace };
}

test('Sub2API and CPA imports persist credentials privately and only return account summaries', async t => {
  const { root } = await fixture(t);
  const directory = join(root, 'auth');
  const accounts = await openAccountStore(directory);
  const result = await accounts.import({ data: { accounts: [
    { platform: 'openai', type: 'oauth', name: 'Fixture', credentials: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', chatgpt_account_id: 'fixture-account', expires_at: 2000000000 } },
    { type: 'codex', access_token: 'other-fixture', email: 'fixture@example.invalid', disabled: true },
    { platform: 'unknown', type: 'oauth', credentials: { access_token: 'hidden-fixture' } },
  ], proxies: [] } });
  assert.equal(result.created, 2); assert.equal(result.errors.length, 1);
  const list = await accounts.list();
  assert.doesNotMatch(JSON.stringify(list) + JSON.stringify(result), /fixture-access|fixture-refresh|hidden-fixture/);
  const imported = list.find(a => a.label === 'Fixture');
  const storedFile = join(directory, `mooncode-${imported.id}.json`);
  const stored = JSON.parse(await readFile(storedFile));
  assert.equal(stored.account_id, 'fixture-account'); assert.equal(stored.type, 'codex');
  assert.equal(stored.expired, new Date(2000000000000).toISOString());
  if (process.platform !== 'win32') assert.equal((await stat(storedFile)).mode & 0o777, 0o600);
  await accounts.setEnabled(imported.id, false);
  assert.equal((await (await openAccountStore(directory)).list()).find(a => a.id === imported.id).enabled, false);
  await assert.rejects(accounts.setEnabled('../outside', true), /Invalid account ID/);
  const update = await accounts.import({ type: 'codex', access_token: 'renewed-fixture', account_id: 'fixture-account' });
  assert.equal(update.updated, 1); assert.equal((await accounts.list()).length, 2);
});

test('saved web settings survive reopening and enforce new link and subagent limits', async t => {
  const { root, workspace } = await fixture(t);
  const settingsPath = join(root, 'settings.json');
  const settings = await openSettings(settingsPath);
  const hub = await startHub({ port: 0 }); t.after(() => hub.close());
  const adapter = { async *stream() { yield { type: 'done', text: '```mooncode-action\n{"id":"spawn","type":"spawn_agent","kind":"workspace","task":"read"}\n```' }; } };
  const web = await startWebService({ hub, workspace, adapter, settings, port: 0, webOrigin: 'https://console.example' }); t.after(() => web.close());
  const headers = { authorization: `Bearer ${web.token}`, 'content-type': 'application/json', origin: 'https://console.example' };
  const post = (path, body) => fetch(web.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('/api/settings', { maxAgents: -1 })).status, 400);
  assert.equal((await post('/api/settings', { maxActive: 1, maxAgents: 0, maxActions: 3 })).status, 200);
  assert.equal((await openSettings(settingsPath)).get().maxAgents, 0);
  const link = await hub.create({ workspace });
  await assert.rejects(hub.create({ workspace }), /Active link limit/); await hub.revoke(link.id);
  const response = await post('/api/chat', { message: 'delegate' });
  assert.match(await response.text(), /Subagent depth\/count limit reached/);
  assert.equal(hub.list().length, 0);
  headers.origin = 'https://other.example';
  assert.equal((await post('/api/settings', { maxActive: 2 })).status, 401);
  assert.equal(settings.get().maxActive, 1);
});

test('CPA streaming preserves conversation and drives real MCP tools; truncated actions never execute', async t => {
  const { workspace } = await fixture(t);
  const hub = await startHub({ port: 0 }); t.after(() => hub.close());
  let requests = [], truncate = false;
  const server = await listen((req, res) => void (async () => {
    assert.equal(req.headers.authorization, 'Bearer fixture-cpa-key');
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); }
    const body = await readJson(req); requests.push(body);
    const answer = body.messages.length === 1 ? '```mooncode-action\n{"id":"read","type":"tool_call","name":"read_file","arguments":{"path":"README.md"}}\n```' : '文件已读';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\r\n\r\n';
    const buffer = Buffer.from(frame);
    for (let i = 0; i < buffer.length; i += 7) res.write(buffer.subarray(i, i + 7));
    if (!truncate) res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    res.end();
  })().catch(e => res.destroy(e)));
  t.after(() => server.close());
  const adapter = new ApiAdapter({ baseUrl: server.origin + '/v1', apiKey: 'fixture-cpa-key' });
  const web = await startWebService({ hub, adapter: {}, apiAdapter: adapter, workspace, port: 0 }); t.after(() => web.close());
  assert.equal((await fetch(web.origin + '/v1/models')).status, 401);
  assert.equal((await fetch(web.origin + '/v1/models', { headers: { authorization: `Bearer ${web.token}` } })).status, 401);
  const publicModels = await fetch(web.origin + '/v1/models', { headers: { authorization: 'Bearer fixture-cpa-key' } });
  assert.equal(publicModels.status, 200); assert.equal((await publicModels.json()).data[0].id, 'fixture-model');
  assert.equal((await fetch(web.origin + '/v1/management', { headers: { authorization: 'Bearer fixture-cpa-key' } })).status, 404);
  const events = [];
  for await (const event of new WebOrchestrator({ workspace, hub, adapter }).run('Read README')) events.push(event);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.length, 3);
  assert.match(requests[1].messages.at(-1).content, /account fixture project/);
  assert.equal(events.at(-1).text, '文件已读');
  assert.equal(adapter.conversations.size, 0); assert.equal(hub.list().length, 0);
  truncate = true; requests = [];
  await assert.rejects(async () => { for await (const event of new WebOrchestrator({ workspace, hub, adapter }).run('Read')) assert.notEqual(event.type, 'action'); }, /without a complete response/);
  assert.equal(hub.list().length, 0);
});

test('console saves limits, imports account files and toggles account status through the UI', async t => {
  const { root, workspace } = await fixture(t);
  const accounts = await openAccountStore(join(root, 'auth'));
  const settings = await openSettings(join(root, 'settings.json'));
  const hub = await startHub({ port: 0 }); t.after(() => hub.close());
  const web = await startWebService({ hub, adapter: {}, apiAdapter: { models: async () => ['fixture-model'] }, accounts, settings, workspace, port: 0 }); t.after(() => web.close());
  const browser = await chromium.launch({ chromiumSandbox: process.platform === 'linux' }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(web.url);
  await page.getByLabel('每次请求的子任务总数').fill('8');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText('设置已保存，对下一次任务生效', { exact: true }).waitFor();
  assert.equal(settings.get().maxAgents, 8);
  await page.getByLabel('选择账号 JSON 文件').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ type: 'codex', access_token: 'ui-fixture-token', email: 'ui@example.invalid' })) });
  await page.getByRole('button', { name: '导入账号', exact: true }).click();
  await page.getByText('新增 1，更新 0', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /ui-fixture-token/);
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '启用', exact: true }).waitFor();
  assert.equal((await accounts.list())[0].enabled, false);
  await page.getByRole('button', { name: '创建链接', exact: true }).click();
  await page.getByText('链接已创建', { exact: true }).waitFor();
  assert.equal(hub.list().length, 1);
});
