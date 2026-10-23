import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomFillSync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readConfig } from './config.mjs';
import reference from 'xxhash-wasm';

const rounds = Number(process.argv[2] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('rounds must be 1-10');
await mkdir('bench-results', { recursive: true });
await build({ entryPoints: ['scripts/benchmark-worker.js'], outfile: 'bench-results/hash-worker.js', bundle: true, format: 'esm', platform: 'browser' });
const settings = await readConfig('wrangler.example.jsonc');
const workers = [{ name: 'hash', routes: ['hash.bench/*'], modules: true, scriptPath: 'bench-results/hash-worker.js', compatibilityDate: settings.compatibility_date },
  ...['xxhash32'].map(algorithm => ({ name: `upload-${algorithm}`, routes: [`${algorithm}.bench/*`], modules: true, scriptPath: 'deploy/dist/worker.js',
    compatibilityDate: settings.compatibility_date, r2Buckets: { bucket: `bench-${algorithm}` },
    bindings: { ...settings.vars, base_url: `https://${algorithm}.bench`, content_hash: algorithm, url_blake2b_salts: ['benchmark-only'], hmac_secret: '' } }))];
const mf = new Miniflare(convertV4MiniflareOptions({ workers, inspectorPort: 0 }));
const oracle = await reference();
let sequence = 0;
function stream(bytes, multipart = false) {
  let offset = 0, state = 0;
  const encoder = new TextEncoder();
  return new ReadableStream({ pull(controller) {
    if (multipart && state === 0) { state = 1; controller.enqueue(encoder.encode('--bench-boundary\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\n\r\n')); }
    else if (offset < bytes.length) { const end = Math.min(offset + 65536, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end; }
    else if (multipart && state === 1) { state = 2; controller.enqueue(encoder.encode('\r\n--bench-boundary--\r\n')); }
    else controller.close();
  } });
}
class Inspector {
  constructor(url) {
    this.socket = new WebSocket(url); this.pending = new Map(); this.next = 0;
    this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); });
    this.socket.addEventListener('message', event => {
      const response = JSON.parse(event.data); const pending = this.pending.get(response.id);
      if (pending) { this.pending.delete(response.id); clearTimeout(pending.timer); response.error ? pending.reject(new Error(JSON.stringify(response.error))) : pending.resolve(response.result); }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}
const rows = [];
try {
  const inspectorURL = await mf.getInspectorURL();
  inspectorURL.protocol = inspectorURL.protocol === 'wss:' ? 'https:' : 'http:';
  const targets = await (await fetch(new URL('/json/list', inspectorURL))).json();
  console.log('Inspector targets:', targets.map(target => ({ id: target.id, title: target.title })));
  const sessions = new Map();
  for (const worker of workers) {
    const target = targets.find(target => target.title === worker.name || target.id === worker.name || target.id.endsWith(`:${worker.name}`) || target.title.endsWith(`:${worker.name}`));
    if (!target) throw new Error(`No inspector target for ${worker.name}`);
    const session = new Inspector(target.webSocketDebuggerUrl); sessions.set(worker.name, session);
    await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 100 });
  }
  async function measure(stage, algorithm, bytes, round) {
    const isHash = stage !== 'upload';
    if (stage === 'compute') {
      const preparation = await mf.dispatchFetch('https://hash.bench/prepare', { method: 'POST', headers: { connection: 'close' }, body: stream(bytes), duplex: 'half' });
      assert.equal(await preparation.text(), 'ready');
    }
    const session = sessions.get(isHash ? 'hash' : `upload-${algorithm}`);
    await session.send('Profiler.start'); const start = performance.now();
    let result;
    try {
      const response = await mf.dispatchFetch(isHash ? `https://hash.bench/${stage === 'compute' ? 'compute' : ''}` : `https://${algorithm}.bench/v1/upload`, {
        method: 'POST', headers: isHash ? { 'x-algorithm': algorithm, connection: 'close' } : { 'content-type': 'multipart/form-data; boundary=bench-boundary', connection: 'close' },
        body: stage === 'compute' ? undefined : stream(bytes, stage === 'upload'), duplex: 'half'
      });
      result = await response.json();
      if (stage === 'upload') assert.equal(result.code, 0, JSON.stringify(result));
    } finally {
      const wallMs = performance.now() - start;
      const { profile } = await session.send('Profiler.stop');
      const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
      let activeUs = 0, hashJsUs = 0, idleUs = 0;
      for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
        const frame = nodes.get(profile.samples[i]); const delta = profile.timeDeltas?.[i] ?? 0;
        if (frame?.functionName === '(idle)') idleUs += delta;
        else { activeUs += delta; if (frame?.url?.includes('worker.js') && ['update', 'round', 'rotl', 'digest'].includes(frame.functionName)) hashJsUs += delta; }
      }
      const row = { stage, algorithm, sizeMiB: bytes.length / 1048576, round, repetitions: stage === 'compute' ? 5 : 1, wallMs: Math.round(wallMs * 100) / 100,
        sampledActiveMs: Math.round(activeUs / 10) / 100, sampledIdleMs: Math.round(idleUs / 10) / 100, sampledHashJsMs: Math.round(hashJsUs / 10) / 100 };
      rows.push(row); console.log(JSON.stringify(row));
      await writeFile(`bench-results/${stage}-${algorithm}-${bytes.length}-${round}.cpuprofile`, JSON.stringify(profile));
    }
    // Reference digest generation is outside both timing and Worker profiling.
    const key = isHash ? result.key : new URL(result.data.url).pathname.split('/')[4];
    const expected = algorithm === 'sha256' ? createHash('sha256').update(bytes).digest('hex') : `${oracle.h32Raw(bytes).toString(16).padStart(8, '0')}-${bytes.length}`;
    assert.equal(key, expected);
  }
  // Warm the exact functions/runtimes before measured cases.
  const warm = randomFillSync(new Uint8Array(65536)); warm.set([137,80,78,71,13,10,26,10]);
  for (let i = 0; i < 3; i++) for (const stage of ['compute', 'hash', 'upload']) for (const algorithm of ['sha256','xxhash32']) {
    if (stage !== 'upload' || algorithm === 'xxhash32') await measure(stage, algorithm, warm, -1 - i);
  }
  rows.length = 0;
  for (const size of [1,10,50]) for (let round = 0; round < rounds; round++) {
    const bytes = randomFillSync(new Uint8Array(size * 1048576)); bytes.set([137,80,78,71,13,10,26,10]);
    new DataView(bytes.buffer).setUint32(32, sequence++);
    const order = round % 2 ? ['xxhash32','sha256'] : ['sha256','xxhash32'];
    for (const stage of ['compute','hash','upload']) for (const algorithm of order) {
      if (stage !== 'upload' || algorithm === 'xxhash32') await measure(stage, algorithm, bytes, round);
    }
  }
  await writeFile('bench-results/results.json', JSON.stringify({ rounds, rows,
    note: 'V8 sampled activity estimates, not Cloudflare billed CPU. Native/asynchronous work and sampling noise limit interpretation. Wall time includes local R2/network.' }, null, 2));
  for (const session of sessions.values()) session.close();
} finally { await mf.dispose(); }
