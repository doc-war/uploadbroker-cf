import { BrokerError } from './errors.js';
import { hmac, equal } from './hash.js';

export function uploadOptions(request, cfg) {
  const fields = new URL(request.url).searchParams;
  for (const name of ['expires', 'timestamp', 'sign']) {
    const value = request.headers.get(`X-UploadBroker-${name}`);
    if (value !== null) fields.set(name, value);
  }
  const hash = request.headers.get('X-UploadBroker-Hash');
  const size = request.headers.get('X-UploadBroker-Size');
  if (hash === null && size === null) return { fields, hint: null };
  if (!/^[0-9a-f]{8}$/.test(hash ?? '') || !/^[1-9][0-9]*$/.test(size ?? '') || !Number.isSafeInteger(Number(size))) {
    throw new BrokerError(40001, 'provide XXH32 (8 lowercase hex) and file size in bytes');
  }
  if (Number(size) > Math.max(...Object.values(cfg.limits))) throw new BrokerError(40004, 'file too large');
  if (cfg.contentHash !== 'xxhash32') throw new BrokerError(40001, 'fast upload requires content_hash=xxhash32');
  // Trust Cloudflare connection metadata, never a client-supplied protocol header.
  if (!['HTTP/2', 'HTTP/3'].includes(request.cf?.httpProtocol)) {
    throw new BrokerError(40001, 'fast upload requires HTTP/2 or HTTP/3');
  }
  // Early success cannot depend on fields still waiting in the multipart body.
  if (fields.has('expires') === false) fields.set('expires', String(cfg.ttl / 3600));
  return { fields, hint: { key: `${hash}-${size}`, size: Number(size) } };
}

export async function authorizeUpload(fields, cfg) {
  if (!cfg.hmac) return;
  if (!fields.get('sign') || !fields.get('timestamp')) throw new BrokerError(50000, 'missing sign or timestamp');
  if (!equal(await hmac(cfg.hmac, fields.get('timestamp')), fields.get('sign'))) throw new BrokerError(50000, 'invalid sign');
}

export function uploadTTL(fields, cfg) {
  if (!fields.get('expires')) return cfg.ttl;
  const hours = fields.get('expires');
  if (!/^[+-]?\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 24) throw new BrokerError(40005, 'expires 1-24');
  return Number(hours) * 3600;
}
