const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const multer = require('multer');
const selfsigned = require('selfsigned');

const app = express();

// ---- 配置（均可通过环境变量覆盖） ----
const PORT = Number(process.env.PORT) || 3000;              // HTTP 端口（完整服务）
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;   // HTTPS 端口（传输层加密 + 原生加密引擎）
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const STORAGE_LIMIT_GB = Number(process.env.STORAGE_LIMIT_GB) || 10; // 存储总量上限
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 30;      // 超过 N 天的目录自动清理
const STORAGE_LIMIT = STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// 加密清单文件名（前端生成；列表计数时排除）
const MANIFEST = 'manifest.enc';

// ---- 基础目录（不存在会自动创建） ----
function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
ensureUploadDir();

// ---- 自签证书（首次启动自动生成，存入 .certs/，之后复用） ----
async function ensureCert() {
  const dir = path.join(__dirname, '.certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'file-box' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('[证书] 已自动生成自签证书（.certs/），浏览器首次访问需手动信任一次');
  return { key: pems.private, cert: pems.cert };
}

// ---- 工具函数 ----
/** 生成文件夹名：日期+时间，精确到分钟，如 20260923_1430 */
function folderName(now) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}`
  );
}

/** 创建不重名的上传目录（同一分钟内多次上传自动追加 _2、_3...；并发安全） */
function createUploadFolder() {
  const base = folderName(new Date());
  let name = base;
  let i = 1;
  for (;;) {
    try {
      fs.mkdirSync(path.join(UPLOAD_DIR, name));
      return name;
    } catch (err) {
      if (err.code === 'EEXIST') {
        name = `${base}_${++i}`; // 目录已存在，试试下一个序号
        continue;
      }
      throw err;
    }
  }
}

/** 文件名安全化：去掉路径分隔符，避免目录穿越 */
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[/\\]/g, '_').trim();
  return base === '.' || base === '..' || base === '' ? '' : base;
}

/** 修正 multer(busboy) 将文件名按 latin1 解析导致的中文乱码；纯 ASCII 名不受影响 */
function fixName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

// ---- 存储空间统计与过期清理 ----
/** 递归统计目录占用字节数 */
function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

/** 从目录名解析上传时间戳（仅识别 YYYYMMDD_HHmm 格式） */
function folderTime(name) {
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** 清理超过保留期的目录（自动运行：启动时、每 6 小时、每次上传前） */
function cleanupExpired() {
  ensureUploadDir();
  const now = Date.now();
  const removed = [];
  for (const d of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const t = folderTime(d.name);
    if (t !== null && now - t > RETENTION_MS) {
      fs.rmSync(path.join(UPLOAD_DIR, d.name), { recursive: true, force: true });
      removed.push(d.name);
    }
  }
  if (removed.length) {
    console.log(`[清理] 已自动删除超过 ${RETENTION_DAYS} 天的目录: ${removed.join(', ')}`);
  }
}
cleanupExpired();
setInterval(cleanupExpired, 6 * 60 * 60 * 1000).unref();

// ---- 上传（multer 2.x，按批次存进当次新建的目录；文件内容已由前端端到端加密） ----
const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      if (!req.uploadFolder) req.uploadFolder = createUploadFolder();
      cb(null, path.join(UPLOAD_DIR, req.uploadFolder));
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    const name = safeName(fixName(file.originalname)) || `file_${Date.now()}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  // 单文件不设大小限制（由下面存储总量 10GB 兜底）；单次最多 200 个文件
  limits: { fileSize: Infinity, files: 200 },
});

app.post(
  '/api/upload',
  (req, res, next) => {
    cleanupExpired(); // 上传前先做一次过期清理，腾出空间
    if (dirSize(UPLOAD_DIR) >= STORAGE_LIMIT) {
      return res.status(413).json({
        error: `存储空间已达上限（${STORAGE_LIMIT_GB}GB），请先删除无用文件`,
      });
    }
    next();
  },
  upload.array('files'),
  (req, res) => {
    if (!req.uploadFolder) {
      return res.status(400).json({ error: '没有收到文件' });
    }
    res.json({ ok: true, folder: req.uploadFolder, count: req.files.length });
  }
);

// ---- 文件列表（按时间倒序：新的在前） ----
// 文件名/大小来自磁盘（密文名）；真实文件名在前端解密 manifest.enc 后还原
app.get('/api/list', (req, res) => {
  ensureUploadDir();
  const folders = fs
    .readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(UPLOAD_DIR, d.name);
      const files = fs
        .readdirSync(dir)
        .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        name: d.name,
        count: files.filter((f) => f.name !== MANIFEST).length,
        size: files.reduce((s, f) => s + f.size, 0),
        files,
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  const used = folders.reduce((s, f) => s + f.size, 0);
  res.json({
    folders,
    usage: { used, limit: STORAGE_LIMIT, limitGB: STORAGE_LIMIT_GB, retentionDays: RETENTION_DAYS },
    httpsPort: HTTPS_PORT,
  });
});

// ---- 删除整个目录（谨慎操作：前端有确认弹层） ----
app.delete('/api/folder/:folder', (req, res) => {
  const folder = safeName(req.params.folder);
  if (!folder) return res.status(400).json({ error: '目录名无效' });
  const dir = path.join(UPLOAD_DIR, folder);
  if (dir.indexOf(UPLOAD_DIR + path.sep) !== 0) {
    return res.status(400).json({ error: '目录名无效' });
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: '目录不存在' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ---- 下载单个文件（密文，前端收到后自动解密） ----
app.get('/api/download/:folder/:file', (req, res) => {
  const folder = safeName(req.params.folder);
  const file = safeName(req.params.file);
  if (!folder || !file) return res.status(400).json({ error: '文件名无效' });
  const fp = path.join(UPLOAD_DIR, folder, file);
  if (fp.indexOf(path.join(UPLOAD_DIR, folder) + path.sep) !== 0) {
    return res.status(400).json({ error: '文件名无效' });
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.download(fp, file);
});

// ---- 前端静态页 ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- 统一错误处理（multer 等） ----
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  const msg =
    err.code === 'LIMIT_FILE_COUNT' ? '单次最多上传 200 个文件' :
    err.message || '请求处理失败';
  res.status(400).json({ error: msg });
});

// ---- 双端口启动：HTTP 可直接用；HTTPS 更优（传输层加密 + 原生加密引擎） ----
(async () => {
  const cert = await ensureCert();
  https.createServer(cert, app).listen(HTTPS_PORT, () => {
    console.log(`file-box 已启动`);
    console.log(`  HTTP : http://localhost:${PORT}`);
    console.log(`  HTTPS: https://localhost:${HTTPS_PORT}（推荐，首次访问需信任自签证书一次）`);
    console.log(`上传目录: ${UPLOAD_DIR}（存储上限 ${STORAGE_LIMIT_GB}GB，超过 ${RETENTION_DAYS} 天自动清理）`);
    console.log('文件在浏览器内端到端加密后上传，服务器磁盘只保存密文');
  });
  http.createServer(app).listen(PORT);
})();
