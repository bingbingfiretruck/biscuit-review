// 播放器：本地文件、逐帧、时间码、进度条意见标记、大屏模式。
import { h, fmtTimecode, fmtTimecodeFrames, fmtClock, fmtBytes, pad } from './util.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function createPlayer(root, { fps = 30, onTime = () => {}, onSeekMarker = () => {}, onFileChosen = () => {}, onError = () => {} } = {}) {
  let currentFps = fps;
  let markers = [];
  let objectUrl = null;
  let file = null;

  // crossorigin：托管视频跨域播放时仍能抓帧到 canvas（Worker 会回 CORS 头）
  const video = h('video', { class: 'player__video', playsinline: true, preload: 'metadata', crossorigin: 'anonymous', 'aria-label': '当前客稿视频' });
  const markerLayer = h('div', { class: 'player__markers', 'aria-label': '意见标记' });
  const range = h('input', { class: 'player__range', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': '视频时间线' });
  const timeLabel = h('span', { class: 'player__time mono' }, '00:00');
  const durLabel = h('span', { class: 'player__dur mono' }, '00:00');
  const bigTc = h('span', { class: 'player__tc-big mono' }, '00:00:00:00');
  const fpsLabel = h('span', { class: 'player__fps' }, `${currentFps}fps`);
  const countLabel = h('span', { class: 'player__timeline-count mono' }, '0 条');
  const playBtn = h('button', { class: 'player__btn player__btn--play', type: 'button', 'aria-label': '播放', onClick: togglePlay }, '▶');
  const speedSel = h('select', { class: 'player__select', 'aria-label': '播放速度', onChange: (e) => { video.playbackRate = Number(e.target.value); } },
    ...SPEEDS.map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
  const theaterBtn = h('button', { class: 'player__btn player__btn--text', type: 'button', 'aria-label': '大屏审片', onClick: () => setTheater(!root.classList.contains('player--theater')) }, '大屏');
  const fileInput = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', class: 'vh', id: 'player-file', onChange: (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; } });
  const emptyTitle = h('div', { class: 'player__empty-title' }, '选择客稿视频');
  const emptyHint = h('div', { class: 'player__empty-hint' }, '视频只在这台设备上播放，不会上传。');
  const emptyActions = h('div', { class: 'row', style: { justifyContent: 'center' } }, h('label', { class: 'btn btn--primary', for: 'player-file' }, '选择客稿视频'));
  const empty = h('div', { class: 'player__empty' },
    h('div', { class: 'player__empty-icon', 'aria-hidden': 'true' }, '🎬'),
    emptyTitle, emptyHint,
    emptyActions,
    fileInput);

  const ctl = (label, title, fn) => h('button', { class: 'player__btn player__btn--text', type: 'button', title, onClick: fn }, label);
  const controls = h('div', { class: 'player__controls' },
    h('div', { class: 'player__clock' }, timeLabel, h('span', { class: 'player__sep' }, '/'), durLabel),
    h('div', { class: 'player__row' },
      h('div', { class: 'player__group' },
        h('label', { class: 'player__btn player__btn--text', for: 'player-file', title: '换一个文件' }, '换文件')),
      h('div', { class: 'player__group player__group--center' },
        ctl('−1 帧', '后退一帧（←）', () => stepFrames(-1)),
        ctl('↺ 3s', '后退 3 秒（Shift+←）', () => stepSeconds(-3)),
        playBtn,
        ctl('3s ↻', '前进 3 秒（Shift+→）', () => stepSeconds(3)),
        ctl('+1 帧', '前进一帧（→）', () => stepFrames(1))),
      h('div', { class: 'player__group' }, speedSel, theaterBtn)),
    h('div', { class: 'player__tc' }, bigTc, fpsLabel),
    h('div', { class: 'player__timeline-head' },
      h('span', { class: 'player__timeline-title' }, '意见时间线'),
      h('span', { class: 'player__timeline-hint' }, '点标记定位并暂停'),
      countLabel),
    h('div', { class: 'player__timeline' }, range, markerLayer));

  const stage = h('div', { class: 'player__stage' }, video, empty);
  root.classList.add('player');
  root.append(stage, controls);
  controls.hidden = true;

  // ---- 事件 ----
  video.addEventListener('loadedmetadata', () => {
    // 舞台按视频比例自适应（竖屏视频不再被 16:9 压成一小条，也不会撑到原始高度）
    if (video.videoWidth && video.videoHeight) stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    durLabel.textContent = fmtClock(video.duration);
    renderMarkers();
    tick();
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', tick);
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', '暂停'); });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', '播放'); });
  video.addEventListener('click', togglePlay);
  video.addEventListener('error', () => {
    if (onError(file) === true) return; // 页面接管（例如托管视频同步中，稍后重试）
    emptyTitle.textContent = '视频暂时无法播放';
    emptyHint.textContent = '当前浏览器不支持这个格式，试试 MP4（H.264）。';
    empty.hidden = false;
    controls.hidden = true;
  });

  let scrubbing = false;
  range.addEventListener('input', () => { scrubbing = true; const t = (range.value / 1000) * (video.duration || 0); video.currentTime = t; paintTime(t); });
  range.addEventListener('change', () => { scrubbing = false; tick(); });

  root.addEventListener('keydown', (e) => {
    if (root.classList.contains('player--markup')) return; // 标记编辑中，快捷键交给编辑器
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stepSeconds(-3) : stepFrames(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stepSeconds(3) : stepFrames(1); }
  });
  root.tabIndex = 0;

  let rafPending = false;
  function tick() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const t = video.currentTime || 0;
      if (!scrubbing && video.duration) range.value = Math.round((t / video.duration) * 1000);
      paintTime(t);
      onTime(t, video.paused);
    });
  }

  function paintTime(t) {
    timeLabel.textContent = fmtClock(t);
    bigTc.textContent = fmtTimecodeFrames(t, currentFps);
    range.style.setProperty('--pct', `${video.duration ? (t / video.duration) * 100 : 0}%`);
  }
  function togglePlay() {
    if (!file) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function clamp(t) { return Math.min(Math.max(0, t), video.duration || 0); }
  function stepFrames(n) {
    if (!file) return;
    video.pause();
    const frame = Math.round(video.currentTime * currentFps);
    video.currentTime = clamp((frame + n) / currentFps + 0.0001);
  }
  function stepSeconds(n) {
    if (!file) return;
    video.currentTime = clamp(video.currentTime + n);
  }
  function seek(sec, { pause = true } = {}) {
    if (!file || sec == null) return;
    if (pause) video.pause();
    video.currentTime = clamp(sec);
    tick();
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    const timed = markers.filter((m) => m.timecode != null);
    countLabel.textContent = `${timed.length} 条`;
    const dur = video.duration;
    if (!dur) return;
    for (const m of timed) {
      const left = Math.min(100, Math.max(0, (m.timecode / dur) * 100));
      markerLayer.append(h('button', {
        class: `player__marker${m.active ? ' is-active' : ''}`, type: 'button',
        style: { left: `${left}%` },
        title: `第 ${m.seq} 条 · ${fmtTimecode(m.timecode, currentFps)}`,
        'aria-label': `定位到第 ${m.seq} 条意见`,
        onClick: (e) => { e.stopPropagation(); seek(m.timecode, { pause: true }); onSeekMarker(m.id); },
      }, String(m.seq)));
    }
  }

  function setMarkers(list) { markers = list || []; renderMarkers(); }
  function setFps(v) { currentFps = v; fpsLabel.textContent = `${v}fps`; tick(); renderMarkers(); }

  function loadFile(f) {
    file = f;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(f);
    video.src = objectUrl;
    empty.hidden = true;
    controls.hidden = false;
    root.focus({ preventScroll: true });
    onFileChosen(f);
  }
  /** 播放后端托管的视频 */
  function loadUrl(url, { name = '托管视频' } = {}) {
    file = { name, hosted: true };
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    video.src = url;
    empty.hidden = true;
    controls.hidden = false;
  }
  function clear() {
    file = null;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    stage.style.aspectRatio = '';
    markers = [];
    renderMarkers();
    empty.hidden = false;
    controls.hidden = true;
  }
  /** 空态里的按钮区（由页面决定：上传 / 本地文件） */
  function setEmptyActions(nodes) { emptyActions.replaceChildren(...nodes.filter(Boolean)); }
  function setEmptyText({ title, hint }) { if (title) emptyTitle.textContent = title; if (hint != null) emptyHint.textContent = hint; }

  /** 抓当前帧 → canvas（原始分辨率，最长边 ≤ maxEdge） */
  function captureFrame(maxEdge = 1280) {
    if (!file || !video.videoWidth) return null;
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  /** 把舞台与控制条位置借给标记编辑器；返回归还函数 */
  function borrowStage({ stage: node, bar }) {
    video.hidden = true; empty.hidden = true; controls.hidden = true;
    root.classList.add('player--markup');
    stage.append(node);
    root.append(bar);
    return () => {
      node.remove(); bar.remove();
      root.classList.remove('player--markup');
      video.hidden = false;
      empty.hidden = !!file;
      controls.hidden = !file;
      root.focus({ preventScroll: true });
    };
  }

  const onTheaterKey = (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.modal-backdrop, .markup')) return; // 弹层/标记层自己处理 Esc
    setTheater(false);
  };
  function setTheater(on) {
    root.classList.toggle('player--theater', on);
    document.body.classList.toggle('theater-open', on);
    theaterBtn.textContent = on ? '退出大屏' : '大屏';
    document.removeEventListener('keydown', onTheaterKey);
    if (on) document.addEventListener('keydown', onTheaterKey);
  }

  function setExpected({ name, size } = {}) {
    if (name) emptyHint.textContent = `这一版的文件是「${name}」（${size ? fmtBytes(size) : '大小未知'}）。`;
  }

  return {
    el: root, video,
    loadFile, loadUrl, clear, setEmptyActions, setEmptyText, seek, stepFrames, stepSeconds, setMarkers, setFps, setTheater, captureFrame, setExpected, borrowStage,
    currentTime: () => video.currentTime || 0,
    hasFile: () => !!file,
    isHosted: () => !!(file && file.hosted),
    file: () => file,
    pause: () => video.pause(),
  };
}

export { pad };
