import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function wranglerRunner(root) {
  return async (args, { capture = false, sensitive = false } = {}) => new Promise((ok, fail) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });
    let stdout = '', stderr = '';
    if (capture) { child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); }
    child.on('error', fail);
    child.on('exit', code => code === 0 ? ok(stdout) : fail(new Error(sensitive ? 'Wrangler authentication unavailable; run wrangler login.' : `Wrangler ${args[0]} failed (${code}): ${stderr.slice(-1000)}`)));
  });
}
export async function cloudflareClient(run, fetcher = fetch) {
  // Never log, persist, or include captured credentials in failure messages.
  let auth;
  try { auth = JSON.parse(await run(['auth', 'token', '--json'], { capture: true, sensitive: true })); }
  catch { throw new Error('Wrangler authentication unavailable; run wrangler login.'); }
  if (!auth.token && !(auth.key && auth.email)) throw new Error('Wrangler returned no usable credentials');
  const headers = auth.type === 'api_key' ? { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email } : { Authorization: `Bearer ${auth.token}` };
  return async (path, extraHeaders = {}) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { headers: { ...headers, ...extraHeaders }, signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    if (!response.ok || !body.success) {
      const error = new Error(`Cloudflare GET ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${(body.errors ?? []).map(item => item.code).join(',')}); verify credentials and read permissions.`);
      error.status = response.status; error.codes = (body.errors ?? []).map(item => item.code); throw error;
    }
    return body.result;
  };
}
export function workerPath(settings) {
  return `/accounts/${encodeURIComponent(settings.account_id)}/workers/scripts/${encodeURIComponent(settings.name)}`;
}
export async function deployments(api, settings) {
  try {
    const result = await api(`${workerPath(settings)}/deployments`);
    return [...(result.deployments ?? [])].sort((a, b) => b.created_on.localeCompare(a.created_on));
  } catch (error) {
    // Explicit missing script only; permission/API errors must not look like first deployment.
    if (error.status === 404 && error.codes?.includes(10007)) return [];
    throw error;
  }
}
