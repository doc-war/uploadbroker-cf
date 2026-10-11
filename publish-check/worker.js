var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../node_modules/blakejs/util.js
var require_util = __commonJS({
  "../node_modules/blakejs/util.js"(exports, module) {
    var ERROR_MSG_INPUT = "Input must be an string, Buffer or Uint8Array";
    function normalizeInput(input) {
      let ret;
      if (input instanceof Uint8Array) {
        ret = input;
      } else if (typeof input === "string") {
        const encoder2 = new TextEncoder();
        ret = encoder2.encode(input);
      } else {
        throw new Error(ERROR_MSG_INPUT);
      }
      return ret;
    }
    __name(normalizeInput, "normalizeInput");
    function toHex(bytes) {
      return Array.prototype.map.call(bytes, function(n) {
        return (n < 16 ? "0" : "") + n.toString(16);
      }).join("");
    }
    __name(toHex, "toHex");
    function uint32ToHex(val) {
      return (4294967296 + val).toString(16).substring(1);
    }
    __name(uint32ToHex, "uint32ToHex");
    function debugPrint(label, arr, size) {
      let msg = "\n" + label + " = ";
      for (let i = 0; i < arr.length; i += 2) {
        if (size === 32) {
          msg += uint32ToHex(arr[i]).toUpperCase();
          msg += " ";
          msg += uint32ToHex(arr[i + 1]).toUpperCase();
        } else if (size === 64) {
          msg += uint32ToHex(arr[i + 1]).toUpperCase();
          msg += uint32ToHex(arr[i]).toUpperCase();
        } else throw new Error("Invalid size " + size);
        if (i % 6 === 4) {
          msg += "\n" + new Array(label.length + 4).join(" ");
        } else if (i < arr.length - 2) {
          msg += " ";
        }
      }
      console.log(msg);
    }
    __name(debugPrint, "debugPrint");
    function testSpeed(hashFn, N, M) {
      let startMs = (/* @__PURE__ */ new Date()).getTime();
      const input = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        input[i] = i % 256;
      }
      const genMs = (/* @__PURE__ */ new Date()).getTime();
      console.log("Generated random input in " + (genMs - startMs) + "ms");
      startMs = genMs;
      for (let i = 0; i < M; i++) {
        const hashHex = hashFn(input);
        const hashMs = (/* @__PURE__ */ new Date()).getTime();
        const ms = hashMs - startMs;
        startMs = hashMs;
        console.log("Hashed in " + ms + "ms: " + hashHex.substring(0, 20) + "...");
        console.log(
          Math.round(N / (1 << 20) / (ms / 1e3) * 100) / 100 + " MB PER SECOND"
        );
      }
    }
    __name(testSpeed, "testSpeed");
    module.exports = {
      normalizeInput,
      toHex,
      debugPrint,
      testSpeed
    };
  }
});

// ../node_modules/blakejs/blake2b.js
var require_blake2b = __commonJS({
  "../node_modules/blakejs/blake2b.js"(exports, module) {
    var util = require_util();
    function ADD64AA(v2, a, b) {
      const o0 = v2[a] + v2[b];
      let o1 = v2[a + 1] + v2[b + 1];
      if (o0 >= 4294967296) {
        o1++;
      }
      v2[a] = o0;
      v2[a + 1] = o1;
    }
    __name(ADD64AA, "ADD64AA");
    function ADD64AC(v2, a, b0, b1) {
      let o0 = v2[a] + b0;
      if (b0 < 0) {
        o0 += 4294967296;
      }
      let o1 = v2[a + 1] + b1;
      if (o0 >= 4294967296) {
        o1++;
      }
      v2[a] = o0;
      v2[a + 1] = o1;
    }
    __name(ADD64AC, "ADD64AC");
    function B2B_GET32(arr, i) {
      return arr[i] ^ arr[i + 1] << 8 ^ arr[i + 2] << 16 ^ arr[i + 3] << 24;
    }
    __name(B2B_GET32, "B2B_GET32");
    function B2B_G(a, b, c, d, ix, iy) {
      const x0 = m[ix];
      const x1 = m[ix + 1];
      const y0 = m[iy];
      const y1 = m[iy + 1];
      ADD64AA(v, a, b);
      ADD64AC(v, a, x0, x1);
      let xor0 = v[d] ^ v[a];
      let xor1 = v[d + 1] ^ v[a + 1];
      v[d] = xor1;
      v[d + 1] = xor0;
      ADD64AA(v, c, d);
      xor0 = v[b] ^ v[c];
      xor1 = v[b + 1] ^ v[c + 1];
      v[b] = xor0 >>> 24 ^ xor1 << 8;
      v[b + 1] = xor1 >>> 24 ^ xor0 << 8;
      ADD64AA(v, a, b);
      ADD64AC(v, a, y0, y1);
      xor0 = v[d] ^ v[a];
      xor1 = v[d + 1] ^ v[a + 1];
      v[d] = xor0 >>> 16 ^ xor1 << 16;
      v[d + 1] = xor1 >>> 16 ^ xor0 << 16;
      ADD64AA(v, c, d);
      xor0 = v[b] ^ v[c];
      xor1 = v[b + 1] ^ v[c + 1];
      v[b] = xor1 >>> 31 ^ xor0 << 1;
      v[b + 1] = xor0 >>> 31 ^ xor1 << 1;
    }
    __name(B2B_G, "B2B_G");
    var BLAKE2B_IV32 = new Uint32Array([
      4089235720,
      1779033703,
      2227873595,
      3144134277,
      4271175723,
      1013904242,
      1595750129,
      2773480762,
      2917565137,
      1359893119,
      725511199,
      2600822924,
      4215389547,
      528734635,
      327033209,
      1541459225
    ]);
    var SIGMA8 = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      14,
      10,
      4,
      8,
      9,
      15,
      13,
      6,
      1,
      12,
      0,
      2,
      11,
      7,
      5,
      3,
      11,
      8,
      12,
      0,
      5,
      2,
      15,
      13,
      10,
      14,
      3,
      6,
      7,
      1,
      9,
      4,
      7,
      9,
      3,
      1,
      13,
      12,
      11,
      14,
      2,
      6,
      5,
      10,
      4,
      0,
      15,
      8,
      9,
      0,
      5,
      7,
      2,
      4,
      10,
      15,
      14,
      1,
      11,
      12,
      6,
      8,
      3,
      13,
      2,
      12,
      6,
      10,
      0,
      11,
      8,
      3,
      4,
      13,
      7,
      5,
      15,
      14,
      1,
      9,
      12,
      5,
      1,
      15,
      14,
      13,
      4,
      10,
      0,
      7,
      6,
      3,
      9,
      2,
      8,
      11,
      13,
      11,
      7,
      14,
      12,
      1,
      3,
      9,
      5,
      0,
      15,
      4,
      8,
      6,
      2,
      10,
      6,
      15,
      14,
      9,
      11,
      3,
      0,
      8,
      12,
      2,
      13,
      7,
      1,
      4,
      10,
      5,
      10,
      2,
      8,
      4,
      7,
      6,
      1,
      5,
      15,
      11,
      9,
      14,
      3,
      12,
      13,
      0,
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      14,
      10,
      4,
      8,
      9,
      15,
      13,
      6,
      1,
      12,
      0,
      2,
      11,
      7,
      5,
      3
    ];
    var SIGMA82 = new Uint8Array(
      SIGMA8.map(function(x) {
        return x * 2;
      })
    );
    var v = new Uint32Array(32);
    var m = new Uint32Array(32);
    function blake2bCompress(ctx, last) {
      let i = 0;
      for (i = 0; i < 16; i++) {
        v[i] = ctx.h[i];
        v[i + 16] = BLAKE2B_IV32[i];
      }
      v[24] = v[24] ^ ctx.t;
      v[25] = v[25] ^ ctx.t / 4294967296;
      if (last) {
        v[28] = ~v[28];
        v[29] = ~v[29];
      }
      for (i = 0; i < 32; i++) {
        m[i] = B2B_GET32(ctx.b, 4 * i);
      }
      for (i = 0; i < 12; i++) {
        B2B_G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1]);
        B2B_G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3]);
        B2B_G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5]);
        B2B_G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7]);
        B2B_G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9]);
        B2B_G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11]);
        B2B_G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13]);
        B2B_G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15]);
      }
      for (i = 0; i < 16; i++) {
        ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
      }
    }
    __name(blake2bCompress, "blake2bCompress");
    var parameterBlock = new Uint8Array([
      0,
      0,
      0,
      0,
      //  0: outlen, keylen, fanout, depth
      0,
      0,
      0,
      0,
      //  4: leaf length, sequential mode
      0,
      0,
      0,
      0,
      //  8: node offset
      0,
      0,
      0,
      0,
      // 12: node offset
      0,
      0,
      0,
      0,
      // 16: node depth, inner length, rfu
      0,
      0,
      0,
      0,
      // 20: rfu
      0,
      0,
      0,
      0,
      // 24: rfu
      0,
      0,
      0,
      0,
      // 28: rfu
      0,
      0,
      0,
      0,
      // 32: salt
      0,
      0,
      0,
      0,
      // 36: salt
      0,
      0,
      0,
      0,
      // 40: salt
      0,
      0,
      0,
      0,
      // 44: salt
      0,
      0,
      0,
      0,
      // 48: personal
      0,
      0,
      0,
      0,
      // 52: personal
      0,
      0,
      0,
      0,
      // 56: personal
      0,
      0,
      0,
      0
      // 60: personal
    ]);
    function blake2bInit(outlen, key, salt, personal) {
      if (outlen === 0 || outlen > 64) {
        throw new Error("Illegal output length, expected 0 < length <= 64");
      }
      if (key && key.length > 64) {
        throw new Error("Illegal key, expected Uint8Array with 0 < length <= 64");
      }
      if (salt && salt.length !== 16) {
        throw new Error("Illegal salt, expected Uint8Array with length is 16");
      }
      if (personal && personal.length !== 16) {
        throw new Error("Illegal personal, expected Uint8Array with length is 16");
      }
      const ctx = {
        b: new Uint8Array(128),
        h: new Uint32Array(16),
        t: 0,
        // input count
        c: 0,
        // pointer within buffer
        outlen
        // output length in bytes
      };
      parameterBlock.fill(0);
      parameterBlock[0] = outlen;
      if (key) parameterBlock[1] = key.length;
      parameterBlock[2] = 1;
      parameterBlock[3] = 1;
      if (salt) parameterBlock.set(salt, 32);
      if (personal) parameterBlock.set(personal, 48);
      for (let i = 0; i < 16; i++) {
        ctx.h[i] = BLAKE2B_IV32[i] ^ B2B_GET32(parameterBlock, i * 4);
      }
      if (key) {
        blake2bUpdate(ctx, key);
        ctx.c = 128;
      }
      return ctx;
    }
    __name(blake2bInit, "blake2bInit");
    function blake2bUpdate(ctx, input) {
      for (let i = 0; i < input.length; i++) {
        if (ctx.c === 128) {
          ctx.t += ctx.c;
          blake2bCompress(ctx, false);
          ctx.c = 0;
        }
        ctx.b[ctx.c++] = input[i];
      }
    }
    __name(blake2bUpdate, "blake2bUpdate");
    function blake2bFinal(ctx) {
      ctx.t += ctx.c;
      while (ctx.c < 128) {
        ctx.b[ctx.c++] = 0;
      }
      blake2bCompress(ctx, true);
      const out = new Uint8Array(ctx.outlen);
      for (let i = 0; i < ctx.outlen; i++) {
        out[i] = ctx.h[i >> 2] >> 8 * (i & 3);
      }
      return out;
    }
    __name(blake2bFinal, "blake2bFinal");
    function blake2b(input, key, outlen, salt, personal) {
      outlen = outlen || 64;
      input = util.normalizeInput(input);
      if (salt) {
        salt = util.normalizeInput(salt);
      }
      if (personal) {
        personal = util.normalizeInput(personal);
      }
      const ctx = blake2bInit(outlen, key, salt, personal);
      blake2bUpdate(ctx, input);
      return blake2bFinal(ctx);
    }
    __name(blake2b, "blake2b");
    function blake2bHex2(input, key, outlen, salt, personal) {
      const output = blake2b(input, key, outlen, salt, personal);
      return util.toHex(output);
    }
    __name(blake2bHex2, "blake2bHex");
    module.exports = {
      blake2b,
      blake2bHex: blake2bHex2,
      blake2bInit,
      blake2bUpdate,
      blake2bFinal
    };
  }
});

// ../node_modules/blakejs/blake2s.js
var require_blake2s = __commonJS({
  "../node_modules/blakejs/blake2s.js"(exports, module) {
    var util = require_util();
    function B2S_GET32(v2, i) {
      return v2[i] ^ v2[i + 1] << 8 ^ v2[i + 2] << 16 ^ v2[i + 3] << 24;
    }
    __name(B2S_GET32, "B2S_GET32");
    function B2S_G(a, b, c, d, x, y) {
      v[a] = v[a] + v[b] + x;
      v[d] = ROTR32(v[d] ^ v[a], 16);
      v[c] = v[c] + v[d];
      v[b] = ROTR32(v[b] ^ v[c], 12);
      v[a] = v[a] + v[b] + y;
      v[d] = ROTR32(v[d] ^ v[a], 8);
      v[c] = v[c] + v[d];
      v[b] = ROTR32(v[b] ^ v[c], 7);
    }
    __name(B2S_G, "B2S_G");
    function ROTR32(x, y) {
      return x >>> y ^ x << 32 - y;
    }
    __name(ROTR32, "ROTR32");
    var BLAKE2S_IV = new Uint32Array([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    var SIGMA = new Uint8Array([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      14,
      10,
      4,
      8,
      9,
      15,
      13,
      6,
      1,
      12,
      0,
      2,
      11,
      7,
      5,
      3,
      11,
      8,
      12,
      0,
      5,
      2,
      15,
      13,
      10,
      14,
      3,
      6,
      7,
      1,
      9,
      4,
      7,
      9,
      3,
      1,
      13,
      12,
      11,
      14,
      2,
      6,
      5,
      10,
      4,
      0,
      15,
      8,
      9,
      0,
      5,
      7,
      2,
      4,
      10,
      15,
      14,
      1,
      11,
      12,
      6,
      8,
      3,
      13,
      2,
      12,
      6,
      10,
      0,
      11,
      8,
      3,
      4,
      13,
      7,
      5,
      15,
      14,
      1,
      9,
      12,
      5,
      1,
      15,
      14,
      13,
      4,
      10,
      0,
      7,
      6,
      3,
      9,
      2,
      8,
      11,
      13,
      11,
      7,
      14,
      12,
      1,
      3,
      9,
      5,
      0,
      15,
      4,
      8,
      6,
      2,
      10,
      6,
      15,
      14,
      9,
      11,
      3,
      0,
      8,
      12,
      2,
      13,
      7,
      1,
      4,
      10,
      5,
      10,
      2,
      8,
      4,
      7,
      6,
      1,
      5,
      15,
      11,
      9,
      14,
      3,
      12,
      13,
      0
    ]);
    var v = new Uint32Array(16);
    var m = new Uint32Array(16);
    function blake2sCompress(ctx, last) {
      let i = 0;
      for (i = 0; i < 8; i++) {
        v[i] = ctx.h[i];
        v[i + 8] = BLAKE2S_IV[i];
      }
      v[12] ^= ctx.t;
      v[13] ^= ctx.t / 4294967296;
      if (last) {
        v[14] = ~v[14];
      }
      for (i = 0; i < 16; i++) {
        m[i] = B2S_GET32(ctx.b, 4 * i);
      }
      for (i = 0; i < 10; i++) {
        B2S_G(0, 4, 8, 12, m[SIGMA[i * 16 + 0]], m[SIGMA[i * 16 + 1]]);
        B2S_G(1, 5, 9, 13, m[SIGMA[i * 16 + 2]], m[SIGMA[i * 16 + 3]]);
        B2S_G(2, 6, 10, 14, m[SIGMA[i * 16 + 4]], m[SIGMA[i * 16 + 5]]);
        B2S_G(3, 7, 11, 15, m[SIGMA[i * 16 + 6]], m[SIGMA[i * 16 + 7]]);
        B2S_G(0, 5, 10, 15, m[SIGMA[i * 16 + 8]], m[SIGMA[i * 16 + 9]]);
        B2S_G(1, 6, 11, 12, m[SIGMA[i * 16 + 10]], m[SIGMA[i * 16 + 11]]);
        B2S_G(2, 7, 8, 13, m[SIGMA[i * 16 + 12]], m[SIGMA[i * 16 + 13]]);
        B2S_G(3, 4, 9, 14, m[SIGMA[i * 16 + 14]], m[SIGMA[i * 16 + 15]]);
      }
      for (i = 0; i < 8; i++) {
        ctx.h[i] ^= v[i] ^ v[i + 8];
      }
    }
    __name(blake2sCompress, "blake2sCompress");
    function blake2sInit(outlen, key) {
      if (!(outlen > 0 && outlen <= 32)) {
        throw new Error("Incorrect output length, should be in [1, 32]");
      }
      const keylen = key ? key.length : 0;
      if (key && !(keylen > 0 && keylen <= 32)) {
        throw new Error("Incorrect key length, should be in [1, 32]");
      }
      const ctx = {
        h: new Uint32Array(BLAKE2S_IV),
        // hash state
        b: new Uint8Array(64),
        // input block
        c: 0,
        // pointer within block
        t: 0,
        // input count
        outlen
        // output length in bytes
      };
      ctx.h[0] ^= 16842752 ^ keylen << 8 ^ outlen;
      if (keylen > 0) {
        blake2sUpdate(ctx, key);
        ctx.c = 64;
      }
      return ctx;
    }
    __name(blake2sInit, "blake2sInit");
    function blake2sUpdate(ctx, input) {
      for (let i = 0; i < input.length; i++) {
        if (ctx.c === 64) {
          ctx.t += ctx.c;
          blake2sCompress(ctx, false);
          ctx.c = 0;
        }
        ctx.b[ctx.c++] = input[i];
      }
    }
    __name(blake2sUpdate, "blake2sUpdate");
    function blake2sFinal(ctx) {
      ctx.t += ctx.c;
      while (ctx.c < 64) {
        ctx.b[ctx.c++] = 0;
      }
      blake2sCompress(ctx, true);
      const out = new Uint8Array(ctx.outlen);
      for (let i = 0; i < ctx.outlen; i++) {
        out[i] = ctx.h[i >> 2] >> 8 * (i & 3) & 255;
      }
      return out;
    }
    __name(blake2sFinal, "blake2sFinal");
    function blake2s(input, key, outlen) {
      outlen = outlen || 32;
      input = util.normalizeInput(input);
      const ctx = blake2sInit(outlen, key);
      blake2sUpdate(ctx, input);
      return blake2sFinal(ctx);
    }
    __name(blake2s, "blake2s");
    function blake2sHex(input, key, outlen) {
      const output = blake2s(input, key, outlen);
      return util.toHex(output);
    }
    __name(blake2sHex, "blake2sHex");
    module.exports = {
      blake2s,
      blake2sHex,
      blake2sInit,
      blake2sUpdate,
      blake2sFinal
    };
  }
});

// ../node_modules/blakejs/index.js
var require_blakejs = __commonJS({
  "../node_modules/blakejs/index.js"(exports, module) {
    var b2b = require_blake2b();
    var b2s = require_blake2s();
    module.exports = {
      blake2b: b2b.blake2b,
      blake2bHex: b2b.blake2bHex,
      blake2bInit: b2b.blake2bInit,
      blake2bUpdate: b2b.blake2bUpdate,
      blake2bFinal: b2b.blake2bFinal,
      blake2s: b2s.blake2s,
      blake2sHex: b2s.blake2sHex,
      blake2sInit: b2s.blake2sInit,
      blake2sUpdate: b2s.blake2sUpdate,
      blake2sFinal: b2s.blake2sFinal
    };
  }
});

// ../src/config.js
var MiB = 1024 * 1024;
function config(env) {
  const number = /* @__PURE__ */ __name((name, fallback, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
    return value;
  }, "number");
  const saltValue = env.url_blake2b_salts ?? [""];
  const salts = typeof saltValue === "string" ? JSON.parse(saltValue) : saltValue;
  if (!Array.isArray(salts) || salts.length < 1 || salts.length > 2 || salts.some((s) => typeof s !== "string")) throw new Error("invalid url_blake2b_salts");
  const baseURL = String(env.base_url ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseURL) || new URL(baseURL).search || new URL(baseURL).hash) throw new Error("invalid base_url");
  const prefix = env.url_prefix ?? "tmp";
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("invalid url_prefix");
  const limits = Object.fromEntries(["image", "audio", "video", "document", "archive"].map((category, i) => [category, number(`limit_${category}_mib`, [50, 5, 10, 5, 30][i], 90) * MiB]));
  const contentHash = env.content_hash ?? "sha256";
  if (!["sha256", "xxhash32"].includes(contentHash)) throw new Error("invalid content_hash");
  const cors = env.cors ?? true;
  if (typeof cors !== "boolean") throw new Error("invalid cors");
  if (env.hmac_secret !== void 0 && typeof env.hmac_secret !== "string") throw new Error("invalid hmac_secret");
  return {
    baseURL,
    prefix,
    salts,
    limits,
    maxBody: Math.max(...Object.values(limits)) + MiB,
    ttl: number("default_ttl_hours", 24, 24) * 3600,
    hmac: env.hmac_secret ?? "",
    cors,
    contentHash,
    version: env.version ?? "0.1.0",
    buildTime: env.build_time ?? ""
  };
}
__name(config, "config");

// ../src/errors.js
var BrokerError = class extends Error {
  static {
    __name(this, "BrokerError");
  }
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function failure(code, msg) {
  const status = code >= 5e4 ? 500 : code >= 40400 && code < 40500 ? 404 : code >= 4e4 ? 400 : 200;
  return Response.json({ code, msg }, { status });
}
__name(failure, "failure");

// ../src/hash.js
var import_blakejs = __toESM(require_blakejs(), 1);

// ../src/xxhash32.js
var P1 = 2654435761;
var P2 = 2246822519;
var P3 = 3266489917;
var P4 = 668265263;
var P5 = 374761393;
var rotl = /* @__PURE__ */ __name((value, bits) => value << bits | value >>> 32 - bits, "rotl");
var round = /* @__PURE__ */ __name((accumulator, lane) => Math.imul(rotl(accumulator + Math.imul(lane, P2) | 0, 13), P1), "round");
var XXHash32 = class {
  static {
    __name(this, "XXHash32");
  }
  constructor(seed = 0) {
    this.seed = seed | 0;
    this.v1 = seed + P1 + P2 | 0;
    this.v2 = seed + P2 | 0;
    this.v3 = seed | 0;
    this.v4 = seed - P1 | 0;
    this.length = 0;
    this.used = 0;
    this.tail = new Uint8Array(16);
  }
  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.used + bytes.length < 16) {
      this.tail.set(bytes, this.used);
      this.used += bytes.length;
      return;
    }
    let v1 = this.v1, v2 = this.v2, v3 = this.v3, v4 = this.v4;
    if (this.used) {
      const take = 16 - this.used;
      this.tail.set(bytes.subarray(0, take), this.used);
      offset = take;
      const view2 = new DataView(this.tail.buffer);
      v1 = round(v1, view2.getUint32(0, true));
      v2 = round(v2, view2.getUint32(4, true));
      v3 = round(v3, view2.getUint32(8, true));
      v4 = round(v4, view2.getUint32(12, true));
      this.used = 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (; offset + 16 <= bytes.length; offset += 16) {
      v1 = round(v1, view.getUint32(offset, true));
      v2 = round(v2, view.getUint32(offset + 4, true));
      v3 = round(v3, view.getUint32(offset + 8, true));
      v4 = round(v4, view.getUint32(offset + 12, true));
    }
    this.v1 = v1;
    this.v2 = v2;
    this.v3 = v3;
    this.v4 = v4;
    this.used = bytes.length - offset;
    this.tail.set(bytes.subarray(offset));
  }
  digest() {
    let hash = this.length >= 16 ? rotl(this.v1, 1) + rotl(this.v2, 7) + rotl(this.v3, 12) + rotl(this.v4, 18) | 0 : this.seed + P5 | 0;
    hash = hash + this.length | 0;
    const view = new DataView(this.tail.buffer);
    let offset = 0;
    for (; offset + 4 <= this.used; offset += 4) hash = Math.imul(rotl(hash + Math.imul(view.getUint32(offset, true), P3) | 0, 17), P4);
    for (; offset < this.used; offset++) hash = Math.imul(rotl(hash + Math.imul(this.tail[offset], P5) | 0, 11), P1);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, P2);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, P3);
    hash ^= hash >>> 16;
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
};

// ../src/hash.js
var { blake2bHex } = import_blakejs.default;
function newContentHasher(algorithm = "sha256") {
  if (algorithm === "xxhash32") {
    const hash = new XXHash32();
    return { update: /* @__PURE__ */ __name((bytes) => hash.update(bytes), "update"), digest: /* @__PURE__ */ __name(async () => `${hash.digest()}-${hash.length}`, "digest"), abort: /* @__PURE__ */ __name(async () => {
    }, "abort") };
  }
  const stream = new crypto.DigestStream("SHA-256");
  const writer = stream.getWriter();
  stream.digest.catch(() => {
  });
  return {
    update: /* @__PURE__ */ __name((bytes) => writer.write(bytes), "update"),
    async digest() {
      await writer.close();
      return hex(new Uint8Array(await stream.digest));
    },
    async abort() {
      await writer.abort().catch(() => {
      });
    }
  };
}
__name(newContentHasher, "newContentHasher");
function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");
function token(salt, key, expire) {
  const date = new Date(expire * 1e3).toISOString().slice(0, 19).replace(/[-T:]/g, "");
  return blake2bHex(`${salt}/${date}/${key}`, void 0, 32).slice(0, 16);
}
__name(token, "token");
function equal(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
__name(equal, "equal");
async function hmac(secret, text) {
  const encoder2 = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder2.encode(text))));
}
__name(hmac, "hmac");
function responseData(cfg, record) {
  return {
    url: `${cfg.baseURL}/${cfg.prefix}/${record.expireAt}/${record.key.slice(0, 2)}/${record.key}/${token(cfg.salts[0], record.key, record.expireAt)}${record.extension}`,
    mimeType: record.mimeType,
    size: record.size,
    expireAt: new Date(record.expireAt * 1e3).toISOString().replace(".000Z", "Z")
  };
}
__name(responseData, "responseData");

// ../src/multipart.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var invalid = /* @__PURE__ */ __name(() => new BrokerError(40001, "invalid multipart form"), "invalid");
function join(a, b) {
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a);
  bytes.set(b, a.length);
  return bytes;
}
__name(join, "join");
function find(bytes, pattern, start = 0) {
  outer: for (let i = bytes.indexOf(pattern[0], start); i >= 0 && i <= bytes.length - pattern.length; i = bytes.indexOf(pattern[0], i + 1)) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}
__name(find, "find");
function headers(bytes) {
  const text = decoder.decode(bytes);
  const lines = text.split("\r\n");
  const disposition = lines.find((line) => /^content-disposition:/i.test(line))?.split(":").slice(1).join(":").trim();
  if (!disposition || !/^form-data(?:;|$)/i.test(disposition)) throw invalid();
  const attrs = {};
  for (const match of disposition.matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\s]+))/g)) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, "$1");
  }
  if (!attrs.name) throw invalid();
  return { name: attrs.name, filename: attrs.filename };
}
__name(headers, "headers");
async function multipart(request, maxBody, handlers) {
  const contentType = request.headers.get("content-type") ?? "";
  const match = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary) || !request.body) throw invalid();
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBody) throw new BrokerError(40004, `max size ${maxBody} bytes`);
  const initial = encoder.encode(`--${boundary}\r
`);
  const delimiter = encoder.encode(`\r
--${boundary}`);
  const separator = encoder.encode("\r\n\r\n");
  let pending = new Uint8Array(0), state = "initial", total = 0, parts = 0;
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
          if (state === "done") {
            pending = new Uint8Array(0);
            break;
          }
          if (state === "initial") {
            if (pending.length < initial.length) break;
            if (find(pending, initial) !== 0) throw invalid();
            pending = pending.subarray(initial.length);
            state = "headers";
          } else if (state === "headers") {
            const end = find(pending, separator);
            if (end < 0) {
              if (pending.length > 8192) throw invalid();
              break;
            }
            if (end > 8192 || ++parts > 32) throw invalid();
            await handlers.start(headers(pending.subarray(0, end)));
            pending = pending.subarray(end + 4);
            state = "body";
          } else {
            let position = find(pending, delimiter);
            while (position >= 0 && pending.length >= position + delimiter.length + 2) {
              const suffix = pending.subarray(position + delimiter.length, position + delimiter.length + 2);
              if (suffix[0] === 13 && suffix[1] === 10 || suffix[0] === 45 && suffix[1] === 45) break;
              position = find(pending, delimiter, position + 1);
            }
            if (position >= 0 && pending.length >= position + delimiter.length + 2) {
              await handlers.data(pending.subarray(0, position));
              await handlers.end();
              const end = position + delimiter.length;
              state = pending[end] === 45 ? "done" : "headers";
              pending = pending.subarray(end + 2);
            } else {
              const safe = Math.max(0, pending.length - delimiter.length - 2);
              if (safe) {
                await handlers.data(pending.subarray(0, safe));
                pending = pending.slice(safe);
              }
              break;
            }
          }
        }
      }
    }
    if (state !== "done") throw invalid();
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}
__name(multipart, "multipart");

// ../src/mime.js
var textTypes = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  ini: "text/x-ini",
  conf: "text/x-config",
  sh: "text/x-shellscript",
  bash: "text/x-bash",
  go: "text/x-go",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-ch",
  cpp: "text/x-c++",
  hpp: "text/x-cpp-header",
  rs: "text/x-rust",
  rb: "text/x-ruby",
  php: "text/x-php",
  sql: "text/x-sql",
  csv: "text/csv",
  css: "text/css"
};
var binaryTypes = [
  ["image/png", "png", "image"],
  ["image/jpeg", "jpg", "image"],
  ["image/webp", "webp", "image"],
  ["audio/mpeg", "mp3", "audio"],
  ["audio/wav", "wav", "audio"],
  ["video/mp4", "mp4", "video"],
  ["video/webm", "webm", "video"],
  ["application/pdf", "pdf", "document"],
  ["application/zip", "zip", "archive"],
  ["application/x-7z-compressed", "7z", "archive"],
  ["application/x-rar-compressed", "rar", "archive"]
];
var known = Object.fromEntries([...binaryTypes.map(([mime, ext]) => [ext, mime]), ...Object.entries(textTypes), ["m4a", "audio/mp4"], ["aac", "audio/aac"]]);
function detect(filename, bytes) {
  if (!bytes.length) return null;
  const starts = /* @__PURE__ */ __name((signature) => signature.every((b, i) => bytes[i] === b), "starts");
  const ascii = /* @__PURE__ */ __name((offset, value) => startsAt(bytes, offset, value), "ascii");
  let mime;
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) mime = "image/png";
  else if (starts([255, 216, 255])) mime = "image/jpeg";
  else if (ascii(0, "RIFF") && ascii(8, "WEBPVP")) mime = "image/webp";
  else if (ascii(0, "RIFF") && ascii(8, "WAVE")) mime = "audio/wav";
  else if (starts([55, 122, 188, 175, 39, 28])) mime = "application/x-7z-compressed";
  else if (starts([82, 97, 114, 33, 26, 7])) mime = "application/x-rar-compressed";
  else if (ascii(0, "%PDF-")) mime = "application/pdf";
  else if (starts([80, 75, 3, 4])) mime = "application/zip";
  else if (ascii(0, "ID3")) mime = "audio/mpeg";
  else if (starts([26, 69, 223, 163])) mime = "video/webm";
  else if (bytes.length >= 12 && ascii(4, "ftyp")) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 12 && size % 4 === 0 && size <= bytes.length) {
      for (let i = 8; i < size; i += 4) if (i !== 12 && ascii(i, "mp4")) mime = "video/mp4";
    }
  }
  if (mime) {
    const [, ext2, category] = binaryTypes.find((row) => row[0] === mime);
    return { mimeType: mime, extension: `.${ext2}`, category };
  }
  const text = new TextDecoder().decode(bytes).replace(/^[\t\n\f\r ]+/, "");
  if (/^(?:<(?:!DOCTYPE HTML|HTML|HEAD|SCRIPT|IFRAME|H1|DIV|FONT|TABLE|A|STYLE|TITLE|B|BODY|BR|P)(?:[\s>])|<!--|<\?xml)/i.test(text)) return null;
  if (bytes.some((b) => b <= 8 || b === 11 || b >= 14 && b <= 26 || b >= 28 && b <= 31)) return null;
  const ext = filename.split(".").length > 1 ? filename.split(".").pop().toLowerCase() : "";
  if (["html", "htm", "svg", "xml"].includes(ext)) return null;
  return { mimeType: textTypes[ext] ?? "text/plain", extension: `.${textTypes[ext] ? ext : "txt"}`, category: "document" };
}
__name(detect, "detect");
function startsAt(bytes, offset, text) {
  return [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
}
__name(startsAt, "startsAt");
function validateExtension(filename, mime) {
  const ext = filename.includes(".") ? filename.split(".").pop() : "";
  return !known[ext] || known[ext] === mime;
}
__name(validateExtension, "validateExtension");

// ../src/storage.js
var PART_SIZE = 5 * MiB;
var INDEX = "index/";
var OBJECTS = "objects/";
var STAGING = "staging/";
var StagedFile = class {
  static {
    __name(this, "StagedFile");
  }
  constructor(bucket) {
    this.bucket = bucket;
    this.key = `${STAGING}${crypto.randomUUID()}`;
    this.buffer = null;
    this.used = 0;
    this.parts = [];
    this.upload = null;
    this.completed = false;
  }
  async write(bytes) {
    this.buffer ??= new Uint8Array(PART_SIZE);
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(PART_SIZE - this.used, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
      if (this.used === PART_SIZE) await this.flush();
    }
  }
  async flush() {
    if (!this.used) return;
    this.upload ??= await this.bucket.createMultipartUpload(this.key);
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.buffer.subarray(0, this.used)));
    this.used = 0;
  }
  async complete() {
    await this.flush();
    await this.upload.complete(this.parts);
    this.completed = true;
    this.buffer = null;
  }
  async dispose() {
    if (this.completed) await this.bucket.delete(this.key);
    else if (this.upload) await this.upload.abort();
    this.buffer = null;
  }
};
async function lookup(bucket, key) {
  const object = await bucket.get(`${INDEX}${key}`);
  return object ? { record: await object.json(), etag: object.etag } : null;
}
__name(lookup, "lookup");
async function reusable(bucket, entry, now, expectedSize) {
  return entry && entry.record.size === expectedSize && entry.record.expireAt - now >= 600 && await bucket.head(entry.record.storageKey) ? entry.record : null;
}
__name(reusable, "reusable");
async function commit(bucket, staged, record, now) {
  let entry = await lookup(bucket, record.key);
  const existing = await reusable(bucket, entry, now, record.size);
  if (existing) return existing;
  record.storageKey = `${OBJECTS}${record.key}/${record.expireAt}/${crypto.randomUUID()}`;
  const source = await bucket.get(staged.key);
  if (!source) throw new BrokerError(50001, "staged object missing");
  await bucket.put(record.storageKey, source.body, {
    httpMetadata: { contentType: record.mimeType },
    customMetadata: { expireAt: String(record.expireAt), key: record.key }
  });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const options = {
        onlyIf: entry ? { etagMatches: entry.etag } : { etagDoesNotMatch: "*" },
        customMetadata: { expireAt: String(record.expireAt) },
        httpMetadata: { contentType: "application/json" }
      };
      const result = await bucket.put(`${INDEX}${record.key}`, JSON.stringify(record), options);
      if (result) return record;
      entry = await lookup(bucket, record.key);
      const winner = await reusable(bucket, entry, now, record.size);
      if (winner) {
        await bucket.delete(record.storageKey);
        return winner;
      }
    }
    throw new BrokerError(50001, "concurrent upload conflict; retry upload");
  } catch (error) {
    await bucket.delete(record.storageKey);
    throw error;
  }
}
__name(commit, "commit");
async function cleanup(bucket, now = Math.floor(Date.now() / 1e3)) {
  let removed = 0;
  for (const prefix of [OBJECTS, STAGING]) {
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await bucket.list({ prefix, cursor, limit: 1e3, include: ["customMetadata"] });
      const expired = result.objects.filter((object) => prefix === STAGING ? object.uploaded.getTime() < (now - 3600) * 1e3 : Number(object.customMetadata?.expireAt) < now).map((object) => object.key);
      if (expired.length) {
        await bucket.delete(expired);
        removed += expired.length;
      }
      if (!result.truncated) break;
      cursor = result.cursor;
    }
  }
  return removed;
}
__name(cleanup, "cleanup");

// ../src/upload.js
async function upload(request, bucket, cfg) {
  const staged = new StagedFile(bucket), hasher = newContentHasher(cfg.contentHash);
  const fields = new URL(request.url).searchParams;
  let mode, field, fieldChunks, fieldSize, filename, seenFile = false, size = 0, type;
  let head = new Uint8Array(0);
  const inspect = /* @__PURE__ */ __name(() => {
    if (type) return;
    type = detect(filename, head);
    if (!type) throw new BrokerError(40003, "unsupported mime");
    if (!validateExtension(filename, type.mimeType)) throw new BrokerError(40006, `mime mismatch: declared extension does not match ${type.mimeType}`);
  }, "inspect");
  const consume = /* @__PURE__ */ __name(async (bytes) => {
    size += bytes.length;
    if (size > Math.max(...Object.values(cfg.limits))) throw new BrokerError(40004, "file too large");
    await hasher.update(bytes);
    if (head.length < 512) {
      const take = bytes.subarray(0, 512 - head.length);
      const next = new Uint8Array(head.length + take.length);
      next.set(head);
      next.set(take, head.length);
      head = next;
    }
    if (head.length === 512) inspect();
    if (type && size > cfg.limits[type.category]) throw new BrokerError(40004, `max size ${cfg.limits[type.category]} bytes`);
    try {
      await staged.write(bytes);
    } catch {
      throw new BrokerError(50001, "storage upload failed");
    }
  }, "consume");
  try {
    await multipart(request, cfg.maxBody, {
      async start(part) {
        mode = "ignore";
        if (part.filename !== void 0 && part.filename !== "" && part.name === "file" && !seenFile) {
          seenFile = true;
          filename = part.filename.split(/[\\/]/).pop();
          mode = "file";
        } else if (part.filename === void 0) {
          mode = "field";
          field = part.name;
          fieldChunks = [];
          fieldSize = 0;
        }
      },
      async data(bytes) {
        if (mode === "file") await consume(bytes);
        else if (mode === "field") {
          fieldSize += bytes.length;
          if (fieldSize > 4096) throw new BrokerError(40001, "form field too large");
          fieldChunks.push(bytes.slice());
        }
      },
      async end() {
        if (mode === "file") {
          if (!size) throw new BrokerError(40002, "empty file");
          inspect();
          if (size > cfg.limits[type.category]) throw new BrokerError(40004, `max size ${cfg.limits[type.category]} bytes`);
        } else if (mode === "field" && !fields.has(field)) {
          const value = new Uint8Array(fieldSize);
          let offset = 0;
          for (const chunk of fieldChunks) {
            value.set(chunk, offset);
            offset += chunk.length;
          }
          fields.set(field, new TextDecoder().decode(value));
        }
      }
    });
    if (cfg.hmac) {
      if (!fields.get("sign") || !fields.get("timestamp")) throw new BrokerError(5e4, "missing sign or timestamp");
      if (!equal(await hmac(cfg.hmac, fields.get("timestamp")), fields.get("sign"))) throw new BrokerError(5e4, "invalid sign");
    }
    if (!seenFile) throw new BrokerError(40001, "missing file");
    let ttl = cfg.ttl;
    if (fields.get("expires")) {
      const hours = fields.get("expires");
      if (!/^[+-]?\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 24) throw new BrokerError(40005, "expires 1-24");
      ttl = Number(hours) * 3600;
    }
    const now = Math.floor(Date.now() / 1e3);
    const record = { key: await hasher.digest(), contentHash: cfg.contentHash, ...type, size, createdAt: now, expireAt: now + ttl };
    try {
      const existing = await reusable(bucket, await lookup(bucket, record.key), now, record.size);
      if (existing) return Response.json({ code: 0, data: responseData(cfg, existing) });
      await staged.complete();
      return Response.json({ code: 0, data: responseData(cfg, await commit(bucket, staged, record, now)) });
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(50001, "storage write failed");
    }
  } finally {
    await hasher.abort();
    await staged.dispose().catch((error) => console.error("staging cleanup failed", error.message));
  }
}
__name(upload, "upload");

// ../src/worker.js
async function read(request, bucket, cfg) {
  const parts = new URL(request.url).pathname.split("/");
  if (parts.length !== 6) throw new BrokerError(40401, "invalid url");
  const [, , expiry, shard, key, signature] = parts;
  const match = /^([0-9a-f]{16})(\.[a-z0-9+_-]+)$/.exec(signature);
  const expire = Number(expiry);
  if (!/^\d+$/.test(expiry) || !Number.isSafeInteger(expire) || expire > 253402300799 || !/^(?:[0-9a-f]{64}|[0-9a-f]{8}-[1-9][0-9]{0,8})$/.test(key) || shard !== key.slice(0, 2) || !match) throw new BrokerError(40401, "invalid url");
  if (!cfg.salts.some((salt) => equal(token(salt, key, expire), match[1]))) throw new BrokerError(40401, "invalid token");
  const now = Math.floor(Date.now() / 1e3);
  if (expire <= now) throw new BrokerError(40402, "resource expired");
  const entry = await lookup(bucket, key);
  if (!entry || entry.record.expireAt <= now) throw new BrokerError(40402, "resource not found");
  const record = entry.record;
  if (match[2] !== record.extension) throw new BrokerError(40401, "extension mismatch");
  const object = await bucket.get(record.storageKey);
  if (!object) throw new BrokerError(40402, "resource not found");
  return new Response(object.body, { headers: {
    "Content-Type": record.mimeType,
    "Content-Length": String(object.size),
    "Cache-Control": `public, max-age=${Math.min(3600, expire - now, record.expireAt - now)}, must-revalidate`,
    "X-Content-Type-Options": "nosniff"
  } });
}
__name(read, "read");
async function health(bucket, cfg) {
  try {
    let cursor, activeCount = 0;
    const now = Math.floor(Date.now() / 1e3);
    for (let page = 0; page < 10; page++) {
      const result = await bucket.list({ prefix: INDEX, cursor, limit: 1e3, include: ["customMetadata"] });
      activeCount += result.objects.filter((object) => Number(object.customMetadata?.expireAt) > now).length;
      if (!result.truncated) break;
      if (page === 9) activeCount = -1;
      cursor = result.cursor;
    }
    return Response.json({ version: cfg.version, status: "ok", storage: "ok", sqlite: "not applicable (R2 metadata)", activeCount, time: cfg.buildTime });
  } catch {
    return Response.json({ version: cfg.version, status: "degraded", storage: "R2 unavailable", sqlite: "not applicable (R2 metadata)", activeCount: -1, time: cfg.buildTime }, { status: 503 });
  }
}
__name(health, "health");
var worker_default = {
  async fetch(request, env) {
    let cfg, response;
    try {
      cfg = config(env);
      if (!env.bucket) throw new Error("missing bucket binding");
      const path = new URL(request.url).pathname;
      if (cfg.cors && request.method === "OPTIONS") response = new Response(null, { status: 204 });
      else if (path === "/v1/health") response = await health(env.bucket, cfg);
      else if (path === "/v1/upload") {
        if (request.method !== "POST") throw new BrokerError(40500, "method not allowed");
        response = await upload(request, env.bucket, cfg);
      } else if (path.startsWith(`/${cfg.prefix}/`)) {
        if (request.method !== "GET") throw new BrokerError(40500, "method not allowed");
        response = await read(request, env.bucket, cfg);
      } else response = new Response("404 page not found\n", { status: 404 });
    } catch (error) {
      if (error instanceof BrokerError) response = failure(error.code, error.message);
      else {
        console.error("request failed", error.message);
        response = failure(5e4, "internal error");
      }
    }
    if (cfg?.cors) {
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
      response.headers.set("Access-Control-Max-Age", "86400");
    }
    return response;
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanup(env.bucket).then((count) => console.log(`cleanup: deleted=${count}`)));
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
