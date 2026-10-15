// 对本地 dev server 跑一遍完整流程：node test/smoke.mjs
const BASE = process.env.API_BASE || 'http://127.0.0.1:8787/api';
const ADMIN = process.env.ADMIN_KEY || 'dev-admin';

let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { failures++; console.log(`✗ ${name}\n    ${e.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
async function req(method, path, { body, token, admin, origin } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['X-Admin-Key'] = admin;
  if (origin) headers.Origin = origin;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
  return { status: res.status, data, headers: res.headers };
}

const ctx = {};
await step('1 无管理口令 → 401 INVALID_ADMIN_KEY', async () => {
  const r = await req('GET', '/admin/projects');
  eq(r.status, 401, 'status'); eq(r.data.code, 'INVALID_ADMIN_KEY', 'code');
});
await step('2 新建项目 → 201，V1 collecting', async () => {
  const r = await req('POST', '/admin/projects', { admin: ADMIN, body: { name: '冒烟项目', video: { name: 'v1.mp4', size: 1234, duration: 61.5 } } });
  eq(r.status, 201, 'status');
  eq(r.data.version.number, 1, 'version.number'); eq(r.data.version.status, 'collecting', 'status');
  eq(typeof r.data.project.owner_token, 'string', 'owner_token'); eq(r.data.project.owner_token.length, 32, 'token 长度');
  Object.assign(ctx, { id: r.data.project.id, owner: r.data.project.owner_token, editor: r.data.project.editor_token });
});
await step('3 owner GET /p → role owner，1 个版本，无意见', async () => {
  const r = await req('GET', '/p', { token: ctx.owner });
  eq(r.status, 200, 'status'); eq(r.data.role, 'owner', 'role'); eq(r.data.versions.length, 1, 'versions'); eq(r.data.versions[0].feedback.length, 0, 'feedback');
});
await step('4 editor GET /p → role editor', async () => {
  const r = await req('GET', '/p', { token: ctx.editor }); eq(r.data.role, 'editor', 'role');
});
await step('5 坏 token → 401 INVALID_TOKEN', async () => {
  const r = await req('GET', '/p', { token: 'bad' }); eq(r.status, 401, 'status'); eq(r.data.code, 'INVALID_TOKEN', 'code');
});
await step('6 owner 写意见（带标记）→ 201 seq 1', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 12.5, text: '第一条', annotation: 'data:image/jpeg;base64,AAAA', annotation_thumb: 'data:image/jpeg;base64,BBBB' } });
  eq(r.status, 201, 'status'); eq(r.data.feedback.seq, 1, 'seq'); eq(r.data.feedback.has_annotation, true, 'has_annotation'); eq(r.data.feedback.annotation_thumb, 'data:image/jpeg;base64,BBBB', 'thumb');
  ctx.fb1 = r.data.feedback.id;
});
await step('7 owner 写意见（整片 + 附件）→ 201 seq 2', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: null, text: '', attachments: [{ name: 'ref.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,CCCC' }] } });
  eq(r.status, 201, 'status'); eq(r.data.feedback.seq, 2, 'seq'); eq(r.data.feedback.timecode, null, 'timecode');
  if (!(r.data.feedback.attachments[0].size > 0)) throw new Error('attachment size 应 > 0');
  ctx.fb2 = r.data.feedback.id; ctx.att = r.data.feedback.attachments[0].id;
});
await step('8 三项全空 → 400', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 1, text: '' } }); eq(r.status, 400, 'status');
});
await step('9 editor 写意见 → 403 FORBIDDEN', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.editor, body: { timecode: 1, text: 'x' } }); eq(r.status, 403, 'status'); eq(r.data.code, 'FORBIDDEN', 'code');
});
await step('10 读标记大图 → 与提交一致', async () => {
  const r = await req('GET', `/p/feedback/${ctx.fb1}/annotation`, { token: ctx.editor }); eq(r.status, 200, 'status'); eq(r.data.annotation, 'data:image/jpeg;base64,AAAA', 'annotation');
});
await step('11 读附件 → 与提交一致', async () => {
  const r = await req('GET', `/p/attachments/${ctx.att}`, { token: ctx.owner }); eq(r.status, 200, 'status'); eq(r.data.data, 'data:image/jpeg;base64,CCCC', 'data'); eq(r.data.name, 'ref.jpg', 'name');
});
await step('12 editor PATCH 已修改 + 修改说明 → 200', async () => {
  const r = await req('PATCH', `/p/feedback/${ctx.fb1}`, { token: ctx.editor, body: { status: 'done', editor_note: '已放大' } });
  eq(r.status, 200, 'status'); eq(r.data.feedback.status, 'done', 'status'); eq(r.data.feedback.editor_note, '已放大', 'note');
});
await step('13 owner PATCH → 403', async () => {
  const r = await req('PATCH', `/p/feedback/${ctx.fb1}`, { token: ctx.owner, body: { status: 'open' } }); eq(r.status, 403, 'status');
});
await step('14 editor 结束本轮 → 403', async () => {
  const r = await req('POST', '/p/round/close', { token: ctx.editor }); eq(r.status, 403, 'status');
});
await step('15 owner 结束本轮 → closed', async () => {
  const r = await req('POST', '/p/round/close', { token: ctx.owner }); eq(r.status, 200, 'status'); eq(r.data.version.status, 'closed', 'status');
  if (!r.data.version.closed_at) throw new Error('closed_at 应非空');
});
await step('16 结束后写意见 → 409 ROUND_CLOSED', async () => {
  const r = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 2, text: 'x' } }); eq(r.status, 409, 'status'); eq(r.data.code, 'ROUND_CLOSED', 'code');
});
await step('17 撤回结束 → collecting', async () => {
  const r = await req('POST', '/p/round/reopen', { token: ctx.owner }); eq(r.status, 200, 'status'); eq(r.data.version.status, 'collecting', 'status'); eq(r.data.version.closed_at, null, 'closed_at');
});
await step('18 删除第二条 → 204，列表剩 1 条', async () => {
  const r = await req('DELETE', `/p/feedback/${ctx.fb2}`, { token: ctx.owner }); eq(r.status, 204, 'status');
  const s = await req('GET', '/p', { token: ctx.owner }); eq(s.data.versions[0].feedback.length, 1, 'feedback 数');
});
await step('19 确认通过 → approved', async () => {
  const r = await req('POST', '/p/approve', { token: ctx.owner }); eq(r.status, 200, 'status'); eq(r.data.version.status, 'approved', 'status');
});
await step('20 通过后删意见 → 409 VERSION_APPROVED', async () => {
  const r = await req('DELETE', `/p/feedback/${ctx.fb1}`, { token: ctx.owner }); eq(r.status, 409, 'status'); eq(r.data.code, 'VERSION_APPROVED', 'code');
});
await step('21 撤回通过 → collecting', async () => {
  const r = await req('POST', '/p/unapprove', { token: ctx.owner }); eq(r.status, 200, 'status'); eq(r.data.version.status, 'collecting', 'status');
});
await step('22 editor 发布 V2 → current_version 2，V1 意见保留', async () => {
  const r = await req('POST', '/p/versions', { token: ctx.editor, body: { video: { name: 'v2.mp4', size: 2345, duration: 62 } } });
  eq(r.status, 201, 'status'); eq(r.data.version.number, 2, 'number');
  const s = await req('GET', '/p', { token: ctx.owner });
  eq(s.data.project.current_version, 2, 'current_version'); eq(s.data.versions[0].feedback.length, 1, 'V1 feedback'); eq(s.data.versions[1].feedback.length, 0, 'V2 feedback');
});
await step('23 V2 无意见时结束本轮 → 409 NO_FEEDBACK', async () => {
  const r = await req('POST', '/p/round/close', { token: ctx.owner }); eq(r.status, 409, 'status'); eq(r.data.code, 'NO_FEEDBACK', 'code');
});
await step('24 改 fps 25 → 200；31 → 400', async () => {
  const r = await req('PATCH', '/p', { token: ctx.owner, body: { fps: 25 } }); eq(r.status, 200, 'status'); eq(r.data.project.fps, 25, 'fps');
  const b = await req('PATCH', '/p', { token: ctx.owner, body: { fps: 31 } }); eq(b.status, 400, 'status');
});
await step('25 管理列表含该项目', async () => {
  const r = await req('GET', '/admin/projects', { admin: ADMIN });
  const p = r.data.projects.find((x) => x.id === ctx.id);
  if (!p) throw new Error('列表里没有该项目');
  eq(p.current_version, 2, 'current_version'); eq(p.status, 'collecting', 'status'); eq(p.feedback_count, 0, 'feedback_count');
});
await step('26 CORS：允许的 Origin 回显；未知 Origin 不回显', async () => {
  const ok = await req('GET', '/p', { token: ctx.owner, origin: 'http://localhost:8788' });
  eq(ok.headers.get('access-control-allow-origin'), 'http://localhost:8788', 'allow-origin');
  const bad = await req('GET', '/p', { token: ctx.owner, origin: 'https://evil.example' });
  eq(bad.headers.get('access-control-allow-origin'), null, 'allow-origin(evil)');
});
await step('27 删除项目 → 204；owner token 失效', async () => {
  const r = await req('DELETE', `/admin/projects/${ctx.id}`, { admin: ADMIN }); eq(r.status, 204, 'status');
  const s = await req('GET', '/p', { token: ctx.owner }); eq(s.status, 401, 'status');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
