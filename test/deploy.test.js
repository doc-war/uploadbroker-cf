import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProduction } from '../scripts/deploy-check.mjs';

const settings = () => ({ name: 'broker', main: '../src/worker.js', r2_buckets: [{ binding: 'bucket', bucket_name: 'broker' }],
  vars: { base_url: 'https://uploads.company.dev', url_blake2b_salts: ['a-real-key-for-production'], cors: true } });
test('deployment accepts production config, including optional anonymous uploads', () => {
  assert.equal(validateProduction(settings()).hmac, '');
});
test('deployment rejects local origins, example domains and placeholder URL keys', () => {
  for (const base_url of ['http://uploads.company.dev', 'https://localhost', 'https://127.0.0.1', 'https://upload.example.com', 'https://uploads.company.dev/path', 'https://user:pass@uploads.company.dev']) {
    const input = settings(); input.vars.base_url = base_url;
    assert.throws(() => validateProduction(input), /base_url/);
  }
  for (const salt of ['', 'replace-with-a-random-url-key', 'local-development-salt']) {
    const input = settings(); input.vars.url_blake2b_salts = [salt];
    assert.throws(() => validateProduction(input), /url_blake2b_salts/);
  }
});
test('deployment requires exactly the intended R2 binding and valid runtime settings', () => {
  const input = settings(); input.r2_buckets[0].binding = 'wrong';
  assert.throws(() => validateProduction(input), /R2/);
  const invalid = settings(); invalid.vars.content_hash = 'unknown';
  assert.throws(() => validateProduction(invalid), /content_hash/);
});
