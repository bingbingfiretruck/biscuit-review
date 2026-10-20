# 饼干在线审片

饼干（博主）和剪辑师两个人用的客稿审片站：饼干按时间码写意见、在画面上画标记、传参考图；剪辑师逐条勾「已修改」、写修改说明、发布新版客稿。意见通过 Cloudflare D1 实时同步，视频上传到 Cloudflare KV（免费 1 GB，无需绑卡），两边打开链接都能直接播放。

形式参考「二个零工作流程 · 在线审片」客稿页。设计稿见 `docs/superpowers/specs/`，实施计划见 `docs/superpowers/plans/`。

## 线上地址（2026-10-15 部署，2026-10-20 切自定义域名）

- 管理台：https://bingbingfiretruck.github.io/biscuit-review/
- 后端 API：https://api.xsbingbing.top （Cloudflare Worker + D1 数据库 `biscuit-review` + KV 命名空间 `VIDEO_KV` 存视频；备用地址 https://biscuit-review-api.biscuit-review-worker.workers.dev 仅国外可直连）
- 管理口令：在本机 `worker/.admin-key.txt`（不入库）。要换口令：`cd worker && npx wrangler secret put ADMIN_KEY`。
- 访问说明：API 走自定义域名 `api.xsbingbing.top`（域名在阿里云，DNS 托管 Cloudflare，NS 为 cody/rayne.ns.cloudflare.com，Worker 用 `wrangler.toml` 的 `routes` 绑定），国内不开代理可直连；`*.workers.dev` 在大陆被 DNS 污染，只作国外备用。

## 怎么用

1. 打开 **管理台**（`index.html`），输入管理口令，新建项目：起名、选帧率、选择剪辑师发来的 V1 视频文件，创建后视频会直接上传（看得到进度）。
2. 得到两条链接：**审片链接** 自己用，**剪辑师链接** 微信发给剪辑师。链接不需要登录，谁拿到谁能用，不要公开。
3. **饼干**打开审片链接 → 视频自动播放 → 暂停在要改的画面 → 写意见 / 画标记 / 传参考图 → 提交。全部写完点「本轮反馈结束」，再微信知会剪辑师。
4. **剪辑师**打开剪辑师链接 → 视频自动播放 → 点意见跳到对应画面 → 改完勾「已修改」写修改说明 → 全部改完选择 V2 文件「发布新版客稿」，视频随即上传。

任一方都能给没有视频的版本补传；网络慢时可点「用本地文件播放」改用本机文件。饼干可以在历史版本里「清理视频释放空间」。
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

### 1. 后端（Cloudflare Worker + D1 + KV，免费额度内）

```bash
cd worker
npx wrangler login                       # 浏览器授权一次（饼干本人操作）
npx wrangler d1 create biscuit-review    # 把输出的 database_id 填进 wrangler.toml（已填：b9d9554b-…）
npx wrangler kv namespace create VIDEO_KV  # 把输出的 id 填进 wrangler.toml（已填：b9f1ada8…）
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

### 大文件上传备用

浏览器上传大视频必须保持页面开着直到提示「视频已上传」；中途刷新或关页会中断，页面会显示「重新上传客稿视频」。实在传不上时可在电脑上直接走接口：`cd worker && node tools/upload-video.mjs <审片链接里的 t> <版本 id> <视频文件>`（约 1 MB/s，660 MB 六七分钟）。

## 容量与限制

- D1 免费版：单库 500 MB、单行 2 MB。画面标记和参考图在浏览器压到 ≤1280px 的 JPEG 再入库，一张约 100–300 KB。
- 视频存 KV：免费 1 GB、不收流量费、无需绑卡。单个视频最大 900 MB，按 8 MB 分片经 Worker 上传；播放走 Worker 的 Range 转发；每个项目自动只保留最近两版的视频，空间不够时上传新版前会先清掉本项目更早版本的视频（意见和标记保留），管理台显示用量。建议剪辑师导出 ≤400 MB 的审片小样，这样能同时保留两版。以后要 10 GB 可开通 R2（需绑卡）后改 `wrangler.toml` 为 `[[r2_buckets]] binding = "VIDEOS"`，代码两种都支持（`worker/src/videostore.js`）。
- 意见附件支持图片、视频、音频，每条最多 6 个：图片压到 ≤1280px 存 D1；视频/音频单个 ≤100 MB，按 8 MB 分片存 KV，与客稿视频共用上面的 1 GB（删意见会释放附件空间）。转码、通知推送不在范围内。
