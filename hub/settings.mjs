import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const settingRanges = Object.freeze({ maxActive: [1, 1024], maxAgents: [0, 256], maxDepth: [0, 16], maxRounds: [1, 256], maxActions: [1, 10000] });
export const defaultSettings = Object.freeze({ maxActive: 16, maxAgents: 4, maxDepth: 2, maxRounds: 12, maxActions: 48, provider: 'web', model: '' });

export function validateSettings(patch, current = defaultSettings) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(settingRanges, key)) {
      const [min, max] = settingRanges[key];
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
    } else if (key === 'provider') {
      if (!['web', 'cpa'].includes(value)) throw new Error('provider must be web or cpa');
    } else if (key === 'model') {
      if (typeof value !== 'string' || value.length > 200 || /[\r\n\x00]/.test(value)) throw new Error('Invalid model name');
    } else throw new Error('Unknown setting field');
    next[key] = value;
  }
  return next;
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function openSettings(path, defaults = {}) {
  let value = validateSettings(defaults);
  if (path) {
    try { value = validateSettings(JSON.parse(await readFile(path, 'utf8')), value); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    get: () => ({ ...value }),
    async save(next) {
      const checked = validateSettings(next, value);
      if (path) await writePrivateJson(path, checked);
      value = checked;
      return this.get();
    },
  };
}
