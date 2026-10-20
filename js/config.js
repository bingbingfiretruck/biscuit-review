// 部署后把 PROD_API_BASE 改成你的 Worker 地址（结尾不带斜杠），例如 'https://api.example.com/api'。
// 留空表示没有后端，页面退回「本地模式」（数据只存在本机浏览器，不能和剪辑师共享）。
export const PROD_API_BASE = 'https://api.xsbingbing.top/api';

const isLocalHost = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = isLocalHost ? 'http://127.0.0.1:8787/api' : PROD_API_BASE;

export const FPS_OPTIONS = [24, 25, 30, 50, 60];
export const POLL_MS = 8000;
export const RETRY_MS = 30000;
export const ANNOTATION_MAX_EDGE = 1280;
export const THUMB_MAX_EDGE = 320;
export const ATTACHMENT_MAX_EDGE = 1280;
export const MAX_ATTACHMENTS = 6;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 视频/音频附件单个上限
export const ATTACH_ACCEPT = 'image/*,video/*,audio/*,.mp4,.mov,.webm,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.amr';
export const STATUS_LABEL = { collecting: '意见填写中', closed: '本轮反馈已结束', approved: '已确认通过' };
export const ROLE_LABEL = { owner: '饼干', editor: '剪辑师' };
