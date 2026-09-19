import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from '../http.mjs';
import { ChatGPTPageAdapter } from '../chatgpt.mjs';

test('browser adapter streams visible text and verifies MCP connection UI on a fixture', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mooncode-page-test-'));
  const website = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="send()">Send</button><button data-testid="stop-button" style="display:none">Stop</button><div id="messages"></div><input id="mcp-url"><button id="save" onclick="document.querySelector('#connected').textContent=document.querySelector('#mcp-url').value;document.querySelector('#connected').hidden=false">Save</button><p id="connected" hidden></p><script>function send(){const stop=document.querySelector('[data-testid=stop-button]');stop.style.display='block';const p=document.createElement('div');p.setAttribute('data-message-author-role','assistant');document.querySelector('#messages').append(p);p.textContent='first';setTimeout(()=>{p.textContent+=' second';stop.style.display='none'},400)}</script>`);
  });
  const adapter = await new ChatGPTPageAdapter({ profile, url: website.origin }).start();
  t.after(async () => { await adapter.close(); await website.close(); await rm(profile, { recursive: true, force: true }); });
  const events = [];
  for await (const event of adapter.stream('hello')) events.push(event);
  assert.equal(events.at(-1).text, 'first second');
  assert.ok(events.filter(e => e.type === 'delta').length >= 2);
  const result = await adapter.connectMcp({ url: 'https://mcp.example.com/mcp/' + 'A'.repeat(43), steps: [
    { action: 'fill', selector: '#mcp-url', value: '{MCP_URL}' },
    { action: 'click', selector: '#save' },
    { action: 'wait', selector: '#connected' },
  ] });
  assert.equal(result.status, 'ui-confirmed');
  assert.match(await (await adapter.page('settings')).locator('#connected').innerText(), /mcp.example.com/);
});

test('default MCP setup locates form labels and confirms the created app', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mooncode-connect-test-'));
  const website = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<button onclick="document.querySelector('[role=dialog]').hidden=false">Create app</button><div role="dialog" hidden><label>Name<input id="name"></label><label>MCP Server URL<input id="url"></label><label>Authentication<select><option>OAuth</option><option>No authentication</option></select></label><label><input type="checkbox">I understand the risk</label><button onclick="document.querySelector('#app').textContent=document.querySelector('#name').value;document.querySelector('[role=dialog]').hidden=true">Create</button></div><p id="app"></p>`);
  });
  const adapter = await new ChatGPTPageAdapter({ profile, url: website.origin }).start();
  t.after(async () => { await adapter.close(); await website.close(); await rm(profile, { recursive: true, force: true }); });
  const result = await adapter.connectMcp({ url: 'https://mcp.example.com/mcp/' + 'B'.repeat(43) });
  assert.equal(result.status, 'ui-confirmed');
  const page = await adapter.page('settings');
  assert.equal(await page.locator('select').inputValue(), 'No authentication');
  assert.equal(await page.locator('#url').inputValue(), 'https://mcp.example.com/mcp/' + 'B'.repeat(43));
});

test('rendered action code blocks survive Markdown fence removal', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mooncode-codeblock-test-'));
  const website = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="const p=document.createElement('div');p.setAttribute('data-message-author-role','assistant');p.innerHTML=document.querySelector('template').innerHTML;document.body.append(p)">Send</button><template><pre><code class="language-mooncode-action">{"id":"tools-1","type":"list_tools"}</code></pre><pre><code class="language-json">{"id":"example","type":"tool_call"}</code></pre></template>`);
  });
  const adapter = await new ChatGPTPageAdapter({ profile, url: website.origin }).start();
  t.after(async () => { await adapter.close(); await website.close(); await rm(profile, { recursive: true, force: true }); });
  let final;
  for await (const event of adapter.stream('list tools')) if (event.type === 'done') final = event;
  assert.equal(final.actions.length, 1);
  assert.equal(JSON.parse(final.actions[0]).type, 'list_tools');
  assert.ok(!final.text.includes('```'));
});
