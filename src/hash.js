import blake from 'blakejs';
import { XXHash32 } from './xxhash32.js';
const { blake2bHex } = blake;
export function newContentHasher() {
  const hash = new XXHash32();
  return { update: bytes => hash.update(bytes), digest: async () => `${hash.digest()}-${hash.length}`, abort: async () => {} };
}
export function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function token(salt, key, expire) {
  const date = new Date(expire * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '');
  return blake2bHex(`${salt}/${date}/${key}`, undefined, 32).slice(0, 16);
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function hmac(secret, text) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text))));
}
export function responseData(cfg, record) {
  return { url: `${cfg.baseURL}/${cfg.prefix}/${record.expireAt}/${record.key.slice(0, 2)}/${record.key}/${token(cfg.salts[0], record.key, record.expireAt)}${record.extension}`,
    mimeType: record.mimeType, size: record.size, expireAt: new Date(record.expireAt * 1000).toISOString().replace('.000Z', 'Z') };
}
