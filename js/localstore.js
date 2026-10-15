// 本地模式：用 localStorage 实现与 api.js 同名的方法，形状、校验、错误码与 Worker 保持一致。
import { ApiError } from './api.js';
import { uid, randomToken } from './util.js';

const KEY = 'biscuit.local.projects';
const now = () => new Date().toISOString();
const FPS = [24, 25, 30, 50, 60];

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch { fail('STORAGE_FULL', '本地模式的浏览器存储已满，删掉一些带图片的意见再试', 507); }
}
function fail(code, message, status) { throw new ApiError(code, message, status); }

function publicFeedback(f) {
  const { annotation, attachments, deleted_at, ...rest } = f;
  return {
    ...rest,
    has_annotation: !!annotation,
    attachments: (attachments || []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.data.length })),
  };
}
function publicVersion(v) {
  return { ...v, feedback: v.feedback.filter((f) => !f.deleted_at).map(publicFeedback) };
}
function publicProject(p) {
  const { owner_token, editor_token, versions, ...rest } = p;
  return rest;
}
const currentVersion = (p) => p.versions.find((v) => v.number === p.current_version);

function validateVideo(video) {
  if (!video || typeof video !== 'object') fail('BAD_REQUEST', '缺少视频信息', 400);
  const name = String(video.name || '').trim();
  if (!name || name.length > 255) fail('BAD_REQUEST', '视频文件名不合法', 400);
  const size = Number(video.size);
  if (!Number.isInteger(size) || size <= 0) fail('BAD_REQUEST', '视频大小不合法', 400);
  const duration = Number(video.duration ?? 0);
  if (!Number.isFinite(duration) || duration < 0) fail('BAD_REQUEST', '视频时长不合法', 400);
  return { name, size, duration };
}

function makeVersion(number, video) {
  return { id: uid(), number, video_name: video.name, video_size: video.size, video_duration: video.duration,
    status: 'collecting', closed_at: null, approved_at: null, created_at: now(), feedback: [] };
}

export function createLocalApi({ token = '' } = {}) {
  const sleep = (r) => new Promise((res) => setTimeout(() => res(r), 40));

  function locate(list) {
    const p = list.find((x) => x.owner_token === token || x.editor_token === token);
    if (!p) fail('INVALID_TOKEN', '这个审片链接无效或已失效', 401);
    return { p, role: p.owner_token === token ? 'owner' : 'editor' };
  }
  /** 读-改-写，自动更新 updated_at 并保存 */
  function mutate(fn) {
    const list = load();
    const { p, role } = locate(list);
    const out = fn(p, role);
    p.updated_at = now();
    save(list);
    return sleep(out);
  }
  const need = (role, want) => { if (role !== want) fail('FORBIDDEN', '当前链接没有这个权限', 403); };
  function findFeedback(p, id) {
    for (const v of p.versions) {
      const f = v.feedback.find((x) => x.id === id && !x.deleted_at);
      if (f) return { v, f };
    }
    fail('NOT_FOUND', '找不到这条意见', 404);
  }

  return {
    isLocal: true,

    async getState() {
      const { p, role } = locate(load());
      return sleep({ role, project: publicProject(p), versions: p.versions.map(publicVersion) });
    },

    patchProject: (body) => mutate((p) => {
      const fps = Number(body?.fps);
      if (!FPS.includes(fps)) fail('BAD_REQUEST', 'fps 只能是 24/25/30/50/60', 400);
      p.fps = fps;
      return { project: publicProject(p) };
    }),

    createVersion: (video) => mutate((p) => {
      const v = validateVideo(video);
      const number = Math.max(0, ...p.versions.map((x) => x.number)) + 1;
      const ver = makeVersion(number, v);
      p.versions.push(ver);
      p.current_version = number;
      return { version: publicVersion(ver) };
    }),

    createFeedback: (body) => mutate((p, role) => {
      need(role, 'owner');
      const cur = currentVersion(p);
      if (cur.status !== 'collecting') fail('ROUND_CLOSED', '本轮反馈已结束，撤回后才能继续写意见', 409);
      if (body?.text != null && typeof body.text !== 'string') fail('BAD_REQUEST', '意见文字必须是文字', 400);
      const text = String(body?.text || '').trim();
      const annotation = typeof body?.annotation === 'string' && body.annotation ? body.annotation : null;
      const thumb = typeof body?.annotation_thumb === 'string' && body.annotation_thumb ? body.annotation_thumb : null;
      const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
      if (text.length > 5000) fail('BAD_REQUEST', '意见文字不能超过 5000 字', 400);
      if (!!annotation !== !!thumb) fail('BAD_REQUEST', '标记大图与缩略图要一起提供', 400);
      const okImg = (s) => s.startsWith('data:image/') && s.length <= 1900000;
      if (annotation && !(okImg(annotation) && okImg(thumb))) fail('BAD_REQUEST', '标记图片不合法或过大', 400);
      if (attachments.length > 6) fail('BAD_REQUEST', '附件最多 6 张', 400);
      for (const a of attachments) {
        if (!a?.data?.startsWith?.('data:image/') || a.data.length > 1900000) fail('BAD_REQUEST', '附件不合法或过大', 400);
        if (!String(a.mime || '').startsWith('image/')) fail('BAD_REQUEST', '附件只支持图片', 400);
        if (String(a.name ?? '').length > 255) fail('BAD_REQUEST', '附件名太长', 400);
      }
      if (!text && !annotation && attachments.length === 0) fail('BAD_REQUEST', '意见不能为空', 400);
      let timecode = body?.timecode ?? null;
      if (timecode != null && !(typeof timecode === 'number' && isFinite(timecode) && timecode >= 0)) fail('BAD_REQUEST', '时间码不合法', 400);
      const seq = Math.max(0, ...cur.feedback.map((f) => f.seq)) + 1;
      const t = now();
      const f = { id: uid(), seq, timecode, text, annotation, annotation_thumb: thumb, status: 'open', editor_note: '',
        attachments: attachments.map((a) => ({ id: uid(), name: String(a.name || '图片').slice(0, 255), mime: a.mime, data: a.data, created_at: t })),
        created_at: t, updated_at: t, deleted_at: null };
      cur.feedback.push(f);
      return { feedback: publicFeedback(f) };
    }),

    deleteFeedback: (id) => mutate((p, role) => {
      need(role, 'owner');
      const { v, f } = findFeedback(p, id);
      if (v.number !== p.current_version) fail('VERSION_LOCKED', '历史版本只读，不能改动', 409);
      if (v.status === 'approved') fail('VERSION_APPROVED', '这一版已确认通过，不能再删意见', 409);
      f.deleted_at = now();
      return null;
    }),

    patchFeedback: (id, body) => mutate((p, role) => {
      need(role, 'editor');
      const { v, f } = findFeedback(p, id);
      if (v.number !== p.current_version) fail('VERSION_LOCKED', '历史版本只读，不能改动', 409);
      if (body?.status == null && body?.editor_note == null) fail('BAD_REQUEST', '没有可修改的内容', 400);
      if (body?.status != null) {
        if (!['open', 'done'].includes(body.status)) fail('BAD_REQUEST', '状态不合法', 400);
        f.status = body.status;
      }
      if (body?.editor_note != null) {
        if (typeof body.editor_note !== 'string') fail('BAD_REQUEST', '修改说明必须是文字', 400);
        const note = body.editor_note;
        if (note.length > 2000) fail('BAD_REQUEST', '修改说明不能超过 2000 字', 400);
        f.editor_note = note;
      }
      f.updated_at = now();
      return { feedback: publicFeedback(f) };
    }),

    async getAnnotation(id) {
      const { p } = locate(load());
      const { f } = findFeedback(p, id);
      if (!f.annotation) fail('NOT_FOUND', '这条意见没有画面标记', 404);
      return sleep({ annotation: f.annotation });
    },

    async getAttachment(id) {
      const { p } = locate(load());
      for (const v of p.versions) for (const f of v.feedback) {
        const a = (f.attachments || []).find((x) => x.id === id);
        if (a) return sleep({ id: a.id, name: a.name, mime: a.mime, data: a.data });
      }
      fail('NOT_FOUND', '找不到这个附件', 404);
    },

    closeRound: () => mutate((p, role) => {
      need(role, 'owner');
      const cur = currentVersion(p);
      if (cur.status !== 'collecting') fail('INVALID_STATE', '当前状态不能结束本轮', 409);
      if (!cur.feedback.some((f) => !f.deleted_at)) fail('NO_FEEDBACK', '还没有任何意见，不能结束本轮', 409);
      cur.status = 'closed';
      cur.closed_at = now();
      return { version: publicVersion(cur) };
    }),
    reopenRound: () => mutate((p, role) => {
      need(role, 'owner');
      const cur = currentVersion(p);
      if (cur.status !== 'closed') fail('INVALID_STATE', '当前状态不能撤回结束', 409);
      cur.status = 'collecting';
      cur.closed_at = null;
      return { version: publicVersion(cur) };
    }),
    approve: () => mutate((p, role) => {
      need(role, 'owner');
      const cur = currentVersion(p);
      if (cur.status === 'approved') fail('INVALID_STATE', '这一版已经确认通过', 409);
      cur.status = 'approved';
      cur.approved_at = now();
      return { version: publicVersion(cur) };
    }),
    unapprove: () => mutate((p, role) => {
      need(role, 'owner');
      const cur = currentVersion(p);
      if (cur.status !== 'approved') fail('INVALID_STATE', '这一版还没有确认通过', 409);
      cur.status = cur.closed_at ? 'closed' : 'collecting';
      cur.approved_at = null;
      return { version: publicVersion(cur) };
    }),

    async adminList() {
      const list = load().slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return sleep({ projects: list.map((p) => {
        const cur = currentVersion(p);
        return { ...publicProject(p), owner_token: p.owner_token, editor_token: p.editor_token,
          status: cur?.status || 'collecting', feedback_count: cur ? cur.feedback.filter((f) => !f.deleted_at).length : 0 };
      }) });
    },
    async adminCreate(body) {
      const name = String(body?.name || '').trim();
      if (!name || name.length > 80) fail('BAD_REQUEST', '项目名 1–80 字', 400);
      const fps = body?.fps == null ? 30 : Number(body.fps);
      if (!FPS.includes(fps)) fail('BAD_REQUEST', 'fps 只能是 24/25/30/50/60', 400);
      const video = validateVideo(body?.video);
      const t = now();
      const ver = makeVersion(1, video);
      const p = { id: uid(), name, fps, owner_token: randomToken(), editor_token: randomToken(),
        current_version: 1, created_at: t, updated_at: t, versions: [ver] };
      const list = load();
      list.push(p);
      save(list);
      return sleep({ project: { ...publicProject(p), owner_token: p.owner_token, editor_token: p.editor_token }, version: publicVersion(ver) });
    },
    async adminDelete(id) {
      const list = load();
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) fail('NOT_FOUND', '找不到这个项目', 404);
      list.splice(i, 1);
      save(list);
      return sleep(null);
    },
  };
}
