import { MiB } from './config.js';
import { BrokerError } from './errors.js';
export const PART_SIZE = 5 * MiB;
export const INDEX = 'index/';
export const OBJECTS = 'objects/';
export const STAGING = 'staging/';

// Keep one part in memory. Small duplicates never write a file to R2;
// larger files upload directly to an immutable object, with at most two parts in flight.
export class UploadedFile {
  constructor(bucket) {
    this.bucket = bucket; this.key = null;
    this.buffer = null; this.used = 0; this.parts = []; this.pending = [];
    this.upload = null; this.completed = false; this.keep = false; this.error = null;
  }
  async write(bytes) {
    if (this.error) throw this.error;
    let offset = 0;
    while (offset < bytes.length) {
      // Delay the first flush until the file actually exceeds one full part.
      if (this.used === PART_SIZE) await this.flush();
      this.buffer ??= new Uint8Array(PART_SIZE);
      const take = Math.min(PART_SIZE - this.used, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.used);
      this.used += take; offset += take;
    }
  }
  async flush() {
    if (!this.used) return;
    if (this.error) throw this.error;
    if (!this.upload) {
      this.key = `${OBJECTS}uploads/${crypto.randomUUID()}`;
      this.upload = await this.bucket.createMultipartUpload(this.key, {
        httpMetadata: { contentType: this.contentType ?? 'application/octet-stream' },
        customMetadata: { directUpload: 'true' }
      });
    }
    const bytes = this.buffer.subarray(0, this.used), number = this.parts.length + 1;
    this.parts.push(null); this.buffer = null; this.used = 0;
    const task = this.upload.uploadPart(number, bytes)
      .then(part => { this.parts[number - 1] = part; })
      .catch(error => { this.error ??= error; });
    this.pending.push(task);
    if (this.pending.length >= 2) {
      await this.pending.shift();
      if (this.error) throw this.error;
    }
  }
  async complete(record) {
    if (this.upload) {
      await this.flush();
      await Promise.all(this.pending);
      if (this.error) throw this.error;
      await this.upload.complete(this.parts);
    } else {
      this.key = `${OBJECTS}${record.key}/${record.expireAt}/${crypto.randomUUID()}`;
      await this.bucket.put(this.key, this.buffer.subarray(0, this.used), {
        httpMetadata: { contentType: record.mimeType },
        customMetadata: { expireAt: String(record.expireAt), key: record.key }
      });
    }
    this.completed = true; this.buffer = null;
    return this.key;
  }
  async dispose() {
    await Promise.all(this.pending);
    if (this.keep) return;
    if (this.completed) await this.bucket.delete(this.key);
    else if (this.upload) await this.upload.abort();
    this.buffer = null;
  }
}
export async function lookup(bucket, key) {
  const object = await bucket.get(`${INDEX}${key}`);
  return object ? { record: await object.json(), etag: object.etag } : null;
}
export async function reusable(bucket, entry, now, expectedSize) {
  return entry && entry.record.size === expectedSize && entry.record.expireAt - now >= 600 && await bucket.head(entry.record.storageKey) ? entry.record : null;
}
export async function commit(bucket, file, record, now, entry) {
  record.storageKey = await file.complete(record);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const options = {
        onlyIf: entry ? { etagMatches: entry.etag } : { etagDoesNotMatch: '*' },
        customMetadata: { expireAt: String(record.expireAt), storageKey: record.storageKey }, httpMetadata: { contentType: 'application/json' }
      };
      const result = await bucket.put(`${INDEX}${record.key}`, JSON.stringify(record), options);
      if (result) { file.keep = true; return record; }
      entry = await lookup(bucket, record.key);
      const winner = await reusable(bucket, entry, now, record.size);
      if (winner) return winner;
    }
    throw new BrokerError(50001, 'concurrent upload conflict; retry upload');
  } catch (error) {
    // A transport error can occur after the conditional index write succeeds.
    // Never delete a possibly published object just because its response was lost.
    try {
      const latest = await lookup(bucket, record.key);
      if (latest?.record.storageKey === record.storageKey) { file.keep = true; return latest.record; }
    } catch { file.keep = true; }
    throw error;
  }
}

export async function cleanup(bucket, now = Math.floor(Date.now() / 1000)) {
  // Immutable generations prevent a cleanup/upload race from deleting refreshed content.
  // Bound one invocation; bucket lifecycle rules are the backstop for large deployments.
  let removed = 0;
  const active = new Set(), expired = new Set();
  let cursor, referencesComplete = true;
  for (let page = 0; page < 10; page++) {
    const result = await bucket.list({ prefix: INDEX, cursor, limit: 1000, include: ['customMetadata'] });
    for (const object of result.objects) {
      const metadata = object.customMetadata ?? {};
      if (metadata.storageKey?.startsWith(OBJECTS)) {
        (Number(metadata.expireAt) <= now ? expired : active).add(metadata.storageKey);
      } else if (!(Number(metadata.expireAt) <= now)) {
        // Old indices have no storageKey metadata. Keep orphan detection conservative.
        referencesComplete = false;
      }
    }
    if (!result.truncated) break;
    if (page === 9) referencesComplete = false;
    cursor = result.cursor;
  }
  for (const prefix of [OBJECTS, STAGING]) {
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await bucket.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
      const obsolete = result.objects.filter(object => prefix === STAGING
        ? object.uploaded.getTime() < (now - 3600) * 1000
        : expired.has(object.key) || Number(object.customMetadata?.expireAt) <= now ||
          (referencesComplete && object.customMetadata?.directUpload === 'true' &&
           object.uploaded.getTime() < (now - 3600) * 1000 && !active.has(object.key))).map(object => object.key);
      if (obsolete.length) { await bucket.delete(obsolete); removed += obsolete.length; }
      if (!result.truncated) break;
      cursor = result.cursor;
    }
  }
  return removed;
}
