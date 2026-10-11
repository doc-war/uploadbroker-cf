import test from 'node:test';
import assert from 'node:assert/strict';
import reference from 'xxhash-wasm';
import { XXHash32 } from '../src/xxhash32.js';
import { newContentHasher } from '../src/hash.js';
import { reusable } from '../src/storage.js';
const oracle = await reference();
test('pure JS XXH32 matches an independent WASM implementation across seeds and chunk boundaries', () => {
  for (const size of [0, 1, 3, 4, 15, 16, 17, 31, 32, 33, 511, 512, 513, 65537]) {
    const backing = new Uint8Array(size + 9);
    for (let i = 0; i < backing.length; i++) backing[i] = (i * 179 + (i >>> 4)) & 255;
    const bytes = backing.subarray(5, 5 + size);
    for (const seed of [0, 1, 0xffffffff, 0x9e3779b1]) {
      const expected = oracle.h32Raw(bytes, seed).toString(16).padStart(8, '0');
      for (const chunkSize of [1, 3, 15, 16, 17, 1024, 65536]) {
        const hash = new XXHash32(seed);
        for (let offset = 0; offset < size; offset += chunkSize) hash.update(bytes.subarray(offset, offset + chunkSize));
        assert.equal(hash.digest(), expected, `${size}/${seed}/${chunkSize}`);
        assert.equal(hash.digest(), expected, 'digest must not modify state');
      }
    }
  }
  assert.equal(new XXHash32().digest(), '02cc5d05');
});
test('xxHash content keys include file size and dedup validates stored size', async () => {
  const hash = newContentHasher('xxhash32');
  await hash.update(new TextEncoder().encode('hello'));
  assert.equal(await hash.digest(), `${oracle.h32ToString('hello')}-5`);
  const entry = { record: { size: 5, expireAt: 1000, storageKey: 'objects/test' } };
  const bucket = { async head() { return {}; } };
  assert.equal(await reusable(bucket, entry, 0, 6), null);
  assert.equal(await reusable(bucket, entry, 0, 5), entry.record);
});
