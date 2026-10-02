#!/usr/bin/env node
/**
 * 生成发布产物：dist/file-box/（可直接运行的目录）+ dist/file-box-<version>.tar.gz
 * 只按白名单收文件，并自校验产物内容 —— 数据、私钥、依赖绝不能进包。
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

// 白名单：运行必需的代码与配置。
// 刻意不进包：node_modules（生产 npm install --omit=dev）、uploads/（你的文件数据）、
// .certs/（HTTPS 私钥）、.env、日志、.git。
const INCLUDE = [
  'server.js',
  'package.json',
  'package-lock.json',
  'ecosystem.config.js',
  'README.md',
  'public',
];
// 产物里一旦出现这些，说明白名单写错了，直接失败
const FORBIDDEN = [/^node_modules\//, /^uploads\//, /^\.certs\//, /^\.git\//, /^dist\//, /\.log$/, /^\.env/];

const copyTree = (src, dst) => {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copyTree(path.join(src, f), path.join(dst, f));
  } else fs.copyFileSync(src, dst);
};
const walk = (dir, base = '') => fs
  .readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory()
    ? walk(path.join(dir, e.name), path.join(base, e.name))
    : [path.join(base, e.name).replace(/\\/g, '/')]));

for (const item of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, item))) {
    console.error(`[打包] 仓库里缺少 ${item}，先确认再打包`);
    process.exit(1);
  }
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(TARBALL, { force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const item of INCLUDE) copyTree(path.join(ROOT, item), path.join(STAGE, item));

const staged = walk(STAGE).sort();
const leaked = staged.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (leaked.length) {
  console.error(`[打包] 白名单泄漏，拒绝出包: ${leaked.join(', ')}`);
  fs.rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

// 用相对路径调 tar：Git Bash 的 GNU tar 会把 "D:\..." 里的 D: 当成远程主机
try {
  cp.execFileSync('tar', ['-czf', TARBALL_NAME, 'file-box'], { cwd: DIST, stdio: 'inherit' });
} catch (e) {
  console.error('[打包] 调用 tar 失败，请确认系统里有 tar（Win10+ / macOS / Linux 自带）');
  console.error(`[打包] 已生成的可直接部署目录: ${path.join(DIST, 'file-box')}`);
  process.exit(1);
}

// 自校验：tar 里的条目要和暂存目录一一对应（少文件/多文件都算失败）
const inTar = cp
  .execFileSync('tar', ['-tzf', TARBALL_NAME], { cwd: DIST, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => l.replace(/^file-box\//, ''))
  .filter((l) => l && !l.endsWith('/'))
  .sort();
if (JSON.stringify(inTar) !== JSON.stringify(staged)) {
  console.error('[打包] 产物内容与暂存目录不一致');
  console.error('  仅在包内:', inTar.filter((x) => !staged.includes(x)));
  console.error('  仅在暂存:', staged.filter((x) => !inTar.includes(x)));
  process.exit(1);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`[打包] ${path.relative(ROOT, TARBALL)}  ${kb(fs.statSync(TARBALL).size)}，${staged.length} 个文件`);
for (const f of staged) {
  console.log(`   ${f.padEnd(24)} ${kb(fs.statSync(path.join(STAGE, f)).size)}`);
}
console.log('[打包] 自校验通过：白名单一致、tar 条目一致、无数据/密钥/依赖');
