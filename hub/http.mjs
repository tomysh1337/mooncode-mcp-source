import { createServer } from 'node:http';

export function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function readJson(req, limit = 16384) {
  let bytes = 0;
  const parts = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request body exceeds limit');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

export async function listen(handler, port = 0) {
  const server = createServer(handler);
  server.requestTimeout = 180000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const done = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await done;
    },
  };
}
