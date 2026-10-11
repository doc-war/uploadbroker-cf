import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { token, hmac } from '../src/hash.js';
import { cleanup } from '../src/storage.js';
import reference from 'xxhash-wasm';
import { smoke } from '../scripts/smoke.mjs';
const oracle = await reference();
const MiB = 1024 * 1024;
const png = Uint8Array.of(137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82);
for (const algorithm of ['sha256', 'xxhash32']) describe(algorithm, () => {
let mf, bucket;
async function send(url, init = {}) {
  // Exercise the local HTTP listener directly, bypassing dispatchFetch's proxy.
  const local = new URL(await mf.ready), requested = new URL(url);
  local.pathname = requested.pathname; local.search = requested.search;
  const headers = new Headers(init.headers); headers.set('connection', 'close');
  return fetch(local, { ...init, headers });
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'broker', modules: true, scriptPath: 'deploy/dist/worker.js', compatibilityDate: '2026-10-10', r2Buckets: ['bucket'],
    bindings: { base_url: 'https://broker.test', url_blake2b_salts: '["test-salt","old-salt"]', hmac_secret: 'upload-secret', build_time: '2026-10-11T01:02:03.456Z', content_hash: algorithm } }] }));
  bucket = await mf.getR2Bucket('bucket');
});
after(async () => { await mf?.dispose(); });
async function post(data = png, filename = 'image.png', fields = {}, validAuth = true) {
  const form = new FormData();
  if (data !== null) form.set('file', new Blob([data]), filename);
  form.set('timestamp', '1782650347');
  form.set('sign', validAuth ? await hmac('upload-secret', '1782650347') : 'invalid');
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  // Serialize Node's FormData with Node's Request; Miniflare uses its own fetch types.
  const request = new Request('https://broker.test/v1/upload', { method: 'POST', body: form });
  return send(request.url, { method: 'POST', headers: request.headers, body: request.body, duplex: 'half' });
}
test('upload, content addressing, read and deduplication', async () => {
  const first = await post(); const result = await first.json();
  assert.equal(first.status, 200); assert.equal(result.code, 0);
  assert.equal(result.data.mimeType, 'image/png'); assert.equal(result.data.size, png.length);
  assert.equal(new URL(result.data.url).pathname.split('/')[4], algorithm === 'sha256' ? createHash('sha256').update(png).digest('hex') : `${oracle.h32Raw(png).toString(16).padStart(8, '0')}-${png.length}`);
  const response = await send(result.data.url);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const second = await (await post(png, 'image.png', { expires: '1' })).json();
  assert.equal(second.data.url, result.data.url);
  const staging = await bucket.list({ prefix: 'staging/' }); assert.equal(staging.objects.length, 0);
});
test('errors retain original codes/statuses and invalid requests do not publish objects', async () => {
  for (const [data, name, fields, auth, code, status] of [
    [null, 'x.png', {}, true, 40001, 400], [new Uint8Array(), 'x.png', {}, true, 40002, 400],
    [png, 'x.jpg', {}, true, 40006, 400], [png, 'x.png', { expires: '25' }, true, 40005, 400],
    [png, 'x.png', {}, false, 50000, 500], ['plain text', 'x.html', {}, true, 40003, 400],
    [new Uint8Array(5 * MiB + 1).fill(65), 'x.txt', {}, true, 40004, 400]
  ]) {
    const response = await post(data, name, fields, auth);
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  assert.equal((await bucket.list({ prefix: 'staging/' })).objects.length, 0);
  const method = await send('https://broker.test/v1/upload'); assert.equal((await method.json()).code, 40500);
});
test('text types, invalid tokens, extensions, shard and salt rotation', async () => {
  const result = await (await post('package main\n', 'main.go')).json();
  assert.equal(result.data.mimeType, 'text/x-go'); assert.ok(result.data.url.endsWith('.go'));
  const url = new URL(result.data.url); const parts = url.pathname.split('/');
  for (const path of [url.pathname.replace(/\.[^.]+$/, '.txt'), url.pathname + '/extra', url.pathname.replace(parts[3], 'xx')]) {
    const response = await send(`https://broker.test${path}`); assert.equal((await response.json()).code, 40401);
  }
  parts[5] = token('old-salt', parts[4], Number(parts[2])) + '.go';
  assert.equal((await send('https://broker.test' + parts.join('/'))).status, 200);
  parts[5] = '0000000000000000.go';
  assert.equal((await (await send('https://broker.test' + parts.join('/'))).json()).code, 40401);
});
test('concurrent duplicate uploads converge on one URL and one generation', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => post('concurrent content', 'a.txt')));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  assert.equal(new Set(results.map(result => result.data.url)).size, 1);
  const key = new URL(results[0].data.url).pathname.split('/')[4];
  assert.equal((await bucket.list({ prefix: `objects/${key}/` })).objects.length, 1);
});
test('expired URLs and records are rejected; cleanup preserves newer generations', async () => {
  const result = await (await post('expiry test', 'expiry.txt')).json();
  const parts = new URL(result.data.url).pathname.split('/'); const key = parts[4];
  parts[2] = String(Math.floor(Date.now() / 1000) - 1); parts[5] = token('test-salt', key, Number(parts[2])) + '.txt';
  assert.equal((await (await send('https://broker.test' + parts.join('/'))).json()).code, 40402);
  const entry = await bucket.get(`index/${key}`); const record = await entry.json();
  const obsolete = `objects/${key}/old/version`;
  await bucket.put(obsolete, 'obsolete', { customMetadata: { expireAt: String(Math.floor(Date.now() / 1000) - 1) } });
  await cleanup(bucket);
  assert.equal(await bucket.head(obsolete), null);
  assert.ok(await bucket.head(record.storageKey));
  record.expireAt = Math.floor(Date.now() / 1000) - 1;
  await bucket.put(`index/${key}`, JSON.stringify(record), { customMetadata: { expireAt: String(record.expireAt) } });
  assert.equal((await (await send(result.data.url)).json()).code, 40402);
});
test('health and cors', async () => {
  const response = await send('https://broker.test/v1/health');
  const result = await response.json(); assert.equal(result.status, 'ok'); assert.ok(result.activeCount >= 1);
  const preflight = await send('https://broker.test/v1/upload', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('native edge cache serves a second signed download with the same content', async () => {
  const content = `native cache ${algorithm}`;
  const result = await (await post(content, 'cache.txt')).json();
  const first = await send(result.data.url);
  assert.equal(first.headers.get('x-uploadbroker-cache'), 'MISS');
  assert.equal(await first.text(), content);
  let second;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    second = await send(`${result.data.url}?ignored=${attempt}`);
    assert.equal(await second.text(), content);
    if (second.headers.get('x-uploadbroker-cache') === 'HIT') break;
  }
  assert.equal(second.headers.get('x-uploadbroker-cache'), 'HIT');
});

test('legacy object and index layouts remain readable after the upload optimization', async () => {
  const key = 'f'.repeat(64), expireAt = Math.floor(Date.now() / 1000) + 3600;
  const storageKey = `objects/${key}/${expireAt}/legacy`;
  await bucket.put(storageKey, 'legacy content', { customMetadata: { expireAt: String(expireAt) } });
  await bucket.put(`index/${key}`, JSON.stringify({ key, storageKey, expireAt, extension: '.txt', mimeType: 'text/plain', size: 14 }),
    { customMetadata: { expireAt: String(expireAt) } });
  const url = `https://broker.test/tmp/${expireAt}/ff/${key}/${token('test-salt', key, expireAt)}.txt`;
  assert.equal(await (await send(url)).text(), 'legacy content');
});
test('near-expiry duplicate refreshes the record and cleanup only deletes old content', async () => {
  const content = 'near expiry refresh';
  const first = await (await post(content, 'refresh.txt')).json();
  const key = new URL(first.data.url).pathname.split('/')[4];
  const old = await (await bucket.get(`index/${key}`)).json();
  const now = Math.floor(Date.now() / 1000);
  old.expireAt = now + 599;
  await bucket.put(`index/${key}`, JSON.stringify(old), { customMetadata: { expireAt: String(old.expireAt) } });
  await bucket.put(old.storageKey, content, { customMetadata: { expireAt: String(old.expireAt) } });
  const refreshed = await (await post(content, 'refresh.txt', { expires: '1' })).json();
  assert.equal(refreshed.code, 0);
  const updated = await (await bucket.get(`index/${key}`)).json();
  assert.notEqual(updated.storageKey, old.storageKey);
  assert.ok(updated.expireAt >= now + 3600);
  await cleanup(bucket, now + 600);
  assert.equal(await bucket.head(old.storageKey), null);
  assert.ok(await bucket.head(updated.storageKey));
  assert.equal((await send(refreshed.data.url)).status, 200);
});
test('truncated upload after a full R2 part does not publish a file', async () => {
  const before = (await bucket.list({ prefix: 'index/' })).objects.length;
  let sent = 0;
  const body = new ReadableStream({ pull(controller) {
    if (!sent) {
      controller.enqueue(new TextEncoder().encode('--broken\r\nContent-Disposition: form-data; name="file"; filename="broken.png"\r\n\r\n'));
      sent++; return;
    }
    if (sent > 97) return controller.close();
    const chunk = new Uint8Array(65536); if (sent === 1) chunk.set(png); sent++; controller.enqueue(chunk);
  } });
  const response = await send('https://broker.test/v1/upload', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=broken' }, body, duplex: 'half' });
  assert.equal((await response.json()).code, 40001);
  assert.equal((await bucket.list({ prefix: 'index/' })).objects.length, before);
  assert.equal((await bucket.list({ prefix: 'staging/' })).objects.length, 0);
});
test('missing underlying object is repaired rather than reusing a dead URL', async () => {
  const data = 'repair missing underlying object';
  const first = await (await post(data, 'repair.txt')).json();
  const key = new URL(first.data.url).pathname.split('/')[4];
  const old = await (await bucket.get(`index/${key}`)).json();
  await bucket.delete(old.storageKey);
  const result = await (await post(data, 'repair.txt')).json();
  assert.equal(result.code, 0);
  const updated = await (await bucket.get(`index/${key}`)).json();
  assert.notEqual(updated.storageKey, old.storageKey);
  assert.equal(await (await send(result.data.url)).text(), data);
});
function largeUpload(size) {
  const boundary = 'large-image-boundary';
  let sent = 0, phase = 0;
  const encoder = new TextEncoder();
  return new ReadableStream({ async pull(controller) {
    if (phase === 0) { controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`)); phase++; }
    else if (sent < size) {
      const chunk = new Uint8Array(Math.min(65536, size - sent));
      if (!sent) chunk.set(png); sent += chunk.length; controller.enqueue(chunk);
    } else if (phase === 1) {
      controller.enqueue(encoder.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n1782650347\r\n--${boundary}\r\nContent-Disposition: form-data; name="sign"\r\n\r\n${await hmac('upload-secret','1782650347')}\r\n--${boundary}--\r\n`)); phase++;
    } else controller.close();
  } });
}
test('50 MiB streaming upload round trip, then 50 MiB + 1 rejection', { timeout: 120000 }, async t => {
  const start = performance.now();
  const response = await send('https://broker.test/v1/upload', { method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=large-image-boundary' }, body: largeUpload(50 * MiB), duplex: 'half' });
  const result = await response.json(); assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.data.size, 50 * MiB);
  const record = await (await bucket.get(`index/${new URL(result.data.url).pathname.split('/')[4]}`)).json();
  assert.match(record.storageKey, /^objects\/uploads\//);
  const download = await send(result.data.url);
  const hasher = createHash('sha256'), xx = oracle.create32(); let count = 0;
  for await (const chunk of download.body) { count += chunk.length; hasher.update(chunk); xx.update(chunk); }
  assert.equal(count, 50 * MiB);
  const actualSha = hasher.digest('hex');
  const expectedSha = createHash('sha256');
  const sample = new Uint8Array(65536); sample.set(png);
  for (let offset = 0; offset < count; offset += sample.length) { expectedSha.update(sample); sample.fill(0); }
  assert.equal(actualSha, expectedSha.digest('hex'));
  assert.equal(algorithm === 'sha256' ? actualSha : `${xx.digest().toString(16).padStart(8, '0')}-${count}`, new URL(result.data.url).pathname.split('/')[4]);
  t.diagnostic(`Local 50 MiB upload/download wall time: ${Math.round(performance.now() - start)} ms; not production CPU time`);
  const excess = await send('https://broker.test/v1/upload', { method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=large-image-boundary' }, body: largeUpload(50 * MiB + 1), duplex: 'half' });
  assert.equal((await excess.json()).code, 40004);
  assert.equal((await bucket.list({ prefix: 'staging/' })).objects.length, 0);
});

test('deployment smoke validates upload, full duplicate metadata, download and build_time', async () => {
  const base = (await mf.ready).origin;
  // Use the actual listener as both upload origin and generated resource URL.
  await mf.setOptions(convertV4MiniflareOptions({ port: Number(new URL(base).port), workers: [{ name: 'broker', modules: true, scriptPath: 'deploy/dist/worker.js', compatibilityDate: '2026-10-10', r2Buckets: ['bucket'],
    bindings: { base_url: base, url_blake2b_salts: ['test-salt'], hmac_secret: 'upload-secret', build_time: '2026-10-11T01:02:03.456Z', content_hash: algorithm } }] }));
  assert.equal((await smoke({ base, settings: { vars: { hmac_secret: 'upload-secret' } }, expectedTime: '2026-10-11T01:02:03.456Z' })).status, 'passed');
});

});
