// 审片页主逻辑：加载项目状态、渲染版本栏/播放器/右侧面板、轮询同步、提交意见。
import {
  API_BASE, POLL_MS, STATUS_LABEL, ROLE_LABEL, FPS_OPTIONS,
  ANNOTATION_MAX_EDGE, ATTACHMENT_MAX_EDGE, MAX_ATTACHMENTS, MAX_MEDIA_BYTES, ATTACH_ACCEPT,
} from './config.js';
import {
  $, h, fmtTimecode, fmtTimecodeMs, fmtDateSlash, fmtBytes, fmtDuration, fmtDate, readVideoMeta,
  toast, confirmModal, imageModal, storage, storageSet, initTheme, currentTheme, setTheme,
} from './util.js';
import { createRemoteApi } from './api.js?v=3';
import { createLocalApi } from './localstore.js';
import { createPlayer } from './player.js?v=2';
import { openMarkup } from './markup.js?v=2';
import { createComposer } from './composer.js?v=3';
import { uploadVideo, uploadAttachment } from './upload.js?v=3';

const token = new URLSearchParams(location.search).get('t') || '';

const els = {
  shell: $('#shell'), gate: $('#gate'), gateTitle: $('#gateTitle'), gateText: $('#gateText'), gateActions: $('#gateActions'),
  projectName: $('#projectName'), headEyebrow: $('#headEyebrow'), headSub: $('#headSub'), downloadBtn: $('#downloadBtn'), miniStatus: $('#miniStatus'), roleChip: $('#roleChip'),
  banner: $('#banner'), railTitle: $('#railTitle'), railHint: $('#railHint'), versionList: $('#versionList'),
  playerRoot: $('#player'), fileWarn: $('#fileWarn'), uploadBar: $('#uploadBar'), panel: $('#panel'),
};
const uploadInput = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', class: 'vh', id: 'uploadInput', onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) startUpload(f, selected()); } });
document.body.append(uploadInput);

const state = {
  api: null, localMode: false, connLost: false,
  role: null, project: null, versions: [],
  selectedVersion: null, activeFeedbackId: null,
  sort: storage('biscuit.sort', 'timecode'),
  draft: { text: '', whole: false, lockedTimecode: null, annotation: null, attachments: [] },
  currentTime: 0, loadedFile: null, playerSource: null, uploading: null, hostedRetries: 0,
  lastUpdatedAt: null, pollTimer: null, pendingRender: false,
};
const cache = { annotations: new Map(), attachments: new Map() };
let player;
let composer = null;
let composerKey = '';

// ---------- 启动 ----------
initTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeBtn);
els.panel.addEventListener('focusout', () => { if (state.pendingRender) setTimeout(() => { if (state.pendingRender && !isTypingInList()) { state.pendingRender = false; renderAll(); } }, 80); });

if (!token) showGate('这个审片链接无效', '链接里缺少凭证，请向饼干要一条新的审片链接。');
else boot();

async function boot() {
  state.localMode = !API_BASE;
  state.api = state.localMode ? createLocalApi({ token }) : createRemoteApi({ token });
  player = createPlayer(els.playerRoot, {
    fps: 30,
    onTime: (t) => { state.currentTime = t; composer?.syncTime(); },
    onSeekMarker: (id) => setActive(id, { scroll: true }),
    onFileChosen: handleFile,
    onError: handleHostedError,
  });
  try {
    await loadState({ first: true });
  } catch (e) {
    if (e.code === 'NETWORK' && !state.localMode) {
      state.localMode = true;
      state.api = createLocalApi({ token });
      try { await loadState({ first: true }); } catch (e2) { return failGate(e2); }
    } else return failGate(e);
  }
  els.gate.hidden = true;
  els.shell.hidden = false;
  if (state.localMode) showBanner('本地模式：没有连接服务器，提交的内容只保存在这台设备，不会同步给对方。', 'info');
  schedulePoll();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(state.pollTimer); poll(); } });
  window.addEventListener('beforeunload', (e) => { if (hasDraft() || state.uploading) { e.preventDefault(); e.returnValue = ''; } });
}

function failGate(e) {
  if (e.code === 'INVALID_TOKEN') {
    showGate('这个审片链接无效或已失效', state.localMode
      ? '现在是本地模式（后端还没部署）：链接只在生成它的那个浏览器里有效，换一个浏览器或设备就打不开。部署好 Cloudflare 后端后，链接才能发给别人。'
      : '请向饼干要一条新的审片链接。');
  } else {
    showGate('暂时无法打开这份客稿', e.message || '请稍后再试。', true);
  }
}
function showGate(title, text, retry = false) {
  els.gate.hidden = false;
  els.shell.hidden = true;
  els.gateTitle.textContent = title;
  els.gateText.textContent = text;
  $('.gate__icon', els.gate).textContent = '!';
  els.gateActions.replaceChildren(
    ...[retry ? h('button', { class: 'btn btn--primary', type: 'button', onClick: () => location.reload() }, '重新尝试') : null,
      h('a', { class: 'btn btn--ghost', href: 'index.html' }, '回到管理台')].filter(Boolean));
}

// ---------- 状态 ----------
async function loadState({ first = false } = {}) {
  const data = await state.api.getState();
  const changed = first || data.project.updated_at !== state.lastUpdatedAt;
  const prevCurrent = state.project?.current_version;
  const prevFps = state.project?.fps;
  state.role = data.role;
  state.project = data.project;
  state.versions = data.versions;
  state.lastUpdatedAt = data.project.updated_at;
  if (state.selectedVersion == null || !state.versions.some((v) => v.number === state.selectedVersion)) {
    state.selectedVersion = data.project.current_version;
  } else if (prevCurrent != null && prevCurrent !== data.project.current_version && state.selectedVersion === prevCurrent) {
    // 对方发布了新版：跟到新版，草稿原样带过去
    state.selectedVersion = data.project.current_version;
    state.activeFeedbackId = null;
    composerKey = '';
    toast(hasDraft() ? `客稿 V${data.project.current_version} 已发布，你没提交的草稿已带到新版` : `客稿 V${data.project.current_version} 已发布`);
  }
  if (first || prevFps !== data.project.fps) player.setFps(data.project.fps);
  if (!changed) return;
  if (!first && isTypingInList()) { state.pendingRender = true; return; }
  renderAll();
}
const selected = () => state.versions.find((v) => v.number === state.selectedVersion);
const isCurrent = () => state.selectedVersion === state.project.current_version;
const fps = () => state.project?.fps || 30;
const hasDraft = () => !!(state.draft.text.trim() || state.draft.annotation || state.draft.attachments.length);
function isTypingInList() {
  const a = document.activeElement;
  return !!(a && els.panel.contains(a) && a.matches('input[type="text"], textarea') && !(composer && composer.el.contains(a)));
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, POLL_MS);
}
async function poll() {
  if (!document.hidden) {
    try {
      await loadState();
      if (state.connLost) { state.connLost = false; hideBanner(); }
    } catch (e) {
      if (e.code === 'NETWORK' && !state.localMode) { state.connLost = true; showBanner('暂时连不上服务器，正在重试…', 'warn'); }
      if (e.code === 'INVALID_TOKEN') { clearTimeout(state.pollTimer); failGate(e); return; }
    }
  }
  schedulePoll();
}

function showBanner(msg, kind = 'warn') {
  els.banner.className = kind === 'info' ? 'banner banner--info' : 'banner';
  els.banner.textContent = msg;
  els.banner.hidden = false;
}
function hideBanner() {
  if (state.localMode) return;
  els.banner.hidden = true;
}
function updateThemeBtn() {
  const t = currentTheme();
  for (const b of document.querySelectorAll('.seg__btn[data-theme]')) b.classList.toggle('is-active', b.dataset.theme === t);
}
function themeToggle() {
  const mk = (key, label) => h('button', { class: 'seg__btn', type: 'button', dataset: { theme: key }, onClick: () => { setTheme(key); updateThemeBtn(); } }, label);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '界面主题' }, mk('light', '日间'), mk('dark', '黑夜'));
  queueMicrotask(updateThemeBtn);
  return seg;
}

// ---------- 渲染 ----------
function renderAll() {
  const sel = selected();
  document.title = `饼干在线审片 · ${state.project.name}`;
  els.projectName.textContent = state.project.name;
  els.headEyebrow.textContent = `客稿 V${sel.number}${isCurrent() ? '' : ' · 历史'}`;
  els.headSub.textContent = `${fmtDateSlash(sel.created_at)} 发出`;
  els.roleChip.textContent = ROLE_LABEL[state.role] + (state.localMode ? ' · 本地模式' : '');
  renderHeadSide(sel);
  renderRail();
  renderPanel();
  renderMarkers();
  syncPlayerSource();
}

function renderHeadSide(v) {
  const hosted = v.video_status === 'ready' && !state.api.isLocal;
  els.downloadBtn.hidden = !hosted;
  if (hosted) {
    els.downloadBtn.href = `${state.api.videoUrl(v.id)}&download=1`;
    els.downloadBtn.setAttribute('download', v.video_name || 'video.mp4');
    els.downloadBtn.textContent = `↓ 下载原片 · ${fmtBytes(v.video_size)}`;
  }
  const n = v.feedback.length;
  const owner = state.role === 'owner';
  let title; let text;
  if (!isCurrent()) { title = '历史版本'; text = `这一版收到 ${n} 条意见，只能回看。`; }
  else if (v.status === 'approved') { title = '已确认通过'; text = `${fmtDateSlash(v.approved_at)} 确认，等待发布。`; }
  else if (v.status === 'closed') { title = owner ? '已提交修改意见' : '可以开始修改'; text = owner ? '剪辑师正在处理；新版发出前仍可继续补充。' : `饼干已结束本轮，共 ${n} 条意见。`; }
  else { title = owner ? (n ? `意见填写中 · 已写 ${n} 条` : '等待您的意见') : '等待饼干的意见'; text = owner ? (n ? '写完请点「本轮反馈结束」。' : '可逐条提交，之后仍能继续补充本轮。') : (n ? `已有 ${n} 条，饼干还在补充。` : '饼干还没开始写。'); }
  els.miniStatus.hidden = false;
  els.miniStatus.replaceChildren(h('div', { class: 'mini-status__title' }, title), h('div', { class: 'mini-status__text' }, text));
}

function renderRail() {
  const cur = state.project.current_version;
  const sel = selected();
  els.versionList.replaceChildren(
    ...state.versions.map((v) => h('button', {
      class: `version-btn${v.number === cur ? ' is-current' : ''}${v.number === state.selectedVersion ? ' is-selected' : ''}${v.status === 'approved' ? ' is-approved' : ''}`,
      type: 'button',
      title: `客稿 V${v.number} · ${STATUS_LABEL[v.status]}${v.number === cur ? '' : ' · 历史只读'}`,
      'aria-pressed': v.number === state.selectedVersion ? 'true' : 'false',
      onClick: () => switchVersion(v.number),
    }, `V${v.number}`)),
    h('select', {
      class: 'input', id: 'fpsSelect', 'aria-label': '帧率', title: '逐帧与时间码按这个帧率计算',
      style: { width: 'auto', minHeight: '32px', marginLeft: 'auto', padding: '2px 8px', fontSize: '12px' },
      onChange: async (e) => {
        const v = Number(e.target.value);
        try { await state.api.patchProject({ fps: v }); player.setFps(v); toast('帧率已更新'); await loadState(); }
        catch (err) { toast(err.message, 'warn'); }
      },
    }, ...FPS_OPTIONS.map((f) => h('option', { value: f, selected: f === fps() }, `${f} fps`))));
  const videoNote = state.api.isLocal ? '' : sel.video_status === 'ready' ? ` · 视频已托管 ${fmtBytes(sel.video_size)}` : sel.video_status === 'uploading' ? ' · 视频上传中' : ' · 未上传视频';
  if (sel.number === cur) {
    els.railTitle.textContent = `客稿 V${sel.number} · 当前`;
    els.railHint.textContent = `${STATUS_LABEL[sel.status]} · ${fmtDate(sel.created_at)} 发出${videoNote}`;
  } else {
    els.railTitle.textContent = `客稿 V${sel.number} · 历史`;
    els.railHint.textContent = `历史只读 · ${STATUS_LABEL[sel.status]} · ${fmtDate(sel.created_at)} 发出${videoNote}`;
  }
}

async function switchVersion(n) {
  if (n === state.selectedVersion) return;
  if (hasDraft()) {
    const ok = await confirmModal({ title: '请先提交当前这条意见', text: '已填写的文字、画面标记或附件还没有保存。切换版本会丢弃它们。', okText: '丢弃并切换', cancelText: '留在这里', danger: true });
    if (!ok) return;
    resetDraft();
  }
  state.selectedVersion = n;
  state.activeFeedbackId = null;
  renderAll();
}

function renderPanel() {
  const v = selected();
  const cur = isCurrent();
  const parts = [];
  parts.push(h('div', { class: 'panel-head' },
    h('div', { class: 'panel-head__copy' },
      h('span', { class: 'panel-head__title' }, `客稿 V${v.number} 审片`),
      h('span', { class: 'panel-head__sub' }, cur ? '当前版本 · 写意见与本轮反馈同屏' : '历史只读 · 时间码只定位这一版')),
    themeToggle()));
  if (cur && v.status === 'closed') {
    parts.push(h('div', { class: 'notice' }, state.role === 'owner'
      ? `本次反馈结束已提交，共 ${v.feedback.length} 条意见；之后仍可撤回继续补充。`
      : `饼干已结束本轮反馈，共 ${v.feedback.length} 条意见；改完逐条勾「已修改」。`));
  }
  if (cur && state.role === 'owner' && v.status === 'collecting') parts.push(getWriteCard(v));
  if (cur) parts.push(renderStatusCard(v));
  parts.push(renderListCard(v, { readOnly: !cur }));
  if (v.number > 1) {
    const prev = state.versions.find((x) => x.number === v.number - 1);
    if (prev) parts.push(renderBasisCard(prev));
  }
  if (cur) parts.push(renderPublishCard(v));

  const active = document.activeElement;
  const keepFocus = composer && composer.el.contains(active);
  const sel = keepFocus && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  els.panel.replaceChildren(...parts);
  if (keepFocus) {
    active.focus({ preventScroll: true });
    if (sel) try { active.setSelectionRange(sel[0], sel[1]); } catch { /* 非文本控件 */ }
  }
}

function renderMarkers() {
  const v = selected();
  player.setMarkers(v.feedback.map((f) => ({ id: f.id, seq: f.seq, timecode: f.timecode, active: f.id === state.activeFeedbackId })));
}

function renderFileWarn() {
  const v = selected();
  const f = state.loadedFile;
  if (!f || !v || state.playerSource?.kind !== 'local') { els.fileWarn.hidden = true; return; }
  const mismatch = f.name !== v.video_name || f.size !== v.video_size;
  els.fileWarn.hidden = !mismatch;
  if (mismatch) {
    els.fileWarn.replaceChildren(
      h('span', { class: 'grow' }, `当前打开的是「${f.name}」（${fmtBytes(f.size)}），不像是客稿 V${v.number} 的文件。期望「${v.video_name}」（${fmtBytes(v.video_size)}），时间码可能对不上。`),
      h('label', { class: 'btn btn--sm btn--ghost', for: 'player-file' }, '换文件'));
  }
}

function handleFile(file) {
  state.loadedFile = { name: file.name, size: file.size };
  state.playerSource = { versionId: selected().id, kind: 'local' };
  renderFileWarn();
  composer?.refresh();
}

/** 托管视频加载失败：多半是刚上传、还没同步到附近节点，10 秒后自动重试 */
function handleHostedError(file) {
  if (!file || !file.hosted) return false;
  const v = selected();
  if (state.hostedRetries >= 8) { toast('托管视频暂时打不开，可以先「用本地文件播放」', 'warn'); return false; }
  state.hostedRetries++;
  player.setEmptyText({ title: '视频正在同步', hint: `刚上传的视频需要几十秒同步到你附近的节点，正在自动重试（第 ${state.hostedRetries} 次）…` });
  player.clear();
  state.playerSource = null;
  renderEmptyActions(v, { syncing: true });
  setTimeout(() => { if (!state.playerSource && selected().id === v.id) syncPlayerSource(); }, 10000);
  return true;
}

// ---------- 播放器来源：托管视频 / 本地文件 ----------
function syncPlayerSource() {
  const v = selected();
  const src = state.playerSource;
  if (!state.uploading && !(src && src.versionId === v.id)) {
    if (v.video_status === 'ready' && !state.api.isLocal) {
      if (!src || src.versionId !== v.id) state.hostedRetries = 0;
      player.loadUrl(state.api.videoUrl(v.id) + (state.hostedRetries ? `&r=${state.hostedRetries}` : ''), { name: v.video_name });
      state.playerSource = { versionId: v.id, kind: 'hosted' };
      state.loadedFile = null;
    } else if (src && src.kind === 'hosted') {
      player.clear();
      state.playerSource = null;
      state.loadedFile = null;
    }
  }
  renderFileWarn();
  renderEmptyActions(v);
  composer?.refresh();
}

function renderEmptyActions(v, { syncing = false } = {}) {
  const nodes = [];
  if (syncing) {
    // 文案已由 handleHostedError 设置
  } else if (state.api.isLocal) {
    player.setEmptyText({ title: '选择客稿视频', hint: `本地模式：请选择「${v.video_name}」（${fmtBytes(v.video_size)}），视频只在这台设备上播放。` });
  } else if (v.video_status === 'uploading' && !state.uploading) {
    // 可能是对方正在传，也可能是上次上传中途关了页面：都允许重新上传
    player.setEmptyText({ title: '视频上传中', hint: '如果是对方在传，传完会自动显示；如果是你自己上次没传完（关了页面或断网），请重新上传，之前的进度不保留。' });
    nodes.push(h('button', { class: 'btn btn--primary', type: 'button', onClick: () => uploadInput.click() }, '重新上传客稿视频'));
  } else if (v.video_status !== 'ready') {
    player.setEmptyText({ title: '这一版还没有上传视频', hint: `上传后你和剪辑师打开链接都能直接播放。这一版的文件是「${v.video_name}」（${fmtBytes(v.video_size)}）。` });
    nodes.push(h('button', { class: 'btn btn--primary', type: 'button', onClick: () => uploadInput.click() }, '上传客稿视频'));
  } else {
    player.setEmptyText({ title: '正在加载托管视频…', hint: '网络慢时也可以用本地文件播放。' });
  }
  nodes.push(h('label', { class: nodes.length ? 'btn btn--ghost' : 'btn btn--primary', for: 'player-file' }, nodes.length ? '用本地文件播放' : '选择客稿视频'));
  player.setEmptyActions(nodes);
}

async function startUpload(file, v) {
  if (state.uploading) return toast('已有一个上传在进行', 'warn');
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return toast('请选择视频文件', 'warn');
  if (file.size > 2 * 1024 * 1024 * 1024) return toast('视频超过 2 GB，请压缩后再传', 'warn');
  state.uploading = { versionId: v.id };
  player.loadFile(file); // 上传者本地先播，不用等上传完
  state.playerSource = { versionId: v.id, kind: 'local' };
  renderUploadBar(v, 0, file.size);
  try {
    const res = await uploadVideo({ api: state.api, versionId: v.id, file, onProgress: (loaded, total) => renderUploadBar(v, loaded, total) });
    toast(res.pruned ? `视频已上传；已自动清理 ${res.pruned} 个更早版本的视频释放空间` : '视频已上传，对方打开链接就能直接看');
    if (state.connLost === false) hideBanner();
  } catch (e) {
    showBanner(`视频没有上传成功：${e.message || '上传失败'}。现在只是在这台设备上本地播放，刷新后就没有了，剪辑师也打不开；处理后请再点「上传客稿视频」重传。`, 'warn');
  } finally {
    state.uploading = null;
    els.uploadBar.hidden = true;
    try { await loadState(); } catch { /* 轮询会再试 */ }
    renderAll();
  }
}
function renderUploadBar(v, loaded, total) {
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  els.uploadBar.hidden = false;
  els.uploadBar.replaceChildren(
    h('div', { class: 'row row--between' }, h('span', {}, `正在上传客稿 V${v.number} 的视频 · ${pct}%`), h('span', { class: 'mono small' }, `${fmtBytes(loaded)} / ${fmtBytes(total)}`)),
    h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${pct}%` } })),
    h('div', { class: 'hint' }, '上传期间请不要关闭页面。上传完成后对方打开链接即可播放；系统只保留最近两版的视频。'));
}
async function clearVideo(v) {
  const ok = await confirmModal({ title: `清理客稿 V${v.number} 的视频？`, text: '清理后这一版的意见仍可回看，但时间码不再能定位画面。可以释放存储空间。', okText: '清理', danger: true });
  if (!ok) return;
  try {
    await state.api.deleteVideo(v.id);
    toast('视频已清理');
    if (state.playerSource?.versionId === v.id) { player.clear(); state.playerSource = null; }
    await loadState();
  } catch (e) { toast(e.message || '清理失败', 'warn'); }
}

// ---------- 写意见 ----------
function getWriteCard(v) {
  const key = `v${v.number}`;
  if (composer && composerKey === key) return composer.el;
  composerKey = key;
  composer = createComposer({
    player, draft: state.draft, maxAttachments: MAX_ATTACHMENTS, attachmentMaxEdge: ATTACHMENT_MAX_EDGE,
    maxMediaBytes: MAX_MEDIA_BYTES, accept: ATTACH_ACCEPT, localMode: state.api.isLocal,
    onSubmit: submitFeedback, onApprove: approve, onMarkup: startMarkup,
  });
  return composer.el;
}
function resetDraft() {
  // 原地清空：composer 持有 state.draft 的引用，不能整个换掉
  Object.assign(state.draft, { text: '', lockedTimecode: null, annotation: null, attachments: [] });
  composer?.refresh();
}

function startMarkup(edit) {
  const d = state.draft;
  let base; let timecode;
  if (edit && d.annotation) { base = d.annotation.base; timecode = d.annotation.timecode; }
  else {
    player.pause();
    base = player.captureFrame(ANNOTATION_MAX_EDGE);
    timecode = player.currentTime();
    if (!base) return toast('先选择客稿视频，再画标记', 'warn');
  }
  composer?.setMarkupOpen(true);
  const finish = () => composer?.setMarkupOpen(false);
  openMarkup({
    player, baseCanvas: base,
    initialStrokes: edit && d.annotation ? d.annotation.strokes : [],
    onDone: ({ full, thumb, strokes }) => {
      d.annotation = { full, thumb, strokes, base, timecode };
      d.lockedTimecode = timecode;
      finish();
    },
    onCancel: finish,
  });
}

async function submitFeedback() {
  const d = state.draft;
  const text = d.text.trim();
  if (!text && !d.annotation && d.attachments.length === 0) return toast('先写点意见，或画个标记、传个附件', 'warn');
  if (!d.whole && !player.hasFile()) return toast('还没有打开视频：先选择客稿视频，或勾选「整片」', 'warn');
  const body = {
    timecode: d.whole ? null : (d.lockedTimecode ?? player.currentTime()),
    text,
    attachments: d.attachments.map((a) => (a.kind === 'image'
      ? { name: a.name, mime: a.mime, data: a.data }
      : { name: a.name, mime: a.mime, size: a.size, kind: a.kind })),
  };
  if (d.annotation) { body.annotation = d.annotation.full; body.annotation_thumb = d.annotation.thumb; }
  const mediaFiles = d.attachments.filter((a) => a.kind !== 'image');
  composer.setSubmitting(true);
  try {
    const res = await state.api.createFeedback(body);
    resetDraft();
    state.activeFeedbackId = res.feedback.id;
    toast(`第 ${res.feedback.seq} 条意见已提交${mediaFiles.length ? '，附件上传中' : ''}`);
    await loadState();
    await uploadMediaAttachments(res.feedback, mediaFiles);
  } catch (e) {
    toast(e.message || '意见提交失败，请稍后重试', 'warn');
    if (e.code === 'ROUND_CLOSED' || e.code === 'INVALID_TOKEN') loadState().catch(() => {});
  } finally {
    composer.setSubmitting(false);
  }
}

/** 意见提交后，把视频/音频附件按返回的附件 id 逐个分片上传 */
async function uploadMediaAttachments(feedback, files) {
  if (!files.length) return;
  const targets = feedback.attachments.filter((a) => a.kind !== 'image');
  state.uploading = { attachments: true };
  try {
    for (let i = 0; i < targets.length && i < files.length; i++) {
      const a = targets[i]; const f = files[i];
      renderAttachUploadBar(i + 1, targets.length, f.name, 0, f.size);
      try {
        await uploadAttachment({ api: state.api, attachmentId: a.id, file: f.file, onProgress: (l, t) => renderAttachUploadBar(i + 1, targets.length, f.name, l, t) });
      } catch (e) { toast(`附件「${f.name}」上传失败：${e.message || '请稍后重试'}`, 'warn'); }
    }
  } finally {
    state.uploading = null;
    els.uploadBar.hidden = true;
    try { await loadState(); } catch { /* 轮询会再试 */ }
  }
}
function renderAttachUploadBar(i, n, name, loaded, total) {
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  els.uploadBar.hidden = false;
  els.uploadBar.replaceChildren(
    h('div', { class: 'row row--between' }, h('span', {}, `正在上传附件 ${i}/${n} · ${name} · ${pct}%`), h('span', { class: 'mono small' }, `${fmtBytes(loaded)} / ${fmtBytes(total)}`)),
    h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${pct}%` } })),
    h('div', { class: 'hint' }, '上传期间请不要关闭页面；传完对方就能播放。'));
}

// ---------- 本轮状态 ----------
function renderStatusCard(v) {
  const n = v.feedback.length;
  const owner = state.role === 'owner';
  const cls = `card status-card${v.status === 'closed' ? ' status-card--closed' : ''}${v.status === 'approved' ? ' status-card--approved' : ''}`;
  let stateText; let hint; const actions = [];
  if (owner) {
    if (v.status === 'collecting') {
      stateText = n ? `意见填写中 · 已写 ${n} 条` : '等待您的意见';
      hint = '全部写完后点击「本轮反馈结束」，剪辑师才会知道可以开始修改。';
      actions.push(h('button', { class: 'btn btn--primary', type: 'button', disabled: !n, title: n ? '' : '至少先提交一条意见', onClick: closeRound }, '本轮反馈结束'));
    } else if (v.status === 'closed') {
      stateText = '剪辑师已收到「开始修改」的提示';
      hint = '下一稿上传前仍可撤回并继续补充。剪辑师勾了「已修改」会在下方意见里显示。';
      actions.push(
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: reopenRound }, '撤回结束，继续写意见'),
        h('button', { class: 'btn btn--ok', type: 'button', onClick: approve }, '确认本版通过'));
    } else {
      stateText = '已确认本版通过';
      hint = `${fmtDate(v.approved_at)} 确认。如果又发现问题，可撤回通过确认后继续填写意见。`;
      actions.push(h('button', { class: 'btn btn--ghost', type: 'button', onClick: unapprove }, '撤回通过确认，继续写意见'));
    }
  } else if (v.status === 'collecting') {
    stateText = n ? `饼干正在写意见 · 已有 ${n} 条` : '等待饼干的意见';
    hint = '饼干点「本轮反馈结束」后，这里会提示你开始修改。现在也可以先看已提交的内容。';
  } else if (v.status === 'closed') {
    stateText = `本轮反馈已结束 · ${n} 条意见，可以开始修改`;
    hint = '逐条修改后勾选「已修改」并写一句修改说明；全部改完后在下方发布新版客稿。';
  } else {
    stateText = '这一版已确认通过';
    hint = `${fmtDate(v.approved_at)} 饼干确认这一版没有问题。`;
  }
  for (const b of actions) b.classList.add('btn--block', 'btn--lg');
  return h('section', { class: cls },
    h('div', { class: 'eyebrow eyebrow--pink' }, STATUS_LABEL[v.status]),
    h('div', { class: 'status-card__state' }, stateText),
    h('div', { class: 'status-card__text' }, hint),
    actions.length ? h('div', { class: 'stack', style: { gap: '8px' } }, ...actions) : null);
}

async function runAction(fn, successMsg) {
  try { await fn(); if (successMsg) toast(successMsg); await loadState(); }
  catch (e) { toast(e.message || '操作失败', 'warn'); if (e.code === 'INVALID_STATE') loadState().catch(() => {}); }
}
async function closeRound() {
  if (hasDraft()) return toast('还有一条意见没提交，先提交或清空它', 'warn');
  if (!await confirmModal({ title: '结束本轮反馈？', text: '结束后剪辑师会看到「可以开始修改」。下一稿发出前你仍可撤回。', okText: '结束本轮' })) return;
  runAction(() => state.api.closeRound(), '本轮反馈已结束，记得微信知会剪辑师');
}
async function reopenRound() {
  if (!await confirmModal({ title: '撤回「反馈结束」并继续补充吗？', text: '撤回后可以继续写意见，剪辑师这边会回到「等待意见」。', okText: '撤回' })) return;
  runAction(() => state.api.reopenRound(), '已撤回，可以继续写意见');
}
async function approve() {
  if (hasDraft()) return toast('还有一条意见没提交，先提交或清空它', 'warn');
  if (!await confirmModal({ title: '确认这一版视频没有问题并通过吗？', text: '通过确认会记录下来；之后仍可撤回。', okText: '确认通过' })) return;
  runAction(() => state.api.approve(), '已确认本版通过');
}
async function unapprove() {
  if (!await confirmModal({ title: '确认撤回这一版的通过确认吗？', text: '撤回后可以继续填写修改意见。', okText: '撤回' })) return;
  runAction(() => state.api.unapprove(), '通过确认已撤回');
}

// ---------- 意见清单 ----------
function sortFeedback(list) {
  const arr = list.slice();
  if (state.sort === 'timecode') {
    arr.sort((a, b) => {
      if (a.timecode == null && b.timecode == null) return a.seq - b.seq;
      if (a.timecode == null) return -1;
      if (b.timecode == null) return 1;
      return a.timecode - b.timecode || a.seq - b.seq;
    });
  } else arr.sort((a, b) => a.seq - b.seq);
  return arr;
}
function sortToggle() {
  const mk = (key, label) => h('button', { type: 'button', class: state.sort === key ? 'is-active' : '', onClick: () => { state.sort = key; storageSet('biscuit.sort', key); renderPanel(); } }, label);
  return h('div', { class: 'sort-toggle', role: 'group', 'aria-label': '意见展示排序' }, mk('seq', '原顺序'), mk('timecode', '按时间码'));
}

function renderListCard(v, { readOnly }) {
  const list = sortFeedback(v.feedback);
  const owner = state.role === 'owner';
  const title = readOnly ? `V${v.number} 收到的反馈` : '本轮反馈';
  let body;
  if (list.length) body = h('div', { class: 'fb-list' }, ...list.map((f) => renderItem(f, { readOnly, v })));
  else if (readOnly) body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '这个客稿版本没有收到意见'));
  else if (owner) body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '这一轮还没有提交意见'), '播放视频，在需要调整的位置暂停并添加第一条意见。');
  else body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '饼干还没有提交意见'), '意见提交后会在这里逐条显示，点一条就能跳到对应画面。');
  const canClear = readOnly && owner && !state.api.isLocal && v.video_status === 'ready';
  return h('section', { class: 'list-section', id: 'listCard' },
    h('div', { class: 'list-head' },
      h('div', { class: 'list-head__copy' }, h('div', { class: 'eyebrow eyebrow--pink' }, `客稿 V${v.number}${readOnly ? ' · 历史只读' : ''}`), h('div', { class: 'list-head__title' }, title)),
      h('div', { class: 'row' }, list.length > 1 && sortToggle(), h('span', { class: 'chip chip--count' }, `${list.length} 条`))),
    canClear ? h('div', { class: 'row row--between' }, h('span', { class: 'hint' }, `这一版视频已托管 · ${fmtBytes(v.video_size)}`), h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onClick: () => clearVideo(v) }, '清理视频释放空间')) : null,
    body,
    !readOnly && state.role === 'editor' && list.length ? h('div', { class: 'hint' }, '点一条意见即可跳到对应画面；改完勾「已修改」，饼干那边会同步看到。') : null);
}

function renderItem(f, { readOnly, v, basis = false }) {
  const canEdit = !readOnly && state.role === 'editor';
  const canDelete = !readOnly && state.role === 'owner' && v.status !== 'approved';
  const strip = h('div', { class: 'fb-strip' },
    h('span', { class: 'fb-strip__seq' }, `#${f.seq}`),
    h('span', { class: 'fb-strip__tc mono' }, f.timecode == null ? '整片' : fmtTimecodeMs(f.timecode)),
    h('span', { class: 'fb-strip__date' }, fmtDateSlash(f.created_at)),
    f.status === 'done' && h('span', { class: 'chip chip--ok' }, '已修改'),
    f.attachments.length ? h('span', { class: 'fb-strip__date' }, `${f.attachments.length} 个附件`) : null,
    h('span', { class: 'grow' }),
    canDelete ? h('button', { class: 'btn btn--sm btn--outline-danger', type: 'button', onClick: () => deleteFeedback(f) }, '删除') : null);
  const media = [];
  if (f.has_annotation && f.annotation_thumb) {
    media.push(h('img', { class: 'fb-item__thumb', src: f.annotation_thumb, alt: '画面标记', title: '点击查看大图', onClick: () => openAnnotation(f) }));
  }
  for (const a of f.attachments) media.push(attachmentTile(a));
  const body = h('div', { class: 'fb-item__body' },
    f.text ? h('div', { class: 'fb-item__text' }, f.text) : h('div', { class: 'fb-item__text fb-item__text--empty' }, f.has_annotation ? '（画面标记）' : '（附件）'),
    media.length ? h('div', { class: 'fb-item__media' }, ...media) : null,
    !canEdit && f.editor_note ? h('div', { class: 'fb-item__note' }, `修改说明：${f.editor_note}`) : null,
    strip);
  if (canEdit) {
    body.append(h('div', { class: 'fb-item__editor' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.status === 'done', onChange: (e) => updateFeedback(f, { status: e.target.checked ? 'done' : 'open' }) }), '已修改'),
      h('input', {
        class: 'input', type: 'text', value: f.editor_note || '', placeholder: '修改说明（可选）：改了什么、怎么改的',
        onBlur: (e) => { const val = e.target.value.trim(); if (val !== (f.editor_note || '')) updateFeedback(f, { editor_note: val }); },
        onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      })));
  }
  return h('article', {
    class: `fb-item${f.status === 'done' ? ' is-done' : ''}${!basis && f.id === state.activeFeedbackId ? ' is-active' : ''}${basis ? ' fb-item--readonly' : ''}`,
    dataset: { id: f.id },
    title: basis ? '' : (f.timecode == null ? '整片意见' : '点击跳到这个画面'),
    onClick: (e) => {
      if (basis) return;
      if (e.target.closest('button, input, textarea, label, img, a, audio, video')) return;
      selectFeedback(f);
    },
  }, body);
}

function selectFeedback(f) {
  if (f.timecode != null) player.seek(f.timecode, { pause: true });
  setActive(f.id, { scroll: false });
}
function setActive(id, { scroll }) {
  state.activeFeedbackId = id;
  for (const el of els.panel.querySelectorAll('.fb-item')) el.classList.toggle('is-active', el.dataset.id === id && !el.classList.contains('fb-item--readonly'));
  renderMarkers();
  if (scroll) els.panel.querySelector(`.fb-item[data-id="${id}"]:not(.fb-item--readonly)`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function updateFeedback(f, body) {
  try {
    await state.api.patchFeedback(f.id, body);
    Object.assign(f, body);
    toast(body.status === 'done' ? '已标记为「已修改」' : body.status === 'open' ? '已取消「已修改」' : '修改说明已保存');
    await loadState();
  } catch (e) { toast(e.message || '保存失败', 'warn'); }
}
async function deleteFeedback(f) {
  const ok = await confirmModal({ title: '确定删除这条意见吗？', text: '删除后剪辑师将看不到它。', okText: '删除', danger: true });
  if (!ok) return;
  try { await state.api.deleteFeedback(f.id); toast('意见已删除'); if (state.activeFeedbackId === f.id) state.activeFeedbackId = null; await loadState(); }
  catch (e) { toast(e.message || '意见删除失败', 'warn'); }
}

async function openAnnotation(f) {
  try {
    let full = cache.annotations.get(f.id);
    if (!full) { full = (await state.api.getAnnotation(f.id)).annotation; cache.annotations.set(f.id, full); }
    imageModal(full, `第 ${f.seq} 条 · ${fmtTimecode(f.timecode, fps())} 的画面标记`);
  } catch (e) { toast(e.message || '标记图片读取失败', 'warn'); }
}
function loadAttachment(id) {
  if (!cache.attachments.has(id)) cache.attachments.set(id, state.api.getAttachment(id).catch((e) => { cache.attachments.delete(id); throw e; }));
  return cache.attachments.get(id);
}
function attachmentThumb(a) {
  const img = h('img', { class: 'fb-item__thumb fb-item__thumb--sq', alt: a.name, title: `${a.name} · 点击查看大图`, onClick: async () => {
    try { const d = await loadAttachment(a.id); imageModal(d.data, a.name); } catch (e) { toast(e.message || '附件读取失败', 'warn'); }
  } });
  loadAttachment(a.id).then((d) => { img.src = d.data; }).catch(() => { img.alt = '附件读取失败'; });
  return img;
}

/** 列表里的附件：图片缩略图 / 视频卡片（弹层播放）/ 音频行内播放 / 上传中占位 */
function attachmentTile(a) {
  if (!a.kind || a.kind === 'image') return attachmentThumb(a);
  const icon = a.kind === 'video' ? '🎬' : '🎵';
  const url = state.api.mediaUrl ? state.api.mediaUrl(a.id) : null;
  if (a.status !== 'ready' || !url) {
    return h('div', { class: 'fb-media fb-media--pending', title: url ? '对方还没传完' : '连上服务器后才能播放' },
      h('span', {}, icon), h('span', { class: 'fb-media__name' }, a.name), h('span', { class: 'fb-media__meta' }, url ? '上传中…' : '离线'));
  }
  if (a.kind === 'audio') {
    return h('div', { class: 'fb-audio' },
      h('div', { class: 'row' }, h('span', { class: 'fb-media__name' }, `${icon} ${a.name}`), h('span', { class: 'fb-media__meta' }, fmtBytes(a.size)),
        h('a', { class: 'fb-media__meta', href: state.api.mediaUrl(a.id, { download: true }) }, '下载')),
      withSyncRetry(h('audio', { controls: true, preload: 'none', src: url }), url));
  }
  return h('button', { class: 'fb-media', type: 'button', title: '点击播放', onClick: () => mediaModal(a) },
    h('span', {}, '▶'), h('span', { class: 'fb-media__name' }, a.name), h('span', { class: 'fb-media__meta' }, fmtBytes(a.size)));
}
/** 刚上传的附件可能还没同步到附近节点（接口回 503）：出错后每 5 秒重试一次，最多 6 次 */
function withSyncRetry(el, src) {
  let tries = 0;
  el.addEventListener('error', () => {
    if (tries++ >= 6 || !el.isConnected) return;
    setTimeout(() => { if (el.isConnected) { el.src = `${src}&r=${tries}`; el.load(); } }, 5000);
  });
  return el;
}
function mediaModal(a) {
  const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } };
  const close = () => { document.removeEventListener('keydown', onKey, true); backdrop.remove(); };
  const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal modal--wide media-modal', role: 'dialog', 'aria-modal': 'true' },
      withSyncRetry(h('video', { controls: true, autoplay: true, playsinline: true, src: state.api.mediaUrl(a.id) }), state.api.mediaUrl(a.id)),
      h('div', { class: 'modal__actions' },
        h('span', { class: 'muted small' }, `${a.name} · ${fmtBytes(a.size)}`),
        h('a', { class: 'btn btn--ghost', href: state.api.mediaUrl(a.id, { download: true }) }, '下载'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, '关闭'))));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
}

function renderBasisCard(prev) {
  const list = sortFeedback(prev.feedback);
  return h('section', { class: 'card' },
    h('div', { class: 'card__head' },
      h('div', { class: 'row' }, h('div', { class: 'card__title' }, '本版修改依据'), h('span', { class: 'chip chip--muted' }, `来自客稿 V${prev.number} · ${list.length} 条`))),
    h('div', { class: 'hint' }, '上一版收到的意见和剪辑师的修改说明，用来核对这一版改了没有。时间码对应的是上一版的画面。'),
    list.length
      ? h('div', { class: 'fb-list' }, ...list.map((f) => renderItem(f, { readOnly: true, v: prev, basis: true })))
      : h('div', { class: 'empty' }, '上一版没有收到意见'));
}

// ---------- 发布新版 ----------
function renderPublishCard(v) {
  const next = v.number + 1;
  const editor = state.role === 'editor';
  return h('section', { class: `card${editor ? '' : ' card--tight'}` },
    h('div', { class: 'card__head' }, h('div', { class: 'card__title' }, editor ? '发布新版客稿' : '登记新版客稿')),
    h('div', { class: 'hint' }, editor
      ? (state.api.isLocal ? `改完后选择 V${next} 的视频文件。本地模式只记录文件名，不上传。` : `改完后选择 V${next} 的视频文件，会直接上传，饼干打开链接就能看。`)
      : (state.api.isLocal ? `剪辑师发来 V${next} 却没在这里登记时，你可以代为登记。` : `剪辑师把 V${next} 发给你却没上传时，你可以在这里代为上传。`)),
    h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', class: 'vh', id: 'newVersionInput', onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) publishVersion(f, next); } }),
    h('label', { class: `btn ${editor ? 'btn--primary' : 'btn--ghost'}`, for: 'newVersionInput' }, `选择 V${next} 文件`));
}
async function publishVersion(file, next) {
  if (hasDraft()) return toast('还有一条意见没提交，先提交或清空它', 'warn');
  const meta = await readVideoMeta(file);
  const ok = await confirmModal({
    title: `发布客稿 V${next}？`,
    text: `文件「${meta.name}」，${fmtBytes(meta.size)}，${fmtDuration(meta.duration)}。发布后当前意见清单会成为 V${next} 的修改依据。`,
    okText: '发布',
  });
  if (!ok) return;
  try {
    const res = await state.api.createVersion(meta);
    toast(`客稿 V${next} 已发布`);
    state.selectedVersion = null;
    state.activeFeedbackId = null;
    await loadState();
    if (state.api.isLocal) { player.loadFile(file); state.playerSource = { versionId: res.version.id, kind: 'local' }; renderFileWarn(); }
    else startUpload(file, res.version);
  } catch (e) { toast(e.message || '发布失败', 'warn'); }
}
