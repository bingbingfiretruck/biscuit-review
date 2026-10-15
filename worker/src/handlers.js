import { fail, assert, nowIso, newId, newToken, json, readJson } from './util.js';

const FPS = [24, 25, 30, 50, 60];
const MAX_IMAGE = 1900000;
const MAX_ATTACHMENTS = 6;

// ---------- 形状 ----------
const publicProject = (p) => ({ id: p.id, name: p.name, fps: p.fps, current_version: p.current_version, created_at: p.created_at, updated_at: p.updated_at });
const publicVersion = (v, feedback = []) => ({
  id: v.id, number: v.number, video_name: v.video_name, video_size: v.video_size, video_duration: v.video_duration,
  status: v.status, closed_at: v.closed_at, approved_at: v.approved_at, created_at: v.created_at, feedback,
});
const publicFeedback = (f, attachments = []) => ({
  id: f.id, seq: f.seq, timecode: f.timecode, text: f.text,
  has_annotation: !!(f.has_annotation ?? f.annotation), annotation_thumb: f.annotation_thumb ?? null,
  status: f.status, editor_note: f.editor_note, attachments, created_at: f.created_at, updated_at: f.updated_at,
});
const attachmentMeta = (a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size });

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
  const atts = (await env.DB.prepare('SELECT a.id, a.feedback_id, a.name, a.mime, length(a.data) AS size FROM attachments a JOIN feedback f ON f.id = a.feedback_id WHERE f.version_id = ? ORDER BY a.created_at ASC').bind(versionId).all()).results;
  return publicVersion(v, fb.map((f) => publicFeedback(f, atts.filter((a) => a.feedback_id === f.id).map(attachmentMeta))));
}
async function findFeedback(ctx, id) {
  const f = await ctx.env.DB.prepare(`SELECT ${FEEDBACK_COLS}, v.status AS version_status FROM feedback f JOIN versions v ON v.id = f.version_id WHERE f.id = ? AND v.project_id = ? AND f.deleted_at IS NULL`).bind(id, ctx.project.id).first();
  assert(f, 'NOT_FOUND', '找不到这条意见', 404);
  return f;
}
async function attachmentsOf(env, feedbackId) {
  const rows = (await env.DB.prepare('SELECT id, name, mime, length(data) AS size FROM attachments WHERE feedback_id = ? ORDER BY created_at ASC').bind(feedbackId).all()).results;
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
  return json({ projects: rows.map((p) => ({ ...publicProject(p), owner_token: p.owner_token, editor_token: p.editor_token, status: p.status || 'collecting', feedback_count: p.feedback_count || 0 })) });
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
  const atts = (await env.DB.prepare('SELECT a.id, a.feedback_id, a.name, a.mime, length(a.data) AS size FROM attachments a JOIN feedback f ON f.id = a.feedback_id JOIN versions v ON v.id = f.version_id WHERE v.project_id = ? ORDER BY a.created_at ASC').bind(project.id).all()).results;
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
  const row = await env.DB.prepare('SELECT MAX(number) AS n FROM versions WHERE project_id = ?').bind(project.id).first();
  const number = (row?.n || 0) + 1;
  const t = nowIso();
  const version = { id: newId(), number, video_name: video.name, video_size: video.size, video_duration: video.duration, status: 'collecting', closed_at: null, approved_at: null, created_at: t };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO versions (id, project_id, number, video_name, video_size, video_duration, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(version.id, project.id, number, video.name, video.size, video.duration, 'collecting', t),
    env.DB.prepare('UPDATE projects SET current_version = ?, updated_at = ? WHERE id = ?').bind(number, t, project.id),
  ]);
  return json({ version: publicVersion(version) }, 201);
}

export async function createFeedback(ctx) {
  need(ctx, 'owner');
  const { env, project, request } = ctx;
  const cur = await currentVersion(ctx);
  assert(cur.status === 'collecting', 'ROUND_CLOSED', '本轮反馈已结束，撤回后才能继续写意见', 409);
  const body = await readJson(request);
  const text = String(body.text ?? '').trim();
  assert(text.length <= 5000, 'BAD_REQUEST', '意见文字不能超过 5000 字');
  const annotation = body.annotation ?? null;
  const thumb = body.annotation_thumb ?? null;
  assert(!!annotation === !!thumb, 'BAD_REQUEST', '标记大图与缩略图要一起提供');
  if (annotation) assert(isImageData(annotation) && isImageData(thumb), 'BAD_REQUEST', '标记图片不合法或过大');
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  assert(attachments.length <= MAX_ATTACHMENTS, 'BAD_REQUEST', `附件最多 ${MAX_ATTACHMENTS} 张`);
  for (const a of attachments) {
    assert(a && isImageData(a.data), 'BAD_REQUEST', '附件不合法或过大');
    assert(String(a.mime ?? '').startsWith('image/'), 'BAD_REQUEST', '附件只支持图片');
    assert(String(a.name ?? '').length <= 255, 'BAD_REQUEST', '附件名太长');
  }
  assert(text || annotation || attachments.length, 'BAD_REQUEST', '意见不能为空');
  let timecode = body.timecode ?? null;
  if (timecode != null) {
    timecode = Number(timecode);
    assert(Number.isFinite(timecode) && timecode >= 0, 'BAD_REQUEST', '时间码不合法');
  }
  const seqRow = await env.DB.prepare('SELECT MAX(seq) AS n FROM feedback WHERE version_id = ?').bind(cur.id).first();
  const seq = (seqRow?.n || 0) + 1;
  const t = nowIso();
  const f = { id: newId(), seq, timecode, text, annotation_thumb: thumb, has_annotation: !!annotation, status: 'open', editor_note: '', created_at: t, updated_at: t };
  const attRows = attachments.map((a) => ({ id: newId(), name: String(a.name || '图片').slice(0, 255), mime: String(a.mime), data: a.data, size: a.data.length }));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO feedback (id, version_id, seq, timecode, text, annotation, annotation_thumb, status, editor_note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(f.id, cur.id, seq, timecode, text, annotation, thumb, 'open', '', t, t),
    ...attRows.map((a) => env.DB.prepare('INSERT INTO attachments (id, feedback_id, name, mime, data, created_at) VALUES (?,?,?,?,?,?)').bind(a.id, f.id, a.name, a.mime, a.data, t)),
    touch(env, project.id, t),
  ]);
  return json({ feedback: publicFeedback(f, attRows.map(attachmentMeta)) }, 201);
}

export async function deleteFeedback(ctx) {
  need(ctx, 'owner');
  const { env, project, params } = ctx;
  const f = await findFeedback(ctx, params[0]);
  assert(f.version_status !== 'approved', 'VERSION_APPROVED', '这一版已确认通过，不能再删意见', 409);
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE feedback SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(t, t, f.id),
    touch(env, project.id, t),
  ]);
  return json(null, 204);
}

export async function patchFeedback(ctx) {
  need(ctx, 'editor');
  const { env, project, params, request } = ctx;
  const f = await findFeedback(ctx, params[0]);
  const body = await readJson(request);
  const sets = []; const vals = [];
  if (body.status != null) {
    assert(['open', 'done'].includes(body.status), 'BAD_REQUEST', '状态不合法');
    sets.push('status = ?'); vals.push(body.status); f.status = body.status;
  }
  if (body.editor_note != null) {
    const note = String(body.editor_note);
    assert(note.length <= 2000, 'BAD_REQUEST', '修改说明不能超过 2000 字');
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
  const row = await env.DB.prepare('SELECT a.id, a.name, a.mime, a.data FROM attachments a JOIN feedback f ON f.id = a.feedback_id JOIN versions v ON v.id = f.version_id WHERE a.id = ? AND v.project_id = ?').bind(params[0], project.id).first();
  assert(row, 'NOT_FOUND', '找不到这个附件', 404);
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
