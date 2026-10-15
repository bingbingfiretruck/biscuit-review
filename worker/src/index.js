import { ApiError, json } from './util.js';
import * as H from './handlers.js';

const ROUTES = [
  ['GET', /^\/api\/admin\/projects$/, 'admin', H.adminList],
  ['POST', /^\/api\/admin\/projects$/, 'admin', H.adminCreate],
  ['DELETE', /^\/api\/admin\/projects\/([^/]+)$/, 'admin', H.adminDelete],
  ['GET', /^\/api\/p$/, 'project', H.getState],
  ['PATCH', /^\/api\/p$/, 'project', H.patchProject],
  ['POST', /^\/api\/p\/versions$/, 'project', H.createVersion],
  ['POST', /^\/api\/p\/feedback$/, 'project', H.createFeedback],
  ['DELETE', /^\/api\/p\/feedback\/([^/]+)$/, 'project', H.deleteFeedback],
  ['PATCH', /^\/api\/p\/feedback\/([^/]+)$/, 'project', H.patchFeedback],
  ['GET', /^\/api\/p\/feedback\/([^/]+)\/annotation$/, 'project', H.getAnnotation],
  ['GET', /^\/api\/p\/attachments\/([^/]+)$/, 'project', H.getAttachment],
  ['POST', /^\/api\/p\/round\/close$/, 'project', H.closeRound],
  ['POST', /^\/api\/p\/round\/reopen$/, 'project', H.reopenRound],
  ['POST', /^\/api\/p\/approve$/, 'project', H.approve],
  ['POST', /^\/api\/p\/unapprove$/, 'project', H.unapprove],
  ['POST', /^\/api\/p\/versions\/([^/]+)\/upload\/start$/, 'project', H.uploadStart],
  ['PUT', /^\/api\/p\/versions\/([^/]+)\/upload\/part$/, 'project', H.uploadPart],
  ['POST', /^\/api\/p\/versions\/([^/]+)\/upload\/complete$/, 'project', H.uploadComplete],
  ['POST', /^\/api\/p\/versions\/([^/]+)\/upload\/abort$/, 'project', H.uploadAbort],
  ['DELETE', /^\/api\/p\/versions\/([^/]+)\/video$/, 'project', H.deleteVideo],
  ['GET', /^\/api\/p\/videos\/([^/]+)$/, 'project', H.getVideo],
  ['HEAD', /^\/api\/p\/videos\/([^/]+)$/, 'project', H.getVideo],
];

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes('*') || allowed.includes(origin));
  const headers = {
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Key, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (ok) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function match(request, pathname) {
  let pathMatched = false;
  for (const [method, re, scope, handler] of ROUTES) {
    const m = pathname.match(re);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    let params;
    try { params = m.slice(1).map(decodeURIComponent); }
    catch { throw new ApiError('NOT_FOUND', '没有这个接口', 404); }
    return { scope, handler, params };
  }
  if (pathMatched) throw new ApiError('METHOD_NOT_ALLOWED', '不支持这个方法', 405);
  throw new ApiError('NOT_FOUND', '没有这个接口', 404);
}

async function authenticate(ctx, scope) {
  const { request, env } = ctx;
  if (scope === 'admin') {
    const key = request.headers.get('X-Admin-Key') || '';
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) throw new ApiError('INVALID_ADMIN_KEY', '管理口令不对', 401);
    return;
  }
  const auth = request.headers.get('Authorization') || '';
  // <video src> 发不了请求头，播放视频时允许用 ?t= 带 token
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (new URL(request.url).searchParams.get('t') || '').trim();
  if (!token) throw new ApiError('INVALID_TOKEN', '这个审片链接无效或已失效', 401);
  const project = await env.DB.prepare('SELECT * FROM projects WHERE owner_token = ?1 OR editor_token = ?1').bind(token).first();
  if (!project) throw new ApiError('INVALID_TOKEN', '这个审片链接无效或已失效', 401);
  ctx.project = project;
  ctx.role = project.owner_token === token ? 'owner' : 'editor';
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) throw new ApiError('NOT_FOUND', '没有这个地址', 404);
      const route = match(request, url.pathname);
      const ctx = { env, request, params: route.params };
      await authenticate(ctx, route.scope);
      const res = await route.handler(ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status, cors);
      if (/UNIQUE constraint failed/i.test(String(e && e.message))) return json({ error: '和另一次操作撞上了，请刷新后重试', code: 'CONFLICT' }, 409, cors);
      console.error('INTERNAL', (e && e.stack) || e);
      return json({ error: '服务器开小差了', code: 'INTERNAL' }, 500, cors);
    }
  },
};
