import test from 'node:test';
import assert from 'node:assert/strict';
import { multipart } from '../src/multipart.js';
import { detect, validateExtension } from '../src/mime.js';
import { token, hmac } from '../src/hash.js';
import { config } from '../src/config.js';
const encoder = new TextEncoder();
function request(bytes, chunkSize, contentType = 'multipart/form-data; boundary="edge-boundary"') {
  let offset = 0;
  return new Request('http://localhost/v1/upload', { method: 'POST', headers: { 'content-type': contentType }, duplex: 'half',
    body: new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += Math.min(chunkSize, bytes.length - offset)));
    } }) });
}
test('multipart is correct across every split, including boundary-like file content', async () => {
  const content = 'hello\r\n--edge-boundaryX!inside\r\nworld';
  const bytes = encoder.encode(`--edge-boundary\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n${content}\r\n--edge-boundary\r\nContent-Disposition: form-data; name="expires"\r\n\r\n3\r\n--edge-boundary--\r\n`);
  for (const size of [1, 2, 3, 7, 16, 31, 64, 65536]) {
    const parts = []; let chunks;
    await multipart(request(bytes, size), 10000, {
      start(header) { chunks = []; parts.push({ ...header, chunks }); },
      data(bytes) { chunks.push(Buffer.from(bytes)); }, end() {}
    });
    assert.equal(parts[0].filename, 'a.txt');
    assert.equal(Buffer.concat(parts[0].chunks).toString(), content);
    assert.equal(Buffer.concat(parts[1].chunks).toString(), '3');
  }
});
test('truncated bodies, oversized headers and total size are rejected', async () => {
  const handlers = { start() {}, data() {}, end() {} };
  await assert.rejects(multipart(request(encoder.encode('--edge-boundary\r\n'), 1), 10000, handlers), { code: 40001 });
  await assert.rejects(multipart(request(encoder.encode('--edge-boundary\r\n' + 'a'.repeat(9000)), 64), 10000, handlers), { code: 40001 });
  await assert.rejects(multipart(request(encoder.encode('x'.repeat(50)), 50), 10, handlers), { code: 40004 });
});
test('MIME sniffing and extension validation preserve text types and reject active content', () => {
  assert.equal(detect('a.png', Uint8Array.of(137,80,78,71,13,10,26,10)).mimeType, 'image/png');
  for (const [filename, mime] of [['a.md','text/markdown'], ['a.go','text/x-go'], ['a.yaml','application/yaml'], ['a.unknown','text/plain']]) {
    assert.equal(detect(filename, encoder.encode('plain text')).mimeType, mime);
  }
  for (const ext of ['html','svg','xml','htm']) assert.equal(detect(`x.${ext}`, encoder.encode('plain text')), null);
  assert.equal(detect('x.txt', encoder.encode('<html>evil</html>')), null);
  assert.equal(detect('x.bin', Uint8Array.of(0,1,2)), null);
  assert.equal(validateExtension('a.jpg', 'image/png'), false);
  assert.equal(validateExtension('a.unknown', 'image/png'), true);
});
test('hash and token compatibility vectors', async () => {
  assert.equal(await hmac('my-secret', '1782650347'), '85838a8a71a08aa37d2d9ba32df7f54af36d455fb042ea06f28be68272187852');
  // Independently generated with Python hashlib.blake2b(digest_size=32).
  assert.equal(token('test-salt', 'abcdef1234567890'.repeat(4), 1782650347), '60117b2268e36a0a');
});
test('configuration rejects invalid sizes, salts and prefixes', () => {
  for (const env of [{ limit_image_mib: '0' }, { url_blake2b_salts: '["a","b","c"]' }, { url_prefix: '../tmp' }, { content_hash: 'unknown' }, { cors: 'false' }]) {
    assert.throws(() => config({ base_url: 'https://example.com', ...env }));
  }
});
test('lowercase config supports JSON numbers, booleans and key arrays', () => {
  const cfg = config({ base_url: 'https://example.com', default_ttl_hours: 3, limit_image_mib: 50,
    cors: false, url_blake2b_salts: ['current', 'old'], hmac_secret: 'test', content_hash: 'xxhash32' });
  assert.equal(cfg.ttl, 10800); assert.equal(cfg.cors, false); assert.deepEqual(cfg.salts, ['current', 'old']);
  assert.equal(cfg.contentHash, 'xxhash32'); assert.equal(cfg.hmac, 'test');
});
