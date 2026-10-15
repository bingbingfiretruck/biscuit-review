// 审片页主逻辑：加载项目状态、渲染版本栏/播放器/右侧面板、轮询同步、提交意见。
import {
  API_BASE, POLL_MS, STATUS_LABEL, ROLE_LABEL, FPS_OPTIONS,
  ANNOTATION_MAX_EDGE, ATTACHMENT_MAX_EDGE, MAX_ATTACHMENTS,
} from './config.js';
import {
  $, h, fmtTimecode, fmtBytes, fmtDuration, fmtDate, readVideoMeta, fileToImage, shrinkToDataUrl,
  toast, confirmModal, imageModal, storage, storageSet, initTheme, currentTheme, setTheme,
} from './util.js';
import { createRemoteApi } from './api.js';
import { createLocalApi } from './localstore.js';
import { createPlayer } from './player.js';
import { openMarkup } from './markup.js';

const token = new URLSearchParams(location.search).get('t') || '';

const els = {
  shell: $('#shell'), gate: $('#gate'), gateTitle: $('#gateTitle'), gateText: $('#gateText'), gateActions: $('#gateActions'),
  projectName: $('#projectName'), versionChip: $('#versionChip'), roleChip: $('#roleChip'), themeBtn: $('#themeBtn'),
  banner: $('#banner'), railTitle: $('#railTitle'), railHint: $('#railHint'), versionList: $('#versionList'),
  playerRoot: $('#player'), fileWarn: $('#fileWarn'), panel: $('#panel'),
};

const state = {
  api: null, localMode: false, connLost: false,
  role: null, project: null, versions: [],
  selectedVersion: null, activeFeedbackId: null,
  sort: storage('biscuit.sort', 'timecode'),
  draft: { text: '', whole: false, lockedTimecode: null, annotation: null, attachments: [] },
  currentTime: 0, loadedFile: null,
  lastUpdatedAt: null, pollTimer: null, pendingRender: false,
};
const cache = { annotations: new Map(), attachments: new Map() };
let player;
let writeCard = null;
let writeCardKey = '';
let tcDisplay = null;

// ---------- 启动 ----------
initTheme();
updateThemeBtn();
els.themeBtn.addEventListener('click', () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); updateThemeBtn(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeBtn);
els.panel.addEventListener('focusout', () => { if (state.pendingRender) setTimeout(() => { if (state.pendingRender && !isTypingInList()) { state.pendingRender = false; renderAll(); } }, 80); });

if (!token) showGate('这个审片链接无效', '链接里缺少凭证，请向饼干要一条新的审片链接。');
else boot();

async function boot() {
  state.localMode = !API_BASE;
  state.api = state.localMode ? createLocalApi({ token }) : createRemoteApi({ token });
  player = createPlayer(els.playerRoot, {
    fps: 30,
    onTime: (t) => { state.currentTime = t; updateTcDisplay(); },
    onSeekMarker: (id) => setActive(id, { scroll: true }),
    onFileChosen: handleFile,
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
  window.addEventListener('beforeunload', (e) => { if (hasDraft()) { e.preventDefault(); e.returnValue = ''; } });
}

function failGate(e) {
  if (e.code === 'INVALID_TOKEN') {
    showGate('这个审片链接无效或已失效', state.localMode ? '本地模式只认这台设备上创建的项目。请回到管理台重新创建，或联系饼干要新链接。' : '请向饼干要一条新的审片链接。');
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
    retry && h('button', { class: 'btn btn--primary', type: 'button', onClick: () => location.reload() }, '重新尝试'),
    h('a', { class: 'btn btn--ghost', href: 'index.html' }, '回到管理台'));
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
    writeCardKey = '';
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
  return !!(a && els.panel.contains(a) && a.matches('input[type="text"], textarea') && !(writeCard && writeCard.contains(a)));
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
function updateThemeBtn() { els.themeBtn.textContent = currentTheme() === 'dark' ? '日间' : '黑夜'; }

// ---------- 渲染 ----------
function renderAll() {
  const sel = selected();
  document.title = `饼干在线审片 · ${state.project.name}`;
  els.projectName.textContent = state.project.name;
  els.versionChip.textContent = `客稿 V${sel.number}`;
  els.roleChip.textContent = ROLE_LABEL[state.role] + (state.localMode ? ' · 本地模式' : '');
  renderRail();
  renderPanel();
  renderMarkers();
  renderFileWarn();
  player.setExpected({ name: sel.video_name, size: sel.video_size });
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
  if (sel.number === cur) {
    els.railTitle.textContent = `客稿 V${sel.number} · 当前`;
    els.railHint.textContent = `${STATUS_LABEL[sel.status]} · ${fmtDate(sel.created_at)} 发出`;
  } else {
    els.railTitle.textContent = `客稿 V${sel.number} · 历史`;
    els.railHint.textContent = `历史只读 · ${STATUS_LABEL[sel.status]} · ${fmtDate(sel.created_at)} 发出`;
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
  if (cur && state.role === 'owner' && v.status === 'collecting') parts.push(getWriteCard(v));
  if (cur) parts.push(renderStatusCard(v));
  parts.push(renderListCard(v, { readOnly: !cur }));
  if (v.number > 1) {
    const prev = state.versions.find((x) => x.number === v.number - 1);
    if (prev) parts.push(renderBasisCard(prev));
  }
  if (cur) parts.push(renderPublishCard(v));

  const active = document.activeElement;
  const keepFocus = writeCard && writeCard.contains(active);
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
  if (!f || !v) { els.fileWarn.hidden = true; return; }
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
  renderFileWarn();
  renderAnnoBox();
}

// ---------- 写意见 ----------
function getWriteCard(v) {
  const key = `v${v.number}`;
  if (writeCard && writeCardKey === key) return writeCard;
  writeCardKey = key;
  writeCard = buildWriteCard(v);
  return writeCard;
}
function resetDraft() {
  // 原地清空：写意见卡里的事件处理器持有 state.draft 的引用，不能整个换掉
  Object.assign(state.draft, { text: '', lockedTimecode: null, annotation: null, attachments: [] });
  const ta = writeCard && $('#fbText', writeCard);
  if (ta) ta.value = '';
  renderAnnoBox();
  renderAttachBox();
  updateTcDisplay();
}

function buildWriteCard(v) {
  const d = state.draft;
  tcDisplay = h('span', { class: 'tc-display', title: '时间码 · 时:分:秒.帧' }, '00:00.00');
  const wholeCb = h('input', { type: 'checkbox', id: 'fbWhole', checked: d.whole, onChange: (e) => { d.whole = e.target.checked; updateTcDisplay(); } });
  const ta = h('textarea', { class: 'input', id: 'fbText', rows: 4, placeholder: '输入对当前客稿的具体反馈…', onInput: (e) => { d.text = e.target.value; } }, d.text);
  const card = h('section', { class: 'card write-card' },
    h('div', { class: 'card__head' },
      h('div', { class: 'card__title' }, '写意见'),
      h('span', { class: 'eyebrow' }, `客稿 V${v.number}`)),
    h('div', { class: 'tc-row' }, tcDisplay, h('label', { class: 'check' }, wholeCb, '整片（不带时间码）')),
    h('div', { class: 'field' }, ta, h('div', { class: 'hint' }, '例如：这里的产品名称请放大一些。暂停在要改的画面上再写，时间码会自动带上。')),
    h('div', { class: 'stack', id: 'annoBox' }),
    h('div', { class: 'attach-grid', id: 'attachBox' }),
    h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'vh', id: 'attachInput', onChange: handleAttachPick }),
    h('button', { class: 'btn btn--primary btn--block', type: 'button', id: 'submitBtn', onClick: submitFeedback }, '提交这条意见'),
    h('div', { class: 'hint' }, '提交后仍可继续补充；全部写完后，请结束本轮反馈通知剪辑师。'));
  queueMicrotask(() => { renderAnnoBox(); renderAttachBox(); updateTcDisplay(); });
  return card;
}

function updateTcDisplay() {
  if (!tcDisplay) return;
  const d = state.draft;
  if (d.whole) { tcDisplay.textContent = '整片'; tcDisplay.classList.add('is-whole'); return; }
  tcDisplay.classList.remove('is-whole');
  tcDisplay.textContent = fmtTimecode(d.lockedTimecode ?? state.currentTime, fps());
}

function renderAnnoBox() {
  const box = writeCard && $('#annoBox', writeCard);
  if (!box) return;
  const a = state.draft.annotation;
  if (a) {
    box.replaceChildren(
      h('div', { class: 'annotation-preview' },
        h('img', { src: a.thumb, alt: '画面标记预览', onClick: () => imageModal(a.full, '画面标记（待提交）') }),
        h('div', { class: 'annotation-preview__actions' },
          h('button', { class: 'btn btn--sm', type: 'button', onClick: () => startMarkup(true) }, '继续编辑'),
          h('button', { class: 'btn btn--sm btn--danger', type: 'button', onClick: () => { state.draft.annotation = null; state.draft.lockedTimecode = null; renderAnnoBox(); updateTcDisplay(); } }, '移除'))),
      h('div', { class: 'hint' }, `标记画面取自 ${fmtTimecode(a.timecode, fps())}，这条意见的时间码已锁定到这一帧。`));
  } else {
    const has = player.hasFile();
    box.replaceChildren(h('button', {
      class: 'btn', type: 'button', id: 'markupBtn', disabled: !has, title: has ? '抓取当前画面，直接画出要改的地方' : '先选择客稿视频',
      onClick: () => startMarkup(false),
    }, '✎ 在当前帧画标记'));
  }
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
  openMarkup({
    baseCanvas: base,
    initialStrokes: edit && d.annotation ? d.annotation.strokes : [],
    onDone: ({ full, thumb, strokes }) => {
      d.annotation = { full, thumb, strokes, base, timecode };
      d.lockedTimecode = timecode;
      renderAnnoBox();
      updateTcDisplay();
    },
  });
}

async function handleAttachPick(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) {
    if (state.draft.attachments.length >= MAX_ATTACHMENTS) { toast(`参考图最多 ${MAX_ATTACHMENTS} 张`, 'warn'); break; }
    if (!f.type.startsWith('image/')) { toast(`「${f.name}」不是图片，参考附件只支持图片`, 'warn'); continue; }
    try {
      const img = await fileToImage(f);
      state.draft.attachments.push({ name: f.name, mime: 'image/jpeg', data: shrinkToDataUrl(img, ATTACHMENT_MAX_EDGE, 0.82) });
    } catch { toast(`「${f.name}」读取失败`, 'warn'); }
  }
  renderAttachBox();
}
function renderAttachBox() {
  const box = writeCard && $('#attachBox', writeCard);
  if (!box) return;
  const list = state.draft.attachments;
  const items = list.map((a, i) => h('div', { class: 'attach-thumb' },
    h('img', { src: a.data, alt: a.name, title: a.name, onClick: () => imageModal(a.data, a.name) }),
    h('button', { class: 'attach-thumb__x', type: 'button', 'aria-label': `移除附件 ${a.name}`, onClick: () => { list.splice(i, 1); renderAttachBox(); } }, '✕')));
  if (list.length < MAX_ATTACHMENTS) items.push(h('label', { class: 'attach-add', for: 'attachInput', title: '上传参考图片（会压缩）' }, '＋ 参考图'));
  box.replaceChildren(...items);
}

async function submitFeedback() {
  const d = state.draft;
  const text = d.text.trim();
  if (!text && !d.annotation && d.attachments.length === 0) return toast('先写点意见，或画个标记、传张参考图', 'warn');
  if (!d.whole && !player.hasFile()) return toast('还没有打开视频：先选择客稿视频，或勾选「整片」', 'warn');
  const body = {
    timecode: d.whole ? null : (d.lockedTimecode ?? player.currentTime()),
    text,
    attachments: d.attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.data })),
  };
  if (d.annotation) { body.annotation = d.annotation.full; body.annotation_thumb = d.annotation.thumb; }
  const btn = $('#submitBtn', writeCard);
  btn.disabled = true; btn.textContent = '正在提交…';
  try {
    const res = await state.api.createFeedback(body);
    resetDraft();
    state.activeFeedbackId = res.feedback.id;
    toast(`第 ${res.feedback.seq} 条意见已提交`);
    await loadState();
  } catch (e) {
    toast(e.message || '意见提交失败，请稍后重试', 'warn');
    if (e.code === 'ROUND_CLOSED' || e.code === 'INVALID_TOKEN') loadState().catch(() => {});
  } finally {
    btn.disabled = false; btn.textContent = '提交这条意见';
  }
}

// ---------- 本轮状态 ----------
function renderStatusCard(v) {
  const n = v.feedback.length;
  const owner = state.role === 'owner';
  const cls = `card status-card${v.status === 'closed' ? ' status-card--closed' : ''}${v.status === 'approved' ? ' status-card--approved' : ''}`;
  let stateText; let hint; const actions = [];
  if (owner) {
    if (v.status === 'collecting') {
      stateText = n ? `意见填写中 · 已写 ${n} 条` : '等待你的意见';
      hint = '全部写完后点击「本轮反馈结束」，剪辑师才会知道可以开始修改。';
      actions.push(
        h('button', { class: 'btn btn--primary', type: 'button', disabled: !n, title: n ? '' : '至少先提交一条意见', onClick: closeRound }, '本轮反馈结束'),
        h('button', { class: 'btn btn--ghost', type: 'button', onClick: approve }, '确认本版通过'));
    } else if (v.status === 'closed') {
      stateText = `本轮反馈已结束 · ${n} 条意见`;
      hint = '剪辑师可以开始修改了。下一稿发出前，可撤回结束并继续补充意见。';
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
  return h('section', { class: cls },
    h('div', { class: 'card__head' }, h('div', { class: 'eyebrow' }, '本轮反馈'), h('span', { class: `chip ${v.status === 'approved' ? 'chip--ok' : v.status === 'closed' ? 'chip--ok' : ''}` }, STATUS_LABEL[v.status])),
    h('div', { class: 'status-card__state' }, stateText),
    h('div', { class: 'hint' }, hint),
    actions.length ? h('div', { class: 'row' }, ...actions) : null);
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
  return h('div', { class: 'sort-toggle', role: 'group', 'aria-label': '意见展示排序' }, mk('timecode', '按时间码'), mk('seq', '原顺序'));
}

function renderListCard(v, { readOnly }) {
  const list = sortFeedback(v.feedback);
  const owner = state.role === 'owner';
  const title = readOnly ? `客稿 V${v.number} 收到的意见` : '已提交的意见';
  let body;
  if (list.length) body = h('div', { class: 'fb-list' }, ...list.map((f) => renderItem(f, { readOnly, v })));
  else if (readOnly) body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '这个客稿版本没有收到意见'));
  else if (owner) body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '这一轮还没有提交意见'), '播放视频，在需要调整的位置暂停并添加第一条意见。');
  else body = h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '饼干还没有提交意见'), '意见提交后会在这里逐条显示，点一条就能跳到对应画面。');
  return h('section', { class: 'card', id: 'listCard' },
    h('div', { class: 'card__head' },
      h('div', { class: 'row' }, h('div', { class: 'card__title' }, title), h('span', { class: 'chip chip--muted' }, `${list.length} 条`), readOnly && h('span', { class: 'chip chip--muted' }, '历史只读')),
      list.length > 1 && sortToggle()),
    body,
    !readOnly && state.role === 'editor' && list.length ? h('div', { class: 'hint' }, '点一条意见即可跳到对应画面；改完勾「已修改」，饼干那边会同步看到。') : null);
}

function renderItem(f, { readOnly, v, basis = false }) {
  const canEdit = !readOnly && state.role === 'editor';
  const canDelete = !readOnly && state.role === 'owner' && v.status !== 'approved';
  const tcChip = f.timecode == null
    ? h('span', { class: 'chip chip--muted' }, '整片')
    : h('span', { class: 'chip chip--mono' }, fmtTimecode(f.timecode, fps()));
  const meta = h('div', { class: 'fb-item__meta' }, tcChip,
    f.status === 'done' && h('span', { class: 'chip chip--ok' }, '已修改'),
    f.attachments.length ? h('span', { class: 'chip chip--muted' }, `${f.attachments.length} 张参考图`) : null,
    h('span', { class: 'muted small' }, fmtDate(f.created_at)));
  const media = [];
  if (f.has_annotation && f.annotation_thumb) {
    media.push(h('img', { class: 'fb-item__thumb', src: f.annotation_thumb, alt: '画面标记', title: '点击查看大图', onClick: () => openAnnotation(f) }));
  }
  for (const a of f.attachments) media.push(attachmentThumb(a));
  const body = h('div', { class: 'fb-item__body' }, meta,
    f.text && h('div', { class: 'fb-item__text' }, f.text),
    media.length ? h('div', { class: 'fb-item__media' }, ...media) : null,
    !canEdit && f.editor_note ? h('div', { class: 'fb-item__note' }, `修改说明：${f.editor_note}`) : null);
  if (canEdit) {
    body.append(h('div', { class: 'fb-item__editor' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.status === 'done', onChange: (e) => updateFeedback(f, { status: e.target.checked ? 'done' : 'open' }) }), '已修改'),
      h('input', {
        class: 'input', type: 'text', value: f.editor_note || '', placeholder: '修改说明（可选）：改了什么、怎么改的',
        onBlur: (e) => { const val = e.target.value.trim(); if (val !== (f.editor_note || '')) updateFeedback(f, { editor_note: val }); },
        onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      })));
  }
  if (canDelete) {
    body.append(h('div', { class: 'fb-item__actions' },
      h('button', { class: 'btn btn--sm btn--danger', type: 'button', onClick: () => deleteFeedback(f) }, '删除')));
  }
  return h('article', {
    class: `fb-item${f.status === 'done' ? ' is-done' : ''}${!basis && f.id === state.activeFeedbackId ? ' is-active' : ''}${basis ? ' fb-item--readonly' : ''}`,
    dataset: { id: f.id },
    title: basis ? '' : (f.timecode == null ? '整片意见' : '点击跳到这个画面'),
    onClick: (e) => {
      if (basis) return;
      if (e.target.closest('button, input, textarea, label, img, a')) return;
      selectFeedback(f);
    },
  }, h('div', { class: 'fb-item__seq', 'aria-label': `第 ${f.seq} 条` }, String(f.seq)), body);
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
      ? `改完后选择 V${next} 的视频文件。只记录文件名、大小和时长，不上传；记得把文件发给饼干。`
      : `剪辑师发来 V${next} 却没在这里登记时，你可以代为登记。`),
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
    await state.api.createVersion(meta);
    toast(`客稿 V${next} 已发布`);
    state.selectedVersion = null;
    state.activeFeedbackId = null;
    await loadState();
    player.loadFile(file);
  } catch (e) { toast(e.message || '发布失败', 'warn'); }
}
