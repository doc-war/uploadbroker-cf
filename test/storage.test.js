import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadedFile, PART_SIZE, commit, cleanup } from '../src/storage.js';
test('direct multipart uses bounded, uniform parts and aborts on failure', async () => {
  const sizes = []; let aborted = false;
  const bucket = {
    async createMultipartUpload() { return {
      async uploadPart(number, bytes) { sizes.push(bytes.length); return { partNumber: number, etag: `part-${number}` }; },
      async abort() { aborted = true; }, async complete() { throw new Error('storage failure'); }
    }; }
  };
  const staged = new UploadedFile(bucket);
  assert.equal(staged.buffer, null);
  for (let i = 0; i < 11; i++) await staged.write(new Uint8Array(1024 * 1024));
  await assert.rejects(staged.complete(), /storage failure/);
  await staged.dispose();
  assert.deepEqual(sizes, [PART_SIZE, PART_SIZE, 1024 * 1024]);
  assert.equal(aborted, true);
});

test('one-part files defer all file writes until deduplication succeeds', async () => {
  const calls = [];
  const bucket = { async put(key, bytes) { calls.push({ key, bytes: bytes.length }); }, async delete(key) { calls.push({ deleted: key }); } };
  const duplicate = new UploadedFile(bucket);
  await duplicate.write(new Uint8Array(PART_SIZE));
  assert.equal(calls.length, 0);
  await duplicate.dispose();
  assert.equal(calls.length, 0, 'a buffered duplicate needs no file write or deletion');
  const first = new UploadedFile(bucket);
  await first.write(Uint8Array.of(1, 2, 3));
  await first.complete({ key: 'abc', expireAt: 100, mimeType: 'image/png' });
  assert.match(calls[0].key, /^objects\/abc\/100\//);
  assert.equal(calls[0].bytes, 3);
  await first.dispose();
  assert.equal(calls[1].deleted, calls[0].key, 'unpublished objects must be removed');
});

test('large uploads publish the directly uploaded object without reading or copying its body', async () => {
  const calls = [], record = { key: 'large', expireAt: 10000, size: PART_SIZE + 1, mimeType: 'image/png' };
  const bucket = {
    async createMultipartUpload(key) {
      calls.push(['create', key]);
      return {
        async uploadPart(partNumber, bytes) { calls.push(['part', bytes.length]); return { partNumber, etag: String(partNumber) }; },
        async complete(parts) { calls.push(['complete', parts.length]); },
        async abort() { throw new Error('published upload must not be aborted'); }
      };
    },
    async put(key, value, options) {
      assert.equal(key, 'index/large', 'only the index uses put() for a large upload');
      assert.equal(options.customMetadata.storageKey, record.storageKey);
      calls.push(['index']); return {};
    },
    async get() { throw new Error('no object copy or extra lookup expected'); },
    async delete() { throw new Error('published file must be kept'); }
  };
  const file = new UploadedFile(bucket);
  await file.write(new Uint8Array(PART_SIZE)); await file.write(Uint8Array.of(1));
  await commit(bucket, file, record, 0, null); await file.dispose();
  assert.match(record.storageKey, /^objects\/uploads\//);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'part', 'part', 'complete', 'index']);
});

test('multipart overlaps at most two parts and retains logical order when they finish out of order', async () => {
  const finishes = new Map(); let active = 0, peak = 0, completed;
  const bucket = { async createMultipartUpload() { return {
    uploadPart(partNumber) {
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => finishes.set(partNumber, () => { active--; resolve({ partNumber, etag: String(partNumber) }); }));
    },
    async complete(parts) { completed = parts.map(part => part.partNumber); }, async abort() {}
  }; } };
  const file = new UploadedFile(bucket);
  await file.write(new Uint8Array(PART_SIZE + 1));
  const writing = file.write(new Uint8Array(PART_SIZE));
  while (!finishes.has(2)) await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2);
  finishes.get(2)(); finishes.get(1)(); await writing;
  const completing = file.complete({});
  while (!finishes.has(3)) await new Promise(resolve => setImmediate(resolve));
  finishes.get(3)(); await completing;
  assert.deepEqual(completed, [1, 2, 3]);
  file.keep = true; await file.dispose();
});

test('lost index-write response does not delete an object that was actually published', async () => {
  let stored, deleted = false;
  const file = { keep: false, async complete() { return 'objects/uploads/new'; } };
  const bucket = {
    async put(key, value) { stored = JSON.parse(value); throw new Error('lost response'); },
    async get() { return { async json() { return stored; }, etag: 'new' }; },
    async delete() { deleted = true; }
  };
  const record = { key: 'key', expireAt: 10000, size: 10 };
  assert.deepEqual(await commit(bucket, file, record, 0, null), record);
  assert.equal(file.keep, true); assert.equal(deleted, false);
});

test('cleanup deletes expired direct objects and old orphans while keeping active and fresh objects', async () => {
  const now = 10000, deleted = [];
  const object = (key, metadata, age = 4000) => ({ key, customMetadata: metadata, uploaded: new Date((now - age) * 1000) });
  const bucket = {
    async list({ prefix }) { return { objects: prefix === 'index/' ? [
      object('index/active', { expireAt: '11000', storageKey: 'objects/uploads/active' }),
      object('index/expired', { expireAt: '9999', storageKey: 'objects/uploads/expired' })
    ] : prefix === 'objects/' ? ['active', 'expired', 'orphan'].map(key => object(`objects/uploads/${key}`, { directUpload: 'true' }))
      .concat(object('objects/uploads/fresh', { directUpload: 'true' }, 10)) : [] }; },
    async delete(keys) { deleted.push(...keys); }
  };
  assert.equal(await cleanup(bucket, now), 2);
  assert.deepEqual(deleted.sort(), ['objects/uploads/expired', 'objects/uploads/orphan']);
});

test('legacy indices and truncated index scans cannot cause live direct objects to be treated as orphans', async () => {
  for (const legacy of [true, false]) {
    const bucket = {
      async list({ prefix }) {
        return { objects: prefix === 'index/' ? legacy ? [{ customMetadata: { expireAt: '20000' } }] : []
          : prefix === 'objects/' ? [{ key: 'objects/uploads/live', customMetadata: { directUpload: 'true' }, uploaded: new Date(0) }] : [],
          truncated: prefix === 'index/' && !legacy, cursor: 'next' };
      },
      async delete() { throw new Error('incomplete reference scan must preserve this object'); }
    };
    assert.equal(await cleanup(bucket, 10000), 0);
  }
});
