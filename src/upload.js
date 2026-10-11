import { BrokerError } from './errors.js';
import { multipart } from './multipart.js';
import { detect, validateExtension } from './mime.js';
import { newContentHasher, hmac, equal, responseData } from './hash.js';
import { UploadedFile, commit, lookup, reusable } from './storage.js';

export async function upload(request, bucket, cfg) {
  const file = new UploadedFile(bucket), hasher = newContentHasher(cfg.contentHash);
  const fields = new URL(request.url).searchParams;
  let mode, field, fieldChunks, fieldSize, filename, seenFile = false, size = 0, type;
  let head = new Uint8Array(0);
  const inspect = () => {
    if (type) return;
    type = detect(filename, head);
    if (!type) throw new BrokerError(40003, 'unsupported mime');
    if (!validateExtension(filename, type.mimeType)) throw new BrokerError(40006, `mime mismatch: declared extension does not match ${type.mimeType}`);
  };
  const consume = async bytes => {
    size += bytes.length;
    if (size > Math.max(...Object.values(cfg.limits))) throw new BrokerError(40004, 'file too large');
    await hasher.update(bytes);
    if (head.length < 512) {
      const take = bytes.subarray(0, 512 - head.length);
      const next = new Uint8Array(head.length + take.length); next.set(head); next.set(take, head.length); head = next;
    }
    if (head.length === 512) inspect();
    if (type && size > cfg.limits[type.category]) throw new BrokerError(40004, `max size ${cfg.limits[type.category]} bytes`);
    file.contentType = type?.mimeType;
    try { await file.write(bytes); } catch { throw new BrokerError(50001, 'storage upload failed'); }
  };
  try {
    await multipart(request, cfg.maxBody, {
      async start(part) {
        mode = 'ignore';
        if (part.filename !== undefined && part.filename !== '' && part.name === 'file' && !seenFile) {
          seenFile = true; filename = part.filename.split(/[\\/]/).pop(); mode = 'file';
        } else if (part.filename === undefined) {
          mode = 'field'; field = part.name; fieldChunks = []; fieldSize = 0;
        }
      },
      async data(bytes) {
        if (mode === 'file') await consume(bytes);
        else if (mode === 'field') {
          fieldSize += bytes.length;
          if (fieldSize > 4096) throw new BrokerError(40001, 'form field too large');
          fieldChunks.push(bytes.slice());
        }
      },
      async end() {
        if (mode === 'file') {
          if (!size) throw new BrokerError(40002, 'empty file');
          inspect();
          if (size > cfg.limits[type.category]) throw new BrokerError(40004, `max size ${cfg.limits[type.category]} bytes`);
        } else if (mode === 'field' && !fields.has(field)) {
          const value = new Uint8Array(fieldSize); let offset = 0;
          for (const chunk of fieldChunks) { value.set(chunk, offset); offset += chunk.length; }
          fields.set(field, new TextDecoder().decode(value));
        }
      }
    });
    if (cfg.hmac) {
      if (!fields.get('sign') || !fields.get('timestamp')) throw new BrokerError(50000, 'missing sign or timestamp');
      if (!equal(await hmac(cfg.hmac, fields.get('timestamp')), fields.get('sign'))) throw new BrokerError(50000, 'invalid sign');
    }
    if (!seenFile) throw new BrokerError(40001, 'missing file');
    let ttl = cfg.ttl;
    if (fields.get('expires')) {
      const hours = fields.get('expires');
      if (!/^[+-]?\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 24) throw new BrokerError(40005, 'expires 1-24');
      ttl = Number(hours) * 3600;
    }
    const now = Math.floor(Date.now() / 1000);
    const record = { key: await hasher.digest(), contentHash: cfg.contentHash, ...type, size, createdAt: now, expireAt: now + ttl };
    try {
      const entry = await lookup(bucket, record.key);
      const existing = await reusable(bucket, entry, now, record.size);
      if (existing) return Response.json({ code: 0, data: responseData(cfg, existing) });
      return Response.json({ code: 0, data: responseData(cfg, await commit(bucket, file, record, now, entry)) });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(50001, 'storage write failed');
    }
  } finally {
    await hasher.abort();
    await file.dispose().catch(error => console.error('upload cleanup failed', error.message));
  }
}
