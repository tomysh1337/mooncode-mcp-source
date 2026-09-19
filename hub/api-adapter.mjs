import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { json } from './http.mjs';

// Imported OAuth credentials are used by a local CLIProxyAPI service. This
// adapter only receives that service's API key, never upstream account tokens.
export class ApiAdapter {
  constructor({ baseUrl, apiKey }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid CPA API URL');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote CPA API requires HTTPS');
    if (!apiKey) throw new Error('MOONCODE_CPA_API_KEY is required');
    this.baseUrl = url.href.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.conversations = new Map();
    this.active = new Set();
  }
  async request(path, options = {}) {
    let response;
    try { response = await fetch(`${this.baseUrl}/${path}`, { ...options, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...options.headers } }); }
    catch { throw new Error('CPA connection failed; check the local account service'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`CPA returned HTTP ${response.status}; check enabled accounts and the selected model`);
    }
    return response;
  }
  async models() {
    const response = await this.request('models', { signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    return (data.data ?? []).filter(m => typeof m.id === 'string').map(m => m.id);
  }
  async proxy(req, res) {
    const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${this.apiKey}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(res, 401, { error: { message: 'API key required', type: 'authentication_error' } });
    const path = req.url?.split('?')[0];
    if (!((req.method === 'GET' && path === '/v1/models') || (req.method === 'POST' && ['/v1/chat/completions', '/v1/responses'].includes(path)))) return json(res, 404, { error: { message: 'Unknown API route' } });
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      let body;
      if (req.method === 'POST') {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) return json(res, 413, { error: { message: 'Request exceeds 16 MiB' } }); chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
      const upstream = await fetch(`${this.baseUrl}/${path.slice(4)}`, { method: req.method, redirect: 'error', body,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: req.headers.accept ?? 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      for await (const chunk of upstream.body) if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      res.end();
    } catch {
      if (res.headersSent) res.destroy(); else json(res, 502, { error: { message: 'Account service unavailable' } });
    } finally { res.off('close', cancel); }
  }
  async *stream(prompt, { agentId, signal, images = [], model } = {}) {
    if (this.active.has(agentId)) throw new Error('This conversation is busy');
    this.active.add(agentId);
    let reader;
    try {
      if (!model) model = (await this.models())[0];
      if (!model) throw new Error('Import an account and select an available model first');
      const history = this.conversations.get(agentId) ?? [];
      const content = images.length ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : prompt;
      const messages = [...history, { role: 'user', content }];
      const response = await this.request('chat/completions', { method: 'POST',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]),
        body: JSON.stringify({ model, stream: true, messages }) });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', answer = '', finished = false, bytes = 0;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('CPA response exceeds 8 MiB');
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { finished = true; break; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { throw new Error('Invalid CPA streaming response'); }
          if (parsed.error) throw new Error('CPA reported an upstream error; check the account service');
          const choice = parsed.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta) { answer += delta; yield { type: 'delta', text: delta }; }
          if (choice?.finish_reason) {
            if (choice.finish_reason !== 'stop') throw new Error('Model response was interrupted; no action was executed');
            finished = true;
          }
        }
      }
      if (!finished || !answer) throw new Error('CPA stream ended without a complete response');
      this.conversations.set(agentId, [...messages, { role: 'assistant', content: answer }]);
      yield { type: 'done', text: answer };
    } finally { await reader?.cancel().catch(() => {}); this.active.delete(agentId); }
  }
  async closeAgent(id) { this.conversations.delete(id); }
  async close() { this.conversations.clear(); }
}
