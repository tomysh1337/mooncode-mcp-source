import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './settings.mjs';

const idPattern = /^[a-f0-9]{32}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function normalizeAccount(input) {
  if (!object(input)) throw new Error('Account must be a JSON object');
  let auth;
  if (object(input.credentials)) {
    const provider = { openai: 'codex', anthropic: 'claude', claude: 'claude' }[input.platform];
    if (!provider || !['oauth', 'setup-token'].includes(input.type)) throw new Error('Sub2API import supports OpenAI/Claude OAuth accounts; export other providers as CPA auth JSON');
    const c = input.credentials;
    auth = { ...c, type: provider, account_id: c.account_id ?? c.chatgpt_account_id,
      email: c.email, expired: c.expired, disabled: input.status === 'disabled' };
    if (!auth.expired && c.expires_at) {
      const time = typeof c.expires_at === 'number' ? c.expires_at * 1000 : Date.parse(c.expires_at);
      if (Number.isFinite(time)) auth.expired = new Date(time).toISOString();
    }
    // Proxy IDs refer to another installation; never silently bypass that route.
    if (input.proxy_key) throw new Error('This Sub2API account references a proxy; export CPA auth JSON with proxy_url configured');
  } else {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.type ?? '')) throw new Error('CPA auth JSON requires a provider type');
    auth = { ...input };
  }
  if (![auth.access_token, auth.refresh_token, auth.api_key, auth.token?.access_token, auth.token?.refresh_token].some(nonempty)) throw new Error('Account has no usable credential fields');
  const identity = auth.account_id || auth.email || auth.refresh_token || auth.access_token || auth.api_key || JSON.stringify(auth.token);
  const id = createHash('sha256').update(auth.type + '\0' + identity).digest('hex').slice(0, 32);
  return { id, auth, label: String(input.name || input.email || auth.email || `${auth.type}-${id.slice(0, 8)}`).slice(0, 160) };
}

export function accountRows(payload) {
  if (object(payload?.data) && Array.isArray(payload.data.accounts)) payload = payload.data;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.accounts) ? payload.accounts : [payload];
  if (!rows.length || rows.length > 1000) throw new Error('Import requires 1..1000 accounts');
  return rows;
}

export async function openAccountStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = id => {
    if (!idPattern.test(id)) throw new Error('Invalid account ID');
    return join(directory, `mooncode-${id}.json`);
  };
  async function read(id) {
    const file = path(id);
    if (!(await lstat(file)).isFile()) throw new Error('Account must be a regular file');
    return JSON.parse(await readFile(file, 'utf8'));
  }
  return {
    async list() {
      const output = [];
      for (const file of await readdir(directory)) {
        const match = /^mooncode-([a-f0-9]{32})\.json$/.exec(file);
        if (!match) continue;
        const auth = await read(match[1]);
        output.push({ id: match[1], label: auth.mooncode_label ?? auth.type, provider: auth.type,
          enabled: auth.disabled !== true, expiresAt: typeof auth.expired === 'string' ? auth.expired : null });
      }
      return output;
    },
    async import(payload) {
      const result = { created: 0, updated: 0, errors: [] };
      for (const [index, row] of accountRows(payload).entries()) {
        let normalized;
        try { normalized = normalizeAccount(row); }
        catch (error) { result.errors.push({ index: index + 1, error: error.message }); continue; }
        let exists = false;
        try { await read(normalized.id); exists = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await writePrivateJson(path(normalized.id), { ...normalized.auth, mooncode_label: normalized.label });
        result[exists ? 'updated' : 'created']++;
      }
      return result;
    },
    async setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
      const auth = await read(id);
      await writePrivateJson(path(id), { ...auth, disabled: !enabled });
    },
  };
}
