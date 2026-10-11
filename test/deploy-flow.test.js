import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTime, checkHealth, publishAndAccept } from '../scripts/deploy-flow.mjs';
import { validateLifecycle, validateRoutes, checkAccount } from '../scripts/account-check.mjs';
import { cloudflareClient, deployments } from '../scripts/cloudflare.mjs';
import { targetSettings } from '../scripts/rollback-check.mjs';
import { validateProduction } from '../scripts/deploy-check.mjs';

const settings = () => ({ name: 'broker', account_id: 'a'.repeat(32), main: '../src/worker.js',
  routes: [{ pattern: 'uploads.company.dev', custom_domain: true }],
  r2_buckets: [{ binding: 'bucket', bucket_name: 'broker' }], vars: { base_url: 'https://uploads.company.dev', url_blake2b_salts: ['real-key-for-production'], hmac_secret: 'secret', cors: true } });
const rules = () => ['objects/', 'index/', 'staging/'].map(prefix => ({ enabled: true, conditions: { prefix },
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: prefix === 'staging/' ? 86400 : 172800 } },
  ...(prefix === 'staging/' ? { abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } } } : {}) }));
test('build timestamps stay unique even when clock repeats or goes backwards', () => {
  const time = buildTime(undefined, 100000);
  assert.equal(Date.parse(buildTime(time, 100000)), 100001);
  assert.equal(Date.parse(buildTime(time, 1)), 100001);
});
test('same static version cannot satisfy health acceptance with an old deployment timestamp', async () => {
  await assert.rejects(checkHealth('https://uploads.company.dev', 'new', { attempts: 1,
    fetcher: async () => Response.json({ status: 'ok', storage: 'ok', version: '0.1.0', time: 'old' }) }), /timestamp/);
  await checkHealth('https://uploads.company.dev', 'new', { attempts: 1,
    fetcher: async url => { assert.equal(url.searchParams.get('deployment'), 'new'); return Response.json({ status: 'ok', storage: 'ok', version: 'different', time: 'new' }); } });
});
test('publish success followed by business failure is recorded as live quality failure', async () => {
  const phases = [], report = {};
  await assert.rejects(publishAndAccept({ publish: async () => phases.push('live'), health: async () => {},
    smoke: async () => { throw new Error('bad download'); }, save: async item => phases.push(item.status) }, report), /bad download/);
  assert.equal(report.status, 'published_quality_failed'); assert.equal(report.health, 'passed');
  assert.ok(phases.indexOf('live') < phases.indexOf('published_quality_failed'));
});
test('publication failure never starts business acceptance', async () => {
  const report = {}; let called = false;
  await assert.rejects(publishAndAccept({ save: async () => {}, publish: async () => { throw new Error('publish failed'); },
    health: async () => { called = true; }, smoke: async () => {} }, report), /publish failed/);
  assert.equal(called, false); assert.equal(report.status, 'publishing');
});
test('lifecycle checks enabled prefix coverage, multipart abort and premature deletion', () => {
  validateLifecycle(rules());
  const disabled = rules(); disabled[1].enabled = false; assert.throws(() => validateLifecycle(disabled), /Missing/);
  const noAbort = rules(); delete noAbort[2].abortMultipartUploadsTransition; assert.throws(() => validateLifecycle(noAbort), /abort/);
  assert.throws(() => validateLifecycle([...rules(), { enabled: true, conditions: { prefix: 'objects/ab' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 100 } } }]), /prematurely/);
});
test('routes reject a more specific competing Worker or disabled route', () => {
  const good = [{ pattern: 'uploads.company.dev/*', script: 'broker' }];
  validateRoutes(good, 'broker', 'https://uploads.company.dev', 'tmp');
  assert.throws(() => validateRoutes([...good, { pattern: 'uploads.company.dev/v1/upload', script: 'other' }], 'broker', 'https://uploads.company.dev', 'tmp'), /route/);
  assert.throws(() => validateRoutes([{ pattern: 'uploads.company.dev/*', script: null }], 'broker', 'https://uploads.company.dev', 'tmp'), /route/);
});
test('live account check requires actual bucket, lifecycle and enabled custom domain', async () => {
  const input = settings(); const cfg = validateProduction(input);
  const api = async path => path.endsWith('/lifecycle') ? { rules: rules() } : path.includes('/workers/domains') ? [{ hostname: 'uploads.company.dev', service: 'broker', environment: 'production', enabled: true }] : { name: 'broker' };
  assert.equal((await checkAccount(input, cfg, api)).routing, 'passed');
  await assert.rejects(checkAccount(input, cfg, async path => path.includes('/workers/domains') ? [] : api(path), { allowPending: false }), /domain/);
  await assert.rejects(checkAccount(input, cfg, async () => { throw new Error('permission denied'); }), /permission/);
});
test('Cloudflare credential capture is private and API failures do not expose tokens', async () => {
  const api = await cloudflareClient(async (args, options) => { assert.deepEqual(args, ['auth', 'token', '--json']); assert.equal(options.sensitive, true); return JSON.stringify({ type: 'oauth', token: 'sensitive-token' }); },
    async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer sensitive-token'); return Response.json({ success: false, errors: [{ code: 10000, message: 'sensitive-token' }] }, { status: 403 }); });
  await assert.rejects(api('/accounts/a'), error => !error.message.includes('sensitive-token') && error.status === 403);
});
test('deployment history does not treat denied access as a first publication', async () => {
  await assert.rejects(deployments(async () => { const error = new Error('denied'); error.status = 403; throw error; }, settings()), /denied/);
});
test('rollback recovers target vars in memory and rejects incompatible bindings or legacy timestamps', () => {
  const input = settings(); const vars = { ...input.vars, build_time: '2026-10-11T01:00:00.000Z', hmac_secret: 'old-secret' };
  const version = { resources: { bindings: [{ type: 'r2_bucket', name: 'bucket', bucket_name: 'broker' }, ...Object.entries(vars).map(([name, value]) =>
    typeof value === 'string' ? { type: 'plain_text', name, text: value } : { type: 'json', name, json: value })] } };
  assert.equal(targetSettings(input, version).cfg.hmac, 'old-secret');
  version.resources.bindings[0].bucket_name = 'different'; assert.throws(() => targetSettings(input, version), /R2/);
  version.resources.bindings[0].bucket_name = 'broker'; version.resources.bindings = version.resources.bindings.filter(binding => binding.name !== 'build_time');
  assert.throws(() => targetSettings(input, version), /build_time/);
});

test('lifecycle accepts omitted whole-bucket prefixes and diagnoses existing retention mismatch', () => {
  const globalRule = { id: 'global', enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 172800 } } };
  validateLifecycle([globalRule, rules()[2]]);
  const existing = rules(); existing[0].id = 'existing-objects'; existing[0].deleteObjectsTransition.condition.maxAge = 86400;
  assert.throws(() => validateLifecycle(existing), /existing-objects: 1 days.*Edit the existing rule/);
});

test('first custom domain deployment verifies ownership and reports pending without claiming live', async () => {
 const input = settings(); const cfg = validateProduction(input);
 const api = async path => {
  if (path.endsWith('/lifecycle')) return { rules: rules() };
  if (path.includes('/workers/domains')) return [];
  if (path.startsWith('/zones?')) return [{ id: 'zone', name: 'company.dev', status: 'active' }];
  if (path.endsWith('/workers/routes')) return [];
  return { name: 'broker' };
 };
 assert.equal((await checkAccount(input, cfg, api)).routing, 'pending_publish');
 await assert.rejects(checkAccount(input, cfg, api, { allowPending: false }), /domain/);
 await assert.rejects(checkAccount(input, cfg, async path => path.startsWith('/zones?') ? [] : api(path)), /active Cloudflare zone/);
 await assert.rejects(checkAccount(input, cfg, async path => path.endsWith('/workers/routes') ? [{ pattern: 'uploads.company.dev/*', script: 'other' }] : api(path)), /different Worker/);
});
