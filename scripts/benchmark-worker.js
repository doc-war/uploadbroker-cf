import { newContentHasher as newXXHasher, hex } from '../src/hash.js';
// SHA-256 remains only as a benchmark reference, not a production content algorithm.
function newContentHasher(algorithm) {
  if (algorithm === 'xxhash32') return newXXHasher();
  const stream = new crypto.DigestStream('SHA-256'), writer = stream.getWriter();
  stream.digest.catch(() => {});
  return { update: bytes => writer.write(bytes),
    async digest() { await writer.close(); return hex(new Uint8Array(await stream.digest)); },
    async abort() { await writer.abort().catch(() => {}); } };
}
// Benchmark-only cache isolates hashing from client I/O. Production uploads remain streaming.
let cached;
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/prepare') { cached = new Uint8Array(await request.arrayBuffer()); return new Response('ready'); }
    const algorithm = request.headers.get('x-algorithm');
    if (!['sha256', 'xxhash32'].includes(algorithm)) return new Response('invalid algorithm', { status: 400 });
    if (path === '/compute') {
      if (!cached) return new Response('prepare first', { status: 400 });
      let key;
      for (let repeat = 0; repeat < 5; repeat++) {
        const hash = newContentHasher(algorithm);
        try {
          for (let offset = 0; offset < cached.length; offset += 65536) await hash.update(cached.subarray(offset, offset + 65536));
          key = await hash.digest();
        } finally { await hash.abort(); }
      }
      return Response.json({ algorithm, size: cached.length, key });
    }
    const hash = newContentHasher(algorithm);
    let size = 0;
    try {
      for await (const bytes of request.body) { size += bytes.length; await hash.update(bytes); }
      return Response.json({ algorithm, size, key: await hash.digest() });
    } finally { await hash.abort(); }
  }
};
