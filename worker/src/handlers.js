import { fail, assert, nowIso, newId, newToken, json, readJson } from './util.js';
import { getVideoStore, parseRange } from './videostore.js';

const FPS = [24, 25, 30, 50, 60];
const MAX_IMAGE = 1900000;
const MAX_ATTACHMENTS = 6;
const MAX_MEDIA = 100 * 1024 * 1024;            // 视频/音频附件单个上限
const MEDIA_KINDS = { video: /^video\//, audio: /^audio\// };

// ---------- 形状 ----------
const publicProject = (p) => ({ id: p.id, name: p.name, fps: p.fps, current_version: p.current_version, created_at: p.created_at, updated_at: p.updated_at });
const publicVersion = (v, feedback = []) => ({
  id: v.id, number: v.number, video_name: v.video_name, video_size: v.video_size, video_duration: v.video_duration,
  video_status: v.video_status || 'none', video_mime: v.video_mime || null,
  status: v.status, closed_at: v.closed_at, approved_at: v.approved_at, created_at: v.created_at, feedback,
});
const publicFeedback = (f, attachments = []) => ({
  id: f.id, seq: f.seq, timecode: f.timecode, text: f.text,
  has_annotation: !!(f.has_annotation ?? f.annotation), annotation_thumb: f.annotation_thumb ?? null,
  status: f.status, editor_note: f.editor_note, attachments, created_at: f.created_at, updated_at: f.updated_at,
});
const attachmentMeta = (a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind || 'image', status: a.status || 'ready' });

const FEEDBACK_COLS = 'f.id, f.version_id, f.seq, f.timecode, f.text, (f.annotation IS NOT NULL) AS has_annotation, f.annotation_thumb, f.status, f.editor_note, f.created_at, f.updated_at';

// ---------- 校验 ----------
function validateVideo(video) {
  assert(video && typeof video === 'object', 'BAD_REQUEST', '缺少视频信息');
  const name = String(video.name ?? '').trim();
  assert(name && name.length <= 255, 'BAD_REQUEST', '视频文件名不合法');
  const size = Number(video.size);
  assert(Number.isInteger(size) && size > 0, 'BAD_REQUEST', '视频大小不合法');
  const duration = Number(video.duration ?? 0);
  assert(Number.isFinite(duration) && duration >= 0, 'BAD_REQUEST', '视频时长不合法');
  return { name, size, duration };
}
function validateFps(v, fallback = 30) {
  if (v == null) return fallback;
  const fps = Number(v);
  assert(FPS.includes(fps), 'BAD_REQUEST', 'fps 只能是 24/25/30/50/60');
  return fps;
}
const isImageData = (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length <= MAX_IMAGE;
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
/** 图片：{ name, mime, data }（压缩后 data URL）；视频/音频：{ name, mime, size, kind }，稍后分片上传 */
function validateAttachment(a) {
  assert(a && typeof a === 'object', 'BAD_REQUEST', '附件不合法');
  const name = String(a.name ?? '').slice(0, 255);
  const mime = String(a.mime ?? '');
  if (a.data !== undefined) {
    assert(isImageData(a.data) && mime.startsWith('image/'), 'BAD_REQUEST', '图片附件不合法或过大');
    return { id: newId(), name: name || '图片', mime, kind: 'image', status: 'ready', data: a.data, size: a.data.length };
  }
  const kind = String(a.kind ?? '');
  assert(MEDIA_KINDS[kind] && MEDIA_KINDS[kind].test(mime) && mime.length <= 64, 'BAD_REQUEST', '附件类型不支持');
  const size = Number(a.size);
  assert(Number.isInteger(size) && size > 0 && size <= MAX_MEDIA, 'BAD_REQUEST', `视频/音频附件最大 ${Math.round(MAX_MEDIA / 1024 / 1024)} MB`);
  return { id: newId(), name: name || (kind === 'video' ? '视频' : '音频'), mime, kind, status: 'uploading', data: '', size };
}
function optionalString(v, what, max) {
  if (v == null) return null;
  assert(typeof v === 'string', 'BAD_REQUEST', `${what}必须是文字`);
  assert(v.length <= max, 'BAD_REQUEST', `${what}不能超过 ${max} 字`);
  return v;
}

// ---------- 查询助手 ----------
const touch = (env, projectId, t = nowIso()) => env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(t, projectId);

async function currentVersion(ctx) {
  const v = await ctx.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND number = ?').bind(ctx.project.id, ctx.project.current_version).first();
  assert(v, 'NOT_FOUND', '找不到当前客稿版本', 404);
  return v;
}
async function loadVersion(env, versionId) {
  const v = await env.DB.prepare('SELECT * FROM versions WHERE id = ?').bind(versionId).first();
  const fb = (await env.DB.prepare(`SELECT ${FEEDBACK_COLS} FROM feedback f WHERE f.version_id = ? AND f.deleted_at IS NULL ORDER BY f.seq ASC`).bind(versionId).all()).results;
  const atts = (await env.DB.prepare("SELECT a.id, a.feedback_id, a.name, a.mime, a.size, a.kind, a.status FROM attachments a JOIN feedback f ON f.id = a.feedback_id WHERE f.version_id = ? AND a.status != 'deleted' ORDER BY a.created_at ASC").bind(versionId).all()).results;
  return publicVersion(v, fb.map((f) => publicFeedback(f, atts.filter((a) => a.feedback_id === f.id).map(attachmentMeta))));
}
async function findFeedback(ctx, id) {
  const f = await ctx.env.DB.prepare(`SELECT ${FEEDBACK_COLS}, v.status AS version_status, v.number AS version_number FROM feedback f JOIN versions v ON v.id = f.version_id WHERE f.id = ? AND v.project_id = ? AND f.deleted_at IS NULL`).bind(id, ctx.project.id).first();
  assert(f, 'NOT_FOUND', '找不到这条意见', 404);
  return f;
}
async function attachmentsOf(env, feedbackId) {
  const rows = (await env.DB.prepare("SELECT id, name, mime, size, kind, status FROM attachments WHERE feedback_id = ? AND status != 'deleted' ORDER BY created_at ASC").bind(feedbackId).all()).results;
  return rows.map(attachmentMeta);
}
const need = (ctx, role) => assert(ctx.role === role, 'FORBIDDEN', '当前链接没有这个权限', 403);

// ---------- 管理接口 ----------
export async function adminList({ env }) {
  const rows = (await env.DB.prepare(`
    SELECT p.*, v.status AS status,
      (SELECT COUNT(*) FROM feedback f WHERE f.version_id = v.id AND f.deleted_at IS NULL) AS feedback_count
    FROM projects p LEFT JOIN versions v ON v.project_id = p.id AND v.number = p.current_version
    ORDER BY p.updated_at DESC`).all()).results;
  const store = getVideoStore(env);
  const usage = store ? await videoUsage(env) : 0;
  return json({ projects: rows.map((p) => ({ ...publicProject(p), owner_token: p.owner_token, editor_token: p.editor_token, status: p.status || 'collecting', feedback_count: p.feedback_count || 0 })),
    storage: store ? { kind: store.kind, used: usage, limit: store.totalLimit } : null });
}

export async function adminCreate({ env, request }) {
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  assert(name && name.length <= 80, 'BAD_REQUEST', '项目名 1–80 字');
  const fps = validateFps(body.fps);
  const video = validateVideo(body.video);
  const t = nowIso();
  const project = { id: newId(), name, fps, owner_token: newToken(), editor_token: newToken(), current_version: 1, created_at: t, updated_at: t };
  const version = { id: newId(), number: 1, video_name: video.name, video_size: video.size, video_duration: video.duration, status: 'collecting', closed_at: null, approved_at: null, created_at: t };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO projects (id, name, fps, owner_token, editor_token, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(project.id, project.name, project.fps, project.owner_token, project.editor_token, 1, t, t),
    env.DB.prepare('INSERT INTO versions (id, project_id, number, video_name, video_size, video_duration, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(version.id, project.id, 1, video.name, video.size, video.duration, 'collecting', t),
  ]);
  return json({ project: { ...publicProject(project), owner_token: project.owner_token, editor_token: project.editor_token }, version: publicVersion(version) }, 201);
}

export async function adminDelete({ env, params }) {
  const id = params[0];
  const p = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first();
  assert(p, 'NOT_FOUND', '找不到这个项目', 404);
  const store = getVideoStore(env);
  if (store) await store.removePrefix(`${id}/`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments WHERE feedback_id IN (SELECT f.id FROM feedback f JOIN versions v ON v.id = f.version_id WHERE v.project_id = ?)').bind(id),
    env.DB.prepare('DELETE FROM feedback WHERE version_id IN (SELECT id FROM versions WHERE project_id = ?)').bind(id),
    env.DB.prepare('DELETE FROM versions WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
  return json(null, 204);
}

// ---------- 项目接口 ----------
export async function getState(ctx) {
  const { env, project } = ctx;
  const versions = (await env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY number ASC').bind(project.id).all()).results;
  const feedback = (await env.DB.prepare(`SELECT ${FEEDBACK_COLS} FROM feedback f JOIN versions v ON v.id = f.version_id WHERE v.project_id = ? AND f.deleted_at IS NULL ORDER BY f.seq ASC`).bind(project.id).all()).results;
  const atts = (await env.DB.prepare("SELECT a.id, a.feedback_id, a.name, a.mime, a.size, a.kind, a.status FROM attachments a JOIN feedback f ON f.id = a.feedback_id JOIN versions v ON v.id = f.version_id WHERE v.project_id = ? AND a.status != 'deleted' ORDER BY a.created_at ASC").bind(project.id).all()).results;
  const attsByFb = new Map();
  for (const a of atts) { if (!attsByFb.has(a.feedback_id)) attsByFb.set(a.feedback_id, []); attsByFb.get(a.feedback_id).push(attachmentMeta(a)); }
  const fbByVersion = new Map();
  for (const f of feedback) { if (!fbByVersion.has(f.version_id)) fbByVersion.set(f.version_id, []); fbByVersion.get(f.version_id).push(publicFeedback(f, attsByFb.get(f.id) || [])); }
  return json({ role: ctx.role, project: publicProject(project), versions: versions.map((v) => publicVersion(v, fbByVersion.get(v.id) || [])) });
}

export async function patchProject(ctx) {
  const { env, project, request } = ctx;
  const body = await readJson(request);
  assert(body.fps != null, 'BAD_REQUEST', '没有可修改的内容');
  const fps = validateFps(body.fps);
  const t = nowIso();
  await env.DB.prepare('UPDATE projects SET fps = ?, updated_at = ? WHERE id = ?').bind(fps, t, project.id).run();
  return json({ project: publicProject({ ...project, fps, updated_at: t }) });
}

export async function createVersion(ctx) {
  const { env, project, request } = ctx;
  const video = validateVideo((await readJson(request)).video);
  const t = nowIso();
  const id = newId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO versions (id, project_id, number, video_name, video_size, video_duration, status, created_at) VALUES (?1, ?2, COALESCE((SELECT MAX(number) FROM versions WHERE project_id = ?2), 0) + 1, ?3, ?4, ?5, ?6, ?7)')
      .bind(id, project.id, video.name, video.size, video.duration, 'collecting', t),
    env.DB.prepare('UPDATE projects SET current_version = (SELECT number FROM versions WHERE id = ?1), updated_at = ?2 WHERE id = ?3').bind(id, t, project.id),
  ]);
  const version = await env.DB.prepare('SELECT * FROM versions WHERE id = ?').bind(id).first();
  return json({ version: publicVersion(version) }, 201);
}

export async function createFeedback(ctx) {
  need(ctx, 'owner');
  const { env, project, request } = ctx;
  const cur = await currentVersion(ctx);
  assert(cur.status === 'collecting', 'ROUND_CLOSED', '本轮反馈已结束，撤回后才能继续写意见', 409);
  const body = await readJson(request);
  const text = (optionalString(body.text, '意见文字', 5000) || '').trim();
  const annotation = strOrNull(body.annotation);
  const thumb = strOrNull(body.annotation_thumb);
  assert(!!annotation === !!thumb, 'BAD_REQUEST', '标记大图与缩略图要一起提供');
  if (annotation) assert(isImageData(annotation) && isImageData(thumb), 'BAD_REQUEST', '标记图片不合法或过大');
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  assert(attachments.length <= MAX_ATTACHMENTS, 'BAD_REQUEST', `附件最多 ${MAX_ATTACHMENTS} 个`);
  const attRows = attachments.map(validateAttachment);
  assert(text || annotation || attachments.length, 'BAD_REQUEST', '意见不能为空');
  let timecode = body.timecode ?? null;
  if (timecode != null) {
    assert(typeof timecode === 'number' && Number.isFinite(timecode) && timecode >= 0, 'BAD_REQUEST', '时间码不合法');
  }
  const t = nowIso();
  const f = { id: newId(), seq: 0, timecode, text, annotation_thumb: thumb, has_annotation: !!annotation, status: 'open', editor_note: '', created_at: t, updated_at: t };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO feedback (id, version_id, seq, timecode, text, annotation, annotation_thumb, status, editor_note, created_at, updated_at) VALUES (?1, ?2, COALESCE((SELECT MAX(seq) FROM feedback WHERE version_id = ?2), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)')
      .bind(f.id, cur.id, timecode, text, annotation, thumb, 'open', '', t),
    ...attRows.map((a) => env.DB.prepare('INSERT INTO attachments (id, feedback_id, name, mime, data, created_at, kind, size, status) VALUES (?,?,?,?,?,?,?,?,?)').bind(a.id, f.id, a.name, a.mime, a.data, t, a.kind, a.size, a.status)),
    touch(env, project.id, t),
  ]);
  f.seq = (await env.DB.prepare('SELECT seq FROM feedback WHERE id = ?').bind(f.id).first()).seq;
  return json({ feedback: publicFeedback(f, attRows.map(attachmentMeta)) }, 201);
}

export async function deleteFeedback(ctx) {
  need(ctx, 'owner');
  const { env, project, params } = ctx;
  const f = await findFeedback(ctx, params[0]);
  assert(f.version_number === project.current_version, 'VERSION_LOCKED', '历史版本只读，不能改动', 409);
  assert(f.version_status !== 'approved', 'VERSION_APPROVED', '这一版已确认通过，不能再删意见', 409);
  const store = getVideoStore(env);
  const media = (await env.DB.prepare("SELECT id, store_key FROM attachments WHERE feedback_id = ? AND kind != 'image' AND status != 'deleted'").bind(f.id).all()).results;
  for (const a of media) if (store && a.store_key) await store.remove(a.store_key);
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE feedback SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(t, t, f.id),
    env.DB.prepare("UPDATE attachments SET status = 'deleted', size = 0, store_key = NULL, upload_id = NULL WHERE feedback_id = ? AND kind != 'image'").bind(f.id),
    touch(env, project.id, t),
  ]);
  return json(null, 204);
}

export async function patchFeedback(ctx) {
  need(ctx, 'editor');
  const { env, project, params, request } = ctx;
  const f = await findFeedback(ctx, params[0]);
  assert(f.version_number === project.current_version, 'VERSION_LOCKED', '历史版本只读，不能改动', 409);
  const body = await readJson(request);
  const sets = []; const vals = [];
  if (body.status != null) {
    assert(['open', 'done'].includes(body.status), 'BAD_REQUEST', '状态不合法');
    sets.push('status = ?'); vals.push(body.status); f.status = body.status;
  }
  if (body.editor_note != null) {
    const note = optionalString(body.editor_note, '修改说明', 2000);
    sets.push('editor_note = ?'); vals.push(note); f.editor_note = note;
  }
  assert(sets.length, 'BAD_REQUEST', '没有可修改的内容');
  const t = nowIso();
  sets.push('updated_at = ?'); vals.push(t); f.updated_at = t;
  await env.DB.batch([
    env.DB.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, f.id),
    touch(env, project.id, t),
  ]);
  return json({ feedback: publicFeedback(f, await attachmentsOf(env, f.id)) });
}

export async function getAnnotation(ctx) {
  const { env, project, params } = ctx;
  const row = await env.DB.prepare('SELECT f.annotation FROM feedback f JOIN versions v ON v.id = f.version_id WHERE f.id = ? AND v.project_id = ? AND f.deleted_at IS NULL').bind(params[0], project.id).first();
  assert(row, 'NOT_FOUND', '找不到这条意见', 404);
  assert(row.annotation, 'NOT_FOUND', '这条意见没有画面标记', 404);
  return json({ annotation: row.annotation });
}

export async function getAttachment(ctx) {
  const { env, project, params } = ctx;
  const row = await env.DB.prepare("SELECT a.id, a.name, a.mime, a.data, a.kind, a.size, a.status FROM attachments a JOIN feedback f ON f.id = a.feedback_id JOIN versions v ON v.id = f.version_id WHERE a.id = ? AND v.project_id = ? AND f.deleted_at IS NULL AND a.status != 'deleted'").bind(params[0], project.id).first();
  assert(row, 'NOT_FOUND', '找不到这个附件', 404);
  if (row.kind && row.kind !== 'image') return json(attachmentMeta(row));
  return json({ id: row.id, name: row.name, mime: row.mime, data: row.data });
}

// ---------- 本轮状态 ----------
async function transition(ctx, check, patch) {
  const cur = await currentVersion(ctx);
  await check(cur);
  const t = nowIso();
  const next = { ...cur, ...patch(cur, t) };
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE versions SET status = ?, closed_at = ?, approved_at = ? WHERE id = ?').bind(next.status, next.closed_at, next.approved_at, cur.id),
    touch(ctx.env, ctx.project.id, t),
  ]);
  return json({ version: await loadVersion(ctx.env, cur.id) });
}

export async function closeRound(ctx) {
  need(ctx, 'owner');
  return transition(ctx,
    async (cur) => {
      assert(cur.status === 'collecting', 'INVALID_STATE', '当前状态不能结束本轮', 409);
      const n = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE version_id = ? AND deleted_at IS NULL').bind(cur.id).first();
      assert(n && n.n > 0, 'NO_FEEDBACK', '还没有任何意见，不能结束本轮', 409);
    },
    (cur, t) => ({ status: 'closed', closed_at: t }));
}

export async function reopenRound(ctx) {
  need(ctx, 'owner');
  return transition(ctx,
    (cur) => { assert(cur.status === 'closed', 'INVALID_STATE', '当前状态不能撤回结束', 409); },
    () => ({ status: 'collecting', closed_at: null }));
}

export async function approve(ctx) {
  need(ctx, 'owner');
  return transition(ctx,
    (cur) => { assert(cur.status !== 'approved', 'INVALID_STATE', '这一版已经确认通过', 409); },
    (cur, t) => ({ status: 'approved', approved_at: t }));
}

export async function unapprove(ctx) {
  need(ctx, 'owner');
  return transition(ctx,
    (cur) => { assert(cur.status === 'approved', 'INVALID_STATE', '这一版还没有确认通过', 409); },
    (cur) => ({ status: cur.closed_at ? 'closed' : 'collecting', approved_at: null }));
}

// ---------- 视频托管（R2 或 KV，见 videostore.js） ----------
async function findVersion(ctx, id) {
  const v = await ctx.env.DB.prepare('SELECT * FROM versions WHERE id = ? AND project_id = ?').bind(id, ctx.project.id).first();
  assert(v, 'NOT_FOUND', '找不到这个客稿版本', 404);
  return v;
}
const extOf = (mime) => (mime === 'video/quicktime' ? '.mov' : mime === 'video/webm' ? '.webm' : '.mp4');
function storeOf(env) { const s = getVideoStore(env); assert(s, 'NO_STORAGE', '服务器还没有配置视频存储', 503); return s; }
const fmtMB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

async function videoUsage(env) {
  const v = await env.DB.prepare("SELECT COALESCE(SUM(video_size), 0) AS n FROM versions WHERE video_status IN ('ready', 'uploading') AND video_key IS NOT NULL").first();
  const a = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE kind != 'image' AND status IN ('ready', 'uploading')").first();
  return (v?.n || 0) + (a?.n || 0);
}
async function discardVideo(store, v) {
  if (!v.video_key) return;
  if (v.upload_id) await store.abort(v.video_key, v.upload_id);
  await store.remove(v.video_key);
}
const clearVideoSql = (env, id) => env.DB.prepare('UPDATE versions SET video_key = NULL, video_mime = NULL, video_status = ?, upload_id = NULL WHERE id = ?').bind('none', id);

/** 空间不够时，从本项目最早的版本开始清掉已托管视频，直到放得下；返回清理后的用量 */
async function freeSpaceFor(env, store, project, v, size) {
  let used = await videoUsage(env);
  if (used + size <= store.totalLimit) return used;
  const olds = (await env.DB.prepare("SELECT * FROM versions WHERE project_id = ? AND id != ? AND video_status = 'ready' AND video_key IS NOT NULL ORDER BY number ASC").bind(project.id, v.id).all()).results;
  for (const o of olds) {
    if (used + size <= store.totalLimit) break;
    await discardVideo(store, o);
    await clearVideoSql(env, o.id).run();
    used -= o.video_size;
  }
  return Math.max(0, used);
}

/** 上传完成后只保留最近两版的视频，释放空间 */
async function pruneOldVideos(env, store, project, keepFrom) {
  const old = (await env.DB.prepare("SELECT * FROM versions WHERE project_id = ? AND number < ? AND video_status = 'ready' AND video_key IS NOT NULL").bind(project.id, keepFrom).all()).results;
  for (const v of old) { await discardVideo(store, v); await clearVideoSql(env, v.id).run(); }
  return old.length;
}

export async function uploadStart(ctx) {
  const { env, project, params, request } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  const body = await readJson(request);
  const size = Number(body.size);
  assert(Number.isInteger(size) && size > 0, 'BAD_REQUEST', '视频大小不合法');
  assert(size <= store.maxVideo, 'BAD_REQUEST', `单个视频最大 ${fmtMB(store.maxVideo)}，请压缩后再传`);
  const mime = String(body.mime || 'video/mp4');
  assert(mime.startsWith('video/') && mime.length <= 64, 'BAD_REQUEST', '只支持视频文件');
  await discardVideo(store, v);
  await clearVideoSql(env, v.id).run();
  const used = await freeSpaceFor(env, store, project, v, size);
  assert(used + size <= store.totalLimit, 'STORAGE_FULL', `视频空间不够（已用 ${fmtMB(used)} / ${fmtMB(store.totalLimit)}，这个视频 ${fmtMB(size)}），先删除旧项目或旧附件释放空间`, 507);
  const key = `${project.id}/${v.id}${extOf(mime)}`;
  const uploadId = await store.createUpload(key, mime);
  await env.DB.batch([
    env.DB.prepare('UPDATE versions SET video_key = ?, video_mime = ?, video_status = ?, upload_id = ?, video_size = ? WHERE id = ?')
      .bind(key, mime, 'uploading', uploadId, size, v.id),
    touch(env, project.id),
  ]);
  return json({ upload_id: uploadId, part_size: store.partSize });
}

export async function uploadPart(ctx) {
  const { env, params, request } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('upload_id') || '';
  const partNumber = Number(url.searchParams.get('part'));
  assert(v.video_status === 'uploading' && v.upload_id && uploadId === v.upload_id, 'INVALID_STATE', '这个上传已失效，请重新开始', 409);
  assert(Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10000, 'BAD_REQUEST', '分片编号不合法');
  const data = await request.arrayBuffer();
  assert(data.byteLength > 0 && data.byteLength <= store.partSize, 'BAD_REQUEST', '分片大小不合法');
  const etag = await store.uploadPart(v.video_key, uploadId, partNumber, data);
  return json({ part_number: partNumber, etag });
}

export async function uploadComplete(ctx) {
  const { env, project, params, request } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  const body = await readJson(request);
  assert(v.video_status === 'uploading' && v.upload_id && body.upload_id === v.upload_id, 'INVALID_STATE', '这个上传已失效，请重新开始', 409);
  assert(Array.isArray(body.parts) && body.parts.length > 0 && body.parts.length <= 10000, 'BAD_REQUEST', '缺少分片信息');
  const parts = body.parts.map((p) => ({ partNumber: Number(p.part_number), etag: String(p.etag) }));
  let size;
  try { size = await store.complete(v.video_key, v.upload_id, parts, v.video_mime, v.video_size); }
  catch (e) { await discardVideo(store, v); await clearVideoSql(env, v.id).run(); fail('UPLOAD_FAILED', `上传校验失败：${e.message}`, 400); }
  await env.DB.batch([
    env.DB.prepare('UPDATE versions SET video_status = ?, upload_id = NULL, video_size = ? WHERE id = ?').bind('ready', size, v.id),
    touch(env, project.id),
  ]);
  const pruned = await pruneOldVideos(env, store, project, v.number - 1);
  return json({ version: await loadVersion(env, v.id), pruned });
}

export async function uploadAbort(ctx) {
  const { env, project, params } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  if (v.video_status === 'uploading') {
    await discardVideo(store, v);
    await env.DB.batch([clearVideoSql(env, v.id), touch(env, project.id)]);
  }
  return json({ version: await loadVersion(env, v.id) });
}

export async function deleteVideo(ctx) {
  need(ctx, 'owner');
  const { env, project, params } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  await discardVideo(store, v);
  await env.DB.batch([clearVideoSql(env, v.id), touch(env, project.id)]);
  return json({ version: await loadVersion(env, v.id) });
}

/** 按 Range 转发存储里的文件，供 <video>/<audio> 直接播放；?download=1 时作为附件下载 */
async function streamStored(store, key, filename, request) {
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' });
  const head = await store.head(key);
  assert(head, 'NOT_FOUND', '文件不存在', 404);
  headers.set('Content-Type', head.mime);
  headers.set('ETag', head.etag);
  if (new URL(request.url).searchParams.get('download')) {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename || 'file')}`);
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }
  const range = parseRange(request.headers.get('Range'), head.size);
  if (range === false) {
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  const want = range || { offset: 0, length: head.size };
  const res = await store.get(key, want);
  assert(res, 'NOT_FOUND', '文件不存在', 404);
  if (res.missing) fail('VIDEO_SYNCING', '文件正在同步到你附近的节点，稍后自动重试', 503);
  headers.set('Content-Length', String(want.length));
  if (range) {
    headers.set('Content-Range', `bytes ${want.offset}-${want.offset + want.length - 1}/${head.size}`);
    return new Response(res.body, { status: 206, headers });
  }
  return new Response(res.body, { status: 200, headers });
}

export async function getVideo(ctx) {
  const { env, params, request } = ctx;
  const store = storeOf(env);
  const v = await findVersion(ctx, params[0]);
  assert(v.video_status === 'ready' && v.video_key, 'NOT_FOUND', '这一版没有托管视频', 404);
  return streamStored(store, v.video_key, v.video_name || 'video.mp4', request);
}

// ---------- 媒体附件上传（与客稿视频共用存储） ----------
async function findAttachment(ctx, id) {
  const a = await ctx.env.DB.prepare("SELECT a.* FROM attachments a JOIN feedback f ON f.id = a.feedback_id JOIN versions v ON v.id = f.version_id WHERE a.id = ? AND v.project_id = ? AND f.deleted_at IS NULL AND a.status != 'deleted'").bind(id, ctx.project.id).first();
  assert(a, 'NOT_FOUND', '找不到这个附件', 404);
  return a;
}
async function discardMedia(store, a) { if (a.store_key) await store.remove(a.store_key); }
const clearMediaSql = (env, id) => env.DB.prepare('UPDATE attachments SET store_key = NULL, upload_id = NULL WHERE id = ?').bind(id);

export async function attachmentUploadStart(ctx) {
  need(ctx, 'owner');
  const { env, project, params } = ctx;
  const store = storeOf(env);
  const a = await findAttachment(ctx, params[0]);
  assert(a.kind !== 'image' && a.status === 'uploading', 'INVALID_STATE', '这个附件不需要上传', 409);
  await discardMedia(store, a);
  const used = await videoUsage(env); // 已含本附件声明的大小
  assert(used <= store.totalLimit, 'STORAGE_FULL', `空间不够（已用 ${fmtMB(used)} / ${fmtMB(store.totalLimit)}），先清理旧视频或删除旧附件`, 507);
  const key = `${project.id}/att/${a.id}`;
  const uploadId = await store.createUpload(key, a.mime);
  await env.DB.prepare('UPDATE attachments SET store_key = ?, upload_id = ? WHERE id = ?').bind(key, uploadId, a.id).run();
  return json({ upload_id: uploadId, part_size: store.partSize });
}

export async function attachmentUploadPart(ctx) {
  need(ctx, 'owner');
  const { env, params, request } = ctx;
  const store = storeOf(env);
  const a = await findAttachment(ctx, params[0]);
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('upload_id') || '';
  const partNumber = Number(url.searchParams.get('part'));
  assert(a.status === 'uploading' && a.upload_id && uploadId === a.upload_id, 'INVALID_STATE', '这个上传已失效，请重新开始', 409);
  assert(Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10000, 'BAD_REQUEST', '分片编号不合法');
  const data = await request.arrayBuffer();
  assert(data.byteLength > 0 && data.byteLength <= store.partSize, 'BAD_REQUEST', '分片大小不合法');
  const etag = await store.uploadPart(a.store_key, uploadId, partNumber, data);
  return json({ part_number: partNumber, etag });
}

export async function attachmentUploadComplete(ctx) {
  need(ctx, 'owner');
  const { env, project, params, request } = ctx;
  const store = storeOf(env);
  const a = await findAttachment(ctx, params[0]);
  const body = await readJson(request);
  assert(a.status === 'uploading' && a.upload_id && body.upload_id === a.upload_id, 'INVALID_STATE', '这个上传已失效，请重新开始', 409);
  assert(Array.isArray(body.parts) && body.parts.length > 0 && body.parts.length <= 10000, 'BAD_REQUEST', '缺少分片信息');
  const parts = body.parts.map((p) => ({ partNumber: Number(p.part_number), etag: String(p.etag) }));
  let size;
  try { size = await store.complete(a.store_key, a.upload_id, parts, a.mime, a.size); }
  catch (e) { await discardMedia(store, a); await clearMediaSql(env, a.id).run(); fail('UPLOAD_FAILED', `上传校验失败：${e.message}`, 400); }
  await env.DB.batch([
    env.DB.prepare("UPDATE attachments SET status = 'ready', upload_id = NULL, size = ? WHERE id = ?").bind(size, a.id),
    touch(env, project.id),
  ]);
  return json({ attachment: attachmentMeta({ ...a, status: 'ready', size }) });
}

export async function attachmentUploadAbort(ctx) {
  need(ctx, 'owner');
  const { env, params } = ctx;
  const store = storeOf(env);
  const a = await findAttachment(ctx, params[0]);
  if (a.status === 'uploading') { await discardMedia(store, a); await clearMediaSql(env, a.id).run(); }
  return json({ attachment: attachmentMeta(a) });
}

export async function getAttachmentMedia(ctx) {
  const { env, params, request } = ctx;
  const store = storeOf(env);
  const a = await findAttachment(ctx, params[0]);
  assert(a.kind !== 'image' && a.status === 'ready' && a.store_key, 'NOT_FOUND', '这个附件还没上传完成', 404);
  return streamStored(store, a.store_key, a.name, request);
}
