import { config } from './config.js';
import { BrokerError, failure } from './errors.js';
import { token, equal } from './hash.js';
import { upload } from './upload.js';
import { cleanup, lookup, INDEX } from './storage.js';
import { edgeCache, cacheRequest, cachedRead, cacheRead, CACHE_STATUS } from './cache.js';

async function read(request, bucket, cfg, ctx) {
  const parts = new URL(request.url).pathname.split('/');
  if (parts.length !== 6) throw new BrokerError(40401, 'invalid url');
  const [, , expiry, shard, key, signature] = parts;
  const match = /^([0-9a-f]{16})(\.[a-z0-9+_-]+)$/.exec(signature);
  const expire = Number(expiry);
  if (!/^\d+$/.test(expiry) || !Number.isSafeInteger(expire) || expire > 253402300799 || !/^[0-9a-f]{8}-[1-9][0-9]{0,8}$/.test(key) || shard !== key.slice(0, 2) || !match) throw new BrokerError(40401, 'invalid url');
  if (!cfg.salts.some(salt => equal(token(salt, key, expire), match[1]))) throw new BrokerError(40401, 'invalid token');
  const now = Math.floor(Date.now() / 1000);
  if (expire <= now) throw new BrokerError(40402, 'resource expired');
  // Authenticate every request, including cache hits and salt rotation.
  const cache = edgeCache(), cacheKey = cacheRequest(request, cfg);
  const cached = await cachedRead(cache, cacheKey, expire, now);
  if (cached) return cached;
  const entry = await lookup(bucket, key);
  if (!entry || entry.record.expireAt <= now) throw new BrokerError(40402, 'resource not found');
  const record = entry.record;
  if (match[2] !== record.extension) throw new BrokerError(40401, 'extension mismatch');
  const object = await bucket.get(record.storageKey);
  if (!object) throw new BrokerError(40402, 'resource not found');
  const until = Math.min(expire, record.expireAt);
  const response = new Response(object.body, { headers: {
    'Content-Type': record.mimeType, 'Content-Length': String(object.size),
    'Cache-Control': `public, max-age=${Math.min(3600, until - now)}, must-revalidate`,
    'X-Content-Type-Options': 'nosniff'
  } });
  return cacheRead(cache, cacheKey, response, until, ctx);
}
async function health(bucket, cfg) {
  try {
    let cursor, activeCount = 0;
    const now = Math.floor(Date.now() / 1000);
    for (let page = 0; page < 10; page++) {
      const result = await bucket.list({ prefix: INDEX, cursor, limit: 1000, include: ['customMetadata'] });
      activeCount += result.objects.filter(object => Number(object.customMetadata?.expireAt) > now).length;
      if (!result.truncated) break;
      if (page === 9) activeCount = -1;
      cursor = result.cursor;
    }
    return Response.json({ version: cfg.version, status: 'ok', storage: 'ok', sqlite: 'not applicable (R2 metadata)', activeCount, time: cfg.buildTime }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ version: cfg.version, status: 'degraded', storage: 'R2 unavailable', sqlite: 'not applicable (R2 metadata)', activeCount: -1, time: cfg.buildTime }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export default {
  async fetch(request, env, ctx) {
    let cfg, response;
    try {
      cfg = config(env);
      if (!env.bucket) throw new Error('missing bucket binding');
      const path = new URL(request.url).pathname;
      if (cfg.cors && request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (path === '/v1/health') response = await health(env.bucket, cfg);
      else if (path === '/v1/upload') {
        if (request.method !== 'POST') throw new BrokerError(40500, 'method not allowed');
        response = await upload(request, env.bucket, cfg);
      } else if (path.startsWith(`/${cfg.prefix}/`)) {
        if (request.method !== 'GET') throw new BrokerError(40500, 'method not allowed');
        response = await read(request, env.bucket, cfg, ctx);
      } else response = new Response('404 page not found\n', { status: 404 });
    } catch (error) {
      if (error instanceof BrokerError) response = failure(error.code, error.message);
      else { console.error('request failed', error.message); response = failure(50000, 'internal error'); }
    }
    if (cfg?.cors) {
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      response.headers.set('Access-Control-Max-Age', '86400');
      response.headers.set('Access-Control-Expose-Headers', `Content-Length, ${CACHE_STATUS}`);
    }
    return response;
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanup(env.bucket).then(count => console.log(`cleanup: deleted=${count}`)));
  }
};
