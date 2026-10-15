# 饼干在线审片 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个两人用的客稿审片站：饼干按时间码写意见、画标记，剪辑师逐条勾已修改、发新版；意见经 Cloudflare D1 实时同步。

**Architecture:** 纯静态前端（GitHub Pages，无构建）+ Cloudflare Worker API（D1 存数据）。视频不上传，双方各自打开本地同一文件；图片压缩后以 data URL 存库。前后端只通过本文件第 2 节的 JSON 契约耦合。

**Tech Stack:** HTML/CSS/原生 JS（ES2020，`type="module"`）、Cloudflare Workers（ESM）、D1（SQLite）、wrangler 4、node 22 原生 fetch 做冒烟测试。

设计稿：`docs/superpowers/specs/2026-10-15-biscuit-review-design.md`

---

## 1. 文件结构

```
饼干在线审片/
  index.html                管理台（饼干用）
  review.html               审片页（审片链接 / 剪辑师链接共用）
  css/tokens.css            色板、双主题、字体、间距 token
  css/base.css              重置、按钮、卡片、chip、输入框、弹层
  css/admin.css             管理台布局
  css/review.css            审片页布局、播放器、面板、标记画布
  js/config.js              API_BASE 判定 + 项目常量
  js/util.js                时间码格式化、图片压缩、id、防抖、DOM 小工具
  js/api.js                 远端 API 客户端（fetch 封装）+ 本地模式适配器切换
  js/localstore.js          本地模式：localStorage 实现与 api.js 同名方法
  js/player.js              播放器：本地文件、逐帧、时间码、进度条标记、大屏
  js/markup.js              画面标记画布：画笔/箭头/矩形/椭圆/文字、颜色、撤销、导出
  js/review.js              审片页主逻辑
  js/admin.js               管理台主逻辑
  worker/
    package.json            已建（dev / deploy / migrate / test 脚本）
    wrangler.toml
    .dev.vars               本地开发密钥（ADMIN_KEY=dev-admin），已 gitignore
    migrations/0001_init.sql
    src/index.js            入口：CORS、路由、鉴权、错误包装
    src/handlers.js         各接口实现
    src/util.js             id/token 生成、校验、JSON 响应
    test/smoke.mjs          对本地 dev server 跑整条流程
  .claude/launch.json       api（wrangler dev :8787）、web（python http.server :8788）
  .gitignore                node_modules、.wrangler、.dev.vars、codex_result.txt
  README.md                 使用说明 + 部署说明
```

## 2. 接口契约（前后端唯一耦合点）

### 2.1 通用
- Base：生产 `https://<worker 域名>/api`，本地 `http://127.0.0.1:8787/api`。
- 请求/响应均 JSON（`Content-Type: application/json; charset=utf-8`）。
- 错误：`{ "error": "<中文说明>", "code": "<大写蛇形>" }`，状态码 400 / 401 / 403 / 404 / 409 / 413。
- 鉴权：
  - 项目接口 `/api/p/*`：`Authorization: Bearer <token>`。token 等于 `projects.owner_token` → 角色 `owner`（饼干）；等于 `editor_token` → `editor`（剪辑师）；都不是 → 401 `INVALID_TOKEN`。
  - 管理接口 `/api/admin/*`：`X-Admin-Key: <ADMIN_KEY>`，不等 → 401 `INVALID_ADMIN_KEY`。
- CORS：`ALLOWED_ORIGINS` 逗号分隔；请求 Origin 命中则回 `Access-Control-Allow-Origin: <该 origin>`、`Vary: Origin`、`Access-Control-Allow-Headers: Authorization, Content-Type, X-Admin-Key`、`Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`；`OPTIONS` 直接 204。值为 `*` 时放行任何 origin。
- id：`crypto.randomUUID()`；token：32 位十六进制（`crypto.getRandomValues(new Uint8Array(16))`）。
- 时间：ISO 8601 字符串（`new Date().toISOString()`）。
- 任何写操作都把 `projects.updated_at` 更新为当前时间（前端轮询靠它判断是否重绘）。
- 请求体上限 8MB；超出 413 `PAYLOAD_TOO_LARGE`。

### 2.2 数据结构（响应里的形状）

```ts
Project  { id, name, fps, current_version, created_at, updated_at }
Version  { id, number, video_name, video_size, video_duration, status, closed_at, approved_at, created_at,
           feedback: Feedback[] }        // status: "collecting" | "closed" | "approved"
Feedback { id, seq, timecode, text, has_annotation, annotation_thumb, status, editor_note,
           attachments: AttachmentMeta[], created_at, updated_at }
           // timecode: number(秒, 小数) | null(整片)；status: "open" | "done"
           // annotation_thumb: data URL(≤320px) | null；大图另拉
AttachmentMeta { id, name, mime, size }   // size = data URL 字符串长度
```

### 2.3 管理接口

| 方法 | 路径 | 请求体 | 成功响应 |
|---|---|---|---|
| POST | /api/admin/projects | `{ name, fps?, video: { name, size, duration } }` | 201 `{ project: Project & { owner_token, editor_token }, version: Version }` |
| GET | /api/admin/projects | — | 200 `{ projects: [ Project & { owner_token, editor_token, status, feedback_count } ] }`，按 updated_at 降序；status/feedback_count 取当前版本，feedback_count 不含已删除 |
| DELETE | /api/admin/projects/:id | — | 204；级联删 versions / feedback / attachments；不存在 404 `NOT_FOUND` |

校验：name 去空格后 1–80 字；fps ∈ {24,25,30,50,60}，默认 30；video.name 1–255 字，size 正整数，duration ≥0 数字。

### 2.4 项目接口（Bearer token）

| 方法 | 路径 | 角色 | 请求体 | 成功响应 / 规则 |
|---|---|---|---|---|
| GET | /api/p | 任一 | — | 200 `{ role, project, versions }`；versions 按 number 升序，每版 feedback 按 seq 升序，已删除不返回 |
| PATCH | /api/p | 任一 | `{ fps }` | 200 `{ project }` |
| POST | /api/p/versions | 任一 | `{ video: { name, size, duration } }` | 201 `{ version }`；number = 当前最大 +1，status `collecting`，并把 `projects.current_version` 指向它 |
| POST | /api/p/feedback | owner | `{ timecode, text, annotation?, annotation_thumb?, attachments?: [{ name, mime, data }] }` | 201 `{ feedback }`；写入当前版本；seq = 该版本最大 seq + 1 |
| DELETE | /api/p/feedback/:id | owner | — | 204；软删除（写 deleted_at） |
| PATCH | /api/p/feedback/:id | editor | `{ status?, editor_note? }` | 200 `{ feedback }` |
| GET | /api/p/feedback/:id/annotation | 任一 | — | 200 `{ annotation }`（大图 data URL）；无标记 404 |
| GET | /api/p/attachments/:id | 任一 | — | 200 `{ id, name, mime, data }` |
| POST | /api/p/round/close | owner | — | 200 `{ version }`：当前版本 `collecting` → `closed`，写 closed_at |
| POST | /api/p/round/reopen | owner | — | 200 `{ version }`：`closed` → `collecting`，closed_at 置空 |
| POST | /api/p/approve | owner | — | 200 `{ version }`：`collecting`/`closed` → `approved`，写 approved_at |
| POST | /api/p/unapprove | owner | — | 200 `{ version }`：`approved` → 若 closed_at 非空则 `closed`，否则 `collecting`；approved_at 置空 |

规则与错误码：
- 角色不符 → 403 `FORBIDDEN`。
- 写意见要求当前版本 status 为 `collecting`，否则 409 `ROUND_CLOSED`。
- 删意见：当前版本为 `approved` 时 409 `VERSION_APPROVED`；意见不属于该项目 → 404。
- 剪辑师 PATCH：status 只能是 `open`/`done`；editor_note ≤ 2000 字；可在任何版本状态下操作。
- 状态机不匹配（如对 `approved` 版本 close）→ 409 `INVALID_STATE`。
- `round/close` 要求当前版本至少 1 条未删除意见，否则 409 `NO_FEEDBACK`。
- 写意见校验：text ≤ 5000 字；text、annotation、attachments 至少一项非空；annotation 与 annotation_thumb 必须同时给或同时不给，都是 `data:image/` 开头；annotation ≤ 1,900,000 字符；attachments ≤ 6 个，每个 data ≤ 1,900,000 字符，mime 以 `image/` 开头，name ≤ 255 字；timecode 为 null 或 ≥0 的有限数。
- 意见、版本等「属于某项目」的判断必须经 join 校验，防止跨项目读写。

## 3. 数据库（`worker/migrations/0001_init.sql`）

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  fps             INTEGER NOT NULL DEFAULT 30,
  owner_token     TEXT NOT NULL UNIQUE,
  editor_token    TEXT NOT NULL UNIQUE,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  video_name     TEXT NOT NULL,
  video_size     INTEGER NOT NULL,
  video_duration REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'collecting',
  closed_at      TEXT,
  approved_at    TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE feedback (
  id               TEXT PRIMARY KEY,
  version_id       TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  timecode         REAL,
  text             TEXT NOT NULL DEFAULT '',
  annotation       TEXT,
  annotation_thumb TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  editor_note      TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX feedback_version_idx ON feedback(version_id, seq);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX attachments_feedback_idx ON attachments(feedback_id);
```

D1 需在每个连接显式 `PRAGMA foreign_keys = ON`？D1 默认开启外键，但保险起见删除项目时按 attachments → feedback → versions → projects 顺序显式删，不依赖级联。

## 4. Worker 任务（派给 Codex）

### Task W1: 脚手架
**Files:** `worker/wrangler.toml`、`worker/.dev.vars`、`worker/migrations/0001_init.sql`、`.gitignore`

- [ ] `wrangler.toml`：
```toml
name = "biscuit-review-api"
main = "src/index.js"
compatibility_date = "2025-09-01"

[[d1_databases]]
binding = "DB"
database_name = "biscuit-review"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[vars]
ALLOWED_ORIGINS = "https://bingbingfiretruck.github.io,http://localhost:8788,http://127.0.0.1:8788"
```
- [ ] `.dev.vars`：`ADMIN_KEY=dev-admin`
- [ ] 第 3 节 SQL 原样写入 `migrations/0001_init.sql`
- [ ] 根目录 `.gitignore`：`node_modules/`、`.wrangler/`、`worker/.dev.vars`、`codex_result.txt`、`.DS_Store`
- [ ] 运行 `cd worker && npm run migrate:local`，预期输出含 `0001_init.sql` applied

### Task W2: 入口与鉴权（`worker/src/index.js`、`worker/src/util.js`）
- [ ] `util.js` 导出：`json(data, status=200, extraHeaders)`、`error(code, message, status)`（抛出 `ApiError`）、`newId()`、`newToken()`、`nowIso()`、`assert(cond, code, message, status=400)`、`readJson(request, maxBytes=8*1024*1024)`（超限抛 413 `PAYLOAD_TOO_LARGE`，非 JSON 抛 400 `BAD_JSON`）。
- [ ] `index.js`：`export default { async fetch(request, env) }`：
  1. 计算 CORS 头（按 2.1）；`OPTIONS` → 204 + CORS 头。
  2. 路径不以 `/api/` 开头 → 404。
  3. `/api/admin/*`：校验 `X-Admin-Key === env.ADMIN_KEY`（`env.ADMIN_KEY` 未设置时一律 401）。
  4. `/api/p` 与 `/api/p/*`：解析 Bearer，查 `projects` 得到 `{ project, role }`，塞进 ctx。
  5. 按 `method + 路径模式` 分发到 handlers；没匹配 → 404 `NOT_FOUND`。
  6. 捕获 `ApiError` → 对应状态码；其它异常 → 500 `{ error: "服务器开小差了", code: "INTERNAL" }` 并 `console.error`。
  7. 所有响应（含错误）都带 CORS 头。

### Task W3: 接口实现（`worker/src/handlers.js`）
- [ ] 按 2.3 / 2.4 实现全部接口，一个导出函数对应一行。
- [ ] `GET /api/p` 一次查 versions，一次查该项目全部未删 feedback（join versions 过滤 project_id），一次查 attachments 元数据（`id, feedback_id, name, mime, length(data) AS size`），在内存里组装；不要 N+1。
- [ ] `annotation_thumb` 随 GET /api/p 返回，`annotation` 永远不随列表返回。
- [ ] 创建意见：一条 INSERT feedback + 每个附件一条 INSERT，用 `env.DB.batch([...])` 一次提交。
- [ ] 删除项目：`batch` 依次 DELETE attachments（子查询 feedback→versions→project）、feedback、versions、projects。

### Task W4: 冒烟测试（`worker/test/smoke.mjs`）
- [ ] 顶部 `const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/api'; const ADMIN = process.env.ADMIN_KEY || 'dev-admin';`
- [ ] 写一个 `step(name, fn)` 工具：打印 `✓ name` / `✗ name` + 原因，任一失败最终 `process.exit(1)`。
- [ ] 顺序（每步都断言状态码和关键字段）：
  1. 无 admin key 调 GET /admin/projects → 401 `INVALID_ADMIN_KEY`
  2. POST /admin/projects `{ name:"冒烟项目", video:{ name:"v1.mp4", size:1234, duration:61.5 } }` → 201，拿 owner_token/editor_token，version.number=1，status=collecting
  3. GET /p 用 owner_token → role=owner，versions 长度 1，feedback 空
  4. GET /p 用 editor_token → role=editor
  5. GET /p 用 "bad" → 401 `INVALID_TOKEN`
  6. owner POST /feedback `{ timecode: 12.5, text:"第一条", annotation:"data:image/jpeg;base64,AAAA", annotation_thumb:"data:image/jpeg;base64,BBBB" }` → 201，seq=1，has_annotation=true，annotation_thumb 回显
  7. owner POST /feedback `{ timecode:null, text:"", attachments:[{ name:"ref.jpg", mime:"image/jpeg", data:"data:image/jpeg;base64,CCCC" }] }` → 201，seq=2，attachments[0].size>0
  8. owner POST /feedback `{ timecode: 1, text:"" }`（三项全空）→ 400
  9. editor POST /feedback → 403 `FORBIDDEN`
  10. GET /p/feedback/:id1/annotation → 200，annotation 等于 6 步发的值
  11. GET /p/attachments/:attId → 200，data 等于 7 步发的值
  12. editor PATCH /feedback/:id1 `{ status:"done", editor_note:"已放大" }` → 200
  13. owner PATCH /feedback/:id1 → 403
  14. editor POST /round/close → 403
  15. owner POST /round/close → 200，status=closed，closed_at 非空
  16. owner POST /feedback → 409 `ROUND_CLOSED`
  17. owner POST /round/reopen → 200，status=collecting
  18. owner DELETE /feedback/:id2 → 204；GET /p 里 feedback 只剩 1 条
  19. owner POST /approve → 200，status=approved
  20. owner DELETE /feedback/:id1 → 409 `VERSION_APPROVED`
  21. owner POST /unapprove → 200，status=collecting（因为 closed_at 已在 17 步清空）
  22. editor POST /versions `{ video:{ name:"v2.mp4", size:2345, duration:62 } }` → 201，number=2；GET /p → project.current_version=2，versions[0].feedback 仍 1 条，versions[1].feedback 空
  23. owner POST /round/close → 409 `NO_FEEDBACK`（V2 没意见）
  24. PATCH /p `{ fps: 25 }` → project.fps=25；`{ fps: 31 }` → 400
  25. GET /admin/projects → 含该项目，current_version=2，status=collecting，feedback_count=0
  26. DELETE /admin/projects/:id → 204；GET /p 用 owner_token → 401
- [ ] 运行方式：终端 A `npm run dev`，终端 B `npm test`，预期全部 ✓ 并 exit 0。

### Task W5: 自检
- [ ] `npx wrangler deploy --dry-run --outdir dist` 通过（不需要登录）。
- [ ] 把运行 smoke 的完整输出贴到结果里。

## 5. 前端任务（Claudian 自己写）

### Task F1: tokens 与基础样式
- `css/tokens.css`：`:root` 日间色板（设计稿第 6 节）+ `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` + `:root[data-theme="dark"]` 黑夜；字体栈；圆角 `--r-sm 9px / --r-md 14px / --r-lg 20px`；阴影。
- `css/base.css`：按钮（`.btn` 主/次/危险/幽灵）、卡片 `.card`、chip `.chip`（`.chip--ok/.chip--warn/.chip--muted`）、输入框、弹层 `.modal`、横幅 `.banner`、`.visually-hidden`、焦点态、`prefers-reduced-motion`。

### Task F2: `js/config.js`、`js/util.js`、`js/api.js`、`js/localstore.js`
- `config.js`：`export const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'http://127.0.0.1:8787/api' : (window.BISCUIT_API_BASE || '')`；`API_BASE` 为空字符串即本地模式。`PROD_API_BASE` 部署后由 README 指引改。
- `util.js`：`fmtTimecode(sec, fps)` → `HH:MM:SS.FF`（小时为 0 时省略）；`parseFile(file)` → `{ name, size, duration }`（用隐藏 video 读 duration）；`shrinkImage(fileOrCanvas, maxEdge, quality)` → data URL（canvas 缩放，JPEG）；`uid()`；`debounce`；`$`/`$$`/`h()` 小工具；`toast(msg)`。
- `api.js`：`createApi({ token, adminKey })` 返回对象：`getState()`, `createFeedback(body)`, `deleteFeedback(id)`, `patchFeedback(id, body)`, `getAnnotation(id)`, `getAttachment(id)`, `closeRound()`, `reopenRound()`, `approve()`, `unapprove()`, `createVersion(video)`, `patchProject(body)`, `adminList()`, `adminCreate(body)`, `adminDelete(id)`；每个方法 `fetch` 后非 2xx 抛 `ApiError { code, message, status }`；网络失败抛 `code: 'NETWORK'`。`isLocal` 标志。
- `localstore.js`：`createLocalApi({ token, adminKey })` 同名方法，数据存 `localStorage['biscuit.projects']`（projects 数组，含 versions/feedback/attachments 全量），同样的校验规则与错误码（至少 ROUND_CLOSED / FORBIDDEN / NO_FEEDBACK / INVALID_TOKEN）。

### Task F3: `js/player.js`
- `createPlayer(root, { fps, onTime, onSeekMarker })`：渲染 `<video>` + 控件；`loadFile(file)`（`URL.createObjectURL`）、`seek(sec, { pause })`、`stepFrames(n)`、`stepSeconds(n)`、`setMarkers([{ id, timecode, active }])`、`currentTime()`、`captureFrame()` → canvas（视频原始分辨率，最长边 ≤1280）、`setTheater(bool)`。进度条：`<input type=range>` 上叠一层标记点容器，点击标记 → `onSeekMarker(id)`。键盘：空格播放/暂停、←/→ 一帧、Shift+←/→ 三秒。

### Task F4: `js/markup.js`
- `openMarkup({ baseCanvas, onDone, onCancel, initialStrokes })`：全屏层；工具 pen/arrow/rect/ellipse/text；6 色；线宽随画布比例；撤销栈；清空；完成 → `{ full: dataURL(≤1280), thumb: dataURL(≤320), strokes }`。触控与鼠标都用 Pointer Events。

### Task F5: `review.html` + `css/review.css` + `js/review.js`
- 读 `?t=`；无 token → 空态。`api.getState()` 失败且 `code==='NETWORK'` → 切本地模式 + 横幅（本地模式下 token 对应项目不存在则提示「本地模式没有这个项目」）。
- 渲染顶栏、版本栏、视频卡、右侧面板（按 role 与所选版本分支）。所选版本默认当前版本。
- 轮询：`setInterval(8000)`，`updated_at` 变了才重绘；重绘保留输入框草稿与所选版本。
- 草稿守卫：文本/标记/附件非空时切版本或 `beforeunload` 提示。
- 列表排序 按时间码/原顺序（localStorage 记住）。
- 意见点击 → `player.seek(timecode, { pause: true })`；标记缩略图点击 → 弹层大图（`api.getAnnotation`）。
- 剪辑师：勾选 → `patchFeedback(id, { status })`；修改说明失焦 → `patchFeedback(id, { editor_note })`（值没变不发）。
- 发布新版：选文件 → `parseFile` → 确认弹层 → `createVersion` → 重新拉状态、切到新版、提示「请打开 V{n} 文件」。
- 文件校验：所选文件 name/size 与版本记录不一致 → 黄色横幅「这不像是 V{n} 的文件（期望 xxx，大小 yyy）」，仍允许继续。

### Task F6: `index.html` + `css/admin.css` + `js/admin.js`
- 管理口令：`localStorage['biscuit.adminKey']`；输入后 `adminList()`，401 则清掉重问。
- 新建项目表单 → `adminCreate` → 展示两条链接（`review.html?t=...` 绝对地址）+ 复制按钮。
- 项目列表卡：名称、V{n}、状态 chip、意见数、两条链接复制、打开审片、删除（二次确认）。
- 本地模式同样可用（用 localstore）。

### Task F7: `.claude/launch.json`、`README.md`
- launch.json：`api`：`bash -c "cd worker && npx wrangler dev --port 8787"`，port 8787；`web`：`python3 -m http.server 8788`，port 8788。
- README：功能、两种链接、本地开发、部署三步（Cloudflare、GitHub Pages、域名）、改 `PROD_API_BASE`。

## 6. 验证清单
- [ ] `worker`: smoke 全绿（Task W4）
- [ ] 内置浏览器走完整流程（设计稿第 8 节），每个关键步骤截图一次
- [ ] 375px 宽 + 黑夜主题各看一次审片页
- [ ] Codex `codex review --uncommitted` 审前端；Claudian 审 Worker

## 7. 部署（需要饼干操作的在前面标 ★）
1. ★ 注册 Cloudflare，终端 `cd 饼干在线审片/worker && npx wrangler login`
2. `npx wrangler d1 create biscuit-review` → 把 database_id 填进 wrangler.toml
3. `npm run migrate:remote`
4. `npx wrangler secret put ADMIN_KEY`（输入管理口令）
5. `npm run deploy` → 得到 `https://biscuit-review-api.<子域>.workers.dev`
6. ★ 买域名并把 DNS 托管到 Cloudflare → Workers 设置里绑定自定义域名（如 `api.xxx.com`）
7. 把 `window.BISCUIT_API_BASE` 写进 `js/config.js`，把域名加进 `ALLOWED_ORIGINS`
8. `gh repo create bingbingfiretruck/biscuit-review --public --source . --push`，开启 Pages（main / root）
