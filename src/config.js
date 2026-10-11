import metadata from '../package.json' with { type: 'json' };
export const MiB = 1024 * 1024;
export function config(env) {
  const number = (name, fallback, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
    return value;
  };
  const saltValue = env.url_blake2b_salts ?? [''];
  const salts = typeof saltValue === 'string' ? JSON.parse(saltValue) : saltValue;
  if (!Array.isArray(salts) || salts.length < 1 || salts.length > 2 || salts.some(s => typeof s !== 'string')) throw new Error('invalid url_blake2b_salts');
  const baseURL = String(env.base_url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseURL) || new URL(baseURL).search || new URL(baseURL).hash) throw new Error('invalid base_url');
  const prefix = env.url_prefix ?? 'tmp';
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('invalid url_prefix');
  const limits = Object.fromEntries(['image', 'audio', 'video', 'document', 'archive'].map((category, i) => [category, number(`limit_${category}_mib`, [50, 5, 10, 5, 30][i], 90) * MiB]));
  const contentHash = env.content_hash ?? 'sha256';
  if (!['sha256', 'xxhash32'].includes(contentHash)) throw new Error('invalid content_hash');
  const cors = env.cors ?? true;
  if (typeof cors !== 'boolean') throw new Error('invalid cors');
  if (env.hmac_secret !== undefined && typeof env.hmac_secret !== 'string') throw new Error('invalid hmac_secret');
  return { baseURL, prefix, salts, limits, maxBody: Math.max(...Object.values(limits)) + MiB,
    ttl: number('default_ttl_hours', 24, 24) * 3600, hmac: env.hmac_secret ?? '', cors, contentHash,
    version: metadata.version, buildTime: env.build_time ?? '' };
}
