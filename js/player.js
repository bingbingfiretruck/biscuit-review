// 播放器：本地文件、逐帧、时间码、进度条意见标记、大屏模式。
import { h, fmtTimecode, pad } from './util.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function createPlayer(root, { fps = 30, onTime = () => {}, onSeekMarker = () => {}, onFileChosen = () => {} } = {}) {
  let currentFps = fps;
  let markers = [];
  let objectUrl = null;
  let file = null;

  const video = h('video', { class: 'player__video', playsinline: true, preload: 'metadata', 'aria-label': '当前客稿视频' });
  const markerLayer = h('div', { class: 'player__markers', 'aria-label': '意见标记' });
  const range = h('input', { class: 'player__range', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': '视频时间线' });
  const timeLabel = h('span', { class: 'player__time mono' }, '00:00.00');
  const durLabel = h('span', { class: 'player__dur mono' }, '00:00.00');
  const playBtn = h('button', { class: 'player__btn player__btn--play', type: 'button', 'aria-label': '播放', onClick: togglePlay }, '▶');
  const speedBtn = h('button', { class: 'player__btn player__btn--text', type: 'button', 'aria-label': '播放速度', onClick: cycleSpeed }, '1×');
  const theaterBtn = h('button', { class: 'player__btn player__btn--text', type: 'button', 'aria-label': '大屏审片', onClick: () => setTheater(!root.classList.contains('player--theater')) }, '大屏');
  const fileInput = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', class: 'vh', id: 'player-file', onChange: (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; } });
  const emptyTitle = h('div', { class: 'player__empty-title' }, '选择客稿视频');
  const emptyHint = h('div', { class: 'player__empty-hint' }, '视频只在这台设备上播放，不会上传。');
  const empty = h('div', { class: 'player__empty' },
    h('div', { class: 'player__empty-icon', 'aria-hidden': 'true' }, '🎬'),
    emptyTitle, emptyHint,
    h('label', { class: 'btn btn--primary', for: 'player-file' }, '选择客稿视频'),
    fileInput);

  const controls = h('div', { class: 'player__controls' },
    h('div', { class: 'player__timeline' }, range, markerLayer),
    h('div', { class: 'player__row' },
      h('div', { class: 'player__group' },
        playBtn,
        h('button', { class: 'player__btn player__btn--text', type: 'button', title: '后退 3 秒（Shift+←）', onClick: () => stepSeconds(-3) }, '−3s'),
        h('button', { class: 'player__btn player__btn--text', type: 'button', title: '后退一帧（←）', onClick: () => stepFrames(-1) }, '−1帧'),
        h('button', { class: 'player__btn player__btn--text', type: 'button', title: '前进一帧（→）', onClick: () => stepFrames(1) }, '+1帧'),
        h('button', { class: 'player__btn player__btn--text', type: 'button', title: '前进 3 秒（Shift+→）', onClick: () => stepSeconds(3) }, '+3s')),
      h('div', { class: 'player__group player__group--time' }, timeLabel, h('span', { class: 'player__sep' }, '/'), durLabel),
      h('div', { class: 'player__group' }, speedBtn, theaterBtn,
        h('label', { class: 'player__btn player__btn--text', for: 'player-file', title: '换一个文件' }, '换文件'))));

  const stage = h('div', { class: 'player__stage' }, video, empty);
  root.classList.add('player');
  root.append(stage, controls);
  controls.hidden = true;

  // ---- 事件 ----
  video.addEventListener('loadedmetadata', () => {
    durLabel.textContent = fmtTimecode(video.duration, currentFps);
    renderMarkers();
    tick();
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', tick);
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', '暂停'); });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', '播放'); });
  video.addEventListener('click', togglePlay);
  video.addEventListener('error', () => { emptyTitle.textContent = '视频暂时无法播放'; emptyHint.textContent = '当前浏览器不支持这个格式，试试 MP4（H.264）。'; empty.hidden = false; controls.hidden = true; });

  let scrubbing = false;
  range.addEventListener('input', () => { scrubbing = true; const t = (range.value / 1000) * (video.duration || 0); video.currentTime = t; timeLabel.textContent = fmtTimecode(t, currentFps); });
  range.addEventListener('change', () => { scrubbing = false; tick(); });

  root.addEventListener('keydown', (e) => {
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
      timeLabel.textContent = fmtTimecode(t, currentFps);
      onTime(t, video.paused);
    });
  }

  function togglePlay() {
    if (!file) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function cycleSpeed() {
    const i = SPEEDS.indexOf(video.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    video.playbackRate = next;
    speedBtn.textContent = `${next}×`;
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
    const dur = video.duration;
    if (!dur) return;
    for (const m of markers) {
      if (m.timecode == null) continue;
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
  function setFps(v) { currentFps = v; durLabel.textContent = fmtTimecode(video.duration || 0, currentFps); tick(); renderMarkers(); }

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

  function setTheater(on) {
    root.classList.toggle('player--theater', on);
    document.body.classList.toggle('theater-open', on);
    theaterBtn.textContent = on ? '退出大屏' : '大屏';
    if (on) {
      const onKey = (e) => { if (e.key === 'Escape') { setTheater(false); document.removeEventListener('keydown', onKey); } };
      document.addEventListener('keydown', onKey);
    }
  }

  function setExpected({ name, size } = {}) {
    if (name) emptyHint.textContent = `请选择剪辑师发来的「${name}」（${size ? formatSize(size) : ''}）。视频只在这台设备上播放，不会上传。`;
  }
  function formatSize(n) { return n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 / 1024)} MB`; }

  return {
    el: root, video,
    loadFile, seek, stepFrames, stepSeconds, setMarkers, setFps, setTheater, captureFrame, setExpected,
    currentTime: () => video.currentTime || 0,
    hasFile: () => !!file,
    file: () => file,
    pause: () => video.pause(),
  };
}

export { pad };
