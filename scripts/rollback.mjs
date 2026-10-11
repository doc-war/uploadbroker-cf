import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.mjs';
import { wranglerRunner, cloudflareClient, deployments, workerPath } from './cloudflare.mjs';
import { targetSettings } from './rollback-check.mjs';
import { checkAccount } from './account-check.mjs';
import { checkHealth, publishAndAccept } from './deploy-flow.mjs';
import { smoke } from './smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const index = args.indexOf('--version'); const versionId = index < 0 ? '' : args[index + 1];
if (index >= 0) args.splice(index, 2);
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(versionId) || args.some(arg => arg !== '--execute')) throw new Error('Usage: npm run deploy:rollback -- --version UUID [--execute]');
const run = wranglerRunner(root);
const configPath = resolve(root, 'deploy/wrangler.jsonc');
const lockPath = resolve(root, 'deploy/.deployment.lock');
let lock, reportPath, report;
const save = value => writeFile(reportPath, JSON.stringify(value, null, 2) + '\n');
try {
  const current = await readConfig(configPath);
  if (!/^[a-f0-9]{32}$/i.test(current.account_id ?? '')) throw new Error('Set account_id');
  const api = await cloudflareClient(run);
  const version = await api(`${workerPath(current)}/versions/${versionId}`);
  const { settings, cfg } = targetSettings(current, version);
  const resources = await checkAccount(settings, cfg, api, { allowPending: false });
  const before = (await deployments(api, current))[0] ?? null;
  console.log(JSON.stringify({ action: 'rollback_plan', worker: current.name, target_version: versionId, target_build_time: cfg.buildTime,
    traffic: '100%', before, resources, warning: 'Reverts version code and bindings/vars. R2 data, lifecycle rules and routes are not restored. URL salts and HMAC keys may change.' }, null, 2));
  if (args.includes('--execute')) {
    lock = await open(lockPath, 'wx');
    const fresh = (await deployments(api, current))[0] ?? null;
    if (fresh?.id !== before?.id) throw new Error('Active deployment changed during planning; inspect again before reverting');
    await mkdir(resolve(root, 'deploy/reports'), { recursive: true });
    report = { id: randomUUID(), action: 'rollback', target_version: versionId, build_time: cfg.buildTime, before, resources };
    reportPath = resolve(root, 'deploy/reports', `${report.id}.json`);
    await publishAndAccept({ save,
      publish: () => run(['versions', 'deploy', `${versionId}@100%`, '--yes', '--config', configPath]),
      health: async () => { report.after = (await deployments(api, current))[0] ?? null; await save(report); await checkHealth(cfg.baseURL, cfg.buildTime); },
      smoke: async () => { report.smoke_result = await smoke({ base: cfg.baseURL, settings, expectedTime: cfg.buildTime }); }
    }, report);
    console.log(`Rollback accepted. Report: ${reportPath}`);
  } else console.log('Plan only. After reviewing side effects, add --execute to switch traffic.');
} catch (error) {
  console.error(`${report?.status?.startsWith('published') ? 'Rollback is LIVE but acceptance failed' : 'Rollback stopped'}: ${error.message}`);
  if (report?.status === 'publishing') console.error('Traffic-switch outcome is uncertain; inspect deployments before retrying.');
  if (reportPath) console.error(`Report: ${reportPath}`);
  process.exitCode = 1;
} finally { if (lock) { await lock.close(); await unlink(lockPath); } }
