import { BrokerError } from './errors.js';
import { multipart } from './multipart.js';
import { detect, validateExtension } from './mime.js';
import { newContentHasher, responseData } from './hash.js';
import { UploadedFile, commit, lookup, reusable } from './storage.js';
import { uploadOptions, authorizeUpload, uploadTTL } from './upload-options.js';

export async function upload(request, bucket, cfg) {
  const { fields, hint } = uploadOptions(request, cfg);
  if (hint) {
    await authorizeUpload(fields, cfg);
    uploadTTL(fields, cfg);
    try {
      const entry = await lookup(bucket, hint.key);
      if (entry && entry.record.size > cfg.limits[entry.record.category]) throw new BrokerError(40004, 'file too large');
      const existing = await reusable(bucket, entry, Math.floor(Date.now() / 1000), hint.size);
      if (existing) return Response.json({ code: 0, data: responseData(cfg, existing) }, {
        headers: { 'X-UploadBroker-Dedup': 'HIT', 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(50001, 'storage lookup failed');
    }
  }
  const file = new UploadedFile(bucket), hasher = newContentHasher();
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
    await authorizeUpload(fields, cfg);
    if (!seenFile) throw new BrokerError(40001, 'missing file');
    const ttl = uploadTTL(fields, cfg);
    const now = Math.floor(Date.now() / 1000);
    const record = { key: await hasher.digest(), contentHash: cfg.contentHash, ...type, size, createdAt: now, expireAt: now + ttl };
    if (hint && (record.key !== hint.key || size !== hint.size)) throw new BrokerError(40001, 'declared hash or size does not match file');
    try {
      const entry = await lookup(bucket, record.key);
      const existing = await reusable(bucket, entry, now, record.size);
      const result = existing ?? await commit(bucket, file, record, now, entry);
      return Response.json({ code: 0, data: responseData(cfg, result) }, hint ? {
        headers: { 'X-UploadBroker-Dedup': 'MISS', 'Cache-Control': 'no-store' }
      } : undefined);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(50001, 'storage write failed');
    }
  } finally {
    await hasher.abort();
    await file.dispose().catch(error => console.error('upload cleanup failed', error.message));
  }
}
