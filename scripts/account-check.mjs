import { OBJECTS, INDEX, STAGING } from '../src/storage.js';
const day = 86400;
export function validateLifecycle(rules) {
  for (const [prefix, transition, age] of [[OBJECTS, 'deleteObjectsTransition', 2 * day], [INDEX, 'deleteObjectsTransition', 2 * day], [STAGING, 'deleteObjectsTransition', day], [STAGING, 'abortMultipartUploadsTransition', day]]) {
    // Cloudflare may omit prefix for a whole-bucket rule (e.g. its default abort rule).
    const enabled = rules.filter(rule => rule.enabled && (rule.conditions?.prefix === undefined || typeof rule.conditions.prefix === 'string'))
      .map(rule => ({ ...rule, conditions: { ...rule.conditions, prefix: rule.conditions?.prefix ?? '' } }));
    const matches = enabled.filter(rule => prefix.startsWith(rule.conditions.prefix));
    if (!matches.some(rule => rule[transition]?.condition?.type === 'Age' && rule[transition].condition.maxAge === age)) {
      const existing = matches.filter(rule => rule[transition]).map(rule => {
        const condition = rule[transition].condition;
        return `${rule.id ?? '(unnamed)'}: ${condition?.type === 'Age' ? `${condition.maxAge / day} days` : condition?.type ?? 'unknown condition'}`;
      });
      throw new Error(`Missing enabled lifecycle matching policy: ${prefix} ${transition} after ${age / day} days. Existing covering rules: ${existing.join('; ') || 'none'}. ${existing.length ? 'Edit the existing rule instead of adding a duplicate.' : 'Add or enable the required rule.'}`);
    }
    if (transition === 'deleteObjectsTransition' && enabled.some(rule => {
      const overlaps = prefix.startsWith(rule.conditions.prefix) || rule.conditions.prefix.startsWith(prefix);
      const condition = rule[transition]?.condition;
      return overlaps && condition && (condition.type !== 'Age' || condition.maxAge < age);
    })) throw new Error(`Lifecycle may delete ${prefix} prematurely`);
  }
}
export function routeMatches(pattern, url) {
  const normalized = pattern.includes('://') ? pattern : `*://${pattern}`;
  return new RegExp(`^${normalized.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(url);
}
export function validateRoutes(routes, name, baseURL, prefix) {
  for (const path of ['/v1/health', '/v1/upload', `/${prefix}/__deployment_probe__`]) {
    const matching = routes.filter(route => routeMatches(route.pattern, baseURL + path));
    matching.sort((a, b) => b.pattern.replaceAll('*', '').length - a.pattern.replaceAll('*', '').length);
    if (!matching.length || matching[0].script !== name) throw new Error(`Live route does not send ${path} to ${name}`);
  }
}
export async function checkAccount(settings, cfg, api, { allowPending = true } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(settings.account_id ?? '')) throw new Error('Fill top-level account_id in deploy/wrangler.jsonc with your real 32-character Cloudflare Account ID (not Zone ID); see README account setup');
  const account = `/accounts/${settings.account_id}`;
  const binding = settings.r2_buckets[0];
  const bucketPath = `${account}/r2/buckets/${encodeURIComponent(binding.bucket_name)}`;
  const headers = binding.jurisdiction ? { 'cf-r2-jurisdiction': binding.jurisdiction } : {};
  const bucket = await api(bucketPath, headers);
  if (bucket.name !== binding.bucket_name) throw new Error('R2 bucket response does not match configuration');
  validateLifecycle((await api(`${bucketPath}/lifecycle`, headers)).rules ?? []);
  const host = new URL(cfg.baseURL).hostname;
  let routing = 'passed';
  if (host.endsWith('.workers.dev')) {
    if (settings.workers_dev === false) throw new Error('workers_dev is disabled in configuration');
    const subdomain = await api(`${account}/workers/subdomain`);
    if (host !== `${settings.name}.${subdomain.subdomain}.workers.dev`) throw new Error('workers.dev URL does not match this account and Worker');
    const live = await api(`${account}/workers/scripts/${encodeURIComponent(settings.name)}/subdomain`);
    if (!live.enabled) throw new Error('Live workers.dev endpoint is disabled');
  } else {
    const configured = settings.routes ?? (settings.route ? [settings.route] : []);
    if (!configured.length) throw new Error(`No routes configured for ${host}; set routes in deploy/wrangler.jsonc (custom_domain or Worker routes)`);
    const custom = configured.some(route => typeof route === 'object' && route.custom_domain && route.pattern === host);
    if (custom) {
      const domains = await api(`${account}/workers/domains?hostname=${encodeURIComponent(host)}`);
      const attached = domains.some(domain => domain.enabled === true && domain.hostname === host && domain.service === settings.name && domain.environment === 'production');
      if (!attached) {
        if (!allowPending || domains.length) throw new Error('Live custom domain is not attached/enabled for this Worker');
        // A new Custom Domain is created by wrangler deploy; verify prerequisites
        // instead of requiring that side effect before the first publication.
        const labels = host.split('.'); let zone;
        for (let start = 0; start < labels.length - 1 && !zone; start++) {
          const zones = await api(`/zones?name=${encodeURIComponent(labels.slice(start).join('.'))}&account.id=${settings.account_id}&per_page=50`);
          zone = zones.find(item => item.status === 'active');
        }
        if (!zone) throw new Error('No active Cloudflare zone found for the planned custom domain');
        const customRoute = configured.find(route => route.custom_domain && route.pattern === host);
        if ((customRoute.zone_id && customRoute.zone_id !== zone.id) || (customRoute.zone_name && customRoute.zone_name !== zone.name)) throw new Error('Planned custom domain zone does not match base_url');
        const liveRoutes = await api(`/zones/${zone.id}/workers/routes`);
        for (const path of ['/v1/health', '/v1/upload', `/${cfg.prefix}/__deployment_probe__`]) {
          if (liveRoutes.some(route => route.script && route.script !== settings.name && routeMatches(route.pattern, cfg.baseURL + path))) throw new Error('A different Worker route intercepts the planned custom domain');
        }
        routing = 'pending_publish';
      }
    } else {
      validateRoutes(configured.map(route => ({ pattern: typeof route === 'string' ? route : route.pattern, script: settings.name })), settings.name, cfg.baseURL, cfg.prefix);
      const labels = host.split('.'); let zone;
      for (let start = 0; start < labels.length - 1 && !zone; start++) {
        const zones = await api(`/zones?name=${encodeURIComponent(labels.slice(start).join('.'))}&account.id=${settings.account_id}&per_page=50`);
        zone = zones.find(item => item.status === 'active');
      }
      if (!zone) throw new Error('No active Cloudflare zone found for base_url');
      for (const route of configured) if (typeof route === 'object' && ((route.zone_id && route.zone_id !== zone.id) || (route.zone_name && route.zone_name !== zone.name))) throw new Error('Configured route zone does not match base_url');
      validateRoutes(await api(`/zones/${zone.id}/workers/routes`), settings.name, cfg.baseURL, cfg.prefix);
      const dns = await api(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
      if (!dns.some(record => record.proxied)) throw new Error('base_url needs a proxied DNS record for Worker routes');
    }
  }
  return { bucket: binding.bucket_name, hostname: host, lifecycle: 'passed', routing,
    ...(routing === 'pending_publish' ? { note: 'Custom domain prerequisites verified; wrangler deploy will create the binding. Not yet live.' } : {}) };
}
