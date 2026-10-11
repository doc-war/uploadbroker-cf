import { BrokerError } from './errors.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const invalid = () => new BrokerError(40001, 'invalid multipart form');
function join(a, b) {
  const bytes = new Uint8Array(a.length + b.length); bytes.set(a); bytes.set(b, a.length); return bytes;
}
function find(bytes, pattern, start = 0) {
  outer: for (let i = bytes.indexOf(pattern[0], start); i >= 0 && i <= bytes.length - pattern.length; i = bytes.indexOf(pattern[0], i + 1)) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}
function headers(bytes) {
  const text = decoder.decode(bytes);
  const lines = text.split('\r\n');
  const disposition = lines.find(line => /^content-disposition:/i.test(line))?.split(':').slice(1).join(':').trim();
  if (!disposition || !/^form-data(?:;|$)/i.test(disposition)) throw invalid();
  const attrs = {};
  for (const match of disposition.matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g)) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
  }
  if (!attrs.name) throw invalid();
  return { name: attrs.name, filename: attrs.filename };
}
/** Sequential callbacks provide backpressure; no entire file or part is retained. */
export async function multipart(request, maxBody, handlers) {
  const contentType = request.headers.get('content-type') ?? '';
  const match = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary) || !request.body) throw invalid();
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBody) throw new BrokerError(40004, `max size ${maxBody} bytes`);
  const initial = encoder.encode(`--${boundary}\r\n`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const separator = encoder.encode('\r\n\r\n');
  let pending = new Uint8Array(0), state = 'initial', total = 0, parts = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBody) throw new BrokerError(40004, `max size ${maxBody} bytes`);
      for (let offset = 0; offset < value.length; offset += 65536) {
        pending = join(pending, value.subarray(offset, offset + 65536));
        while (true) {
          if (state === 'done') { pending = new Uint8Array(0); break; }
          if (state === 'initial') {
            if (pending.length < initial.length) break;
            if (find(pending, initial) !== 0) throw invalid();
            pending = pending.subarray(initial.length); state = 'headers';
          } else if (state === 'headers') {
            const end = find(pending, separator);
            if (end < 0) { if (pending.length > 8192) throw invalid(); break; }
            if (end > 8192 || ++parts > 32) throw invalid();
            await handlers.start(headers(pending.subarray(0, end)));
            pending = pending.subarray(end + 4); state = 'body';
          } else {
            let position = find(pending, delimiter);
            while (position >= 0 && pending.length >= position + delimiter.length + 2) {
              const suffix = pending.subarray(position + delimiter.length, position + delimiter.length + 2);
              if ((suffix[0] === 13 && suffix[1] === 10) || (suffix[0] === 45 && suffix[1] === 45)) break;
              position = find(pending, delimiter, position + 1);
            }
            if (position >= 0 && pending.length >= position + delimiter.length + 2) {
              await handlers.data(pending.subarray(0, position));
              await handlers.end();
              const end = position + delimiter.length;
              state = pending[end] === 45 ? 'done' : 'headers';
              pending = pending.subarray(end + 2);
            } else {
              const safe = Math.max(0, pending.length - delimiter.length - 2);
              if (safe) { await handlers.data(pending.subarray(0, safe)); pending = pending.slice(safe); }
              break;
            }
          }
        }
      }
    }
    if (state !== 'done') throw invalid();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
