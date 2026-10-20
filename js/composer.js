// 写意见内卡（参考站形式）：两个入口按钮、预览区、带时间码芯片与字数的输入框、确认通过 / 提交。
// 草稿对象 draft 由 review.js 持有，这里原地读写：{ text, whole, lockedTimecode, annotation, attachments }。
// 附件：图片压成 data URL 随意见提交；视频/音频存 { kind, name, mime, size, file }，提交后再分片上传。
import { h, fmtTimecodeMs, fmtBytes, fileToImage, shrinkToDataUrl, imageModal, toast } from './util.js';

const TEXT_MAX = 1000;
const EXT_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', amr: 'audio/amr' };

/** 判断文件类型：image / video / audio / null */
function kindOf(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime = file.type || EXT_MIME[ext] || '';
  if (mime.startsWith('image/')) return { kind: 'image', mime };
  if (mime.startsWith('video/')) return { kind: 'video', mime };
  if (mime.startsWith('audio/')) return { kind: 'audio', mime };
  return null;
}

export function createComposer({ player, draft, maxAttachments, attachmentMaxEdge, maxMediaBytes, accept, localMode, onSubmit, onApprove, onMarkup }) {
  let markupOpen = false;
  let submitting = false;

  const markupBtn = h('button', { class: 'composer__tool', type: 'button', id: 'markupBtn', onClick: () => onMarkup(false) }, '在当前帧画标记');
  const attachInput = h('input', { type: 'file', accept, multiple: true, class: 'vh', id: 'attachInput', onChange: pickAttachments });
  const attachBtn = h('button', { class: 'composer__tool', type: 'button', title: '上传参考图片 / 视频 / 音频', onClick: () => attachInput.click() },
    '选择附件', h('span', { class: 'composer__tool-sub' }, '图片 · 视频 · 音频'));
  const annoBox = h('div', { class: 'stack', id: 'annoBox', hidden: true });
  const attachBox = h('div', { class: 'attach-grid', id: 'attachBox', hidden: true });
  const counter = h('span', { class: 'composer__count', 'aria-live': 'polite' }, `0/${TEXT_MAX}`);
  const tcChip = h('button', { class: 'tc-chip', type: 'button', title: '点一下在「当前时间码」和「整片」之间切换', onClick: () => { draft.whole = !draft.whole; syncTime(); } });
  const ta = h('textarea', {
    class: 'input', id: 'fbText', rows: 5, maxlength: TEXT_MAX, placeholder: '输入对当前客稿的具体反馈…',
    onInput: (e) => { draft.text = e.target.value; syncCounter(); syncSubmit(); },
  }, draft.text);
  const approveBtn = h('button', { class: 'btn btn--outline', type: 'button', onClick: () => onApprove() }, '确认本版通过');
  const submitBtn = h('button', { class: 'btn btn--primary', type: 'button', id: 'submitBtn', onClick: () => onSubmit() }, '提交意见');
  const mediaMB = Math.round(maxMediaBytes / 1024 / 1024);

  const el = h('section', { class: 'composer', 'aria-label': '写意见' },
    h('div', { class: 'composer__tools' }, markupBtn, attachBtn, attachInput),
    annoBox, attachBox,
    h('div', { class: 'composer__field' }, ta, h('div', { class: 'composer__meta' }, tcChip, counter)),
    h('div', { class: 'composer__actions' }, approveBtn, submitBtn),
    h('div', { class: 'hint' }, `提交后仍可继续补充；全部写完后，请结束本轮反馈通知剪辑师。附件支持 JPG、PNG、WebP、MP4、WebM、MOV、MP3、WAV、M4A、AAC、FLAC、OGG、Opus 或 AMR，每条最多 ${maxAttachments} 个；图片会压缩到 ${attachmentMaxEdge}px，视频/音频单个不超过 ${mediaMB} MB。`));

  const hasContent = () => !!(draft.text.trim() || draft.annotation || draft.attachments.length);

  function refresh() {
    const has = player.hasFile();
    markupBtn.disabled = !has || markupOpen;
    markupBtn.title = has ? '抓取当前画面，直接画出要改的地方' : '先选择客稿视频';
    if (ta.value !== draft.text) ta.value = draft.text;
    syncCounter();
    renderAnno();
    renderAttach();
    syncSubmit();
    syncTime();
  }
  function syncCounter() { counter.textContent = `${draft.text.length}/${TEXT_MAX}`; }
  function syncSubmit() { submitBtn.disabled = submitting || !hasContent(); }
  function syncTime() {
    tcChip.classList.toggle('is-whole', draft.whole);
    tcChip.textContent = draft.whole ? '整片 · 不带时间码' : `时间码 ${fmtTimecodeMs(draft.lockedTimecode ?? player.currentTime())}`;
  }
  function setSubmitting(on) {
    submitting = on;
    submitBtn.textContent = on ? '正在提交…' : '提交意见';
    syncSubmit();
  }
  function setMarkupOpen(on) {
    markupOpen = on;
    markupBtn.textContent = on ? '正在画标记…' : '在当前帧画标记';
    refresh();
  }

  function renderAnno() {
    const a = draft.annotation;
    annoBox.hidden = !a;
    if (!a) { annoBox.replaceChildren(); return; }
    annoBox.replaceChildren(
      h('div', { class: 'annotation-preview' },
        h('img', { src: a.thumb, alt: '画面标记预览', onClick: () => imageModal(a.full, '画面标记（待提交）') }),
        h('div', { class: 'annotation-preview__actions' },
          h('button', { class: 'btn btn--sm', type: 'button', onClick: () => onMarkup(true) }, '继续编辑'),
          h('button', { class: 'btn btn--sm btn--danger', type: 'button', onClick: removeAnno }, '移除'))),
      h('div', { class: 'hint' }, `标记画面取自 ${fmtTimecodeMs(a.timecode)}，这条意见的时间码已锁定到这一帧。`));
  }
  function removeAnno() {
    draft.annotation = null;
    draft.lockedTimecode = null;
    refresh();
  }

  async function pickAttachments(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      if (draft.attachments.length >= maxAttachments) { toast(`附件最多 ${maxAttachments} 个`, 'warn'); break; }
      const t = kindOf(f);
      if (!t) { toast(`「${f.name}」不是支持的图片、视频或音频格式`, 'warn'); continue; }
      if (t.kind === 'image') await addImage(f);
      else addMedia(f, t);
    }
    refresh();
  }
  async function addImage(f) {
    try {
      const img = await fileToImage(f);
      draft.attachments.push({ kind: 'image', name: f.name, mime: 'image/jpeg', data: shrinkToDataUrl(img, attachmentMaxEdge, 0.82) });
    } catch { toast(`「${f.name}」读取失败`, 'warn'); }
  }
  function addMedia(f, t) {
    if (localMode) return toast('本地模式只能传图片附件，连上服务器后才能传视频/音频', 'warn');
    if (f.size > maxMediaBytes) return toast(`「${f.name}」超过 ${mediaMB} MB，请压缩后再传`, 'warn');
    if (!f.size) return toast(`「${f.name}」是空文件`, 'warn');
    draft.attachments.push({ kind: t.kind, name: f.name, mime: t.mime, size: f.size, file: f });
  }
  function renderAttach() {
    const list = draft.attachments;
    attachBox.hidden = !list.length;
    attachBox.replaceChildren(...list.map((a, i) => (a.kind === 'image' ? imageTile(a, i) : mediaTile(a, i))));
  }
  function removeAt(i) { draft.attachments.splice(i, 1); refresh(); }
  function imageTile(a, i) {
    return h('div', { class: 'attach-thumb' },
      h('img', { src: a.data, alt: a.name, title: a.name, onClick: () => imageModal(a.data, a.name) }),
      h('button', { class: 'attach-thumb__x', type: 'button', 'aria-label': `移除附件 ${a.name}`, onClick: () => removeAt(i) }, '✕'));
  }
  function mediaTile(a, i) {
    return h('div', { class: 'attach-file', title: a.name },
      h('span', { class: 'attach-file__icon', 'aria-hidden': 'true' }, a.kind === 'video' ? '🎬' : '🎵'),
      h('span', { class: 'attach-file__name' }, a.name),
      h('span', { class: 'attach-file__size' }, fmtBytes(a.size)),
      h('button', { class: 'attach-file__x', type: 'button', 'aria-label': `移除附件 ${a.name}`, onClick: () => removeAt(i) }, '✕'));
  }

  queueMicrotask(refresh);
  return { el, refresh, syncTime, setSubmitting, setMarkupOpen };
}
