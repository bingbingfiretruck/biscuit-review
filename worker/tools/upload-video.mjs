// 备用通道：浏览器上传不顺时，直接从本机把客稿视频分片传到指定版本。
// 用法：node tools/upload-video.mjs <审片链接里的 t> <版本 id> <视频文件>
// 版本 id 可在审片页控制台 fetch(API_BASE+'/p') 的 versions[].id 里找，或让 Claude 代查。
import { open, stat } from 'node:fs/promises';
const BASE = process.env.API_BASE || 'https://api.xsbingbing.top/api';
const [OWNER, VID, FILE] = process.argv.slice(2);
async function call(method, path, { body, raw } = {}) {
  const headers = { Authorization: `Bearer ${OWNER}` };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = 'application/octet-stream';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
      return data;
    } catch (e) {
      if (attempt >= 4 || /→ 4\d\d/.test(e.message)) throw e;
      console.log(`retry ${attempt}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const size = (await stat(FILE)).size;
const start = await call('POST', `/p/versions/${VID}/upload/start`, { body: { size, mime: 'video/mp4' } });
const partSize = start.part_size; const total = Math.ceil(size / partSize);
console.log(`start ok: ${Math.round(size / 1048576)} MB, ${total} parts of ${partSize / 1048576} MB`);
const fh = await open(FILE, 'r'); const parts = []; const t0 = Date.now();
try {
  for (let n = 1, off = 0; off < size; n++, off += partSize) {
    const len = Math.min(partSize, size - off); const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, off);
    const r = await call('PUT', `/p/versions/${VID}/upload/part?upload_id=${encodeURIComponent(start.upload_id)}&part=${n}`, { body: buf, raw: true });
    parts.push({ part_number: r.part_number, etag: r.etag });
    if (n % 10 === 0 || n === total) console.log(`part ${n}/${total} (${Math.round((off + len) / 1048576)} MB, ${Math.round((Date.now() - t0) / 1000)}s)`);
  }
} finally { await fh.close(); }
const done = await call('POST', `/p/versions/${VID}/upload/complete`, { body: { upload_id: start.upload_id, parts } });
console.log('COMPLETE:', done.version.video_status, Math.round(done.version.video_size / 1048576) + ' MB', 'pruned=' + done.pruned);
