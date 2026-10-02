# 文件盒子（File Box）

轻量文件上传 / 下载服务。批量上传文件，每次上传自动在服务端按「上传日期+时间（精确到分钟）」建一个目录存放；列表按时间倒序展示，显示每个目录内的文件数量与相对时间标签，支持下载单个文件或把整个目录打包成 zip 下载。文件在浏览器内自动加密后才传输与存储，全程无需任何配置。PC 与手机浏览器均可使用，界面遵循 iOS 原生设计。

## 功能特性

- 批量上传：点「选择文件」选好先进清单，确认后再点「上传」发送；可继续添加、单个移除，也支持拖拽，单文件无大小限制
- 隐私保护：文件在浏览器内自动加密后才上传，服务器磁盘只保存密文，需通过本页面下载查看
- 存储管理：总量上限默认 10GB，页面实时显示用量，超限自动暂停上传并提示清理
- 自动清理：超过 90 天的目录自动删除（可配置），防止空间被占满
- 自动分组：每次上传生成一个目录，命名为 `YYYYMMDD_HHmm`（如 `20260923_1430`）；同一分钟内多次上传自动追加 `_2`、`_3`
- 文件列表：按时间倒序（最新在前）展示，显示文件数量、总大小与相对时间标签（周几 · 刚刚 / N 分钟前 / N 小时前 / N 天前 / N 周前 / N 个月前）
- 下载：目录内任意单个文件，或一键打包整个目录为 zip（服务端把整目录密文聚合成一条流，浏览器边下边多线程解密）
- 删除：每个目录可一键删除，有 iOS 风格二次确认弹层
- 地址分享：复制项目地址，或复制某个目录的直达链接，对方打开自动展开定位
- 自动适配 PC / 移动端，iOS 原生质感 UI
- 端口可自定义，HTTP / HTTPS 双端口，基于 pm2 部署

## 目录结构

```
.
├── server.js            # 服务端（Express）
├── ecosystem.config.js  # pm2 配置
├── package.json
├── public/
│   ├── index.html       # 前端单页
│   ├── crypto.js        # 浏览器端加密模块（原生 WebCrypto + 纯 JS 回退）
│   └── dec-worker.js    # 打包下载的解密线程
├── scripts/
│   └── pack.js          # npm run pack：按白名单收集出 dist 发布包并自校验
├── dist/                # 发布产物（npm run pack 生成，不入库）
├── uploads/             # 上传文件（密文）存放处，启动时自动创建
├── .certs/              # HTTPS 自签证书，首次启动自动生成
└── README.md
```

## 环境要求

- Node.js ≥ 18
- pm2（全局安装）：`npm install -g pm2`

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式直接运行（不经过 pm2）
npm start
# 或 node server.js
```

启动后浏览器访问：`http://服务器IP:3000`（也支持 `https://服务器IP:3443`，见下文「HTTP 与 HTTPS」）

## 打包（出发布产物）

```bash
npm run pack
# 产物：dist/file-box-1.0.0.tar.gz（约 40KB / 8 个文件）
#      dist/file-box/                （同内容的目录，可直接拿去跑）
```

按**白名单**收文件，只含运行必需的代码与配置：
`server.js`、`public/`（前端 3 个静态文件）、`package.json`、`package-lock.json`、`ecosystem.config.js`、`README.md`。

**刻意不进包**（打包脚本会自检，混进去就直接失败退出）：

- `node_modules/` —— 生产机上用 `npm install --omit=dev` 现装
- `uploads/` —— 你的文件数据都在这里
- `.certs/` —— HTTPS 私钥，每台服务器各自生成
- `.env`、`*.log`、`.git/`、`dist/`

> 本项目前端零构建：`public/` 下的文件由 Express 直出，`npm run pack` 只做收集与压缩，
> 没有编译/混淆步骤，改了前端不需要重新打包（开发时直接刷新页面即可）。

## 生产部署（跑 dist）

```bash
# 1. 本地打包并传到服务器
npm run pack
scp dist/file-box-1.0.0.tar.gz user@server:/tmp/

# 2. 服务器上解压到部署目录
mkdir -p /opt/file-box
tar -xf /tmp/file-box-1.0.0.tar.gz -C /opt/file-box --strip-components=1

# 3. 装生产依赖并启动
cd /opt/file-box
npm install --omit=dev
pm2 start ecosystem.config.js
pm2 save

# 4. 验证（端口以 ecosystem.config.js 的 env.PORT 为准：pm2 方式默认是 4444，
#    直接 npm start 不带配置才是 3000）
curl -s http://127.0.0.1:4444/api/list | head -c 200
```

> ⚠️ **数据就在应用目录里**：`uploads/` 与 `.certs/` 不在发布包中，但运行时会生成在
> 应用目录下。**升级时不要用「删掉整个目录再解压」的方式**，否则历史文件会被一起删掉。
> 正确做法是解压覆盖（`tar -xf` 只覆盖同名文件，不会删除多余文件）。

### 升级与回滚

```bash
# 升级：先备份数据，再解压覆盖，最后重启
tar -czf /tmp/uploads-$(date +%F).tar.gz -C /opt/file-box uploads
tar -xf /tmp/file-box-<新版本>.tar.gz -C /opt/file-box --strip-components=1
cd /opt/file-box && npm install --omit=dev && pm2 restart file-box

# 回滚：用旧版本包再覆盖一次即可（uploads/ 不受影响）
tar -xf /tmp/file-box-<旧版本>.tar.gz -C /opt/file-box --strip-components=1
pm2 restart file-box
```

## pm2 启动

```bash
# 启动（使用 ecosystem.config.js）
pm2 start ecosystem.config.js
```

### 自定义端口

方式一：修改 `ecosystem.config.js` 里的 `env.PORT`，然后重启。

方式二：不修改配置，直接指定：

```bash
# 用 8080 端口启动（仅本次生效）
PORT=8080 pm2 start ecosystem.config.js
```

方式三：想永久固定用某个端口，可以在 `ecosystem.config.js` 的 `env` 中改成：

```js
env: {
  PORT: 8080,
  HTTPS_PORT: 8443,
},
```

### HTTP 与 HTTPS

服务同时监听两个端口，功能完全一致：

- `http://IP:PORT`（默认 3000）：直接可用，无需任何配置
- `https://IP:HTTPS_PORT`（默认 3443）：更推荐。首次访问浏览器会提示「不安全」，点「高级 → 继续访问」一次即可（自签证书，服务器首次启动自动生成）；传输全程加密，且加解密更快

> **为什么 HTTPS 下加解密快得多**：浏览器只在「安全上下文」里开放原生 WebCrypto（硬件加速）。
> `http://localhost` 也算安全上下文，但用手机/其他设备访问 `http://内网IP:端口` 不算，
> 此时页面会自动回退到内置的纯 JS 实现，实测吞吐约 8 MB/s，而原生约 1400 MB/s。
> 回退状态下打包下载已改为多线程解密（不再卡页面），但要用满速度仍建议走 HTTPS 端口；
> 页面处于该模式时，「地址分享」里会自动多出一行 HTTPS 地址提示。

> 可配置项（均可通过环境变量覆盖，默认值见 `ecosystem.config.js`）：
>
> - `PORT`：HTTP 端口，默认 `3000`
> - `HTTPS_PORT`：HTTPS 端口，默认 `3443`
> - `STORAGE_LIMIT_GB`：存储总量上限（GB），默认 `10`。达到上限后上传会被拒绝，并提示清理
> - `RETENTION_DAYS`：目录保留天数，默认 `90`。超过该天数的目录会自动删除（启动时、每 6 小时、每次上传前都会触发检查）

## 存储与自动清理

- **上传没有单文件大小限制**，但整个服务的存储空间有上限（默认 10GB）
- 页面上传区域会实时显示「已用 / 上限」用量条；接近或达到上限时变红，并提示删除无用文件，此时上传按钮自动禁用
- 超过保留期（默认 90 天，可通过 `RETENTION_DAYS` 配置）的目录会被**自动删除**，防止空间被占满；需要长期保存的文件请及时下载
- 手动删除：目录行右侧垃圾桶图标，随时清理

## 常用命令

```bash
pm2 list                 # 查看运行状态
pm2 logs file-box        # 查看日志
pm2 restart file-box     # 重启
pm2 stop file-box        # 停止
pm2 delete file-box      # 删除进程
pm2 save                 # 保存进程列表（开机自启需配合 pm2 startup）
```

设置开机自启（可选）：

```bash
pm2 startup             # 按提示执行输出的一条命令
pm2 save
```

## 更新代码

用 git 直接部署（不走 dist 包）的话，同一套流程即可：

```bash
git pull                # 拉取最新代码
npm install             # 如有新依赖
pm2 restart file-box    # 重启生效
```

用上面的 dist 发布包部署，则见「升级与回滚」。

## 使用说明

1. 打开页面后，在「上传文件」区域点主按钮「选择文件」；手机上会先弹出选择面板：「照片图库」（快速选照片/视频）、「选择文件」（任意类型）
2. 选好的文件会先列成清单（显示名称与大小），可以「继续添加」凑齐一批、单个「移除」或「清空」，此时代码还没有上传任何东西
3. 确认清单无误后点「上传」才会真正发送；上传完成后列表自动刷新，界面回到初始状态
4. 每次上传都会生成一个新目录（以当次时间命名），你的多个文件会在同一个目录里
5. 列表默认最新目录在最上面，点目录可展开查看里面的单个文件
6. 下载单个文件：点击文件名右侧的「下载」
7. 下载整个目录：点击目录右侧的「打包下载」，会得到一个 zip（不压缩，直接聚合，按钮上会显示进度百分比）
8. 删除目录：点击目录右侧的垃圾桶图标，在弹出的确认框里点「删除」即可清除该目录及其中所有文件
9. 分享地址：页面底部「地址分享」可复制本项目地址；每个目录都有「复制链接」，把链接发给他人后，打开页面会自动展开并定位到该目录

> 项目启动时若没有 `uploads/` 目录会自动创建；文件以加密形式存储在该目录中，备份直接复制即可，恢复后仍通过本页面正常下载使用。