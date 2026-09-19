import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export async function connect(url) {
  const target = new URL(url);
  if (target.username || target.password || target.hash || !/^\/mcp\/[A-Za-z0-9_-]{43}$/.test(target.pathname)) throw new Error('Expected a complete MCP capability URL');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) throw new Error('Use HTTPS outside loopback');
  const client = new Client({ name: 'mooncode-subagent', version: '0.2.0' });
  try { await client.connect(new StreamableHTTPClientTransport(target)); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}

export async function relay(url) {
  const remote = await connect(url);
  const definitions = [];
  let cursor;
  do {
    const result = await remote.listTools(cursor ? { cursor } : {});
    definitions.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  const handle = serveStdio(() => {
    const server = new McpServer({ name: 'mooncode-subagent-relay', version: '0.2.0' });
    for (const tool of definitions) server.registerTool(tool.name, {
      description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema), annotations: tool.annotations,
    }, async args => {
      try { return await remote.callTool({ name: tool.name, arguments: args }); }
      catch { return { isError: true, content: [{ type: 'text', text: 'Remote MCP call failed; check link expiry and connection' }] }; }
    });
    return server;
  }, { legacy: 'serve', onerror: () => process.stderr.write('MCP relay transport error\n') });
  let closing;
  const close = () => closing ??= Promise.allSettled([handle.close(), remote.close()]);
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
  return { close };
}
