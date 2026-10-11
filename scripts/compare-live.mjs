import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomFillSync, createHash, createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readConfig } from './config.mjs';

// Sequential requests avoid bandwidth competition between the two services.
const endpoints = [
  { name: 'go', base: 'https://uploadbroker.dow-war.com' },
  { name: 'workers', base: 'https://uploadbroker2.dow-war.com' },
];
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const sizes = (option('--sizes') ?? '1,10,49').split(',').map(Number);
const maxTime = Number(option('--max-time') ?? 600);
const healthCount = Number(option('--health-count') ?? 7);
if (sizes.some(size => !Number.isInteger(size) || size < 1 || size > 49) || !Number.isInteger(maxTime) || maxTime < 1 || maxTime > 900 || !Number.isInteger(healthCount) || healthCount < 0 || healthCount > 20) throw new Error('Invalid sizes, max-time or health-count');
const folder = resolve('deploy/reports', `network-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(folder, { recursive: true });
const settings = await readConfig();
const report = { startedAt: new Date().toISOString(), client: process.platform,
  method: 'Sequential curl requests; default TLS verification; valid random RGB PNG; MB=1000000 bytes; expires=1 hour', maxTime,
  health: [], business: [] };
const metrics = '{"http":"%{http_code}","curlExit":%{exitcode},"dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"ready":%{time_pretransfer},"sent":%{time_posttransfer},"ttfb":%{time_starttransfer},"total":%{time_total},"upload":%{size_upload},"download":%{size_download},"connections":%{num_connects},"remote":"%{remote_ip}","httpVersion":"%{http_version}"}\n';
let sequence = 0;
async function curlBatch(requests) {
  const files = requests.map(() => { const id = sequence++; return { body: resolve(folder, `${id}.body`), headers: resolve(folder, `${id}.headers`) }; });
  const args = requests.flatMap((request, i) => [
    ...(i ? ['--next'] : []), '--silent', '--show-error', '--connect-timeout', '20', '--max-time', String(maxTime),
    '--write-out', metrics, '--output', files[i].body, '--dump-header', files[i].headers,
    ...request.args ?? [], request.url,
  ]);
  const result = await new Promise((accept, reject) => {
    const child = spawn('curl.exe', args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => accept({ code, stdout, stderr }));
  });
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line); row.http = Number(row.http); return row;
  });
  return Promise.all(files.map(async (file, i) => {
    const headers = await readFile(file.headers, 'utf8').catch(() => '');
    const row = { ...rows[i],
      cfRay: headers.match(/^cf-ray:\s*(.+)$/im)?.[1]?.trim(),
      cache: headers.match(/^cf-cache-status:\s*(.+)$/im)?.[1]?.trim(),
      workerCache: headers.match(/^x-uploadbroker-cache:\s*(.+)$/im)?.[1]?.trim(),
      age: headers.match(/^age:\s*(.+)$/im)?.[1]?.trim(), bodyFile: file.body };
    if (row.curlExit) row.error = result.stderr.slice(0, 400);
    return row;
  }));
}
const save = () => writeFile(resolve(folder, 'results.json'), JSON.stringify(report, null, 2));
if (option('--download-report')) {
  const source = JSON.parse(await readFile(resolve(option('--download-report')), 'utf8'));
  report.sourceReport = resolve(option('--download-report'));
  report.method = 'Download-only recheck of existing uploaded resources; sequential curl with connection reuse';
  for (const entry of source.business.filter(entry => sizes.includes(entry.targetMB) && entry.firstUpload?.response?.code === 0)) {
    const url = entry.firstUpload.response.data.url;
    const downloads = await curlBatch([{ url }, { url }]);
    for (const row of downloads) {
      const bytes = await readFile(row.bodyFile).catch(() => Buffer.alloc(0));
      row.integrityPassed = row.curlExit === 0 && row.http === 200 && bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256;
      await rm(row.bodyFile, { force: true }); delete row.bodyFile;
    }
    report.business.push({ endpoint: entry.endpoint, targetMB: entry.targetMB, bytes: entry.bytes, sha256: entry.sha256, downloads });
    await save(); console.log(JSON.stringify({ stage: 'downloadRecheck', endpoint: entry.endpoint, targetMB: entry.targetMB, downloads }));
  }
  report.finishedAt = new Date().toISOString(); await save();
  console.log(`Report: ${resolve(folder, 'results.json')}`);
  process.exit(report.business.length && report.business.every(entry => entry.downloads.every(row => row.integrityPassed)) ? 0 : 1);
}
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
function pngChunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const value of payload) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); payload.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
async function image(targetMB) {
  const width = 1024, stride = width * 3 + 1;
  const height = Math.floor((targetMB * 1000000 - 4096) / stride);
  const pixels = randomFillSync(Buffer.alloc(stride * height));
  for (let i = 0; i < height; i++) pixels[i * stride] = 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 0 })), pngChunk('IEND', Buffer.alloc(0))]);
  const path = resolve(folder, `${targetMB}MB.png`); await writeFile(path, bytes);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), targetMB };
}
for (const endpoint of healthCount ? endpoints : []) {
  const rows = await curlBatch(Array.from({ length: healthCount }, () => ({ url: `${endpoint.base}/v1/health`, args: ['--header', 'Cache-Control: no-cache'] })));
  for (const [i, row] of rows.entries()) {
    row.endpoint = endpoint.name; row.sample = i; row.health = JSON.parse(await readFile(row.bodyFile, 'utf8'));
  }
  report.health.push(...rows); await save();
  console.log(JSON.stringify({ stage: 'health', endpoint: endpoint.name, rows }));
}
for (const targetMB of sizes) {
  const file = await image(targetMB);
  const order = targetMB === 10 ? [...endpoints].reverse() : endpoints;
  for (const endpoint of order) {
    const entry = { endpoint: endpoint.name, targetMB, bytes: file.bytes, sha256: file.sha256 }; report.business.push(entry);
    try {
      const args = ['--header', 'Expect:', '--form', 'expires=1', '--form', `file=@${file.path};type=image/png`];
      const secret = endpoint.name === 'workers' ? settings.vars?.hmac_secret : process.env.GO_HMAC_SECRET;
      if (secret) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        args.push('--form', `timestamp=${timestamp}`, '--form', `sign=${createHmac('sha256', secret).update(timestamp).digest('hex')}`);
      }
      for (const stage of ['firstUpload', 'duplicateUpload']) {
        let row;
        const failedAttempts = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          [row] = await curlBatch([{ url: `${endpoint.base}/v1/upload`, args }]);
          if (row.curlExit !== 35 || row.upload !== 0 || attempt === 2) break;
          failedAttempts.push(row);
          console.log(JSON.stringify({ stage: 'handshakeRetry', endpoint: endpoint.name, targetMB, attempt: attempt + 1 }));
        }
        if (failedAttempts.length) row.failedAttempts = failedAttempts;
        entry[stage] = row;
        if (row.curlExit) throw new Error(`curl failed (${row.curlExit}): ${row.error}`);
        const data = JSON.parse(await readFile(row.bodyFile, 'utf8')); row.response = data;
        if (row.http !== 200 || data.code !== 0 || data.data?.size !== file.bytes) throw new Error(`Upload rejected: HTTP ${row.http}, ${JSON.stringify(data).slice(0, 400)}`);
        if (new URL(data.data.url).origin !== endpoint.base) throw new Error('Unexpected download origin');
        console.log(JSON.stringify({ stage, endpoint: endpoint.name, targetMB, total: row.total, ttfb: row.ttfb })); await save();
      }
      entry.dedupPassed = JSON.stringify(entry.firstUpload.response.data) === JSON.stringify(entry.duplicateUpload.response.data);
      const url = entry.firstUpload.response.data.url;
      const downloads = await curlBatch([{ url }, { url }]); entry.downloads = downloads;
      for (const row of downloads) {
        const bytes = await readFile(row.bodyFile).catch(() => Buffer.alloc(0));
        row.integrityPassed = row.curlExit === 0 && row.http === 200 && bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256;
        await rm(row.bodyFile, { force: true }); delete row.bodyFile;
      }
      console.log(JSON.stringify({ stage: 'downloads', endpoint: endpoint.name, targetMB, downloads }));
    } catch (error) { entry.error = error.message; console.log(JSON.stringify({ stage: 'error', endpoint: endpoint.name, targetMB, error: error.message })); }
    await save();
  }
  await rm(file.path);
}
report.finishedAt = new Date().toISOString(); await save();
console.log(`Report: ${resolve(folder, 'results.json')}`);
