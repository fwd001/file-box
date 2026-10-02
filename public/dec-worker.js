// 打包下载的解密工作线程。
// HTTP 访问（非安全上下文）时浏览器没有 WebCrypto，纯 JS AES-256-GCM 只有约 8MB/s，
// 且全在主线程上跑会把页面卡死；把分块解密派发到多个线程后可接近线性加速。
// 引擎与密钥都由主线程下发：线程之间用同一把密钥，避免每个线程各跑一次 12 万次 PBKDF2。
importScripts('crypto.js');

let pinned = null;
const used = () => (FBCrypto.native ? 'native' : 'js'); // 实际在用的引擎（engine 字段只表示能力）

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.engine && m.engine !== pinned) {
      FBCrypto._test.setEngine(m.engine);
      pinned = m.engine;
    }
    if (m.op === 'initKey') { FBCrypto.importJsKey(m.key); return; }
    if (m.op === 'deriveKey') {
      const key = await FBCrypto.exportJsKey();
      self.postMessage({ op: 'key', key, engine: used() });
      return;
    }
    const pt = await FBCrypto.decryptBytes(m.block);
    self.postMessage({ id: m.id, pt, engine: used() }, [pt.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, error: (err && err.message) || '解密失败', engine: used() });
  }
};
