// 画面标记：借用播放器舞台原位编辑。工具：画笔/箭头/矩形/椭圆（下拉）、文字、移动画面、调整标记、缩放；
// 虚线、四色 + 调色、清空、撤销/重做、完成/取消。几何计算见 markup-geo.js。
import { h, shrinkToDataUrl } from './util.js';
import { fitRect, toCanvas, fromCanvas, zoomAround, strokeBounds, hitTest, translate } from './markup-geo.js';

const COLORS = ['#ff3b5c', '#ffd60a', '#3da9fc', '#ffffff'];
const SHAPES = [['pen', '画笔'], ['arrow', '箭头'], ['rect', '矩形'], ['ellipse', '椭圆']];
const SHAPE_NAME = Object.fromEntries(SHAPES);
const HISTORY_MAX = 50;
const cloneStroke = (s) => ({ ...s, points: s.points.map((p) => [...p]) });

/**
 * openMarkup({ player, baseCanvas, initialStrokes, onDone({ full, thumb, strokes }), onCancel })
 * 标记坐标以画布像素存储；view 只影响显示与指针换算，导出时忽略。
 */
export function openMarkup({ player, baseCanvas, initialStrokes = [], onDone, onCancel }) {
  const W = baseCanvas.width;
  const H = baseCanvas.height;
  const lineWidth = Math.max(3, Math.round(Math.max(W, H) / 220));
  const fontSize = Math.max(18, Math.round(Math.max(W, H) / 32));
  const font = `700 ${fontSize}px ${getComputedStyle(document.body).fontFamily}`;

  const st = {
    strokes: initialStrokes.map(cloneStroke), history: [], future: [],
    view: { scale: 1, tx: 0, ty: 0 },
    tool: 'pen', shape: 'pen', dashed: false, color: COLORS[0], custom: null,
    selected: -1, drawing: null, drag: null, textPos: null,
  };

  // ---- DOM ----
  const canvas = h('canvas', { class: 'mk__canvas', width: W, height: H, 'aria-label': '画面标记绘图区' });
  const ctx = canvas.getContext('2d');
  const textInput = h('input', { class: 'mk__text input', type: 'text', placeholder: '输入文字，回车放置', hidden: true, 'aria-label': '文字标记输入区' });
  const layer = h('div', { class: 'mk' }, canvas, textInput);
  const ui = buildBar();
  const release = player.borrowStage({ stage: layer, bar: ui.bar });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDocDown, true);
  sync();
  redraw();

  function buildBar() {
    const btn = (label, attrs, onClick) => h('button', { class: 'mk-btn', type: 'button', ...attrs, onClick }, label);
    const shapeBtn = btn('', { 'aria-haspopup': 'menu', title: '选择画笔形状' }, () => { ui.menu.hidden = !ui.menu.hidden; });
    const menu = h('div', { class: 'mk-menu', role: 'menu', hidden: true },
      ...SHAPES.map(([id, name]) => h('button', { type: 'button', role: 'menuitem', dataset: { shape: id }, onClick: () => { setShape(id); hideMenu(); } }, name)));
    const colorBtns = COLORS.map((c) => h('button', { class: 'mk-color', type: 'button', style: { background: c }, 'aria-label': `颜色 ${c}`, onClick: () => setColor(c) }));
    const customBtn = h('button', { class: 'mk-color', type: 'button', hidden: true, 'aria-label': '自定义颜色', onClick: () => setColor(st.custom) });
    const picker = h('input', { type: 'color', class: 'vh', value: COLORS[0], 'aria-label': '调色', onInput: (e) => { st.custom = e.target.value; setColor(st.custom); } });
    const parts = {
      bar: null, shapeBtn, menu, colorBtns, customBtn,
      textBtn: btn('文字', {}, () => setTool('text')),
      panBtn: btn('移动画面', {}, () => setTool('pan')),
      adjustBtn: btn('调整标记', { title: '点选一条标记后拖动；Delete 删除' }, () => setTool('adjust')),
      zoomLabel: h('span', { class: 'mk-zoom', 'aria-live': 'polite' }, '100%'),
      dashBtn: btn('虚线', { 'aria-pressed': 'false' }, () => { st.dashed = !st.dashed; sync(); }),
      undoBtn: btn('撤销', {}, undo),
      redoBtn: btn('重做', {}, redo),
    };
    parts.bar = h('div', { class: 'mk-bar', role: 'toolbar', 'aria-label': '画面标记工具' },
      h('div', { class: 'mk-row' },
        h('div', { class: 'mk-shape' }, shapeBtn, menu), parts.textBtn, parts.panBtn, parts.adjustBtn,
        btn('−', { 'aria-label': '缩小' }, () => zoom(1 / 1.25)), parts.zoomLabel, btn('+', { 'aria-label': '放大' }, () => zoom(1.25))),
      h('div', { class: 'mk-row' },
        parts.dashBtn, ...colorBtns, customBtn, btn('调色', {}, () => picker.click()), picker,
        btn('清空', {}, clearAll), parts.undoBtn, parts.redoBtn,
        h('button', { class: 'mk-btn mk-btn--primary', type: 'button', onClick: done }, '完成'),
        btn('取消', {}, cancel)));
    return parts;
  }

  // ---- 工具状态 ----
  function isShapeTool() { return Object.hasOwn(SHAPE_NAME, st.tool); }
  function sync() {
    ui.shapeBtn.replaceChildren(SHAPE_NAME[st.shape], h('span', { class: 'mk-caret', 'aria-hidden': 'true' }, '▾'));
    ui.shapeBtn.classList.toggle('is-active', isShapeTool());
    ui.textBtn.classList.toggle('is-active', st.tool === 'text');
    ui.panBtn.classList.toggle('is-active', st.tool === 'pan');
    ui.adjustBtn.classList.toggle('is-active', st.tool === 'adjust');
    ui.dashBtn.classList.toggle('is-active', st.dashed);
    ui.dashBtn.setAttribute('aria-pressed', String(st.dashed));
    ui.colorBtns.forEach((b, i) => b.classList.toggle('is-active', COLORS[i] === st.color));
    ui.customBtn.hidden = !st.custom;
    if (st.custom) { ui.customBtn.style.background = st.custom; ui.customBtn.classList.toggle('is-active', st.color === st.custom); }
    ui.undoBtn.disabled = !st.history.length;
    ui.redoBtn.disabled = !st.future.length;
    ui.zoomLabel.textContent = `${Math.round(st.view.scale * 100)}%`;
    for (const item of ui.menu.children) item.classList.toggle('is-active', item.dataset.shape === st.shape);
    layer.className = `mk mk--${st.tool}`;
  }
  function setTool(t) {
    st.tool = t;
    if (t !== 'text') hideText();
    if (t !== 'adjust') st.selected = -1;
    sync();
    redraw();
  }
  function setShape(id) { st.shape = id; setTool(id); }
  function setColor(c) {
    st.color = c;
    if (st.tool === 'adjust' && st.selected >= 0) { pushHistory(); st.strokes[st.selected] = { ...st.strokes[st.selected], color: c }; redraw(); }
    sync();
  }
  function hideMenu() { ui.menu.hidden = true; }
  function onDocDown(e) { if (!ui.menu.hidden && !ui.menu.contains(e.target) && !ui.shapeBtn.contains(e.target)) hideMenu(); }

  // ---- 坐标：事件 → 未缩放画布像素 → 画布坐标 ----
  function contentBox() { const r = canvas.getBoundingClientRect(); return { r, f: fitRect(r.width, r.height, W, H) }; }
  function toPx(e) { const { r, f } = contentBox(); return [(e.clientX - r.left - f.x) / f.k, (e.clientY - r.top - f.y) / f.k]; }
  function pt(e) { const [px, py] = toPx(e); return toCanvas(st.view, px, py); }
  function textSize(s) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = font;
    const w = ctx.measureText(s.text).width;
    ctx.restore();
    return { w, h: fontSize * 1.2 };
  }

  // ---- 指针 ----
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    hideMenu();
    const [x, y] = pt(e);
    if (st.tool === 'text') { showText(x, y); return; }
    if (st.drawing || st.drag) return; // 已有一根手指在操作
    canvas.setPointerCapture(e.pointerId);
    if (st.tool === 'pan') { st.drag = { id: e.pointerId, kind: 'pan', start: toPx(e), view: { ...st.view } }; return; }
    if (st.tool === 'adjust') { startAdjust(e, x, y); return; }
    st.drawing = { tool: st.tool, color: st.color, dashed: st.dashed, pointerId: e.pointerId, points: [[x, y]] };
    if (st.tool !== 'pen') st.drawing.points.push([x, y]);
  });
  function startAdjust(e, x, y) {
    const i = hitTest(st.strokes, x, y, (lineWidth * 3) / st.view.scale, textSize);
    st.selected = i;
    if (i >= 0) st.drag = { id: e.pointerId, kind: 'move', start: [x, y], origin: st.strokes[i], moved: false };
    redraw();
  }
  canvas.addEventListener('pointermove', (e) => {
    if (st.drag && e.pointerId === st.drag.id) { dragMove(e); return; }
    if (!st.drawing || e.pointerId !== st.drawing.pointerId) return;
    const p = pt(e);
    if (st.drawing.tool === 'pen') st.drawing.points.push(p);
    else st.drawing.points[1] = p;
    redraw();
  });
  function dragMove(e) {
    const d = st.drag;
    if (d.kind === 'pan') {
      const [px, py] = toPx(e);
      st.view = { ...d.view, tx: d.view.tx + (px - d.start[0]), ty: d.view.ty + (py - d.start[1]) };
    } else {
      const [x, y] = pt(e);
      if (!d.moved) { d.moved = true; pushHistory(); }
      st.strokes[st.selected] = translate(d.origin, x - d.start[0], y - d.start[1]);
    }
    redraw();
  }
  function finish(e) {
    if (st.drag && e.pointerId === st.drag.id) { releaseCapture(e); st.drag = null; return; }
    if (!st.drawing || e.pointerId !== st.drawing.pointerId) return;
    releaseCapture(e);
    const s = st.drawing;
    st.drawing = null;
    if (s.tool !== 'pen' && e.type === 'pointerup') s.points[1] = pt(e);
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const tiny = Math.hypot(b[0] - a[0], b[1] - a[1]) < 3 && s.points.length < 4;
    if (!tiny) { pushHistory(); st.strokes.push({ tool: s.tool, color: s.color, dashed: s.dashed, points: s.points }); }
    redraw();
  }
  function releaseCapture(e) { try { canvas.releasePointerCapture(e.pointerId); } catch { /* 可能已释放 */ } }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // ---- 文字 ----
  function showText(x, y) {
    st.textPos = [x, y];
    const { f } = contentBox();
    const [px, py] = fromCanvas(st.view, x, y);
    textInput.hidden = false;
    textInput.style.left = `${f.x + px * f.k}px`;
    textInput.style.top = `${f.y + py * f.k}px`;
    textInput.value = '';
    textInput.focus();
  }
  function hideText() { textInput.hidden = true; st.textPos = null; }
  function commitText() {
    const t = textInput.value.trim();
    if (t && st.textPos) { pushHistory(); st.strokes.push({ tool: 'text', color: st.color, dashed: false, points: [st.textPos], text: t }); }
    hideText();
    redraw();
  }
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { e.stopPropagation(); hideText(); }
  });
  textInput.addEventListener('blur', () => { if (!textInput.hidden && !textInput.value.trim()) hideText(); });

  // ---- 历史 / 缩放 / 清空 ----
  function pushHistory() {
    st.history.push(JSON.stringify(st.strokes));
    if (st.history.length > HISTORY_MAX) st.history.shift();
    st.future = [];
    sync();
  }
  function undo() {
    if (!st.history.length) return;
    st.future.push(JSON.stringify(st.strokes));
    st.strokes = JSON.parse(st.history.pop());
    st.selected = -1; sync(); redraw();
  }
  function redo() {
    if (!st.future.length) return;
    st.history.push(JSON.stringify(st.strokes));
    st.strokes = JSON.parse(st.future.pop());
    st.selected = -1; sync(); redraw();
  }
  function clearAll() { if (!st.strokes.length) return; pushHistory(); st.strokes = []; st.selected = -1; redraw(); }
  function zoom(factor) { st.view = zoomAround(st.view, factor, W / 2, H / 2); sync(); redraw(); }

  // ---- 绘制 ----
  function redraw() { paint(ctx, true); }
  function paint(c, withView) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    if (withView) c.setTransform(st.view.scale, 0, 0, st.view.scale, st.view.tx, st.view.ty);
    c.drawImage(baseCanvas, 0, 0, W, H);
    st.strokes.forEach((s, i) => drawStroke(c, s, withView && i === st.selected));
    if (st.drawing) drawStroke(c, st.drawing, false);
  }
  function drawStroke(c, s, selected) {
    c.save();
    c.strokeStyle = s.color; c.fillStyle = s.color;
    c.lineWidth = lineWidth; c.lineCap = 'round'; c.lineJoin = 'round';
    c.setLineDash(s.dashed ? [lineWidth * 3, lineWidth * 2] : []);
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = lineWidth;
    if (s.tool === 'pen') drawPath(c, s.points);
    else if (s.tool === 'rect') drawRect(c, s.points);
    else if (s.tool === 'ellipse') drawEllipse(c, s.points);
    else if (s.tool === 'arrow') drawArrow(c, s.points);
    else if (s.tool === 'text') drawText(c, s);
    c.restore();
    if (selected) drawSelection(c, s);
  }
  function drawPath(c, p) {
    c.beginPath(); c.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
    c.stroke();
  }
  function drawRect(c, [[x1, y1], [x2, y2]]) { c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
  function drawEllipse(c, [[x1, y1], [x2, y2]]) {
    c.beginPath();
    c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    c.stroke();
  }
  function drawArrow(c, [[x1, y1], [x2, y2]]) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = lineWidth * 4;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.moveTo(x2, y2);
    c.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
    c.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
    c.closePath(); c.fill();
  }
  function drawText(c, s) {
    const [[x, y]] = s.points;
    c.font = font; c.textBaseline = 'top';
    c.setLineDash([]); c.lineWidth = Math.max(2, lineWidth / 2);
    c.strokeStyle = s.color.toLowerCase() === '#ffffff' ? '#111' : '#fff';
    c.shadowBlur = 0;
    c.strokeText(s.text, x, y);
    c.fillText(s.text, x, y);
  }
  function drawSelection(c, s) {
    const b = strokeBounds(s, textSize);
    const pad = lineWidth;
    c.save();
    c.setLineDash([6 / st.view.scale, 4 / st.view.scale]);
    c.lineWidth = 1.5 / st.view.scale; c.strokeStyle = '#fff';
    c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 2;
    c.strokeRect(b.x1 - pad, b.y1 - pad, b.x2 - b.x1 + pad * 2, b.y2 - b.y1 + pad * 2);
    c.restore();
  }

  // ---- 键盘 / 完成 / 取消 ----
  function onKey(e) {
    if (e.key === 'Escape') {
      if (!textInput.hidden) return; // 文字框自己处理
      e.stopImmediatePropagation();
      if (!ui.menu.hidden) { hideMenu(); return; }
      cancel();
      return;
    }
    const typing = e.target.matches?.('input, textarea, select');
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.tool === 'adjust' && st.selected >= 0 && !typing) {
      e.preventDefault();
      pushHistory(); st.strokes.splice(st.selected, 1); st.selected = -1; redraw();
    }
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDocDown, true);
    release();
  }
  function done() {
    hideText();
    st.selected = -1;
    paint(ctx, false);
    const full = shrinkToDataUrl(canvas, 1280, 0.82);
    const thumb = shrinkToDataUrl(canvas, 320, 0.7);
    close();
    onDone?.({ full, thumb, strokes: st.strokes });
  }
  function cancel() { close(); onCancel?.(); }
}
