// 分片上传视频到后端（R2）：start → 逐片 PUT（带进度、失败重试）→ complete。
export async function uploadVideo({ api, versionId, file, onProgress = () => {} }) {
  const { upload_id: uploadId, part_size: partSize } = await api.uploadStart(versionId, { size: file.size, mime: file.type || 'video/mp4' });
  const total = file.size;
  const count = Math.max(1, Math.ceil(total / partSize));
  const parts = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    const blob = file.slice(i * partSize, Math.min(total, (i + 1) * partSize));
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await api.uploadPart(versionId, uploadId, i + 1, blob, (loaded) => onProgress(Math.min(total, done + loaded), total));
        parts.push({ part_number: r.part_number, etag: r.etag });
        break;
      } catch (e) {
        const retryable = e.code === 'NETWORK' || (e.status >= 500);
        if (!retryable || attempt >= 3) {
          try { await api.uploadAbort(versionId); } catch { /* 忽略 */ }
          throw e;
        }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    done += blob.size;
    onProgress(done, total);
  }
  const res = await api.uploadComplete(versionId, { upload_id: uploadId, parts });
  return res.version;
}
