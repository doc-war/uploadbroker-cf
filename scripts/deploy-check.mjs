import { config } from '../src/config.js';

export function validateProduction(settings) {
  const cfg = config(settings.vars ?? {});
  const url = new URL(cfg.baseURL);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' ||
      /^127\./.test(hostname) || /^0\./.test(hostname) ||
      /(^|\.)example\.(com|net|org)$/.test(hostname) || hostname.endsWith('.test') || hostname.endsWith('.invalid')) {
    throw new Error('base_url must be the real public HTTPS origin');
  }
  if (cfg.salts.some(salt => !salt.trim() || /replace-with|placeholder|local-development|benchmark-only|test-salt/i.test(salt))) {
    throw new Error('url_blake2b_salts must contain real keys, not empty values or placeholders');
  }
  if (!settings.name || !settings.main) throw new Error('Worker name and main are required');
  if (settings.r2_buckets?.length !== 1 || settings.r2_buckets[0].binding !== 'bucket' || !settings.r2_buckets[0].bucket_name) {
    throw new Error('configure exactly one R2 bucket with binding bucket');
  }
  return cfg;
}
