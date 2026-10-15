import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 远端 Worker API 客户端。所有方法失败时抛 ApiError；网络不通为 code 'NETWORK'。 */
export function createRemoteApi({ token = '', adminKey = '', base = API_BASE } = {}) {
  async function call(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (adminKey) headers['X-Admin-Key'] = adminKey;
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError('NETWORK', '连不上服务器', 0);
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) throw new ApiError(data?.code || `HTTP_${res.status}`, data?.error || `请求失败（${res.status}）`, res.status);
    return data;
  }
  return {
    isLocal: false,
    getState: () => call('GET', '/p'),
    patchProject: (body) => call('PATCH', '/p', body),
    createVersion: (video) => call('POST', '/p/versions', { video }),
    createFeedback: (body) => call('POST', '/p/feedback', body),
    deleteFeedback: (id) => call('DELETE', `/p/feedback/${encodeURIComponent(id)}`),
    patchFeedback: (id, body) => call('PATCH', `/p/feedback/${encodeURIComponent(id)}`, body),
    getAnnotation: (id) => call('GET', `/p/feedback/${encodeURIComponent(id)}/annotation`),
    getAttachment: (id) => call('GET', `/p/attachments/${encodeURIComponent(id)}`),
    closeRound: () => call('POST', '/p/round/close'),
    reopenRound: () => call('POST', '/p/round/reopen'),
    approve: () => call('POST', '/p/approve'),
    unapprove: () => call('POST', '/p/unapprove'),
    adminList: () => call('GET', '/admin/projects'),
    adminCreate: (body) => call('POST', '/admin/projects', body),
    adminDelete: (id) => call('DELETE', `/admin/projects/${encodeURIComponent(id)}`),
  };
}
