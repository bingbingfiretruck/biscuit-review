# 饼干在线审片

饼干（博主）和剪辑师两个人用的客稿审片站：饼干按时间码写意见、在画面上画标记、传参考图；剪辑师逐条勾「已修改」、写修改说明、发布新版客稿。意见通过 Cloudflare 数据库实时同步，视频不上传。

形式参考「二个零工作流程 · 在线审片」客稿页。设计稿见 `docs/superpowers/specs/`，实施计划见 `docs/superpowers/plans/`。

## 线上地址（2026-10-15 已部署）

- 管理台：https://bingbingfiretruck.github.io/biscuit-review/
- 后端 API：https://biscuit-review-api.biscuit-review-worker.workers.dev （Cloudflare Worker + D1，数据库 `biscuit-review`）
- 管理口令：在本机 `worker/.admin-key.txt`（不入库）。要换口令：`cd worker && npx wrangler secret put ADMIN_KEY`。
- 访问说明：`*.workers.dev` 在中国大陆被 DNS 污染，饼干自己在国内用时要开着代理；剪辑师在日本直接打开即可。以后不想开代理，买个域名绑到 Worker 即可（见下方部署第 1 步）。

## 怎么用

1. 打开 **管理台**（`index.html`），输入管理口令，新建项目：起名、选帧率、选择剪辑师发来的 V1 视频文件（只读文件名/大小/时长，不上传）。
2. 得到两条链接：**审片链接** 自己用，**剪辑师链接** 微信发给剪辑师。链接不需要登录，谁拿到谁能用，不要公开。
3. **饼干**打开审片链接 → 选择本地的 V1 视频 → 暂停在要改的画面 → 写意见 / 画标记 / 传参考图 → 提交。全部写完点「本轮反馈结束」，再微信知会剪辑师。
4. **剪辑师**打开剪辑师链接 → 选择同一个视频文件 → 点意见跳到对应画面 → 改完勾「已修改」写修改说明 → 全部改完选择 V2 文件「发布新版客稿」，并把 V2 文件发给饼干。
5. 饼干打开 V2：右侧「本版修改依据」列出 V1 的意见和修改说明，逐条核对；没问题点「确认本版通过」。

两条链接都能切换历史版本（只读）、切换日间/黑夜主题、改帧率。

## 目录

```
index.html / review.html   管理台 / 审片页
css/  js/                  纯静态，无构建
worker/                    Cloudflare Worker + D1 后端
.claude/launch.json        本地预览：web（8788）、api（8787）
```

## 本地开发

```bash
cd worker && npm install && npm run migrate:local && npm run dev     # API：http://127.0.0.1:8787
python3 -m http.server 8788 --bind 127.0.0.1                          # 页面：http://127.0.0.1:8788
cd worker && npm test                                                 # 27 步冒烟测试（需 API 在跑）
```

本地开发的管理口令在 `worker/.dev.vars`（默认 `dev-admin`）。页面在 localhost 下自动连 8787 的 API；没有后端时退回「本地模式」（数据只在本机浏览器，不能共享）。

## 部署

### 1. 后端（Cloudflare Worker + D1，免费）

```bash
cd worker
npx wrangler login                       # 浏览器授权一次（饼干本人操作）
npx wrangler d1 create biscuit-review    # 把输出的 database_id 填进 wrangler.toml（已填：b9d9554b-…）
npm run migrate:remote
npx wrangler secret put ADMIN_KEY        # 输入管理口令
npm run deploy                           # 得到 https://biscuit-review-api.<子域>.workers.dev
```

**国内访问必读**：`*.workers.dev` 在国内被 DNS 污染，剪辑师直接打不开。要买一个域名（阿里云/新网约 10 元/年），DNS 托管到 Cloudflare，在 Worker 的「设置 → 域和路由」绑定自定义域名（如 `api.你的域名`）。

### 远端冒烟（部署后验证）

```bash
cd worker
API_BASE=https://biscuit-review-api.biscuit-review-worker.workers.dev/api ADMIN_KEY="$(cat .admin-key.txt)" npm test
```

会新建一个「冒烟项目」跑完 32 步后删掉。2026-10-15 线上 32/32 通过。

**国内跑要注意**：Node 的 `fetch` 不读系统代理，直连 `workers.dev` 会全部 `fetch failed`。Node ≥ 24 在命令前加 `NODE_USE_ENV_PROXY=1` 即可；Node 22 需要 `npm i -D undici` 后用预加载脚本 `node --import ./proxy.mjs test/smoke.mjs`，脚本内容两行：`import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'; setGlobalDispatcher(new EnvHttpProxyAgent());`。

### 2. 页面（GitHub Pages）

1. 把 `js/config.js` 里的 `PROD_API_BASE` 改成 Worker 地址加 `/api`（例如 `https://api.你的域名/api`）。
2. 把页面域名加进 `worker/wrangler.toml` 的 `ALLOWED_ORIGINS`（默认已含 `https://bingbingfiretruck.github.io`），重新 `npm run deploy`。
3. 推到 GitHub，开启 Pages（main 分支，根目录）。

## 容量与限制

- D1 免费版：单库 500 MB、单行 2 MB。画面标记和参考图在浏览器压到 ≤1280px 的 JPEG 再入库，一张约 100–300 KB。
- 参考附件只支持图片，每条意见最多 6 张；视频/音频附件、视频上传与转码、通知推送都不在 v1 范围内。
