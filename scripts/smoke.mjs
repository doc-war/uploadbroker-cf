import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash, createHmac, randomFillSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { readConfig } from './config.mjs';

export async function smoke({ base, file, sizeMiB = 1, settings, expectedTime }) {
base = base?.replace(/\/+$/, '');
if (!base || !/^https?:\/\//.test(base)) throw new Error('Provide a valid base URL');
const size = file ? (await stat(file)).size : Number(sizeMiB) * 1024 * 1024;
if (!Number.isInteger(size) || size < 100 || size > 50 * 1024 * 1024) throw new Error('size must be between 100 bytes and 50 MiB');
const filename = file ? basename(file) : 'smoke.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=', 'base64');
const padding = randomFillSync(Buffer.alloc(65536));
async function* content() {
  if (file) { yield* createReadStream(file, { highWaterMark: 65536 }); return; }
  yield png;
  for (let sent = png.length; sent < size;) {
    const chunk = padding.subarray(0, Math.min(65536, size - sent)); sent += chunk.length; yield chunk;
  }
}
async function send() {
  const boundary = `broker-smoke-${Date.now()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = settings.vars?.hmac_secret;
  const digest = createHash('sha256');
  async function* body() {
    yield `--${boundary}\r\nContent-Disposition: form-data; name="expires"\r\n\r\n1\r\n`;
    if (secret) {
      const sign = createHmac('sha256', secret).update(timestamp).digest('hex');
      for (const [name, value] of [['timestamp', timestamp], ['sign', sign]]) yield `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    const safeName = filename.replace(/["\r\n\\]/g, '_');
    yield `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    for await (const chunk of content()) { digest.update(chunk); yield chunk; }
    yield `\r\n--${boundary}--\r\n`;
  }
  const start = performance.now();
  const response = await fetch(`${base}/v1/upload`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Readable.toWeb(Readable.from(body())), duplex: 'half', signal: AbortSignal.timeout(180000) });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error(`HTTP ${response.status}: upload returned a non-JSON response: ${text.slice(0, 300)}`); }
  assert.equal(response.status, 200);
  assert.equal(result.code, 0, `HTTP ${response.status}: ${JSON.stringify(result)}`);
  assert.equal(result.data.size, size);
  return { data: result.data, hash: digest.digest('hex'), wallMs: Math.round(performance.now() - start) };
}
const first = await send();
const second = await send();
assert.deepEqual(second.data, first.data, 'duplicate upload must reuse URL and metadata');
assert.equal(new URL(first.data.url).origin, new URL(base).origin, 'download URL must stay on the configured origin');
const downloads = [];
for (let attempt = 0; attempt < 2; attempt++) {
  const start = performance.now();
  const download = await fetch(first.data.url, { signal: AbortSignal.timeout(180000) });
  const headersMs = Math.round(performance.now() - start);
  assert.equal(download.status, 200);
  const digest = createHash('sha256'); let downloaded = 0;
  for await (const chunk of download.body) { digest.update(chunk); downloaded += chunk.length; }
  assert.equal(downloaded, size); assert.equal(digest.digest('hex'), first.hash);
  downloads.push({ headersMs, wallMs: Math.round(performance.now() - start),
    cache: download.headers.get('x-uploadbroker-cache') ?? 'unknown' });
}
const healthResponse = await fetch(`${base}/v1/health?deployment=${encodeURIComponent(expectedTime ?? Date.now())}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.status, 'ok'); assert.equal(health.storage, 'ok');
if (expectedTime) assert.equal(health.time, expectedTime, 'deployment build_time must still match after business acceptance');
return { status: 'passed', bytes: size, firstUploadWallMs: first.wallMs, duplicateUploadWallMs: second.wallMs,
  downloads, downloadSHA256: first.hash, health: health.status,
  note: 'Wall time is not Worker CPU time. Cache hits are best effort. Inspect Cloudflare invocation CPU metrics.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const result = await smoke({ base: option('--base-url'), file: option('--file'), sizeMiB: option('--size-mib') ?? 1,
    settings: await readConfig(option('--config') ?? 'deploy/wrangler.jsonc'), expectedTime: option('--expect-build-time') });
  console.log(JSON.stringify(result, null, 2));
}
