# 饼干在线审片 · 意见附件支持视频/音频 · 设计稿

日期：2026-10-20
前置：`2026-10-19-composer-markup-design.md`（写意见区）、视频托管（KV 分片上传，`worker/src/videostore.js`）。

## 1. 目标与范围

「选择附件」从只支持图片改为图片 / 视频 / 音频都能传，剪辑师打开意见就能播放或下载。

做：
- 视频、音频附件走和托管客稿视频同一套 KV 分片上传与 Range 播放；图片附件不变（浏览器压缩后存 D1）。
- 单个视频/音频 ≤ 100 MB；每条意见附件总数仍 ≤ 6。
- 支持：视频 MP4 / WebM / MOV；音频 MP3 / WAV / M4A / AAC / OGG / FLAC / AMR。浏览器不能直接播的格式（FLAC、AMR、部分 MOV）给「下载」。
- 删除意见时删掉 KV 里的附件文件；管理台空间用量把附件算进去。
- 本地模式（无后端）只支持图片，选了视频/音频提示「本地模式只能传图片」。

不做：附件转码、缩略图抽帧、附件在时间线上的标记、历史版本清理附件的批量按钮。

## 2. 数据与接口

### 2.1 表（迁移 0004）

`attachments` 加列：`kind TEXT NOT NULL DEFAULT 'image'`（image / video / audio）、`size INTEGER NOT NULL DEFAULT 0`、`status TEXT NOT NULL DEFAULT 'ready'`（uploading / ready）、`store_key TEXT`、`upload_id TEXT`。迁移时把已有行的 `size` 回填为 `length(data)`。媒体附件 `data` 存空串。

对外形状 `attachmentMeta`：`{ id, name, mime, size, kind, status }`。

### 2.2 提交意见

`POST /p/feedback` 的 `attachments[]` 两种元素：
- 图片：`{ name, mime: 'image/…', data: 'data:image/…' }`（不变）。
- 媒体：`{ name, mime: 'video/…'|'audio/…', size, kind: 'video'|'audio' }`，`size` 1 字节到 100 MB。登记为 `status = 'uploading'`，返回带 id 的附件元数据。

空间校验在 `upload/start` 时做（与客稿视频共用 `totalLimit`）：用量 = 版本视频大小之和 + 媒体附件（uploading/ready）大小之和。

### 2.3 附件上传（owner）

- `POST /p/attachments/:id/upload/start` → `{ upload_id, part_size }`。条件：附件属于本项目、kind ≠ image、status = uploading、所在意见未删除。`store_key = ${project.id}/att/${attachment.id}`。重复 start 会丢弃旧分片重新开始。
- `PUT /p/attachments/:id/upload/part?upload_id=&part=`：同视频分片。
- `POST /p/attachments/:id/upload/complete` `{ upload_id, parts }` → status ready，`size` 以实际为准。
- `POST /p/attachments/:id/upload/abort`：丢弃分片；附件保持 uploading（页面显示「上传未完成」，饼干可删意见重发）。

### 2.4 读取

- `GET /p/attachments/:id`：图片仍返回 JSON `{ data }`；媒体返回 `{ id, name, mime, size, kind, status }`（不含数据）。
- `GET|HEAD /p/attachments/:id/media?t=<token>`：按 Range 流式返回媒体，`?download=1` 加 `Content-Disposition`。与 `getVideo` 共用解析逻辑（抽成 `streamStored(store, key, name, request)`）。

### 2.5 删除

- 删意见（软删）时：对其媒体附件 `store.remove(store_key)`，并把 `status` 置 `'deleted'`、`size` 置 0（不再计入用量）。
- 删项目：`removePrefix(${id}/)` 已覆盖 `att/`。

## 3. 前端

- **composer**：按钮文案「选择附件 / 图片 · 视频 · 音频」，`accept="image/*,video/*,audio/*,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.amr"`。图片照旧压缩成 data URL；媒体以 `{ kind, name, mime, size, file }` 存草稿，超过 100 MB 或非支持类型 toast 拒绝。预览区：图片缩略图；媒体一块带图标、文件名、大小的卡片，可 ✕。
- **提交**：先 `createFeedback`（图片内联 + 媒体元数据），再逐个媒体附件分片上传，复用顶部上传条显示「正在上传附件 1/2 · 35%」；全部完成后 `loadState`。上传中 `beforeunload` 拦截（已有 `state.uploading` 逻辑，改为也覆盖附件）。
- **列表**：图片缩略图不变；视频附件显示带 ▶ 的卡片，点开弹层 `<video controls>`；音频附件行内 `<audio controls>`；`status = uploading` 显示「上传中…」灰卡；不能播的格式显示「下载」链接。媒体地址 `api.mediaUrl(id)`。
- **upload.js**：`uploadVideo` 泛化为 `uploadChunked({ start, part, complete, abort, file, onProgress })`，视频与附件各传一组端点。
- **localstore.js**：`createFeedback` 收到媒体元数据时报错 `LOCAL_MEDIA_UNSUPPORTED`，composer 提前拦截并提示。

## 4. 验证

- 冒烟（worker/test/smoke.mjs）新增：登记媒体附件 → uploading；start/part/complete 传 200 KB 伪造字节 → ready；`GET /media` 带 Range → 206 且字节一致；超 100 MB 的 size → 400；删意见后 `GET /media` → 404 且用量减少。
- 本地：ffmpeg 生成 3 秒 mp4 与 mp3，通过 API 建一条带两种附件的意见，浏览器打开审片页能播放、弹层正常、剪辑师视角一致；本地模式提示。
- 远端：`migrate:remote` → `deploy` → 冒烟全绿 → 线上页面走一遍。
