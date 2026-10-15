# 饼干在线审片 · 设计稿

日期：2026-10-15
参考：二个零工作流程「在线审片」客稿页（https://doublezero.synology.me:14443/client-review/…）
用途：饼干（博主/甲方）与剪辑师两个人之间的客稿审片与修改意见同步。

## 1. 定位与取舍

照搬参考站的「客稿页」形式：视频播放器 + 时间码意见 + 画面标记 + 本轮反馈结束 + 确认通过 + 多版本历史。
去掉只对工作室有意义的部分：纯净版申请、飞书通知、历史访问密码、多账号登录、服务端转码。

两个角色，无账号，凭链接区分：
- **饼干**（审片链接）：写意见、画标记、传参考图、删意见、「本轮反馈结束」、「确认本版通过」。
- **剪辑师**（剪辑师链接）：看意见清单、逐条勾「已修改」并写修改说明、「发布新版客稿」。
- 两边都能发布新版（防止剪辑师嫌麻烦，饼干代为登记）。

## 2. 架构

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 纯静态 HTML/CSS/JS，无构建 | 仓库 `饼干在线审片/`，部署 GitHub Pages（与饼饼车库同一套流程），仓库名 `biscuit-review` |
| 后端 | Cloudflare Worker + D1（SQLite） | 代码在 `worker/`，`wrangler deploy` 部署；免费额度足够两人使用 |
| 视频 | 不上传 | 双方各自在浏览器打开本地的同一个视频文件；项目记录文件名/大小/时长用于校验「是同一个文件」 |
| 图片 | 存 D1 | 画面标记、参考图在浏览器端压到 ≤1280px JPEG 再上传，单张 ≤2MB（D1 单行上限） |
| 鉴权 | 链接 token | 每个项目两条链接，各带 32 位随机 token；管理台另用管理口令（Worker 环境变量 `ADMIN_KEY`） |
| 降级 | 本地模式 | 未配置后端或请求失败时退回 localStorage，顶部横幅提示；仅供预览，不能共享 |
| 同步 | 轮询 | 页面每 8 秒拉一次项目状态（带 `updated_at` 比对，无变化不重绘） |

国内可达性：`*.workers.dev` 在国内被 DNS 污染。剪辑师在国内使用必须给 Worker 绑一个自定义域名（阿里云/新网约 10 元/年）。GitHub Pages 国内可直接访问。

## 3. 页面

### 3.1 管理台 `index.html`（饼干用）
- 首次打开输入管理口令，存 localStorage。
- 新建项目：项目名（如「国庆湖州 vlog」）、选择 V1 客稿视频文件（只读取文件名/大小/时长，不上传）→ 生成「审片链接」「剪辑师链接」，一键复制。
- 项目列表：名称、当前版本、状态（意见填写中 / 本轮反馈已结束 / 已确认通过）、打开、删除（二次确认）。

### 3.2 审片页 `review.html?t=<token>`
布局照参考站：顶栏 → 版本栏 → 工作区（左视频卡 sticky，右侧面板），窄屏单列。

**顶栏**：品牌「饼干 · 在线审片」、项目名、`客稿 V2` 徽章、角色徽章（饼干 / 剪辑师）、主题切换（日间 / 黑夜）。

**版本栏**：V1 … Vn 圆形按钮横向滑动；当前版本标「当前 · 可继续反馈」，历史版本标「历史 · 只读」。

**视频卡**（深色）：
- 未选文件：「选择客稿视频」按钮 + 期望文件名/大小；选错文件（名或大小不符）给黄色提示但允许继续。
- 自定义控件：播放/暂停、−3 秒 / +3 秒、−1 帧 / +1 帧（按 fps 推算，默认 30，可在项目设置里改 25/30/60）、播放速度、时间码 `00:01:23.12`（时:分:秒.帧）、大屏模式。
- 进度条上有每条意见的标记点，点击跳转并暂停；当前选中意见高亮。
- 播放进度随当前意见联动：点右侧意见 → 跳到该时间码并暂停。

**右侧面板 · 饼干**：
- 「写意见」卡：时间码（取当前暂停帧；可切「整片」不带时间码）、文本框（占位「输入对当前客稿的具体反馈…」，示例「例如：这里的产品名称请放大一些。」）、「在当前帧画标记」、参考图附件（多张）、「提交这条意见」。提交后文本清空、标记清空，时间码保留。
- 「在当前帧画标记」：抓当前视频帧到全屏画布；工具：画笔、箭头、矩形、椭圆、文字；颜色 6 色；撤销、清空、完成/取消。完成后在写意见卡显示缩略图，可重新编辑或移除。
- 「本轮反馈」状态卡：
  - 意见填写中（n 条）→ 按钮「本轮反馈结束」（n=0 时禁用）
  - 本轮反馈已结束 → 文案「剪辑师可以开始修改了」+ 按钮「撤回结束，继续写意见」
  - 按钮「确认本版通过」→ 已确认本版通过 + 「撤回通过确认」
- 「已提交的意见」列表：排序切换 按时间码 / 原顺序；每条：序号、时间码 chip（整片则显示「整片」）、文字、标记缩略图（点开大图）、附件缩略图、状态 chip（待修改 / 已修改）、剪辑师修改说明（若有）、删除（二次确认，本轮已结束后仍可删）。点击整条 → 视频跳转。
- 「本版修改依据」（V≥2）：上一版的意见清单，只读，带修改说明与已修改状态；点击时间码不跳转（视频已是新版）。

**右侧面板 · 剪辑师**：
- 「本轮状态」卡：等待饼干意见（n 条，填写中）/ 本轮反馈已结束，可以开始修改 / 已确认通过。
- 「意见清单」：同上列表；每条多一个「已修改」勾选和「修改说明」输入（失焦即保存）。
- 「发布新版客稿」卡：选择新视频文件 → 记录为 V(n+1) → 当前版本归档，意见清单变为新版的「修改依据」。发布前确认弹层。
- 剪辑师不能写/删意见、不能结束本轮、不能确认通过。

**历史版本**：切到旧版本时右侧只显示该版收到的意见（只读）；视频区提示「历史版本 · 只读，请打开对应文件查看」。

### 3.3 空态与错误
- 链接无效：「这个审片链接无效或已失效」+ 说明去找饼干要新链接。
- 后端不可达：顶部横幅「暂时连不上服务器，已切换本地模式，提交的内容只保存在这台设备」，并每 30 秒重试。
- 未提交的草稿（文字/标记/附件）在切换版本、刷新前弹「请先提交当前这条意见」。

## 4. 数据模型（D1）

```sql
projects   (id TEXT PK, name, fps INTEGER DEFAULT 30, owner_token UNIQUE, editor_token UNIQUE,
            current_version INTEGER, created_at, updated_at)
versions   (id TEXT PK, project_id, number INTEGER, video_name, video_size INTEGER, video_duration REAL,
            status TEXT  -- collecting | closed | approved
            closed_at, approved_at, created_at, UNIQUE(project_id, number))
feedback   (id TEXT PK, version_id, seq INTEGER, timecode REAL NULL, text,
            annotation TEXT NULL  -- data:image/jpeg;base64,...
            status TEXT  -- open | done
            editor_note TEXT, created_at, updated_at, deleted_at NULL)
attachments(id TEXT PK, feedback_id, name, mime, data TEXT, created_at)
```

状态机（每个 version）：`collecting` →「本轮反馈结束」→ `closed` →「确认通过」→ `approved`；撤回按原路返回。发布新版：新 version 为 `collecting`，旧版保持原状态并只读。

## 5. API（Worker，前缀 `/api`）

鉴权：`Authorization: Bearer <token>`；管理接口用 `X-Admin-Key`。CORS 只放行 GitHub Pages 域与本地开发域。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /admin/projects | 管理 | 新建项目 + V1；返回两条 token |
| GET | /admin/projects | 管理 | 项目列表（含当前版本状态、意见数） |
| DELETE | /admin/projects/:id | 管理 | 删除项目及其全部数据 |
| GET | /p | 任一 | 项目全量状态：project、versions、每版 feedback（不含附件大图）、role、updated_at |
| GET | /p/attachments/:id | 任一 | 附件图片（返回 image/jpeg） |
| GET | /p/feedback/:id/annotation | 任一 | 标记大图 |
| POST | /p/feedback | 饼干 | 新建意见（当前版本，JSON：timecode、text、annotation、attachments[]） |
| DELETE | /p/feedback/:id | 饼干 | 软删除 |
| PATCH | /p/feedback/:id | 剪辑师 | status / editor_note |
| POST | /p/round/close · /p/round/reopen | 饼干 | 本轮结束 / 撤回 |
| POST | /p/approve · /p/unapprove | 饼干 | 确认通过 / 撤回 |
| POST | /p/versions | 任一 | 发布新版（video_name/size/duration） |
| PATCH | /p | 任一 | 改 fps |

GET /p 响应里 feedback 的 annotation 只给缩略图（≤320px），大图按需拉取，避免轮询流量过大。

## 6. 视觉

沿用参考站的粉 × 李子色系与柔和径向渐变背景，大圆角卡片，深色播放器卡；日间 / 黑夜双主题。
- 色板：`--pink #eba3b1` `--pinkStrong #df879a` `--pinkSoft #fff0f3` `--paper #fffdfc` `--cream #f8f4f3` `--line #eadfe1` `--plum #5b3944` `--ink #241e20` `--muted #786a6e`；黑夜：`#211d20 / #292327 / #30282d / #f8eef1`。
- 字体：中文系统栈（PingFang SC、Hiragino Sans GB、Microsoft YaHei），时间码用等宽数字（tabular-nums）。
- 品牌：「饼干 · 在线审片」+ 一枚饼干图标（SVG）。

## 7. v1 不做
纯净版申请、飞书/微信通知（状态在页面可见，双方微信口头知会）、历史访问密码、视频上传与转码、视频/音频附件、多用户账号、评论回复串。

## 8. 验证
- 本地：`wrangler dev` 起 Worker（本地 D1）+ 静态站，内置浏览器走完整流程：建项目 → 饼干写 3 条意见（含画标记、附件）→ 本轮结束 → 剪辑师勾已修改 + 修改说明 → 发布 V2 → V2 页显示修改依据 → 切回 V1 只读。
- Worker：`node worker/test/smoke.mjs` 对本地 dev server 跑一遍接口；角色越权返回 403。
- 窄屏（375px）与黑夜主题各看一次。

## 9. 部署与交接（需要饼干本人操作的部分）
1. 注册 Cloudflare 账号（免费），终端运行 `npx wrangler login` 用浏览器授权。
2. 我执行：建 D1、跑迁移、设置管理口令、`wrangler deploy`。
3. 我执行：建 GitHub 仓库 `biscuit-review`，推送，开 Pages。
4. 绑定自定义域名到 Worker（国内访问必需）：你提供一个域名，DNS 托管到 Cloudflare。

## 10. 2026-10-15 晚追加：视频托管

用户要求两边打开链接都能直接看视频。改动：
- 存储：Cloudflare R2（桶 `biscuit-review-videos`，Worker 绑定 `VIDEOS`）。需账号开通 R2（要求绑支付卡）。
- 上传：浏览器按 20 MB 分片 `PUT /api/p/versions/:id/upload/part`，先 `upload/start` 建多段上传，最后 `upload/complete`；失败自动重试 3 次后 `abort`。管理台建项目后直接传 V1；发布新版后直接传新版；审片页对无视频版本提供「上传客稿视频」。
- 播放：`GET /api/p/videos/:id?t=<token>`，Worker 按 Range 转发 R2（206），`<video crossorigin="anonymous">` 以便抓帧画标记。网络慢时仍可「用本地文件播放」。
- 清理：owner 可对历史版本「清理视频释放空间」；删项目时顺带删 R2 对象。
- `versions` 新增 `video_key / video_mime / video_status(none|uploading|ready) / upload_id`（迁移 0003）。
