// 视频存储抽象：R2（有就用）或 KV（免费、无需绑卡、1 GB）。接口一致，handlers 不关心底层。

const KV_PART = 8 * 1024 * 1024;          // KV 单值上限 25 MiB，用 8 MB 分片方便按 Range 取
const KV_TOTAL = 1024 * 1024 * 1024 - 48 * 1024 * 1024; // 免费 1 GB，留 48 MB 余量
const R2_PART = 20 * 1024 * 1024;
const R2_TOTAL = 10 * 1024 * 1024 * 1024 - 256 * 1024 * 1024;

export function getVideoStore(env) {
  if (env.VIDEOS) return r2Store(env.VIDEOS);
  if (env.VIDEO_KV) return kvStore(env.VIDEO_KV);
  return null;
}

function r2Store(bucket) {
  return {
    kind: 'r2', partSize: R2_PART, totalLimit: R2_TOTAL, maxVideo: 2 * 1024 * 1024 * 1024,
    async createUpload(key, mime) { return (await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime } })).uploadId; },
    async uploadPart(key, uploadId, n, data) { return (await bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, data)).etag; },
    async complete(key, uploadId, parts, _mime, _declaredSize) {
      const obj = await bucket.resumeMultipartUpload(key, uploadId).complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
      return obj.size;
    },
    async abort(key, uploadId) { try { await bucket.resumeMultipartUpload(key, uploadId).abort(); } catch { /* 已失效 */ } },
    async remove(key) { try { await bucket.delete(key); } catch { /* 不存在 */ } },
    async removePrefix(prefix) { const l = await bucket.list({ prefix }); if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key)); },
    async head(key) { const h = await bucket.head(key); return h ? { size: h.size, mime: h.httpMetadata?.contentType || 'video/mp4', etag: h.httpEtag } : null; },
    async get(key, { offset, length }) {
      const obj = await bucket.get(key, { range: { offset, length } });
      return obj ? { body: obj.body, size: obj.size, mime: obj.httpMetadata?.contentType || 'video/mp4', etag: obj.httpEtag } : null;
    },
  };
}

function kvStore(kv) {
  const metaKey = (key) => `${key}/meta`;
  const partKey = (key, n) => `${key}/${String(n).padStart(5, '0')}`;
  const readMeta = async (key) => kv.get(metaKey(key), { type: 'json', cacheTtl: 60 });
  return {
    kind: 'kv', partSize: KV_PART, totalLimit: KV_TOTAL, maxVideo: 900 * 1024 * 1024, // 总共 1 GB：大视频只能存一版，空间不够时清更早版本
    async createUpload(key, mime) {
      await kv.put(`${key}/upload`, JSON.stringify({ mime, started: Date.now() }), { expirationTtl: 86400 });
      return `kv-${crypto.randomUUID()}`;
    },
    async uploadPart(key, _uploadId, n, data) {
      await kv.put(partKey(key, n), data, { metadata: { size: data.byteLength } });
      return String(data.byteLength);
    },
    async complete(key, _uploadId, parts, mime, declaredSize) {
      const sorted = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
      const sizes = sorted.map((p) => Number(p.etag) || 0);
      const size = sizes.reduce((a, b) => a + b, 0);
      if (declaredSize && size !== declaredSize) throw new Error(`分片大小总和 ${size} 与声明 ${declaredSize} 不符`);
      await kv.put(metaKey(key), JSON.stringify({ size, mime, parts: sorted.length, partSize: KV_PART, sizes }));
      await kv.delete(`${key}/upload`);
      return size;
    },
    async abort(key) { await this.remove(key); },
    async remove(key) {
      const l = await kv.list({ prefix: `${key}/` });
      await Promise.all(l.keys.map((k) => kv.delete(k.name)));
    },
    async removePrefix(prefix) {
      let cursor; do {
        const l = await kv.list({ prefix, cursor });
        await Promise.all(l.keys.map((k) => kv.delete(k.name)));
        cursor = l.list_complete ? undefined : l.cursor;
      } while (cursor);
    },
    async head(key) { const m = await readMeta(key); return m ? { size: m.size, mime: m.mime, etag: `"kv-${m.size}-${m.parts}"` } : null; },
    async get(key, { offset, length }) {
      const m = await readMeta(key);
      if (!m) return null;
      const end = Math.min(m.size, offset + length);
      let idx = Math.floor(offset / m.partSize);
      let skip = offset - idx * m.partSize;
      let remaining = end - offset;
      // 先取第一片：不存在（还没同步到这个节点）就让上层回 503
      const first = await kv.get(partKey(key, idx + 1), { type: 'arrayBuffer', cacheTtl: 86400 });
      if (!first) return { missing: true, size: m.size, mime: m.mime };
      let pending = first;
      const body = new ReadableStream({
        async pull(controller) {
          if (remaining <= 0 || idx >= m.parts) { controller.close(); return; }
          const buf = pending || await kv.get(partKey(key, idx + 1), { type: 'arrayBuffer', cacheTtl: 86400 });
          pending = null;
          if (!buf) { controller.error(new Error('视频分片缺失')); return; }
          const take = Math.min(buf.byteLength - skip, remaining);
          controller.enqueue(new Uint8Array(buf, skip, take));
          remaining -= take; skip = 0; idx++;
          if (remaining <= 0) controller.close();
        },
      });
      return { body, size: m.size, mime: m.mime, etag: `"kv-${m.size}-${m.parts}"` };
    },
  };
}

/** 解析 Range 头；返回 { offset, length } 或 null（无 Range）；非法返回 false */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return false;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start == null && end == null) return false;
  if (start == null) { const n = Math.min(end, size); start = size - n; end = size - 1; }
  else if (end == null || end >= size) end = size - 1;
  if (start > end || start >= size) return false;
  return { offset: start, length: end - start + 1 };
}
