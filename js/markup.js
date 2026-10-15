// 画面标记：在抓到的视频帧上画笔/箭头/矩形/椭圆/文字，导出大图与缩略图。
import { h, shrinkToDataUrl } from './util.js';

const COLORS = ['#ff5a73', '#ffd43b', '#4ade80', '#60a5fa', '#ffffff', '#111111'];
const TOOLS = [
  ['pen', '画笔'], ['arrow', '箭头'], ['rect', '矩形'], ['ellipse', '椭圆'], ['text', '文字'],
];

/**
 * openMarkup({ baseCanvas, initialStrokes, onDone({ full, thumb, strokes }), onCancel })
 * 坐标全部以画布像素存储，便于重新编辑。
 */
export function openMarkup({ baseCanvas, initialStrokes = [], onDone, onCancel }) {
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  const lineWidth = Math.max(3, Math.round(Math.max(W, H) / 220));
  const fontSize = Math.max(18, Math.round(Math.max(W, H) / 32));

  let strokes = initialStrokes.map((s) => ({ ...s, points: s.points ? s.points.map((p) => [...p]) : undefined }));
  let tool = 'pen';
  let color = COLORS[0];
  let drawing = null;

  const canvas = h('canvas', { class: 'markup__canvas', width: W, height: H, 'aria-label': '画面标记绘图区' });
  const ctx = canvas.getContext('2d');
  const textInput = h('input', { class: 'markup__text input', type: 'text', placeholder: '输入文字标记，回车放置', hidden: true, 'aria-label': '文字标记输入区' });

  const toolBtns = TOOLS.map(([id, label]) => h('button', {
    class: `markup__tool${id === tool ? ' is-active' : ''}`, type: 'button', dataset: { tool: id },
    onClick: () => selectTool(id),
  }, label));
  const colorBtns = COLORS.map((c) => h('button', {
    class: `markup__color${c === color ? ' is-active' : ''}`, type: 'button', style: { background: c },
    'aria-label': `使用颜色 ${c}`, onClick: () => selectColor(c),
  }));
  const undoBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: undo }, '撤销');
  const clearBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => { strokes = []; redraw(); } }, '清空');

  const layer = h('div', { class: 'markup', role: 'dialog', 'aria-modal': 'true', 'aria-label': '在当前帧画标记' },
    h('div', { class: 'markup__bar' },
      h('div', { class: 'markup__tools' }, ...toolBtns),
      h('div', { class: 'markup__colors' }, ...colorBtns),
      h('div', { class: 'markup__actions' }, undoBtn, clearBtn,
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: cancel }, '取消'),
        h('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: done }, '完成'))),
    h('div', { class: 'markup__stage' }, h('div', { class: 'markup__frame', style: { aspectRatio: `${W} / ${H}` } }, canvas, textInput)),
    h('div', { class: 'markup__hint' }, '在画面上直接指出问题。文字工具：点一下画面定位，输入后回车。Esc 取消。'));

  document.body.append(layer);
  document.body.classList.add('markup-open');
  redraw();

  function selectTool(id) {
    tool = id;
    toolBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.tool === id));
    if (id !== 'text') hideText();
  }
  function selectColor(c) {
    color = c;
    colorBtns.forEach((b, i) => b.classList.toggle('is-active', COLORS[i] === c));
  }
  function undo() { strokes.pop(); redraw(); }

  // ---- 坐标 ----
  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }

  // ---- 指针 ----
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const [x, y] = toCanvas(e);
    if (tool === 'text') { showText(x, y); return; }
    canvas.setPointerCapture(e.pointerId);
    drawing = { tool, color, points: [[x, y]] };
    if (tool !== 'pen') drawing.points.push([x, y]);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const [x, y] = toCanvas(e);
    if (drawing.tool === 'pen') drawing.points.push([x, y]);
    else drawing.points[1] = [x, y];
    redraw();
  });
  const finish = (e) => {
    if (!drawing) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 可能已释放 */ }
    const s = drawing; drawing = null;
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const tiny = Math.hypot(b[0] - a[0], b[1] - a[1]) < 3 && s.points.length < 4;
    if (!tiny) strokes.push(s);
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // ---- 文字 ----
  let textPos = null;
  function showText(x, y) {
    textPos = [x, y];
    const r = canvas.getBoundingClientRect();
    const frame = canvas.parentElement.getBoundingClientRect();
    textInput.hidden = false;
    textInput.style.left = `${((x / W) * r.width) + (r.left - frame.left)}px`;
    textInput.style.top = `${((y / H) * r.height) + (r.top - frame.top)}px`;
    textInput.value = '';
    textInput.focus();
  }
  function hideText() { textInput.hidden = true; textPos = null; }
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const t = textInput.value.trim();
      if (t && textPos) strokes.push({ tool: 'text', color, points: [textPos], text: t });
      hideText(); redraw();
    } else if (e.key === 'Escape') { e.stopPropagation(); hideText(); }
  });
  textInput.addEventListener('blur', () => { if (!textInput.hidden && !textInput.value.trim()) hideText(); });

  // ---- 绘制 ----
  function redraw() {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(baseCanvas, 0, 0, W, H);
    for (const s of strokes) drawStroke(s);
    if (drawing) drawStroke(drawing);
  }
  function drawStroke(s) {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = lineWidth;
    const p = s.points;
    if (s.tool === 'pen') {
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.stroke();
    } else if (s.tool === 'rect') {
      const [[x1, y1], [x2, y2]] = p;
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.tool === 'ellipse') {
      const [[x1, y1], [x2, y2]] = p;
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.tool === 'arrow') {
      const [[x1, y1], [x2, y2]] = p;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = lineWidth * 4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    } else if (s.tool === 'text') {
      const [[x, y]] = p;
      ctx.font = `700 ${fontSize}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, lineWidth / 2);
      ctx.strokeStyle = s.color === '#ffffff' ? '#111' : '#fff';
      ctx.shadowBlur = 0;
      ctx.strokeText(s.text, x, y);
      ctx.fillText(s.text, x, y);
    }
    ctx.restore();
  }

  // ---- 完成 / 取消 ----
  function close() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('markup-open');
    layer.remove();
  }
  function done() {
    hideText();
    redraw();
    const full = shrinkToDataUrl(canvas, 1280, 0.82);
    const thumb = shrinkToDataUrl(canvas, 320, 0.7);
    close();
    onDone?.({ full, thumb, strokes });
  }
  function cancel() { close(); onCancel?.(); }
  const onKey = (e) => { if (e.key === 'Escape' && textInput.hidden) cancel(); };
  document.addEventListener('keydown', onKey);
}
