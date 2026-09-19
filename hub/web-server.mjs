import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { listen, json, readJson } from './http.mjs';
import { readProjectSkills } from './skills.mjs';
import { WebOrchestrator } from './orchestrator.mjs';

export async function startWebService({ hub, adapter, workspace, port = 48400, connectSteps, allowWrite = false, allowExec = false }) {
  const token = randomBytes(32).toString('base64url');
  const html = await readFile(new URL('./web.html', import.meta.url));
  const orchestrator = new WebOrchestrator({ hub, adapter, workspace, allowWrite, allowExec });
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
    const authorization = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if ((req.headers.origin && req.headers.origin !== http.origin) || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return json(res, 401, { error: 'Web control token required' });
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
  http = await listen((req, res) => void handle(req, res).catch(error => json(res, 400, { error: error.message })), port);
  return { url: `${http.origin}/#token=${token}`, origin: http.origin, token,
    async close() {
      for (const controller of active) controller.abort();
      await http.close();
      if (connectionLink) await hub.revoke(connectionLink.id);
    },
  };
}
