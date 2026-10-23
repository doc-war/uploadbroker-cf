import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, constants } from 'node:http2';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import worker from '../src/worker.js';
import { config } from '../src/config.js';
import { hmac, token } from '../src/hash.js';
import { XXHash32 } from '../src/xxhash32.js';

const text = new TextEncoder().encode('fast upload content');
const hash = bytes => { const value = new XXHash32(); value.update(bytes); return value.digest(); };
const hashValue = hash(text), key = `${hashValue}-${text.length}`;

function fixture({ exists = true, ttl = 3600, secret = '' } = {}) {
  const env = { base_url: 'https://broker.test', url_blake2b_salts: ['salt'], hmac_secret: secret };
  const record = { key, contentHash: 'xxhash32', category: 'document', size: text.length,
    mimeType: 'text/plain', extension: '.txt', expireAt: Math.floor(Date.now() / 1000) + ttl, storageKey: 'objects/existing' };
  const stored = new Map(exists ? [[`index/${key}`, JSON.stringify(record)], [record.storageKey, text]] : []);
  const calls = { get: 0, head: 0, put: 0, multipart: 0, abort: 0, reads: 0 };
  const bucket = {
    async get(path) { calls.get++; const value = stored.get(path); return value === undefined ? null : { etag: 'etag', async json() { return JSON.parse(value); } }; },
    async head(path) { calls.head++; return stored.has(path) ? {} : null; },
    async put(path, value) { calls.put++; stored.set(path, typeof value === 'string' ? value : value.slice()); return { etag: 'new-etag' }; },
    async delete(path) { stored.delete(path); },
    async createMultipartUpload() {
      calls.multipart++;
      return { async uploadPart(partNumber) { return { partNumber, etag: String(partNumber) }; },
        async abort() { calls.abort++; }, async complete() { throw new Error('invalid upload must not complete'); } };
    }
  };
  env.bucket = bucket;
  function request({ headers = {}, protocol = 'HTTP/2', bytes, fields = {}, declaredHash = hashValue, declaredSize = text.length } = {}) {
    const extra = new Headers(headers);
    if (declaredHash !== null) extra.set('X-UploadBroker-Hash', declaredHash);
    if (declaredSize !== null) extra.set('X-UploadBroker-Size', String(declaredSize));
    let body;
    if (bytes !== undefined) {
      const form = new FormData(); form.set('file', new Blob([bytes]), 'file.txt');
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      const serialized = new Request(env.base_url, { method: 'POST', body: form });
      extra.set('content-type', serialized.headers.get('content-type')); body = serialized.body;
    } else {
      extra.set('content-type', 'multipart/form-data; boundary=unfinished');
      body = new ReadableStream({ pull() { calls.reads++; throw new Error('body must not be read'); } }, { highWaterMark: 0 });
    }
    const req = new Request(`${env.base_url}/v1/upload`, { method: 'POST', headers: extra, body, duplex: 'half' });
    Object.defineProperty(req, 'cf', { value: { httpProtocol: protocol } });
    return req;
  }
  return { env, record, stored, calls, request, send: options => worker.fetch(request(options), env) };
}

test('header hit returns original metadata without reading or writing any upload body', async () => {
  const f = fixture();
  const response = await f.send({ headers: { 'X-UploadBroker-Expires': '24' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-uploadbroker-dedup'), 'HIT');
  const result = await response.json();
  assert.equal(result.data.size, text.length); assert.equal(result.data.mimeType, 'text/plain');
  assert.equal(Date.parse(result.data.expireAt) / 1000, f.record.expireAt, 'hit never renews TTL');
  assert.deepEqual(f.calls, { get: 1, head: 1, put: 0, multipart: 0, abort: 0, reads: 0 });
});

test('HTTP/3 also accepts header hits', async () => {
  const response = await fixture().send({ protocol: 'HTTP/3' });
  assert.equal(response.headers.get('x-uploadbroker-dedup'), 'HIT');
});

test('hash miss falls through the original multipart upload and verifies the declared key', async () => {
  const f = fixture({ exists: false });
  const response = await f.send({ bytes: text });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-uploadbroker-dedup'), 'MISS');
  assert.equal((await response.json()).code, 0);
  assert.equal(JSON.parse(f.stored.get(`index/${key}`)).key, key);
  assert.equal(f.calls.put, 2);
});

test('early authentication is mandatory and runs before any lookup or body read', async () => {
  for (const headers of [{}, { 'X-UploadBroker-Timestamp': '123', 'X-UploadBroker-Sign': 'wrong' }]) {
    const f = fixture({ secret: 'secret' }); const response = await f.send({ headers });
    assert.equal((await response.json()).code, 50000);
    assert.equal(f.calls.get, 0); assert.equal(f.calls.reads, 0);
  }
  const f = fixture({ secret: 'secret' });
  assert.equal((await f.send({ headers: { 'X-UploadBroker-Timestamp': '123', 'X-UploadBroker-Sign': await hmac('secret', '123') } })).status, 200);
});

test('header controls remain authoritative on a miss with conflicting trailing form fields', async () => {
  const f = fixture({ exists: false, secret: 'secret' });
  const response = await f.send({ bytes: text, headers: { 'X-UploadBroker-Expires': '1', 'X-UploadBroker-Timestamp': '123',
    'X-UploadBroker-Sign': await hmac('secret', '123') }, fields: { expires: '25', timestamp: 'bad', sign: 'bad' } });
  assert.equal((await response.json()).code, 0);
  const record = JSON.parse(f.stored.get(`index/${key}`)); assert.equal(record.expireAt - record.createdAt, 3600);
});

test('fast upload freezes the default TTL before trailing multipart fields', async () => {
  const f = fixture({ exists: false });
  const response = await f.send({ bytes: text, fields: { expires: '1' } });
  assert.equal((await response.json()).code, 0);
  const record = JSON.parse(f.stored.get(`index/${key}`)); assert.equal(record.expireAt - record.createdAt, 86400);
});

test('HTTP/1, missing protocol metadata and spoofed protocol headers cannot enable fast upload', async () => {
  for (const protocol of ['HTTP/1.0', 'HTTP/1.1', undefined, 'HTTP/4']) {
    const f = fixture(), req = f.request({ headers: { 'X-Forwarded-Proto': 'HTTP/2' } });
    req.cf.httpProtocol = protocol;
    const response = await worker.fetch(req, f.env);
    assert.equal((await response.json()).code, 40001); assert.equal(f.calls.get, 0); assert.equal(f.calls.reads, 0);
  }
});

test('malformed and incomplete hash/size headers fail before body consumption', async () => {
  for (const [declaredHash, declaredSize] of [[null, 1], ['abc', 1], ['ABCDEF12', 1], ['0xabcdef12', 1],
    [hashValue, null], [hashValue, 0], [hashValue, -1], [hashValue, '01'], [hashValue, '1.2'], [hashValue, '9007199254740992']]) {
    const f = fixture(), response = await f.send({ declaredHash, declaredSize });
    assert.equal((await response.json()).code, 40001); assert.equal(f.calls.get, 0); assert.equal(f.calls.reads, 0);
  }
});

test('oversized declarations and invalid early TTL never return an existing resource', async () => {
  for (const options of [{ declaredSize: 51 * 1024 * 1024 }, { headers: { 'X-UploadBroker-Expires': '25' } }]) {
    const f = fixture(), response = await f.send(options);
    assert.equal((await response.json()).code, options.declaredSize ? 40004 : 40005);
    assert.equal(f.calls.get, 0); assert.equal(f.calls.reads, 0);
  }
});

test('a resource exceeding its current category limit cannot be reused early', async () => {
  const f = fixture(); f.env.limit_document_mib = 1;
  f.record.size = 2 * 1024 * 1024;
  const largeKey = `${hashValue}-${f.record.size}`;
  f.stored.set(`index/${largeKey}`, JSON.stringify(f.record));
  assert.equal((await (await f.send({ declaredSize: f.record.size })).json()).code, 40004);
  assert.equal(f.calls.reads, 0);
});

test('less than 600 seconds remaining triggers normal upload rather than early reuse', async () => {
  const f = fixture({ ttl: 599 }), oldStorageKey = f.record.storageKey;
  const response = await f.send({ bytes: text });
  assert.equal(response.headers.get('x-uploadbroker-dedup'), 'MISS'); assert.equal((await response.json()).code, 0);
  assert.notEqual(JSON.parse(f.stored.get(`index/${key}`)).storageKey, oldStorageKey);
});

test('exactly 600 seconds remaining meets the existing reuse threshold', async () => {
  const f = fixture({ ttl: 600 }), originalNow = Date.now;
  try {
    Date.now = () => (f.record.expireAt - 600) * 1000;
    assert.equal((await f.send()).headers.get('x-uploadbroker-dedup'), 'HIT');
  } finally { Date.now = originalNow; }
});

test('a missing object cannot produce an early hit and is repaired through upload', async () => {
  const f = fixture(); f.stored.delete(f.record.storageKey);
  const response = await f.send({ bytes: text });
  assert.equal(response.headers.get('x-uploadbroker-dedup'), 'MISS'); assert.equal((await response.json()).code, 0);
  assert.ok(f.stored.has(JSON.parse(f.stored.get(`index/${key}`)).storageKey));
});

test('declared size mismatch and hash mismatch cannot publish small files', async () => {
  for (const options of [{ declaredHash: hashValue === '00000000' ? '11111111' : '00000000' }, { declaredSize: text.length + 1 }]) {
    const f = fixture({ exists: false }), response = await f.send({ bytes: text, ...options });
    assert.equal((await response.json()).code, 40001); assert.equal(f.calls.put, 0); assert.equal(f.stored.size, 0);
  }
});

test('a mismatch after uploading multipart parts aborts without completing or publishing', async () => {
  const bytes = new Uint8Array(6 * 1024 * 1024).fill(65), f = fixture({ exists: false });
  f.env.limit_document_mib = 10;
  const response = await f.send({ bytes, declaredSize: bytes.length, declaredHash: hash(bytes) === '00000000' ? '11111111' : '00000000' });
  assert.equal((await response.json()).code, 40001);
  assert.equal(f.calls.multipart, 1); assert.equal(f.calls.abort, 1); assert.equal(f.calls.put, 0);
});

test('lookup failure returns a storage error without reading the file', async () => {
  const f = fixture(); f.env.bucket.get = async () => { throw new Error('storage offline'); };
  assert.equal((await (await f.send()).json()).code, 50001); assert.equal(f.calls.reads, 0);
});

test('content hashing is fixed to XXH32; SHA-256 configuration is rejected', () => {
  assert.equal(config({ base_url: 'https://broker.test' }).contentHash, 'xxhash32');
  assert.throws(() => config({ base_url: 'https://broker.test', content_hash: 'sha256' }), /xxhash32/);
});

test('old signed SHA-256 URLs are rejected before R2 or cached content can be read', async () => {
  const f = fixture(), oldKey = 'a'.repeat(64), expiry = Math.floor(Date.now() / 1000) + 3600;
  const url = `${f.env.base_url}/tmp/${expiry}/aa/${oldKey}/${token('salt', oldKey, expiry)}.txt`;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches'); let cacheReads = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: { match() { cacheReads++; throw new Error('must not read old cache'); } } } });
  try {
    assert.equal((await (await worker.fetch(new Request(url), f.env)).json()).code, 40401);
    assert.equal(f.calls.get, 0); assert.equal(cacheReads, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'caches', descriptor); else delete globalThis.caches;
  }
});

test('a real HTTP/2 client receives a full success while its upload stream is still open', { timeout: 10000 }, async () => {
  const f = fixture(), server = createServer();
  server.on('stream', (stream, headers) => {
    (async () => {
      const req = new Request(`${f.env.base_url}/v1/upload`, { method: 'POST',
        headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(':'))),
        body: Readable.toWeb(stream), duplex: 'half' });
      Object.defineProperty(req, 'cf', { value: { httpProtocol: 'HTTP/2' } });
      const response = await worker.fetch(req, f.env);
      stream.respond({ ':status': response.status, ...Object.fromEntries(response.headers) });
      stream.end(await response.text());
    })().catch(error => stream.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connect(`http://127.0.0.1:${server.address().port}`);
  let req;
  try {
    req = client.request({ ':method': 'POST', ':path': '/v1/upload', 'content-type': 'multipart/form-data; boundary=slow',
      'x-uploadbroker-hash': hashValue, 'x-uploadbroker-size': String(text.length) });
    req.write('--slow\r\n'); // Deliberately do not send the file or finish the request.
    const response = await new Promise((resolve, reject) => {
      let body = '', headers; req.on('response', value => { headers = value; });
      req.setEncoding('utf8'); req.on('data', value => { body += value; });
      req.on('end', () => resolve({ headers, body })); req.on('error', reject);
    });
    assert.equal(response.headers[':status'], 200); assert.equal(response.headers['x-uploadbroker-dedup'], 'HIT');
    assert.equal(JSON.parse(response.body).code, 0); assert.equal(req.writableEnded, false);
    assert.equal(f.calls.put, 0);
  } finally {
    req?.close(constants.NGHTTP2_CANCEL); client.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
