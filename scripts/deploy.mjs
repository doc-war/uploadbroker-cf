import { access, mkdir, writeFile, readFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.mjs';
import { validateProduction } from './deploy-check.mjs';
import { wranglerRunner, cloudflareClient, deployments } from './cloudflare.mjs';
import { smoke } from './smoke.mjs';
import { checkAccount } from './account-check.mjs';
import { buildTime, checkHealth, publishAndAccept } from './deploy-flow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let smokeSize = 1;
const sizeIndex = args.indexOf('--smoke-size-mib');
if (sizeIndex >= 0) { smokeSize = Number(args[sizeIndex + 1]); args.splice(sizeIndex, 2); }
if (args.some(arg => !['--check', '--dry-run'].includes(arg)) || (args.includes('--check') && args.includes('--dry-run')) || !Number.isInteger(smokeSize) || smokeSize < 1 || smokeSize > 50) throw new Error('Usage: npm run deploy -- [--check | --dry-run] [--smoke-size-mib 1..50]');
const configPath = resolve(root, 'deploy/wrangler.jsonc');
const output = resolve(root, 'deploy/dist');
const reports = resolve(root, 'deploy/reports');
const run = wranglerRunner(root);
const lockPath = resolve(root, 'deploy/.deployment.lock');
let lock, report, reportPath;
const save = async value => writeFile(reportPath, JSON.stringify(value, null, 2) + '\n');
try {
  const settings = await readConfig(configPath);
  const cfg = validateProduction(settings);
  await access(resolve(dirname(configPath), settings.main));
  if (smokeSize * 1024 * 1024 > cfg.limits.image) throw new Error('Smoke size exceeds configured image limit');
  if (!/^[a-f0-9]{32}$/i.test(settings.account_id ?? '')) throw new Error('Fill top-level account_id in deploy/wrangler.jsonc with your real 32-character Cloudflare Account ID (not Zone ID); see README account setup');
  const api = await cloudflareClient(run);
  const resources = await checkAccount(settings, cfg, api);
  console.log('Production configuration, bucket and lifecycle checks passed.');
  console.log(`Domain routing: ${resources.routing}${resources.note ? `. ${resources.note}` : ''}`);
  if (!args.includes('--check')) {
    lock = await open(lockPath, 'wx');
    await mkdir(reports, { recursive: true });
    const timePath = resolve(reports, 'last-build-time');
    let previousTime;
    try { previousTime = await readFile(timePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const time = buildTime(previousTime);
    await writeFile(timePath, time);
    const before = await deployments(api, settings);
    report = { id: randomUUID(), worker: settings.name, account: settings.account_id, build_time: time, resources, before: before[0] ?? null, status: 'building' };
    reportPath = resolve(reports, `${report.id}.json`);
    await save(report);
    const varArgs = ['--var', `build_time:${time}`];
    await run(['deploy', '--config', configPath, '--dry-run', '--outdir', output, ...varArgs]);
    if (args.includes('--dry-run')) { report.status = 'dry_run_passed'; await save(report); }
    else {
      await publishAndAccept({ save,
        publish: () => run(['deploy', resolve(output, 'worker.js'), '--config', configPath, '--no-bundle', ...varArgs]),
        health: async () => {
          report.after = (await deployments(api, settings))[0] ?? null; await save(report);
          report.resources_after = await checkAccount(settings, cfg, api, { allowPending: false }); await save(report);
          await checkHealth(cfg.baseURL, time);
        },
        smoke: async () => { report.smoke_result = await smoke({ base: cfg.baseURL, settings, sizeMiB: smokeSize, expectedTime: time }); }
      }, report);
      console.log(`Deployment accepted: build_time=${time}`);
    }
    console.log(`Deployment report: ${reportPath}`);
  }
} catch (error) {
  if (report?.status === 'published_quality_failed' || report?.status === 'published_pending_acceptance') {
    console.error(`Published and LIVE, but acceptance did not pass: ${error.message}`);
    console.error('No automatic rollback: reverting code/config can affect URL salts, HMAC keys, bindings and stored data compatibility. Review versions and use npm run deploy:rollback for a controlled revert.');
  } else {
    console.error(`Deployment stopped: ${error.message}`);
    if (report?.status === 'publishing') console.error('Publish outcome is uncertain; inspect Cloudflare deployments before retrying or reverting.');
  }
  if (reportPath) console.error(`Deployment report: ${reportPath}`);
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
}
