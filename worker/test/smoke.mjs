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
await step('8b 请求体 null / 文字传对象 / 时间码传字符串 / 非法编码 → 400 或 404', async () => {
  const a = await fetch(BASE + '/admin/projects', { method: 'POST', headers: { 'X-Admin-Key': ADMIN, 'Content-Type': 'application/json' }, body: 'null' });
  eq(a.status, 400, 'null body');
  const b = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 1, text: { x: 1 } } }); eq(b.status, 400, 'text 对象');
  const c = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: '', text: 'x' } }); eq(c.status, 400, 'timecode 空串');
  const d = await req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: 1, text: 'x', annotation: '', annotation_thumb: '' } });
  eq(d.status, 201, '空字符串标记视为无标记'); eq(d.data.feedback.has_annotation, false, 'has_annotation');
  ctx.fbTmp = d.data.feedback.id;
  const e = await req('DELETE', '/p/feedback/%ZZ', { token: ctx.owner }); // 本地 workerd 404；线上 Cloudflare 边缘直接 400
  if (![400, 404].includes(e.status)) throw new Error(`非法编码: 期望 400 或 404，实际 ${e.status}`);
  const f = await req('DELETE', `/p/feedback/${ctx.fbTmp}`, { token: ctx.owner }); eq(f.status, 204, '清理临时意见');
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
await step('18b 已删意见的附件 → 404', async () => {
  const r = await req('GET', `/p/attachments/${ctx.att}`, { token: ctx.owner }); eq(r.status, 404, 'status');
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
  ctx.v2 = r.data.version.id;
  const s = await req('GET', '/p', { token: ctx.owner });
  eq(s.data.project.current_version, 2, 'current_version'); eq(s.data.versions[0].feedback.length, 1, 'V1 feedback'); eq(s.data.versions[1].feedback.length, 0, 'V2 feedback');
});
await step('22b 历史版本只读：删 / 改 V1 意见 → 409 VERSION_LOCKED', async () => {
  const d = await req('DELETE', `/p/feedback/${ctx.fb1}`, { token: ctx.owner }); eq(d.status, 409, 'delete'); eq(d.data.code, 'VERSION_LOCKED', 'code');
  const p = await req('PATCH', `/p/feedback/${ctx.fb1}`, { token: ctx.editor, body: { status: 'open' } }); eq(p.status, 409, 'patch'); eq(p.data.code, 'VERSION_LOCKED', 'code');
});
await step('23 V2 无意见时结束本轮 → 409 NO_FEEDBACK', async () => {
  const r = await req('POST', '/p/round/close', { token: ctx.owner }); eq(r.status, 409, 'status'); eq(r.data.code, 'NO_FEEDBACK', 'code');
});
await step('23b 5 条并发意见 → seq 1..5 不重复', async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => req('POST', '/p/feedback', { token: ctx.owner, body: { timecode: i, text: `并发 ${i}` } })));
  for (const r of rs) eq(r.status, 201, 'status');
  const seqs = rs.map((r) => r.data.feedback.seq).sort((a, b) => a - b);
  eq(JSON.stringify(seqs), '[1,2,3,4,5]', 'seqs');
});
await step('24 改 fps 25 → 200；31 → 400', async () => {
  const r = await req('PATCH', '/p', { token: ctx.owner, body: { fps: 25 } }); eq(r.status, 200, 'status'); eq(r.data.project.fps, 25, 'fps');
  const b = await req('PATCH', '/p', { token: ctx.owner, body: { fps: 31 } }); eq(b.status, 400, 'status');
});
await step('24b 视频上传：start → part → complete', async () => {
  const bytes = new Uint8Array(1500000); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
  const st = await req('POST', `/p/versions/${ctx.v2}/upload/start`, { token: ctx.editor, body: { size: bytes.length, mime: 'video/mp4' } });
  eq(st.status, 200, 'start'); if (!st.data.upload_id) throw new Error('缺 upload_id');
  const bad = await req('PUT', `/p/versions/${ctx.v2}/upload/part?upload_id=wrong&part=1`, { token: ctx.editor });
  eq(bad.status, 409, '错误 upload_id');
  const pr = await fetch(`${BASE}/p/versions/${ctx.v2}/upload/part?upload_id=${encodeURIComponent(st.data.upload_id)}&part=1`, { method: 'PUT', headers: { Authorization: `Bearer ${ctx.editor}`, 'Content-Type': 'application/octet-stream' }, body: bytes });
  eq(pr.status, 200, 'part'); const part = await pr.json(); if (!part.etag) throw new Error('缺 etag');
  const done = await req('POST', `/p/versions/${ctx.v2}/upload/complete`, { token: ctx.editor, body: { upload_id: st.data.upload_id, parts: [{ part_number: 1, etag: part.etag }] } });
  eq(done.status, 200, 'complete'); eq(done.data.version.video_status, 'ready', 'video_status'); eq(done.data.version.video_size, bytes.length, 'video_size');
  ctx.videoBytes = bytes.length;
});
await step('24c 播放：?t= 鉴权 + Range 206 / HEAD / 全量 200', async () => {
  const r = await fetch(`${BASE}/p/videos/${ctx.v2}?t=${ctx.owner}`, { headers: { Range: 'bytes=0-99' } });
  eq(r.status, 206, 'range status'); eq(r.headers.get('content-range'), `bytes 0-99/${ctx.videoBytes}`, 'content-range');
  eq((await r.arrayBuffer()).byteLength, 100, 'range body');
  const h = await fetch(`${BASE}/p/videos/${ctx.v2}?t=${ctx.editor}`, { method: 'HEAD' });
  eq(h.status, 200, 'head'); eq(h.headers.get('content-length'), String(ctx.videoBytes), 'head length'); eq(h.headers.get('accept-ranges'), 'bytes', 'accept-ranges');
  const full = await fetch(`${BASE}/p/videos/${ctx.v2}?t=${ctx.owner}`);
  eq(full.status, 200, 'full'); eq((await full.arrayBuffer()).byteLength, ctx.videoBytes, 'full body');
  const noauth = await fetch(`${BASE}/p/videos/${ctx.v2}`); eq(noauth.status, 401, 'no token');
});
await step('24d 清理视频：editor 403，owner 200 → none，再播放 404', async () => {
  const e = await req('DELETE', `/p/versions/${ctx.v2}/video`, { token: ctx.editor }); eq(e.status, 403, 'editor');
  const o = await req('DELETE', `/p/versions/${ctx.v2}/video`, { token: ctx.owner }); eq(o.status, 200, 'owner'); eq(o.data.version.video_status, 'none', 'status');
  const g = await fetch(`${BASE}/p/videos/${ctx.v2}?t=${ctx.owner}`); eq(g.status, 404, 'after delete');
});
await step('25 管理列表含该项目', async () => {
  const r = await req('GET', '/admin/projects', { admin: ADMIN });
  const p = r.data.projects.find((x) => x.id === ctx.id);
  if (!p) throw new Error('列表里没有该项目');
  eq(p.current_version, 2, 'current_version'); eq(p.status, 'collecting', 'status'); eq(p.feedback_count, 5, 'feedback_count');
});
await step('26 CORS：允许的 Origin 回显；未知 Origin 不回显', async () => {
  const ok = await req('GET', '/p', { token: ctx.owner, origin: 'http://localhost:8788' });
  eq(ok.headers.get('access-control-allow-origin'), 'http://localhost:8788', 'allow-origin');
  const bad = await req('GET', '/p', { token: ctx.owner, origin: 'https://evil.example' });
  eq(bad.headers.get('access-control-allow-origin'), null, 'allow-origin(evil)');
});
await step('26b 3 个并发发布新版 → 无 500，版本号唯一', async () => {
  const rs = await Promise.all([3, 4, 5].map((i) => req('POST', '/p/versions', { token: ctx.editor, body: { video: { name: `v${i}.mp4`, size: 100 + i, duration: 1 } } })));
  for (const r of rs) if (![201, 409].includes(r.status)) throw new Error(`状态 ${r.status}`);
  const s = await req('GET', '/p', { token: ctx.owner });
  const nums = s.data.versions.map((v) => v.number);
  eq(new Set(nums).size, nums.length, '版本号唯一'); eq(s.data.project.current_version, Math.max(...nums), 'current = max');
});
await step('27 删除项目 → 204；owner token 失效', async () => {
  const r = await req('DELETE', `/admin/projects/${ctx.id}`, { admin: ADMIN }); eq(r.status, 204, 'status');
  const s = await req('GET', '/p', { token: ctx.owner }); eq(s.status, 401, 'status');
});

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
