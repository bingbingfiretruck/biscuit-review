// 分片上传（客稿视频 / 媒体附件共用）：start → 逐片 PUT（带进度、失败重试）→ complete。
export async function uploadChunked({ start, part, complete, abort, file, onProgress = () => {} }) {
  const { upload_id: uploadId, part_size: partSize } = await start();
  const total = file.size;
  const count = Math.max(1, Math.ceil(total / partSize));
  const parts = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    const blob = file.slice(i * partSize, Math.min(total, (i + 1) * partSize));
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await part(uploadId, i + 1, blob, (loaded) => onProgress(Math.min(total, done + loaded), total));
        parts.push({ part_number: r.part_number, etag: r.etag });
        break;
      } catch (e) {
        const retryable = e.code === 'NETWORK' || (e.status >= 500);
        if (!retryable || attempt >= 3) {
          try { await abort(); } catch { /* 忽略 */ }
          throw e;
        }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    done += blob.size;
    onProgress(done, total);
  }
  return complete({ upload_id: uploadId, parts });
}

/** 客稿视频 */
export function uploadVideo({ api, versionId, file, onProgress }) {
  return uploadChunked({
    file, onProgress,
    start: () => api.uploadStart(versionId, { size: file.size, mime: file.type || 'video/mp4' }),
    part: (uploadId, n, blob, p) => api.uploadPart(versionId, uploadId, n, blob, p),
    complete: (body) => api.uploadComplete(versionId, body),
    abort: () => api.uploadAbort(versionId),
  });
}

/** 意见里的视频/音频附件（意见提交后按返回的附件 id 上传） */
export function uploadAttachment({ api, attachmentId, file, onProgress }) {
  return uploadChunked({
    file, onProgress,
    start: () => api.attachmentUploadStart(attachmentId),
    part: (uploadId, n, blob, p) => api.attachmentUploadPart(attachmentId, uploadId, n, blob, p),
    complete: (body) => api.attachmentUploadComplete(attachmentId, body),
    abort: () => api.attachmentUploadAbort(attachmentId),
  });
}
