/**
 * 文件盒子 · 端到端加密模块
 * - HTTPS / localhost：使用浏览器原生 WebCrypto（AES-256-GCM，硬件加速）
 * - HTTP：自动回退到内置纯 JS 实现（同算法同格式，密文完全互通）
 * - 密文块格式：[4字节明文长度(大端)][12字节随机IV][密文(含16字节校验)]
 */
(function (global) {
  'use strict';

  const SECRET = 'FileBox::e2ee::v1::2026'; // 内置口令（仅存在于浏览器端，与服务端无关）
  const KDF_SALT = 'FileBox::kdf::v1';
  const KDF_ITER = 120000;
  const JS_CHUNK = 512 * 1024;          // 纯 JS 引擎分块（小块，避免页面卡顿）
  const NATIVE_CHUNK = 4 * 1024 * 1024; // 原生引擎分块

  const hasNative = !!(global.crypto && global.crypto.subtle);
  let useNative = hasNative; // 测试时可切换引擎
  const te = new TextEncoder();
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ================= GF(2^8) =================
  function xt(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }

  // AES S-box（程序生成：GF(2^8) 逆元 + 仿射变换，避免手抄错误）
  const SBOX = (function () {
    const exp = new Uint8Array(255), log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x = xt(x) ^ x; } // x *= 3（生成元）
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const inv = i ? exp[(255 - log[i]) % 255] : 0;
      let r = 0;
      for (let b = 0; b < 8; b++) {
        const bit = ((inv >> b) & 1) ^ ((inv >> ((b + 4) & 7)) & 1) ^ ((inv >> ((b + 5) & 7)) & 1)
          ^ ((inv >> ((b + 6) & 7)) & 1) ^ ((inv >> ((b + 7) & 7)) & 1) ^ ((0x63 >> b) & 1);
        r |= bit << b;
      }
      s[i] = r;
    }
    return s;
  })();

  // ================= SHA-256 / HMAC / PBKDF2（纯 JS） =================
  const K256 = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(msg) {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const l = msg.length;
    const total = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(msg); buf[l] = 0x80;
    const bl = l * 8; // 本模块中消息长度远小于 2^32 位
    buf[total - 4] = (bl >>> 24) & 255; buf[total - 3] = (bl >>> 16) & 255;
    buf[total - 2] = (bl >>> 8) & 255; buf[total - 1] = bl & 255;
    const dv = new DataView(buf.buffer);
    const w = new Int32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => odv.setInt32(i * 4, x, false));
    return out;
  }

  function uconcat(a, b) {
    const r = new Uint8Array(a.length + b.length);
    r.set(a); r.set(b, a.length);
    return r;
  }

  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const b = i < key.length ? key[i] : 0;
      ipad[i] = b ^ 0x36; opad[i] = b ^ 0x5c;
    }
    return sha256(uconcat(opad, sha256(uconcat(ipad, msg))));
  }

  function pbkdf2Sha256(pw, salt, iter) {
    const block = new Uint8Array(salt.length + 4);
    block.set(salt);
    block[salt.length + 3] = 1; // INT(1) 大端
    let u = hmacSha256(pw, block);
    const out = Uint8Array.from(u);
    for (let i = 1; i < iter; i++) {
      u = hmacSha256(pw, u);
      for (let j = 0; j < 32; j++) out[j] ^= u[j];
    }
    return out;
  }

  // ================= AES-256（纯 JS） =================
  function expandKey256(key) { // key: Uint8Array(32) → 60 words
    const w = new Uint32Array(60);
    for (let i = 0; i < 8; i++) {
      w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    let rcon = 1;
    const sub = (t) => ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16)
      | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
    for (let i = 8; i < 60; i++) {
      let t = w[i - 1];
      if (i % 8 === 0) {
        t = sub(((t << 8) | (t >>> 24)) >>> 0) ^ ((rcon << 24) >>> 0);
        rcon = xt(rcon);
      } else if (i % 8 === 4) {
        t = sub(t);
      }
      w[i] = (w[i - 8] ^ t) >>> 0;
    }
    return w;
  }

  function encBlock(rk, src) { // rk: 60 words; src: 16B → 新 16B
    const s = Uint8Array.from(src);
    const ark = (r) => {
      const b = r * 4;
      for (let i = 0; i < 16; i++) s[i] ^= (rk[b + (i >> 2)] >>> (24 - 8 * (i & 3))) & 255;
    };
    const shiftRows = () => {
      let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    };
    ark(0);
    for (let r = 1; r <= 13; r++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      shiftRows();
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c]     = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3;
        s[c + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3;
        s[c + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3;
        s[c + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3);
      }
      ark(r);
    }
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows();
    ark(14);
    return s;
  }

  // ================= GCM（纯 JS） =================
  function pmulM(a, b) { // GCM 字节位序（MSB=x^0）的 8 位多项式乘 → 16 位（bit15=x^0）
    let r = 0;
    for (let i = 0; i < 8; i++) {
      if ((a >> (7 - i)) & 1) {
        for (let j = 0; j < 8; j++) {
          if ((b >> (7 - j)) & 1) r ^= 1 << (15 - (i + j));
        }
      }
    }
    return r >>> 0;
  }

  // GHASH 8-bit 查表：M[b] = b·H；R[b] = b·R（R = 0xE1<<120，约减多项式）
  function makeGhTables(H) {
    // R 表：b(x)·R(x)，结果落在块 byte0-1（word0 高 16 位）
    const R = new Uint32Array(256 * 4);
    for (let b = 1; b < 256; b++) {
      R[b * 4] = (pmulM(b, 0xe1) << 16) >>> 0;
    }
    // M 表：M[b] = b(x)·H。注意字节内位序：MSB = x^0、LSB = x^7
    // M[128]（x^0）= H；M[1<<j] = M[1<<(j+1)]·x（右移一位）；其余按位分解 XOR
    const M = new Uint32Array(256 * 4);
    for (let i = 0; i < 4; i++) {
      M[128 * 4 + i] = ((H[4 * i] << 24) | (H[4 * i + 1] << 16) | (H[4 * i + 2] << 8) | H[4 * i + 3]) >>> 0;
    }
    for (let j = 6; j >= 0; j--) { // M[1<<j] = M[1<<(j+1)]·x
      const src = (1 << (j + 1)) * 4, dst = (1 << j) * 4;
      const c = M[src + 3] & 1; // bit127 溢出
      M[dst + 3] = ((M[src + 3] >>> 1) | ((M[src + 2] & 1) << 31)) >>> 0;
      M[dst + 2] = ((M[src + 2] >>> 1) | ((M[src + 1] & 1) << 31)) >>> 0;
      M[dst + 1] = ((M[src + 1] >>> 1) | ((M[src] & 1) << 31)) >>> 0;
      M[dst] = M[src] >>> 1;
      if (c) M[dst] = (M[dst] ^ 0xe1000000) >>> 0;
    }
    for (let b = 3; b < 256; b++) {
      if ((b & (b - 1)) === 0) continue; // 2 的幂已处理
      const low = b & -b, base = b ^ low;
      for (let i = 0; i < 4; i++) M[b * 4 + i] = (M[base * 4 + i] ^ M[low * 4 + i]) >>> 0;
    }
    return { M, R };
  }

  function ghash(tab, data) { // data 长度为 16 的倍数 → Uint8Array(16)
    const Y = new Uint8Array(16);
    const ydv = new DataView(Y.buffer); // 大端写回
    const Z = new Uint32Array(4);
    for (let off = 0; off < data.length; off += 16) {
      Z[0] = Z[1] = Z[2] = Z[3] = 0;
      for (let i = 15; i >= 0; i--) { // 高字节（byte15）在前的 Horner 法
        // Z·x^8：byte0 是低位端，乘 x^8 = 块值右移一字节，byte15 溢出需约减
        const carry = Z[3] & 0xff;
        Z[3] = (((Z[2] & 0xff) << 24) | (Z[3] >>> 8)) >>> 0;
        Z[2] = (((Z[1] & 0xff) << 24) | (Z[2] >>> 8)) >>> 0;
        Z[1] = (((Z[0] & 0xff) << 24) | (Z[1] >>> 8)) >>> 0;
        Z[0] = (Z[0] >>> 8) >>> 0;
        if (carry) {
          // carry·R 落在 byte0-1（word0 的高 16 位）
          Z[0] = (Z[0] ^ tab.R[carry * 4]) >>> 0;
        }
        const b = data[off + i] ^ Y[i];
        Z[0] = (Z[0] ^ tab.M[b * 4]) >>> 0;
        Z[1] = (Z[1] ^ tab.M[b * 4 + 1]) >>> 0;
        Z[2] = (Z[2] ^ tab.M[b * 4 + 2]) >>> 0;
        Z[3] = (Z[3] ^ tab.M[b * 4 + 3]) >>> 0;
      }
      ydv.setUint32(0, Z[0], false); ydv.setUint32(4, Z[1], false);
      ydv.setUint32(8, Z[2], false); ydv.setUint32(12, Z[3], false);
    }
    return Y;
  }

  function inc32(b) { // 最后 4 字节大端 +1
    b[15] = (b[15] + 1) & 255; if (b[15]) return;
    b[14] = (b[14] + 1) & 255; if (b[14]) return;
    b[13] = (b[13] + 1) & 255; if (b[13]) return;
    b[12] = (b[12] + 1) & 255;
  }

  const ZERO16 = new Uint8Array(16);

  function jsGcmSeal(key, iv, pt) { // → { ct, tag }
    const rk = expandKey256(key);
    const H = encBlock(rk, ZERO16);
    const tab = makeGhTables(H);
    const ct = new Uint8Array(pt.length);
    const cb = new Uint8Array(16); cb.set(iv); cb[15] = 1; inc32(cb); // CB_1 = inc32(J0)
    for (let off = 0; off < pt.length; off += 16) {
      const ks = encBlock(rk, cb);
      const n = Math.min(16, pt.length - off);
      for (let i = 0; i < n; i++) ct[off + i] = pt[off + i] ^ ks[i];
      inc32(cb);
    }
    // GHASH: ct（补齐 16 倍数）|| [len(C) 位数 64BE]
    const padLen = (ct.length + 15) & ~15;
    const ghData = new Uint8Array(padLen + 16);
    ghData.set(ct);
    const bits = ct.length * 8;
    ghData[padLen + 12] = (bits >>> 24) & 255; ghData[padLen + 13] = (bits >>> 16) & 255;
    ghData[padLen + 14] = (bits >>> 8) & 255; ghData[padLen + 15] = bits & 255;
    const S = ghash(tab, ghData);
    const j0 = new Uint8Array(16); j0.set(iv); j0[15] = 1;
    const ej0 = encBlock(rk, j0);
    const tag = new Uint8Array(16);
    for (let i = 0; i < 16; i++) tag[i] = ej0[i] ^ S[i];
    return { ct, tag };
  }

  function jsGcmOpen(key, iv, ct, tag) { // 校验并解密 → Uint8Array
    const rk = expandKey256(key);
    const H = encBlock(rk, ZERO16);
    const tab = makeGhTables(H);
    const padLen = (ct.length + 15) & ~15;
    const ghData = new Uint8Array(padLen + 16);
    ghData.set(ct);
    const bits = ct.length * 8;
    ghData[padLen + 12] = (bits >>> 24) & 255; ghData[padLen + 13] = (bits >>> 16) & 255;
    ghData[padLen + 14] = (bits >>> 8) & 255; ghData[padLen + 15] = bits & 255;
    const S = ghash(tab, ghData);
    const j0 = new Uint8Array(16); j0.set(iv); j0[15] = 1;
    const ej0 = encBlock(rk, j0);
    for (let i = 0; i < 16; i++) {
      if ((ej0[i] ^ S[i]) !== tag[i]) throw new Error('数据校验失败');
    }
    const pt = new Uint8Array(ct.length);
    const cb = new Uint8Array(16); cb.set(iv); cb[15] = 1; inc32(cb); // CB_1 = inc32(J0)
    for (let off = 0; off < ct.length; off += 16) {
      const ks = encBlock(rk, cb);
      const n = Math.min(16, ct.length - off);
      for (let i = 0; i < n; i++) pt[off + i] = ct[off + i] ^ ks[i];
      inc32(cb);
    }
    return pt;
  }

  // ================= 原生引擎密钥（PBKDF2 → AES-256-GCM） =================
  let nativeKeyPromise = null;
  function nativeKey() {
    if (!nativeKeyPromise) {
      nativeKeyPromise = global.crypto.subtle
        .importKey('raw', te.encode(SECRET), 'PBKDF2', false, ['deriveBits'])
        .then((bm) => global.crypto.subtle.deriveBits(
          { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(KDF_SALT), iterations: KDF_ITER },
          bm, 256))
        .then((bits) => global.crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    }
    return nativeKeyPromise;
  }

  let jsKeyPromise = null;
  function jsKey() {
    if (!jsKeyPromise) {
      jsKeyPromise = new Promise((resolve) => {
        setTimeout(() => resolve(pbkdf2Sha256(te.encode(SECRET), te.encode(KDF_SALT), KDF_ITER)), 0);
      });
    }
    return jsKeyPromise;
  }

  // ================= 统一 API =================
  const api = {
    engine: hasNative ? 'native' : 'js',
    CHUNK: hasNative ? NATIVE_CHUNK : JS_CHUNK,

    /** 加密一段数据（单块，适合清单等小数据） */
    async encryptBytes(u8) {
      const iv = global.crypto.getRandomValues(new Uint8Array(12));
      let ct;
      if (useNative && hasNative) {
        ct = new Uint8Array(await global.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await nativeKey(), u8));
      } else {
        const r = jsGcmSeal(await jsKey(), iv, u8);
        ct = uconcat(r.ct, r.tag);
      }
      const out = new Uint8Array(16 + ct.length);
      new DataView(out.buffer).setUint32(0, u8.length);
      out.set(iv, 4);
      out.set(ct, 16);
      return out;
    },

    /** 解密单块（格式与 encryptBytes 输出一致） */
    async decryptBytes(buf) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
      const iv = buf.subarray(4, 16);
      const ct = buf.subarray(16);
      let pt;
      if (useNative && hasNative) {
        pt = new Uint8Array(await global.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await nativeKey(), ct));
      } else {
        pt = jsGcmOpen(await jsKey(), iv, ct.subarray(0, ct.length - 16), ct.subarray(ct.length - 16));
      }
      if (pt.length !== len) throw new Error('数据校验失败');
      return pt;
    },

    /** 分块加密整个文件 → 密文 Blob（内存友好，大文件自动分块） */
    async encryptFile(file, onProg) {
      const parts = [];
      if (!file.size) {
        parts.push(await api.encryptBytes(new Uint8Array(0)));
        onProg && onProg(100);
      } else {
        for (let off = 0; off < file.size; off += api.CHUNK) {
          const buf = new Uint8Array(await file.slice(off, off + api.CHUNK).arrayBuffer());
          parts.push(await api.encryptBytes(buf));
          onProg && onProg(Math.min(100, Math.ceil((off + api.CHUNK) / file.size * 100)));
          await tick(); // 让出主线程，进度条不卡
        }
      }
      return new Blob(parts);
    },

    /** 流式解密（边下载边解密）→ 明文 Blob；onByte(已处理字节数) */
    async decryptStream(body, onByte) {
      const reader = body.getReader();
      let buf = new Uint8Array(0);
      const readExact = async (n) => {
        while (buf.length < n) {
          const r = await reader.read();
          if (r.done) throw new Error('数据不完整');
          const nb = new Uint8Array(buf.length + r.value.length);
          nb.set(buf); nb.set(r.value, buf.length);
          buf = nb;
        }
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
      };
      const parts = [];
      let done = 0;
      for (;;) {
        if (!buf.length) {
          const r = await reader.read();
          if (r.done) break;
          buf = r.value;
          continue;
        }
        const head = await readExact(4);
        const len = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
        const iv = await readExact(12);
        const ct = await readExact(len + 16);
        done += 16 + len + 16;
        const block = new Uint8Array(16 + len + 16);
        block.set(head, 0); block.set(iv, 4); block.set(ct, 16);
        parts.push(await api.decryptBytes(block));
        onByte && onByte(done);
        await tick();
      }
      return new Blob(parts);
    },

    /** 测试钩子（生产无副作用） */
    _test: {
      sha256, pbkdf2Sha256, jsGcmSeal, jsGcmOpen, expandKey256, encBlock, ghash, makeGhTables,
      setEngine(name) { useNative = name === 'native' && hasNative; },
      get useNative() { return useNative && hasNative; },
    },
  };

  global.FBCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
