# 意见附件支持视频/音频 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 意见附件支持视频/音频（≤100 MB，走 KV 分片上传与 Range 播放），图片附件不变。

**Architecture:** 后端沿用 `videostore.js` 的存储抽象，附件表加 kind/size/status/store_key/upload_id；新增附件上传三接口与媒体流接口。前端 `upload.js` 泛化为通用分片上传，composer 接受媒体文件并在提交后逐个上传，列表按 kind 渲染播放器。

**Tech Stack:** Cloudflare Workers + D1 + KV、原生 ES Module、`<video>/<audio>`、node smoke 测试。

设计稿：`docs/superpowers/specs/2026-10-20-media-attachments-design.md`

---

### Task 1: 后端 — 表、提交、上传、流、删除

**Files:**
- Create: `worker/migrations/0004_media_attachments.sql`
- Modify: `worker/src/handlers.js`、`worker/src/index.js`
- Test: `worker/test/smoke.mjs`

- [ ] **Step 1: 迁移**

```sql
ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE attachments ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE attachments ADD COLUMN store_key TEXT;
ALTER TABLE attachments ADD COLUMN upload_id TEXT;
UPDATE attachments SET size = length(data) WHERE size = 0;
```

- [ ] **Step 2: 冒烟先写失败用例**（放在第 11 步之后）

```js
await step('11b 登记视频附件 → uploading；分片上传 → ready；Range 读取一致', async () => {
  const bytes = new Uint8Array(200 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 2, text: '参考片段', attachments: [{ name: 'ref.mp4', mime: 'video/mp4', size: bytes.length, kind: 'video' }] } });
  eq(r.status, 201, 'status'); const a = r.data.feedback.attachments[0]; eq(a.kind, 'video', 'kind'); eq(a.status, 'uploading', 'status');
  ctx.fbMedia = r.data.feedback.id; ctx.media = a.id;
  const s = await req('POST', `/p/attachments/${a.id}/upload/start`, { token: ctx.owner, body: {} }); eq(s.status, 200, 'start');
  const partSize = s.data.part_size; const parts = [];
  for (let i = 0, n = 1; i < bytes.length; i += partSize, n++) {
    const res = await fetch(`${BASE}/p/attachments/${a.id}/upload/part?upload_id=${encodeURIComponent(s.data.upload_id)}&part=${n}`, { method: 'PUT', headers: { Authorization: `Bearer ${ctx.owner}`, 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(i, Math.min(bytes.length, i + partSize)) });
    eq(res.status, 200, 'part'); const j = await res.json(); parts.push({ part_number: j.part_number, etag: j.etag });
  }
  const c = await req('POST', `/p/attachments/${a.id}/upload/complete`, { token: ctx.owner, body: { upload_id: s.data.upload_id, parts } });
  eq(c.status, 200, 'complete'); eq(c.data.attachment.status, 'ready', 'ready'); eq(c.data.attachment.size, bytes.length, 'size');
  const g = await fetch(`${BASE}/p/attachments/${a.id}/media?t=${ctx.editor}`, { headers: { Range: 'bytes=10-19' } });
  eq(g.status, 206, 'range status'); const buf = new Uint8Array(await g.arrayBuffer()); eq(buf.length, 10, 'range len'); eq(buf[0], 10 % 251, 'byte');
});
await step('11c 媒体附件超 100 MB → 400；本地模式不涉及', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 2, text: 'x', attachments: [{ name: 'big.mp4', mime: 'video/mp4', size: 101 * 1024 * 1024, kind: 'video' }] } });
  eq(r.status, 400, 'status');
});
```
并在第 18b 之后加：删除 `ctx.fbMedia` → 204；`GET /p/attachments/${ctx.media}/media` → 404。

- [ ] **Step 3: 跑冒烟确认新用例失败**

Run: `cd worker && npm test`（本地 dev 在跑）
Expected: 11b/11c 失败（404 / 400 附件只支持图片）

- [ ] **Step 4: handlers.js**

- 常量 `MAX_MEDIA = 100 * 1024 * 1024`、`MEDIA_KINDS = { video: /^video\//, audio: /^audio\// }`。
- `attachmentMeta` 返回 `{ id, name, mime, size, kind, status }`；所有 `length(a.data) AS size` 改为 `a.size`，并加 `a.kind, a.status`，过滤 `a.status != 'deleted'`。
- `createFeedback`：附件元素若有 `data` → 图片逻辑（size = data.length）；否则校验 `kind ∈ video/audio`、`mime` 前缀匹配、`size` 整数 1..MAX_MEDIA、`name ≤ 255`，插入 `status='uploading', data=''`。
- 新增 `findAttachment(ctx, id)`（JOIN feedback/versions，限本项目、未删意见）。
- `attachmentUploadStart/Part/Complete/Abort`：复制版本视频的四个函数，把 `versions` 换成 `attachments`，key = `${project.id}/att/${a.id}`，`maxVideo` 换 `MAX_MEDIA`，用量用新的 `storageUsage(env)`（版本视频 + 媒体附件）。
- `getAttachment`：媒体返回元数据。`getAttachmentMedia`：从 `getVideo` 抽出 `streamStored(store, key, filename, request)` 共用。
- `deleteFeedback`：查该意见的媒体附件，`store.remove(key)`，`UPDATE attachments SET status='deleted', size=0, store_key=NULL`。
- `adminList` 的 `storage.used` 用 `storageUsage`。

- [ ] **Step 5: index.js 路由**

```js
['POST', /^\/api\/p\/attachments\/([^/]+)\/upload\/start$/, 'project', H.attachmentUploadStart],
['PUT', /^\/api\/p\/attachments\/([^/]+)\/upload\/part$/, 'project', H.attachmentUploadPart],
['POST', /^\/api\/p\/attachments\/([^/]+)\/upload\/complete$/, 'project', H.attachmentUploadComplete],
['POST', /^\/api\/p\/attachments\/([^/]+)\/upload\/abort$/, 'project', H.attachmentUploadAbort],
['GET', /^\/api\/p\/attachments\/([^/]+)\/media$/, 'project', H.getAttachmentMedia],
['HEAD', /^\/api\/p\/attachments\/([^/]+)\/media$/, 'project', H.getAttachmentMedia],
```
（放在 `GET /attachments/:id` 之前无所谓，正则互不匹配。）

- [ ] **Step 6: migrate:local + 冒烟全绿，提交**

```bash
cd worker && npm run migrate:local && npm test
git add worker && git commit -m "feat: 意见附件支持视频/音频——KV 分片上传、Range 播放、删除清理"
```

### Task 2: 前端

**Files:**
- Modify: `js/upload.js`、`js/api.js`、`js/composer.js`、`js/review.js`、`js/localstore.js`、`js/config.js`、`css/review.css`、`review.html`（版本号）

- [ ] **Step 1: config.js** 加 `MAX_MEDIA_BYTES = 100 * 1024 * 1024`、`ATTACH_ACCEPT = 'image/*,video/*,audio/*,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.amr'`。
- [ ] **Step 2: upload.js** 改为 `uploadChunked({ start, part, complete, abort, file, onProgress })`，`uploadVideo` 变成薄封装；新增 `uploadAttachment({ api, attachmentId, file, onProgress })`。
- [ ] **Step 3: api.js** 加 `attachmentUploadStart/Complete/Abort`、`attachmentUploadPart`（复用 xhr 逻辑，抽 `putPart(path, blob, onProgress)`）、`mediaUrl(id)`。
- [ ] **Step 4: composer.js** 选择器 accept 改；`pickAttachments` 分流：图片压缩；媒体校验类型与大小后存 `{ kind, name, mime, size, file }`；`renderAttach` 对媒体渲染卡片（图标 🎬/🎵、名字、大小、✕）；本地模式（`api.isLocal`）选媒体直接 toast 拒绝。按钮副标题「图片 · 视频 · 音频」，说明文案更新。
- [ ] **Step 5: review.js** `submitFeedback`：body.attachments 图片 `{name,mime,data}`，媒体 `{name,mime,size,kind}`；拿到返回的附件 id 后按顺序 `uploadAttachment`，进度写到 `els.uploadBar`（「正在上传附件 i/n · xx%」），`state.uploading = { attachments: true }` 期间 `beforeunload` 拦截；失败 toast 但不回滚意见。`renderItem` 的 media：按 `a.kind` 渲染 —— image 用现有缩略图；video 卡片点开 `mediaModal`（`<video controls autoplay>` + 下载链接）；audio 行内 `<audio controls preload="none">`；`status==='uploading'` 灰卡「上传中…」。
- [ ] **Step 6: localstore.js** `createFeedback` 遇到无 `data` 的附件 → `fail('LOCAL_MEDIA_UNSUPPORTED', '本地模式只能传图片附件', 400)`。
- [ ] **Step 7: css** `.attach-file`（媒体卡片）、`.fb-media`（列表里的视频卡片/音频行）、弹层里的 `video { max-height: 70vh }`。
- [ ] **Step 8: review.html** `review.js?v=3`、`review.css?v=3`；review.js 内 `composer.js?v=3`、`player.js?v=2` 不变、`markup.js?v=2` 不变；新增 import 的 `upload.js`/`api.js` 被 review.js 直接引用无版本——给它们也加 `?v=3`。
- [ ] **Step 9: 本地验证**：ffmpeg 生成 `clip.mp4`（3 秒）与 `clip.mp3`，scratchpad 脚本通过 API 建一条带两种附件的意见并上传；浏览器打开审片页：视频卡片点开能播、音频行内能播、剪辑师视角一致；本地模式选媒体被拒绝（可用 localstore 单测代替）。
- [ ] **Step 10: 提交**

### Task 3: 上线

- [ ] `cd worker && npm run migrate:remote && npx wrangler deploy`
- [ ] `git push origin main`，等 Pages。
- [ ] 远端冒烟（直连 api.xsbingbing.top）全绿；线上审片页打开一条带媒体附件的意见能播放。
- [ ] README「容量与限制」更新：附件支持视频/音频 ≤100 MB，与客稿视频共用 1 GB。
