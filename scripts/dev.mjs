import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTime } from './deploy-flow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const time = buildTime();
console.log(`Local dev build_time=${time}`);
const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--config', resolve(root, 'deploy/wrangler.jsonc'), ...process.argv.slice(2), '--var', `build_time:${time}`],
  { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(`Dev startup failed: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
