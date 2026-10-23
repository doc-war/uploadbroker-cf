import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { token } from '../src/hash.js';
import { cacheRead } from '../src/cache.js';

function fixture({ recordTTL = 120, urlTTL = 120 } = {}) {
  const now = Math.floor(Date.now() / 1000), key = 'aaaaaaaa-18', content = 'cached image bytes';
  const record = { expireAt: now + recordTTL, extension: '.png', mimeType: 'image/png', storageKey: 'objects/file' };
  const pending = [], stored = new Map(); let reads = 0, matches = 0, puts = 0;
  const cache = {
    async match(request) { matches++; return stored.get(request.url)?.clone(); },
    async put(request, response) {
      puts++; stored.set(request.url, new Response(await response.arrayBuffer(), response));
    }
  };
  const bucket = { async get(path) {
    reads++;
    if (path.startsWith('index/')) return { async json() { return record; } };
    return { size: content.length, body: new Response(content).body };
  } };
  const env = { bucket, base_url: 'https://broker.test', url_blake2b_salts: ['salt'], build_time: 'build-one' };
  const url = `https://broker.test/tmp/${now + urlTTL}/aa/${key}/${token('salt', key, now + urlTTL)}.png`;
  const ctx = { waitUntil(task) { pending.push(task); } };
  return { env, record, cache, ctx, pending, stored, url, now, content,
    counts: () => ({ reads, matches, puts }),
    async send(urlOverride = url) { return worker.fetch(new Request(urlOverride), env, ctx); } };
}
async function withCache(f, action) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: f.cache } });
  try { await action(); }
  finally { if (original) Object.defineProperty(globalThis, 'caches', original); else delete globalThis.caches; }
}

test('warm signed downloads skip all R2 reads and expose cache status to browsers', async () => {
  const f = fixture();
  await withCache(f, async () => {
    const first = await f.send();
    assert.equal(first.headers.get('x-uploadbroker-cache'), 'MISS');
    assert.equal(first.headers.get('x-uploadbroker-cache-until'), null);
    assert.equal(await first.text(), f.content); await Promise.all(f.pending);
    assert.equal(f.counts().reads, 2);
    f.env.bucket.get = async () => { throw new Error('warm cache must work without R2'); };
    const second = await f.send(`${f.url}?unused=query`);
    assert.equal(second.status, 200); assert.equal(second.headers.get('x-uploadbroker-cache'), 'HIT');
    assert.match(second.headers.get('access-control-expose-headers'), /X-UploadBroker-Cache/);
    assert.equal(second.headers.get('x-uploadbroker-cache-until'), null);
    assert.equal(await second.text(), f.content);
    assert.deepEqual(f.counts(), { reads: 2, matches: 2, puts: 1 });
  });
});

test('cached content never bypasses signature verification or salt removal', async () => {
  const f = fixture();
  await withCache(f, async () => {
    await (await f.send()).text(); await Promise.all(f.pending);
    const invalid = await f.send(f.url.replace(/\/[0-9a-f]{16}\.png$/, '/0000000000000000.png'));
    assert.equal((await invalid.json()).code, 40401);
    f.env.url_blake2b_salts = ['new-salt'];
    assert.equal((await (await f.send()).json()).code, 40401);
    assert.equal(f.counts().matches, 1, 'invalid tokens must not even query the cache');
  });
});

test('URL expiry is checked before cache lookup and cache-hit browser TTL decreases with time', async () => {
  const f = fixture(), originalNow = Date.now;
  await withCache(f, async () => {
    try {
      Date.now = () => f.now * 1000;
      await (await f.send()).text(); await Promise.all(f.pending);
      Date.now = () => (f.now + 100) * 1000;
      const hit = await f.send(); assert.match(hit.headers.get('cache-control'), /max-age=20,/);
      await hit.text();
      Date.now = () => (f.now + 121) * 1000;
      assert.equal((await (await f.send()).json()).code, 40402);
      assert.equal(f.counts().matches, 2);
    } finally { Date.now = originalNow; }
  });
});

test('record expiry bounds cache lifetime even when the signed URL lasts longer', async () => {
  const f = fixture({ recordTTL: 20, urlTTL: 120 }), originalNow = Date.now;
  await withCache(f, async () => {
    try {
      Date.now = () => f.now * 1000;
      const first = await f.send(); assert.match(first.headers.get('cache-control'), /max-age=20,/);
      await first.text(); await Promise.all(f.pending);
      Date.now = () => (f.now + 21) * 1000;
      assert.equal((await (await f.send()).json()).code, 40402);
      assert.equal(f.counts().reads, 3, 'expired cache entry must go back to the index');
    } finally { Date.now = originalNow; }
  });
});

test('deployment timestamps isolate cache entries across releases', async () => {
  const f = fixture();
  await withCache(f, async () => {
    await (await f.send()).text(); await Promise.all(f.pending);
    f.env.build_time = 'build-two';
    const fresh = await f.send(); assert.equal(fresh.headers.get('x-uploadbroker-cache'), 'MISS');
    await fresh.text(); await Promise.all(f.pending);
    assert.equal(f.counts().reads, 4); assert.equal(f.stored.size, 2);
  });
});

test('cache read and write failures preserve a valid full download', async () => {
  const f = fixture(); f.cache.match = async () => { throw new Error('cache unavailable'); };
  f.cache.put = async () => { throw new Error('cache unavailable'); };
  await withCache(f, async () => {
    const response = await f.send(); assert.equal(response.status, 200);
    assert.equal(await response.text(), f.content); await Promise.all(f.pending);
  });
});

test('cache fill applies backpressure instead of buffering a whole slow-client download', async () => {
  let produced = 0; const pending = [];
  const source = new ReadableStream({ pull(controller) {
    if (produced === 100) controller.close();
    else { produced++; controller.enqueue(new Uint8Array(65536)); }
  } });
  const cache = { async put(request, response) { await response.arrayBuffer(); } };
  const response = cacheRead(cache, new Request('https://broker.test/file'), new Response(source), 20000,
    { waitUntil(task) { pending.push(task); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(produced <= 3, `source raced ahead of the unread client: ${produced} chunks`);
  assert.equal((await response.arrayBuffer()).byteLength, 100 * 65536);
  await Promise.all(pending);
});

test('a cache that stops consuming mid-stream cannot truncate or stall the client', async () => {
  const pending = [], bytes = new Uint8Array(200000).fill(42);
  const cache = { async put(request, response) {
    const reader = response.body.getReader(); await reader.read(); await reader.cancel(); throw new Error('cache fill stopped');
  } };
  const response = cacheRead(cache, new Request('https://broker.test/file'), new Response(bytes), 20000,
    { waitUntil(task) { pending.push(task); } });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); await Promise.all(pending);
});
