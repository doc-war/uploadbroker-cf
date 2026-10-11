const UNTIL = 'X-UploadBroker-Cache-Until';
export const CACHE_STATUS = 'X-UploadBroker-Cache';

export function edgeCache() {
  try { return globalThis.caches?.default; } catch { return undefined; }
}
export function cacheRequest(request, cfg) {
  const url = new URL(new URL(request.url).pathname, cfg.baseURL);
  // Queries do not affect signed resource identity. A new deployment starts a new namespace.
  url.searchParams.set('__uploadbroker_cache', `v2:${cfg.buildTime}`);
  return new Request(url, { method: 'GET' });
}
export async function cachedRead(cache, key, expire, now) {
  if (!cache) return null;
  try {
    const cached = await cache.match(key);
    if (!cached) return null;
    const until = Number(cached.headers.get(UNTIL));
    if (cached.status !== 200 || !Number.isSafeInteger(until) || until <= now || until > expire) {
      // A cloned stream's cancel promise may wait for its other reader.
      // Invalid cache content must never delay the R2 fallback.
      cached.body?.cancel().catch(() => {});
      return null;
    }
    const response = new Response(cached.body, cached);
    response.headers.delete(UNTIL);
    response.headers.set('Cache-Control', `public, max-age=${Math.min(3600, until - now)}, must-revalidate`);
    response.headers.set(CACHE_STATUS, 'HIT');
    return response;
  } catch { return null; }
}
export function cacheRead(cache, key, response, until, ctx) {
  response.headers.set(CACHE_STATUS, cache && ctx?.waitUntil ? 'MISS' : 'BYPASS');
  if (!cache || !ctx?.waitUntil) return response;
  // Response.clone()/tee() can buffer a whole large download for the slower reader.
  // Both branches apply backpressure, so a cache fill cannot race ahead of the client.
  const client = new TransformStream(), fill = new TransformStream();
  const clientWriter = client.writable.getWriter(), cacheWriter = fill.writable.getWriter();
  const reader = response.body.getReader();
  let caching = true;
  const copy = new Response(fill.readable, response);
  copy.headers.set(UNTIL, String(until));
  copy.headers.delete(CACHE_STATUS);
  const store = (async () => {
    try { await cache.put(key, copy); }
    catch (error) {
      // Cache availability must not turn an otherwise valid download into an error.
      console.error('edge cache write failed', error.message);
    }
    finally {
      caching = false;
      await cacheWriter.abort().catch(() => {});
    }
  })();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        await Promise.all([clientWriter.write(value), caching
          ? cacheWriter.write(value).catch(() => { caching = false; }) : undefined]);
      }
      await Promise.all([clientWriter.close(), caching ? cacheWriter.close().catch(() => {}) : undefined]);
    } catch (error) {
      await Promise.allSettled([reader.cancel(error), clientWriter.abort(error), cacheWriter.abort(error)]);
    } finally { reader.releaseLock(); }
  })();
  ctx.waitUntil(Promise.all([store, pump]));
  return new Response(client.readable, response);
}
