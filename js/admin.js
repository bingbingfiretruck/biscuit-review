// 管理台：输入管理口令、新建项目、生成两条链接、项目列表。
import { API_BASE, STATUS_LABEL } from './config.js';
import { $, h, fmtBytes, fmtDuration, fmtDate, readVideoMeta, toast, confirmModal, copyText, storage, storageSet, initTheme, currentTheme, setTheme } from './util.js';
import { createRemoteApi } from './api.js';
import { createLocalApi } from './localstore.js';
import { uploadVideo } from './upload.js';

const els = {
  banner: $('#banner'), modeChip: $('#modeChip'), themeBtn: $('#themeBtn'),
  keyCard: $('#keyCard'), keyForm: $('#keyForm'), keyInput: $('#keyInput'),
  app: $('#app'), createForm: $('#createForm'), nameInput: $('#nameInput'), fpsInput: $('#fpsInput'),
  videoInput: $('#videoInput'), videoMeta: $('#videoMeta'), createBtn: $('#createBtn'),
  linksCard: $('#linksCard'), projectList: $('#projectList'), refreshBtn: $('#refreshBtn'),
};
const state = { api: null, localMode: !API_BASE, adminKey: storage('biscuit.adminKey', ''), video: null, videoFile: null, projects: [], uploading: false };
window.addEventListener('beforeunload', (e) => { if (state.uploading) { e.preventDefault(); e.returnValue = ''; } });

initTheme();
updateThemeBtn();
els.themeBtn.addEventListener('click', () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); updateThemeBtn(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeBtn);
function updateThemeBtn() { els.themeBtn.textContent = currentTheme() === 'dark' ? '日间' : '黑夜'; }

const reviewUrl = (t) => new URL(`review.html?t=${t}`, location.href).href;

boot();

async function boot() {
  if (state.localMode) return enterLocal();
  if (!state.adminKey) { els.keyCard.hidden = false; return; }
  await tryEnter(state.adminKey);
}

function enterLocal() {
  state.localMode = true;
  state.api = createLocalApi({});
  els.modeChip.hidden = false;
  els.keyCard.hidden = true;
  els.app.hidden = false;
  showBanner('本地模式：没有连接服务器，项目只保存在这台设备的浏览器里，链接发给别人打不开。部署 Worker 后在 js/config.js 填上地址即可切换。', 'info');
  refresh();
}

async function tryEnter(key) {
  const api = createRemoteApi({ adminKey: key });
  try {
    const data = await api.adminList();
    state.api = api;
    state.adminKey = key;
    storageSet('biscuit.adminKey', key);
    els.keyCard.hidden = true;
    els.app.hidden = false;
    renderProjects(data.projects);
    renderStorage(data.storage || null);
  } catch (e) {
    if (e.code === 'NETWORK') { showBanner('连不上服务器，先用本地模式。', 'warn'); enterLocal(); return; }
    if (e.code === 'INVALID_ADMIN_KEY') storageSet('biscuit.adminKey', '');
    els.keyCard.hidden = false;
    els.keyInput.focus();
    toast(e.code === 'INVALID_ADMIN_KEY' ? '管理口令不对' : `管理接口出错：${e.message}`, 'warn');
  }
}

els.keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  if (!key) return;
  tryEnter(key);
});

els.videoInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  els.videoMeta.replaceChildren(h('span', { class: 'muted' }, '正在读取视频信息…'));
  state.video = await readVideoMeta(f);
  state.videoFile = f;
  els.videoMeta.replaceChildren(
    h('div', { class: 'file-pick__name' }, state.video.name),
    h('div', { class: 'muted' }, `${fmtBytes(state.video.size)} · ${fmtDuration(state.video.duration)}`));
});

els.createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.nameInput.value.trim();
  if (!name) return toast('先给项目起个名字', 'warn');
  if (!state.video) return toast('先选择 V1 客稿视频文件', 'warn');
  els.createBtn.disabled = true;
  els.createBtn.textContent = '正在创建…';
  try {
    const res = await state.api.adminCreate({ name, fps: Number(els.fpsInput.value), video: state.video });
    toast(`项目「${res.project.name}」已创建`);
    renderLinks(res.project);
    const file = state.videoFile;
    els.nameInput.value = '';
    state.video = null;
    state.videoFile = null;
    if (!state.localMode && file) uploadFirstVideo(res, file);
    els.videoMeta.replaceChildren(h('span', { class: 'muted' }, '选剪辑师发给你的那个文件。创建后会直接上传，你和剪辑师打开链接就能看。'));
    await refresh();
  } catch (err) {
    toast(err.message || '创建失败', 'warn');
    if (err.code === 'INVALID_ADMIN_KEY') { storageSet('biscuit.adminKey', ''); location.reload(); }
  } finally {
    els.createBtn.disabled = false;
    els.createBtn.textContent = '创建项目并生成链接';
  }
});

els.refreshBtn.addEventListener('click', refresh);

async function refresh() {
  try { const data = await state.api.adminList(); renderProjects(data.projects); renderStorage(data.storage || null); }
  catch (e) { toast(e.message || '刷新失败', 'warn'); }
}

function linkRow(label, url) {
  return h('div', { class: 'link-row' },
    h('span', { class: 'link-row__label' }, label),
    h('code', { title: url }, url),
    h('button', { class: 'btn btn--sm', type: 'button', onClick: async () => { toast((await copyText(url)) ? `${label}已复制` : '复制失败，请手动选中复制', 'ok'); } }, '复制'));
}

async function uploadFirstVideo(res, file) {
  const ownerApi = createRemoteApi({ token: res.project.owner_token });
  const box = h('div', { class: 'upload-bar', id: 'adminUpload' });
  els.linksCard.append(box);
  const render = (loaded, total) => {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    box.replaceChildren(
      h('div', { class: 'row row--between' }, h('span', {}, `正在上传 V1 视频 · ${pct}%`), h('span', { class: 'mono small' }, `${fmtBytes(loaded)} / ${fmtBytes(total)}`)),
      h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${pct}%` } })),
      h('div', { class: 'hint' }, '上传期间请不要关闭页面。'));
  };
  state.uploading = true;
  render(0, file.size);
  try {
    await uploadVideo({ api: ownerApi, versionId: res.version.id, file, onProgress: render });
    box.replaceChildren(h('div', {}, `✓ 视频已上传（${fmtBytes(file.size)}），剪辑师打开链接就能直接看。`));
    refresh();
  } catch (e) {
    box.className = 'banner';
    box.replaceChildren(`视频上传失败：${e.message || '未知错误'}。打开审片页可以重新上传。`);
  } finally { state.uploading = false; }
}

function renderLinks(p) {
  els.linksCard.hidden = false;
  els.linksCard.replaceChildren(
    h('div', { class: 'card__head' }, h('div', { class: 'card__title' }, `「${p.name}」的两条链接`), h('span', { class: 'chip' }, '刚创建')),
    h('p', { class: 'hint' }, '审片链接自己留着用；剪辑师链接微信发给剪辑师。两条链接都不需要登录，谁拿到谁就能用，不要公开发。'),
    linkRow('审片链接', reviewUrl(p.owner_token)),
    linkRow('剪辑师链接', reviewUrl(p.editor_token)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('a', { class: 'btn btn--primary', href: reviewUrl(p.owner_token) }, '打开审片页')));
  els.linksCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderStorage(storage) {
  let bar = document.getElementById('storageBar');
  if (!storage) { bar?.remove(); return; }
  if (!bar) { bar = h('div', { id: 'storageBar', class: 'stack', style: { gap: '4px' } }); els.projectList.parentElement.insertBefore(bar, els.projectList); }
  const pct = Math.min(100, Math.round((storage.used / storage.limit) * 100));
  bar.replaceChildren(
    h('div', { class: 'row row--between small' }, h('span', { class: 'muted' }, `视频空间 · 已用 ${fmtBytes(storage.used)} / ${fmtBytes(storage.limit)}（${storage.kind === 'kv' ? '免费 KV' : 'R2'}）`), h('span', { class: pct > 85 ? 'chip chip--warn' : 'muted' }, `${pct}%`)),
    h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${pct}%`, background: pct > 85 ? 'var(--warn)' : '' } })),
    h('div', { class: 'hint' }, '每个项目只保留最近两版的视频；空间紧张时去审片页的历史版本里清理，或删掉整个旧项目。'));
}

function renderProjects(list) {
  state.projects = list;
  if (!list.length) {
    els.projectList.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty__title' }, '还没有项目'), '在上面新建第一个审片项目，剪辑师发来的每条视频建一个。'));
    return;
  }
  els.projectList.replaceChildren(...list.map((p) => h('article', { class: 'project' },
    h('div', { class: 'project__head' },
      h('div', { class: 'project__name' }, p.name),
      h('div', { class: 'project__meta' },
        h('span', { class: 'chip chip--mono' }, `客稿 V${p.current_version}`),
        h('span', { class: `chip ${p.status === 'approved' || p.status === 'closed' ? 'chip--ok' : ''}` }, STATUS_LABEL[p.status] || p.status),
        h('span', { class: 'chip chip--muted' }, `${p.feedback_count} 条意见`),
        h('span', { class: 'muted small' }, `${fmtDate(p.updated_at)} 更新`))),
    linkRow('审片链接', reviewUrl(p.owner_token)),
    linkRow('剪辑师链接', reviewUrl(p.editor_token)),
    h('div', { class: 'project__actions' },
      h('button', { class: 'btn btn--sm btn--danger', type: 'button', onClick: () => removeProject(p) }, '删除项目'),
      h('a', { class: 'btn btn--sm', href: reviewUrl(p.editor_token) }, '以剪辑师身份查看'),
      h('a', { class: 'btn btn--sm btn--primary', href: reviewUrl(p.owner_token) }, '打开审片页')))));
}

async function removeProject(p) {
  const ok = await confirmModal({ title: `删除「${p.name}」？`, text: '全部版本、意见和图片都会删除，不能恢复。两条链接随即失效。', okText: '删除', danger: true });
  if (!ok) return;
  try { await state.api.adminDelete(p.id); toast('项目已删除'); if (!els.linksCard.hidden) els.linksCard.hidden = true; await refresh(); }
  catch (e) { toast(e.message || '删除失败', 'warn'); }
}

function showBanner(msg, kind) {
  els.banner.className = kind === 'info' ? 'banner banner--info' : 'banner';
  els.banner.textContent = msg;
  els.banner.hidden = false;
}
