import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { listen, json, readJson } from './http.mjs';
import { readProjectSkills } from './skills.mjs';
import { WebOrchestrator } from './orchestrator.mjs';
import { openSettings, settingRanges, validateSettings } from './settings.mjs';

export async function startWebService({ hub, adapter, apiAdapter, accounts, settings, workspace, port = 48400, host = '127.0.0.1', webOrigin, token = randomBytes(32).toString('base64url'), connectSteps, allowWrite = false, allowExec = false }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Web token must have at least 32 characters');
  if (webOrigin) {
    const url = new URL(webOrigin);
    if (url.protocol !== 'https:' || url.origin !== webOrigin) throw new Error('webOrigin must be an HTTPS origin');
  }
  const html = await readFile(new URL('./web.html', import.meta.url));
  settings ??= await openSettings();
  hub.configure({ maxActive: settings.get().maxActive });
  let busy = false;
  const active = new Set();
  let connectionLink;
  let http;
  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      return res.end(html);
    }
    if (req.url?.startsWith('/v1/')) {
      if (!apiAdapter?.proxy) return json(res, 503, { error: { message: 'Account API is not configured' } });
      return apiAdapter.proxy(req, res);
    }
    const authorization = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if ((req.headers.origin && ![http.origin, webOrigin].includes(req.headers.origin)) || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return json(res, 401, { error: 'Web control token required' });
    if (req.method === 'GET' && req.url === '/api/settings') return json(res, 200, { settings: settings.get(), ranges: settingRanges, cpaConfigured: Boolean(apiAdapter), accountsConfigured: Boolean(accounts), activeLinks: hub.list().length });
    if (req.method === 'GET' && req.url === '/api/accounts') return json(res, 200, accounts ? await accounts.list() : []);
    if (req.method === 'GET' && req.url === '/api/models') return json(res, 200, apiAdapter ? await apiAdapter.models() : []);
    if (req.method === 'GET' && req.url === '/api/links') return json(res, 200, hub.list());
    if (req.method === 'POST' && ['/api/settings', '/api/accounts/import', '/api/accounts/enabled', '/api/links', '/api/links/revoke'].includes(req.url)) {
      if (busy) return json(res, 409, { error: 'Wait for the current task or operation to finish' });
      busy = true;
      try {
        const body = await readJson(req, req.url === '/api/accounts/import' ? 8 * 1024 * 1024 : 16384);
        if (req.url === '/api/settings') {
          const previous = settings.get(), next = validateSettings(body, previous);
          if (next.provider === 'cpa' && !apiAdapter) throw new Error('Configure the CPA URL and API key before selecting account mode');
          hub.configure({ maxActive: next.maxActive });
          try { return json(res, 200, await settings.save(next)); }
          catch (error) { hub.configure({ maxActive: previous.maxActive }); throw error; }
        }
        if (req.url.startsWith('/api/accounts/')) {
          if (!accounts) throw new Error('Account import directory is not configured');
          if (req.url.endsWith('/import')) return json(res, 200, await accounts.import(body));
          await accounts.setEnabled(body.id, body.enabled);
          return json(res, 200, { ok: true });
        }
        if (req.url === '/api/links') {
          const kind = body.kind ?? 'workspace';
          return json(res, 201, await hub.create({ kind, name: body.name ?? kind, ttl: body.ttl ?? 3600,
            ...(kind === 'workspace' ? { workspace, allowWrite, allowExec } : {}) }));
        }
        return json(res, 200, { revoked: await hub.revoke(body.id) });
      } finally { busy = false; }
    }
    if (req.method === 'GET' && req.url === '/api/skills') return json(res, 200, (await readProjectSkills(workspace)).map(({ name, path }) => ({ name, path })));
    if (req.method === 'POST' && req.url === '/api/connect') {
      if (busy) return json(res, 409, { error: 'A request is running' });
      busy = true;
      try {
        const link = await hub.create({ kind: 'workspace', workspace, name: 'ChatGPT', ttl: 0, allowWrite, allowExec });
        try {
          const result = await adapter.connectMcp({ url: link.url, name: 'MoonCode', steps: connectSteps });
          if (connectionLink) await hub.revoke(connectionLink.id);
          connectionLink = link;
          return json(res, 200, { ...result, link });
        } catch (error) { await hub.revoke(link.id); throw error; }
      } finally { busy = false; }
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') return json(res, 404, { error: 'Not found' });
    if (busy) return json(res, 409, { error: 'A request is running' });
    busy = true;
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const { message } = await readJson(req, 65536);
      if (typeof message !== 'string' || !message.trim() || message.length > 16000) return json(res, 400, { error: 'message must be 1..16000 characters' });
      const current = settings.get();
      const selectedAdapter = current.provider === 'cpa' ? apiAdapter : adapter;
      if (!selectedAdapter) throw new Error('Selected provider is not configured');
      const orchestrator = new WebOrchestrator({ hub, adapter: selectedAdapter, workspace, allowWrite, allowExec, ...current });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      res.flushHeaders();
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      try {
        for await (const event of orchestrator.run(message, { signal: controller.signal })) {
          if (controller.signal.aborted) break;
          if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
        }
        if (!res.destroyed) res.end('event: done\ndata: {}\n\n');
      } catch (error) {
        if (!res.destroyed) res.end(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      } finally { clearInterval(heartbeat); }
    } finally {
      active.delete(controller);
      res.off('close', cancel);
      busy = false;
    }
  }
  http = await listen((req, res) => void handle(req, res).catch(error => json(res, 400, { error: error.message })), port, host);
  return { url: `${webOrigin ?? http.origin}/#token=${token}`, origin: http.origin, token,
    async close() {
      for (const controller of active) controller.abort();
      await http.close();
      if (connectionLink) await hub.revoke(connectionLink.id);
    },
  };
}
