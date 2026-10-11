// Incremental XXH32 using only JS 32-bit arithmetic; no BigInt or WASM.
// Algorithm reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;
const rotl = (value, bits) => (value << bits) | (value >>> (32 - bits));
const round = (accumulator, lane) => Math.imul(rotl((accumulator + Math.imul(lane, P2)) | 0, 13), P1);

export class XXHash32 {
  constructor(seed = 0) {
    this.seed = seed | 0;
    this.v1 = (seed + P1 + P2) | 0; this.v2 = (seed + P2) | 0;
    this.v3 = seed | 0; this.v4 = (seed - P1) | 0;
    this.length = 0; this.used = 0; this.tail = new Uint8Array(16);
  }
  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.used + bytes.length < 16) {
      this.tail.set(bytes, this.used); this.used += bytes.length; return;
    }
    let v1 = this.v1, v2 = this.v2, v3 = this.v3, v4 = this.v4;
    if (this.used) {
      const take = 16 - this.used;
      this.tail.set(bytes.subarray(0, take), this.used); offset = take;
      const view = new DataView(this.tail.buffer);
      v1 = round(v1, view.getUint32(0, true)); v2 = round(v2, view.getUint32(4, true));
      v3 = round(v3, view.getUint32(8, true)); v4 = round(v4, view.getUint32(12, true));
      this.used = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (; offset + 16 <= bytes.length; offset += 16) {
      v1 = round(v1, view.getUint32(offset, true)); v2 = round(v2, view.getUint32(offset + 4, true));
      v3 = round(v3, view.getUint32(offset + 8, true)); v4 = round(v4, view.getUint32(offset + 12, true));
    }
    this.v1 = v1; this.v2 = v2; this.v3 = v3; this.v4 = v4;
    this.used = bytes.length - offset;
    this.tail.set(bytes.subarray(offset));
  }
  digest() {
    let hash = this.length >= 16
      ? (rotl(this.v1, 1) + rotl(this.v2, 7) + rotl(this.v3, 12) + rotl(this.v4, 18)) | 0
      : (this.seed + P5) | 0;
    hash = (hash + this.length) | 0;
    const view = new DataView(this.tail.buffer);
    let offset = 0;
    for (; offset + 4 <= this.used; offset += 4) hash = Math.imul(rotl((hash + Math.imul(view.getUint32(offset, true), P3)) | 0, 17), P4);
    for (; offset < this.used; offset++) hash = Math.imul(rotl((hash + Math.imul(this.tail[offset], P5)) | 0, 11), P1);
    hash ^= hash >>> 15; hash = Math.imul(hash, P2);
    hash ^= hash >>> 13; hash = Math.imul(hash, P3); hash ^= hash >>> 16;
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
