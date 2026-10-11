import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = await readConfig(resolve(root, 'wrangler.example.jsonc'));
settings.main = '../src/worker.js';
settings.$schema = '../node_modules/wrangler/config-schema.json';
await mkdir(resolve(root, 'deploy'), { recursive: true });
try {
  await writeFile(resolve(root, 'deploy/wrangler.jsonc'), JSON.stringify(settings, null, 2) + '\n', { flag: 'wx' });
  console.log('Created deploy/wrangler.jsonc. Set your production account, domain, keys and resources before deploying.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('deploy/wrangler.jsonc already exists; preserved without changes.');
}
