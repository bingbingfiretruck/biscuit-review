export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status = 400) => { throw new ApiError(code, message, status); };
export const assert = (cond, code, message, status = 400) => { if (!cond) fail(code, message, status); };
export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
export function newToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function json(data, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
export async function readJson(request, maxBytes = 8 * 1024 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) fail('PAYLOAD_TOO_LARGE', '请求内容太大', 413);
  const text = await request.text();
  if (text.length > maxBytes) fail('PAYLOAD_TOO_LARGE', '请求内容太大', 413);
  if (!text.trim()) return {};
  let data;
  try { data = JSON.parse(text); } catch { fail('BAD_JSON', '请求格式不正确', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('BAD_JSON', '请求格式不正确', 400);
  return data;
}
