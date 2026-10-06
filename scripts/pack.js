#!/usr/bin/env node
/**
 * 生成自包含发布产物：dist/file-box/（解压即跑，不需要 npm install）
 * 与 dist/file-box-<version>.tar.gz。
 *
 * 依赖按 package-lock.json 的**生产闭包**精确收集（跳过 dev 标记的包），出包前自检：
 * 闭包齐不齐、有没有混进数据/私钥/dev 包、以及脱离仓库后能否解析到依赖。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'file-box');
const TARBALL_NAME = `file-box-${pkg.version}.tar.gz`;
const TARBALL = path.join(DIST, TARBALL_NAME);

// 应用自身的文件（依赖另算）
const INCLUDE = [
  'server.js',
  'package.json',
  'package-lock.json',
  'ecosystem.config.js',
  'README.md',
  'public',
];
// 产物顶层一旦出现这些，直接失败
const FORBIDDEN = [/^uploads\//, /^\.certs\//, /^\.git\//, /^dist\//, /\.log$/, /^\.env/, /^scripts\//];

const sizeOf = (p) => (fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0)
  : fs.statSync(p).size);

const copyTree = (src, dst, skipNestedModules = false) => {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (skipNestedModules && f === 'node_modules') continue; // 嵌套包由各自的锁条目单独收
      copyTree(path.join(src, f), path.join(dst, f), skipNestedModules);
    }
  } else {
    fs.copyFileSync(src, dst);
  }
};

const walkFiles = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? walkFiles(path.join(dir, e.name), path.join(base, e.name))
  : [path.join(base, e.name).replace(/\\/g, '/')]));

// 列出 node_modules 里实际存在的包，路径写法与锁文件的 key 保持一致（嵌套包记成 a/node_modules/b）
const listInstalledPackages = (root) => {
  const out = new Set();
  const scan = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (fs.existsSync(path.join(full, 'package.json'))) {
        out.add(rel);
        scan(path.join(full, 'node_modules'), `${rel}/node_modules`); // 路径要与锁文件的 key 对齐
      } else if (e.name.startsWith('@')) {
        scan(full, rel); // 作用域目录本身不是包
      }
    }
  };
  scan(root, '');
  return out;
};

// ---- 依赖闭包 ----
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const lockEntries = Object.entries(lock.packages || {}).filter(([k]) => k.startsWith('node_modules/'));
const prodDirs = lockEntries.filter(([, v]) => !v.dev).map(([k]) => k.slice('node_modules/'.length)).sort();
const devOnly = lockEntries.filter(([, v]) => v.dev).map(([k]) => k.slice('node_modules/'.length));
if (!lockEntries.length) {
  console.error('[打包] package-lock.json 里没有 packages 字段（lockfileVersion < 3？）');
  console.error('[打包] 请先 npm install 生成 v3 锁文件，避免把 dev 依赖一起带到生产');
  process.exit(1);
}

for (const item of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, item))) {
    console.error(`[打包] 仓库里缺少 ${item}，先确认再打包`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.error('[打包] 仓库没有 node_modules，先 npm install 再打包');
  process.exit(1);
}
const missing = prodDirs.filter((d) => !fs.existsSync(path.join(ROOT, 'node_modules', d)));
if (missing.length) {
  console.error(`[打包] 有 ${missing.length} 个生产依赖没装，先 npm ci：${missing.slice(0, 5).join(', ')}`);
  process.exit(1);
}

// 「把打包机的 node_modules 直接带到目标机」成立的前提是依赖全为纯 JS。
// 一旦有原生二进制 / install 脚本 / os-cpu 限定，这个前提就破了，必须换目标平台打包。
const nativeHits = [];
for (const d of prodDirs) {
  const dir = path.join(ROOT, 'node_modules', d);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  if (meta.os || meta.cpu || meta.libc || meta.gypfile || meta.binary) {
    nativeHits.push(`${d}（平台限定/原生声明）`);
    continue;
  }
  if (meta.scripts && (meta.scripts.install || meta.scripts.preinstall || meta.scripts.postinstall)) {
    nativeHits.push(`${d}（有 install 脚本）`);
    continue;
  }
  if (walkFiles(dir).some((f) => /\.(node|dll|so|dylib|exe|gyp)$/i.test(f))) nativeHits.push(`${d}（含二进制文件）`);
}
if (nativeHits.length) {
  console.error(`[打包] 生产依赖里有 ${nativeHits.length} 个不是纯 JS：${nativeHits.slice(0, 6).join(', ')}`);
  console.error('[打包] 此时把 node_modules 带到别的系统不可靠，请在目标系统上 npm install 后再打包，');
  console.error('[打包] 或沿用「服务器上执行 npm install --omit=dev」的部署方式。');
  process.exit(1);
}

// ---- 收集 ----
fs.rmSync(STAGE, { recursive: true, force: true });
for (const stale of fs.existsSync(DIST) ? fs.readdirSync(DIST) : []) {
  if (/^file-box-.*\.tar\.gz$/.test(stale)) fs.rmSync(path.join(DIST, stale), { force: true });
}
fs.mkdirSync(STAGE, { recursive: true });
for (const item of INCLUDE) copyTree(path.join(ROOT, item), path.join(STAGE, item));
fs.mkdirSync(path.join(STAGE, 'node_modules'), { recursive: true });
for (const d of prodDirs) copyTree(path.join(ROOT, 'node_modules', d), path.join(STAGE, 'node_modules', d), true);
// npm 自己的账本与按平台生成的 .bin 启动器不该带到别的系统上
for (const junk of ['.bin', '.package-lock.json', '.modules.yaml', '.yarn-integrity', '.installed-cli-version']) {
  fs.rmSync(path.join(STAGE, 'node_modules', junk), { recursive: true, force: true });
}

// ---- 自检 ----
const staged = walkFiles(STAGE);
const leaked = staged.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (leaked.length) {
  console.error(`[打包] 白名单泄漏，拒绝出包: ${leaked.slice(0, 5).join(', ')}`);
  fs.rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}
const present = listInstalledPackages(path.join(STAGE, 'node_modules'));
const extra = [...present].filter((p) => !prodDirs.includes(p));
if (extra.length) {
  console.error(`[打包] 混进了 ${extra.length} 个不在生产闭包内的包（dev 依赖？）: ${extra.slice(0, 5).join(', ')}`);
  process.exit(1);
}
if (present.size !== prodDirs.length) {
  console.error(`[打包] 依赖数量对不上：闭包 ${prodDirs.length} 个，产物里 ${present.size} 个`);
  process.exit(1);
}
// 少一个文件都不行：逐个比对源与产物的文件数（嵌套 node_modules 由各自条目计，这里要跳过以免重复计数）
const countFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => (
  e.isDirectory() ? (e.name === 'node_modules' ? s : s + countFiles(path.join(dir, e.name))) : s + 1), 0);
const srcFileCount = prodDirs.reduce((s, d) => s + countFiles(path.join(ROOT, 'node_modules', d)), 0);
const stageDepCount = staged.filter((f) => f.startsWith('node_modules/')).length;
if (stageDepCount !== srcFileCount) {
  console.error(`[打包] 依赖文件数对不上：源 ${srcFileCount}，产物 ${stageDepCount}（可能漏拷或嵌套依赖没展开）`);
  process.exit(1);
}
// 脱离仓库能不能解析到依赖（在暂存目录里跑，且清掉 NODE_PATH）
const env = Object.assign({}, process.env);
delete env.NODE_PATH;
for (const dep of Object.keys(pkg.dependencies || {})) {
  const r = cp.spawnSync(process.execPath, ['-e', `process.stdout.write(require.resolve(${JSON.stringify(dep)}))`], {
    cwd: STAGE, env, encoding: 'utf8',
  });
  const resolved = (r.stdout || '').replace(/\\/g, '/');
  if (r.status !== 0 || !resolved.includes('/dist/file-box/node_modules/')) {
    console.error(`[打包] 依赖 ${dep} 在产物里解析不到：${resolved || r.stderr}`);
    process.exit(1);
  }
}

// ---- 出 tar ----
// 用相对路径调 tar：Git Bash 的 GNU tar 会把 "D:\..." 里的 D: 当成远程主机
try {
  cp.execFileSync('tar', ['-czf', TARBALL_NAME, 'file-box'], { cwd: DIST, stdio: 'inherit' });
} catch {
  console.error('[打包] 调用 tar 失败，请确认系统里有 tar（Win10+ / macOS / Linux 自带）');
  console.error(`[打包] 已生成的可直接部署目录: ${STAGE}`);
  process.exit(1);
}
const inTar = cp.execFileSync('tar', ['-tzf', TARBALL_NAME], { cwd: DIST, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
  .map((l) => l.replace(/^file-box\//, ''))
  .filter((l) => l && !l.endsWith('/'))
  .sort();
const want = staged.slice().sort();
if (JSON.stringify(inTar) !== JSON.stringify(want)) {
  console.error(`[打包] tar 条目与暂存目录不一致（包内 ${inTar.length} / 暂存 ${want.length}）`);
  console.error('  仅在包内:', inTar.filter((x) => !staged.includes(x)).slice(0, 3));
  console.error('  仅在暂存:', want.filter((x) => !inTar.includes(x)).slice(0, 3));
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const appFiles = staged.filter((f) => !f.startsWith('node_modules/'));
console.log(`[打包] dist/${TARBALL_NAME}  ${mb(fs.statSync(TARBALL).size)}（内含 ${staged.length} 个文件，文件总大小 ${mb(sizeOf(STAGE))}；小文件多，解压后占盘会更大一些）`);
console.log(`[打包]   应用文件 ${appFiles.length} 个：${appFiles.join(', ')}`);
console.log(`[打包]   生产依赖 ${prodDirs.length} 个包 / ${stageDepCount} 个文件（按锁文件闭包精确收集${devOnly.length ? `，已剔除 ${devOnly.length} 个 dev 包` : '；本仓库无 dev 依赖'}）`);
console.log('[打包] 自检通过：无数据/私钥/脚本泄漏、闭包完整、文件数一致、脱离仓库可解析、tar 条目一致');
console.log('[打包] 依赖全为纯 JS，可跨平台携带；产物自包含 —— 服务器上解压即跑，不需要 npm install');
