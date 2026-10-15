export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 小型 DOM 构造器：h('div', { class: 'x', onClick }, '文本', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

export function randomToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 秒 → 时:分:秒.帧（小时为 0 时省略） */
export function fmtTimecode(sec, fps = 30) {
  if (sec == null || !isFinite(sec)) return '整片';
  const frames = Math.round(Math.max(0, sec) * fps);
  const f = frames % fps;
  const s = Math.floor(frames / fps);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const core = `${pad(mm)}:${pad(ss)}.${pad(f)}`;
  return hh ? `${pad(hh)}:${core}` : core;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '时长未知';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${pad(s % 60)} 秒` : `${s} 秒`;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 读取视频文件的名称/大小/时长（不上传） */
export function readVideoMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (duration) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      resolve({ name: file.name, size: file.size, duration: isFinite(duration) ? duration : 0 });
    };
    const timer = setTimeout(() => done(0), 15000);
    v.addEventListener('loadedmetadata', () => { clearTimeout(timer); done(v.duration); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); done(0); }, { once: true });
    v.src = url;
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法读取'));
    img.src = src;
  });
}

export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try { return await loadImage(url); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

/** canvas / img / video → JPEG data URL，最长边 ≤ maxEdge */
export function shrinkToDataUrl(source, maxEdge = 1280, quality = 0.82) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

let toastEl;
export function toast(msg, kind = '') {
  toastEl?.remove();
  toastEl = h('div', { class: `toast${kind ? ' toast--' + kind : ''}`, role: 'status' }, msg);
  document.body.append(toastEl);
  const el = toastEl;
  setTimeout(() => { if (toastEl === el) el.remove(); }, 2800);
}

/** 自定义确认弹层，resolve(true/false) */
export function confirmModal({ title, text = '', okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const close = (v) => { document.removeEventListener('keydown', onKey); backdrop.remove(); resolve(v); };
    const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(false); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal__title' }, title),
        text && h('p', { class: 'modal__text' }, text),
        h('div', { class: 'modal__actions' },
          h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => close(false) }, cancelText),
          h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', onClick: () => close(true) }, okText))));
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    backdrop.querySelector('.btn--primary, .btn--danger')?.focus();
  });
}

/** 大图弹层 */
export function imageModal(src, caption = '') {
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
  const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal modal--wide', role: 'dialog', 'aria-modal': 'true' },
      h('img', { src, alt: caption, style: { maxHeight: '78vh', margin: '0 auto', objectFit: 'contain', borderRadius: '10px' } }),
      h('div', { class: 'modal__actions' },
        caption && h('span', { class: 'muted small' }, caption),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, '关闭'))));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { class: 'vh' }, text);
    document.body.append(ta);
    ta.select();
    try { return document.execCommand('copy'); }
    catch { return false; }
    finally { ta.remove(); }
  }
}

export function storage(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function storageSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式等情况忽略 */ }
}

/* 主题：日间 / 黑夜 */
export function initTheme() {
  const t = storage('biscuit.theme', null);
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
}
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function setTheme(t) {
  document.documentElement.dataset.theme = t;
  storageSet('biscuit.theme', t);
}
