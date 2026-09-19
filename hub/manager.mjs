import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { startBridgeServer } from '@mooncode/agent-runtime';
import { startBrowserServer } from './browser.mjs';
import { json, listen, readJson } from './http.mjs';

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}..${max}`);
  return value;
}
export function normalizePublicOrigin(raw) {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Public origin must be an HTTPS origin without path/credentials');
  return url.origin;
}

export async function startHub({ port = 48271, adminPort = 0, publicOrigin, maxActive = 16, browserExecutable, log = () => {} } = {}) {
  integer(port, 0, 65535, 'port');
  integer(adminPort, 0, 65535, 'adminPort');
  integer(maxActive, 1, 1024, 'maxActive');
  const configuredOrigin = normalizePublicOrigin(publicOrigin);
  const adminToken = randomBytes(32).toString('base64url');
  const links = new Map();
  const routes = new Map();
  let starting = 0;
  let closing = false;
  const creates = new Set();
  const deletes = new Set();

  const gateway = await listen((req, res) => {
    // Administrative routes live on a separate loopback listener, never on this gateway.
    const path = req.url?.split('?')[0];
    const record = routes.get(path);
    if (!record || (record.expiresAt && Date.now() >= record.expiresAt)) return json(res, 404, { error: 'Unknown or expired MCP link' });
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.protocol === 'https:' && url.origin === origin) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          res.setHeader('access-control-allow-methods', 'POST, GET, DELETE, OPTIONS');
          res.setHeader('access-control-allow-headers', 'Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID');
          res.setHeader('access-control-expose-headers', 'MCP-Session-Id');
        }
      } catch { /* No CORS grant for malformed origins. */ }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    const target = new URL(record.worker.localUrl);
    // Send only protocol headers; discard client-controlled forwarding and authentication headers.
    const headers = {};
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const upstream = request(target, { method: req.method, headers }, response => {
      if (res.destroyed || res.headersSent) { response.destroy(); return; }
      const forwarded = {};
      for (const name of ['content-type', 'mcp-session-id', 'cache-control']) if (response.headers[name]) forwarded[name] = response.headers[name];
      res.writeHead(response.statusCode ?? 502, forwarded);
      response.pipe(res);
    });
    record.requests.add(upstream);
    upstream.once('close', () => record.requests.delete(upstream));
    upstream.once('error', () => {
      if (res.headersSent) res.destroy();
      else json(res, 502, { error: 'MCP worker disconnected' });
    });
    res.once('close', () => upstream.destroy());
    upstream.setTimeout(180000, () => upstream.destroy());
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        req.unpipe(upstream);
        json(res, 413, { error: 'Request body exceeds 2 MiB' });
        upstream.destroy();
      }
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }, port);

  function describe(record) {
    return { id: record.id, name: record.name, kind: record.kind, workspace: record.workspace,
      allowWrite: record.allowWrite, allowExec: record.allowExec,
      createdAt: record.createdAt, expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      url: `${configuredOrigin ?? gateway.origin}${record.path}` };
  }
  async function createInner(input) {
    if (closing) throw new Error('Hub is stopping');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a link configuration');
    const kind = input.kind ?? 'workspace';
    if (!['workspace', 'browser', 'desktop'].includes(kind)) throw new Error('kind must be workspace, browser or desktop');
    const ttl = integer(input.ttl ?? 3600, 0, 604800, 'ttl');
    const name = input.name ?? kind;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('name must be 1..100 characters');
    for (const key of ['allowWrite', 'allowExec']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
    if (kind !== 'workspace' && (input.allowWrite || input.allowExec || input.workspace)) throw new Error('Browser/desktop links do not take workspace permissions');
    if (input.allowExec && !input.allowWrite) throw new Error('Command execution also requires allowWrite');
    if (links.size + starting >= maxActive) throw new Error(`Active link limit (${maxActive}) reached; revoke a link or raise --max-active`);
    starting++;
    let worker;
    try {
      const workspace = kind === 'workspace' ? await realpath(input.workspace ?? process.cwd()) : undefined;
      if (workspace && !(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
      const secret = randomBytes(32).toString('base64url');
      const id = randomUUID();
      worker = kind !== 'workspace'
        ? await startBrowserServer({ secret, executablePath: browserExecutable, desktop: kind === 'desktop' })
        : await startBridgeServer({ workspaceRoot: workspace, port: 0, secret, allowWrite: input.allowWrite === true,
            accessScope: input.allowExec ? 'computer' : 'workspace', tunnel: 'none', log: () => {} });
      if (closing) throw new Error('Hub stopped during link creation');
      const record = { id, name, kind, workspace, allowWrite: input.allowWrite === true, allowExec: input.allowExec === true,
        createdAt: new Date().toISOString(), expiresAt: ttl ? Date.now() + ttl * 1000 : null,
        path: `/mcp/${secret}`, worker, requests: new Set() };
      links.set(id, record);
      routes.set(record.path, record);
      log({ type: 'link.created', id, kind });
      return describe(record);
    } catch (error) { await worker?.close(); throw error; }
    finally { starting--; }
  }
  function create(input) {
    const pending = createInner(input);
    creates.add(pending);
    void pending.finally(() => creates.delete(pending)).catch(() => {});
    return pending;
  }
  function revoke(id) {
    const record = links.get(id);
    if (!record) return Promise.resolve(false);
    links.delete(id);
    routes.delete(record.path);
    for (const req of record.requests) req.destroy();
    const pending = record.worker.close().then(() => { log({ type: 'link.revoked', id }); return true; });
    deletes.add(pending);
    void pending.finally(() => deletes.delete(pending)).catch(() => {});
    return pending;
  }
  const timer = setInterval(() => {
    for (const record of links.values()) if (record.expiresAt && Date.now() >= record.expiresAt) void revoke(record.id).catch(() => {});
  }, 1000);
  timer.unref();
  let admin;
  try {
    admin = await listen((req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${adminToken}`);
      if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: 'Local admin authentication required' });
      void (async () => {
        if (req.method === 'GET' && req.url === '/links') return json(res, 200, [...links.values()].map(describe));
        if (req.method === 'POST' && req.url === '/links') return json(res, 201, await create(await readJson(req)));
        if (req.method === 'DELETE' && /^\/links\/[a-f0-9-]{36}$/.test(req.url ?? '')) return json(res, await revoke(req.url.slice(7)) ? 200 : 404, { ok: true });
        json(res, 404, { error: 'Not found' });
      })().catch(error => json(res, 400, { error: error.message }));
    }, adminPort);
  } catch (error) { clearInterval(timer); await gateway.close(); throw error; }
  let closePromise;
  return { origin: gateway.origin, adminOrigin: admin.origin, adminToken, create, revoke,
    list: () => [...links.values()].map(describe),
    close() {
      return closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        await admin.close();
        await gateway.close();
        await Promise.allSettled([...creates]);
        await Promise.allSettled([...links.keys()].map(revoke));
        await Promise.allSettled([...deletes]);
      })();
    },
  };
}
