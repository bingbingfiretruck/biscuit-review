# 写意见区与标记编辑器重排 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 审片页写意见区按参考站重排（并排入口按钮、内嵌时间码/字数的输入框、并排「确认本版通过 / 提交意见」），标记编辑器改为播放器原位编辑并补齐全套工具条。

**Architecture:** 纯前端改动，后端与接口不变。写意见卡抽成 `js/composer.js`（原地读写 `review.js` 持有的 `state.draft`）；`js/markup.js` 重写为借用播放器舞台的内联编辑器，几何计算放 `js/markup-geo.js` 并用 `node --test` 单测；`player.js` 只新增「借舞台 / 还舞台」接口。

**Tech Stack:** 原生 ES Module、Canvas 2D、Pointer Events、`node --test`（Node 22）、本地 wrangler dev + python http.server 预览。

设计稿：`docs/superpowers/specs/2026-10-19-composer-markup-design.md`

---

## 1. 文件结构

```
js/markup-geo.js        新建：纯几何函数（无 DOM）
test/markup-geo.test.mjs 新建：node --test
js/player.js            改：borrowStage / 编辑中屏蔽快捷键
js/markup.js            重写：内联编辑器
js/composer.js          新建：写意见内卡
js/review.js            改：接 composer、状态卡/页头文案、startMarkup 走 borrowStage
css/review.css          改：composer 与工具条样式，删全屏 .markup
```

接口约定（后面任务都按这个来）：

```js
// js/markup-geo.js
fitRect(boxW, boxH, W, H)            → { x, y, w, h, k }      // 画布在元素盒内 object-fit:contain 的内容框，k = w/W
toCanvas(view, px, py)               → [x, y]                  // 内容框像素 → 画布坐标（逆视图）
fromCanvas(view, x, y)               → [px, py]
clampScale(s)                        → 0.5 … 4
zoomAround(view, factor, cx, cy)     → 新 view，(cx,cy) 为内容框像素中的不动点
strokeBounds(s, textSize)            → { x1, y1, x2, y2 }     // textSize(s) → { w, h }，文字用
hitTest(strokes, x, y, tol, textSize) → 命中的最高层下标或 -1
translate(s, dx, dy)                 → 新 stroke

// js/player.js
player.borrowStage({ stage, bar })    → release()               // 隐藏 video/空态/控制条，挂入 stage 与 bar

// js/markup.js
openMarkup({ player, baseCanvas, initialStrokes, onDone({ full, thumb, strokes }), onCancel })

// js/composer.js
createComposer({ player, draft, fps(), maxAttachments, attachmentMaxEdge, onSubmit(), onApprove(), onMarkup(edit) })
  → { el, refresh(), syncTime(), setSubmitting(on), setMarkupOpen(on) }
```

---

### Task 1: 几何纯函数 + 单测

**Files:**
- Create: `js/markup-geo.js`
- Test: `test/markup-geo.test.mjs`

- [ ] **Step 1: 写失败的测试**

```js
// test/markup-geo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRect, toCanvas, fromCanvas, clampScale, zoomAround, strokeBounds, hitTest, translate } from '../js/markup-geo.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('fitRect：横图在竖盒里上下留黑边', () => {
  const r = fitRect(100, 200, 160, 90);
  near(r.w, 100); near(r.h, 56.25); near(r.x, 0); near(r.y, 71.875); near(r.k, 0.625);
});
test('toCanvas / fromCanvas 互逆，带缩放平移', () => {
  const view = { scale: 2, tx: 10, ty: -5 };
  const [x, y] = toCanvas(view, 110, 95);
  near(x, 50); near(y, 50);
  const [px, py] = fromCanvas(view, x, y);
  near(px, 110); near(py, 95);
});
test('clampScale 限制在 0.5–4', () => {
  assert.equal(clampScale(0.1), 0.5); assert.equal(clampScale(9), 4); assert.equal(clampScale(1.25), 1.25);
});
test('zoomAround 保持不动点', () => {
  const view = { scale: 1, tx: 0, ty: 0 };
  const v2 = zoomAround(view, 2, 100, 50);
  assert.equal(v2.scale, 2);
  const [x, y] = toCanvas(v2, 100, 50);
  near(x, 100); near(y, 50);
});
test('strokeBounds：线段与文字', () => {
  const b = strokeBounds({ tool: 'arrow', points: [[10, 20], [30, 5]] });
  assert.deepEqual(b, { x1: 10, y1: 5, x2: 30, y2: 20 });
  const t = strokeBounds({ tool: 'text', points: [[5, 5]], text: 'ab' }, () => ({ w: 40, h: 20 }));
  assert.deepEqual(t, { x1: 5, y1: 5, x2: 45, y2: 25 });
});
test('hitTest：画笔按线段距离，矩形按包围盒，最高层优先', () => {
  const strokes = [
    { tool: 'pen', points: [[0, 0], [100, 0]] },
    { tool: 'rect', points: [[40, -10], [60, 10]] },
  ];
  assert.equal(hitTest(strokes, 50, 3, 5), 1);
  assert.equal(hitTest(strokes, 10, 3, 5), 0);
  assert.equal(hitTest(strokes, 10, 30, 5), -1);
});
test('translate 平移所有点且不改原对象', () => {
  const s = { tool: 'pen', color: '#fff', points: [[1, 1], [2, 2]] };
  const t = translate(s, 5, -1);
  assert.deepEqual(t.points, [[6, 0], [7, 1]]);
  assert.deepEqual(s.points, [[1, 1], [2, 2]]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/`
Expected: 全部 fail（`Cannot find module '../js/markup-geo.js'`）

- [ ] **Step 3: 实现**

```js
// js/markup-geo.js —— 标记编辑器的纯几何：不碰 DOM，便于单测。
export function fitRect(boxW, boxH, W, H) {
  const k = Math.min(boxW / W, boxH / H);
  const w = W * k; const h = H * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, k };
}
export function toCanvas(view, px, py) { return [(px - view.tx) / view.scale, (py - view.ty) / view.scale]; }
export function fromCanvas(view, x, y) { return [x * view.scale + view.tx, y * view.scale + view.ty]; }
export function clampScale(s) { return Math.min(4, Math.max(0.5, s)); }
export function zoomAround(view, factor, cx, cy) {
  const scale = clampScale(view.scale * factor);
  const r = scale / view.scale;
  return { scale, tx: cx - (cx - view.tx) * r, ty: cy - (cy - view.ty) * r };
}
export function strokeBounds(s, textSize = () => ({ w: 0, h: 0 })) {
  if (s.tool === 'text') {
    const [[x, y]] = s.points; const { w, h } = textSize(s);
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }
  const xs = s.points.map((p) => p[0]); const ys = s.points.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function hitsStroke(s, x, y, tol, textSize) {
  if (s.tool === 'pen' || s.tool === 'arrow') {
    for (let i = 1; i < s.points.length; i++) if (segDist(x, y, s.points[i - 1], s.points[i]) <= tol) return true;
    return s.points.length === 1 && Math.hypot(x - s.points[0][0], y - s.points[0][1]) <= tol;
  }
  const b = strokeBounds(s, textSize);
  return x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol;
}
export function hitTest(strokes, x, y, tol, textSize) {
  for (let i = strokes.length - 1; i >= 0; i--) if (hitsStroke(strokes[i], x, y, tol, textSize)) return i;
  return -1;
}
export function translate(s, dx, dy) { return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy]) }; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/`
Expected: `# pass 7`、`# fail 0`

- [ ] **Step 5: 提交**

```bash
git add js/markup-geo.js test/markup-geo.test.mjs
git commit -m "feat: 标记编辑器几何纯函数与单测"
```

---

### Task 2: 播放器借还舞台

**Files:**
- Modify: `js/player.js`

- [ ] **Step 1: 在 `setTheater` 之前加 `borrowStage`**

```js
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
```

- [ ] **Step 2: 快捷键在编辑中不响应**

`root.addEventListener('keydown', …)` 第一行加：`if (root.classList.contains('player--markup')) return;`

- [ ] **Step 3: 导出**

返回对象里加 `borrowStage`。

- [ ] **Step 4: 提交**

```bash
git add js/player.js
git commit -m "feat: 播放器提供 borrowStage 给标记编辑器"
```

---

### Task 3: 重写 js/markup.js（内联编辑器）

**Files:**
- Rewrite: `js/markup.js`
- Modify: `css/review.css`（`/* ===== 画面标记层 ===== */` 整段替换）

状态：`strokes[]`、`history[]`、`future[]`（快照字符串，上限 50）、`view = {scale:1,tx:0,ty:0}`、`tool`（`pen|arrow|rect|ellipse|text|pan|adjust`）、`shape`（最近一次选的形状，决定「画笔˅」按钮文字）、`dashed`、`color`、`custom`（调色结果）、`selected`（调整标记选中的下标）、`drawing`（进行中的笔画）、`dragging`（平移或移动标记时的起点）。

- [ ] **Step 1: DOM**

`layer = h('div', { class: 'mk' }, canvas, textInput, selectionBox?)`：`canvas` 为 `mk__canvas`（`position:absolute; inset:0; width:100%; height:100%; object-fit:contain; touch-action:none`），`textInput` 绝对定位。
`bar = h('div', { class: 'mk-bar' }, row1, row2)`：
- row1：`shapeBtn`（文字 = 形状名 + ˅，点开 `mk-menu`，四项 画笔/箭头/矩形/椭圆）、`textBtn`、`panBtn`、`adjustBtn`、`zoomOut`、`zoomLabel`、`zoomIn`。
- row2：`dashBtn`、四个 `mk-color`（`#ff3b5c` `#ffd60a` `#3da9fc` `#ffffff`）、`customSwatch`（有调色结果才显示）、`pickBtn`（触发隐藏的 `<input type="color">`）、`clearBtn`、`undoBtn`、`redoBtn`、`doneBtn`、`cancelBtn`。
`release = player.borrowStage({ stage: layer, bar })`。

- [ ] **Step 2: 指针换算**

```js
function toCanvasPx(e) {               // 事件 → 内容框像素
  const r = canvas.getBoundingClientRect();
  const f = fitRect(r.width, r.height, W, H);
  return [((e.clientX - r.left - f.x) / f.k), ((e.clientY - r.top - f.y) / f.k)];
}
function pt(e) { const [px, py] = toCanvasPx(e); return toCanvas(view, px, py); }
```

- [ ] **Step 3: pointerdown / move / up 按工具分派**

- `pan`：记 `dragging = { px, py, tx, ty }`，move 时 `view.tx = tx + (npx - px)`（内容框像素单位已等于画布单位 ×scale，直接相加）。
- `adjust`：`selected = hitTest(strokes, x, y, tol, textSize)`；命中则 `pushHistory()` 并记起点，move 时 `strokes[selected] = translate(original, dx, dy)`；未命中则取消选中。
- `text`：`showText(x, y)`。
- 形状：与原实现相同，`drawing = { tool, color, dashed, points }`；完成时 `pushHistory(); strokes.push(s)`。

- [ ] **Step 4: 绘制**

```js
function paint(ctx, withView) {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  if (withView) ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
  ctx.drawImage(baseCanvas, 0, 0, W, H);
  strokes.forEach((s, i) => drawStroke(ctx, s, withView && i === selected));
  if (drawing) drawStroke(ctx, drawing, false);
}
```
`drawStroke` 在原实现基础上加 `ctx.setLineDash(s.dashed ? [lineWidth * 3, lineWidth * 2] : [])`，选中时用 `strokeBounds` 画一圈 1px 虚线框（`lineDashOffset` 不动）。

- [ ] **Step 5: 历史**

```js
function pushHistory() { history.push(JSON.stringify(strokes)); if (history.length > 50) history.shift(); future = []; syncButtons(); }
function undo() { if (!history.length) return; future.push(JSON.stringify(strokes)); strokes = JSON.parse(history.pop()); selected = -1; redraw(); }
function redo() { if (!future.length) return; history.push(JSON.stringify(strokes)); strokes = JSON.parse(future.pop()); selected = -1; redraw(); }
```
`syncButtons()` 更新 undo/redo disabled、工具高亮、虚线高亮、缩放文字、形状按钮文字。

- [ ] **Step 6: 缩放**

`zoomIn/Out`：`view = zoomAround(view, ±, cx, cy)`，不动点取内容框中心 `(f.w/2, f.h/2)`，用 `canvas.getBoundingClientRect()` 算 `f`。`zoomLabel.textContent = Math.round(view.scale*100)+'%'`。

- [ ] **Step 7: 文字输入定位**

`showText(x, y)`：`[px, py] = fromCanvas(view, x, y)`，再加内容框偏移 `f.x/f.y` 并乘 `f.k` 换成 CSS 像素；`textInput.style.left/top`。回车：`pushHistory(); strokes.push({ tool:'text', color, dashed:false, points:[[x,y]], text })`。

- [ ] **Step 8: 键盘**

`document` 捕获 keydown：Esc → 文字框打开则只关它，否则 `cancel()`；`Delete`/`Backspace` 且 `tool==='adjust' && selected>=0` 且焦点不在输入框 → `pushHistory(); strokes.splice(selected,1); selected=-1; redraw()`。

- [ ] **Step 9: 完成 / 取消**

`done()`：`hideText(); selected=-1; paint(ctx,false); full = shrinkToDataUrl(canvas,1280,.82); thumb = shrinkToDataUrl(canvas,320,.7); close(); onDone({ full, thumb, strokes })`。`cancel()`：`close(); onCancel?.()`。`close()`：移除 keydown、`release()`。

- [ ] **Step 10: CSS（替换 `.markup*`）**

```css
/* ===== 画面标记：播放器原位编辑 ===== */
.mk { position: absolute; inset: 0; background: #000; }
.mk__canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; touch-action: none; cursor: crosshair; display: block; }
.mk--pan .mk__canvas { cursor: grab; } .mk--adjust .mk__canvas { cursor: move; } .mk--text .mk__canvas { cursor: text; }
.mk__text { position: absolute; width: min(60%, 320px); transform: translate(0, -50%); line-height: 1.4; }
.mk-bar { display: grid; gap: 8px; padding: 10px 12px 12px; background: var(--player-bg); }
.mk-row { display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; }
.mk-btn { position: relative; min-height: 38px; padding: 0 14px; border-radius: 11px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: var(--player-fg); font-weight: 700; font-size: var(--fs-sm); cursor: pointer; }
.mk-btn:hover { background: rgba(255,255,255,.12); }
.mk-btn.is-active { background: #f2a7b6; border-color: #f2a7b6; color: #211d20; }
.mk-btn:disabled { opacity: .4; cursor: not-allowed; }
.mk-btn--primary { background: var(--pink-strong); border-color: transparent; color: var(--on-accent); }
.mk-menu { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 5; display: grid; min-width: 120px; padding: 6px; border-radius: 12px; background: #1c1719; border: 1px solid rgba(255,255,255,.14); box-shadow: var(--shadow-lg); }
.mk-menu button { text-align: left; padding: 8px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--player-fg); font-weight: 700; font-size: var(--fs-sm); cursor: pointer; }
.mk-menu button:hover, .mk-menu button.is-active { background: rgba(255,255,255,.1); }
.mk-color { width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); cursor: pointer; padding: 0; }
.mk-color.is-active { border-color: #fff; box-shadow: 0 0 0 2px #000, 0 0 0 4px #fff; }
.mk-zoom { min-width: 64px; text-align: center; font-family: var(--mono); color: #d9cbd0; font-size: var(--fs-sm); }
.player--markup .player__stage { cursor: default; }
```

- [ ] **Step 11: 提交**

```bash
git add js/markup.js css/review.css
git commit -m "feat: 标记编辑器改为播放器原位，补齐画笔下拉/移动/调整/缩放/虚线/调色/重做"
```

---

### Task 4: 新建 js/composer.js，review.js 接线

**Files:**
- Create: `js/composer.js`
- Modify: `js/review.js`（删 `buildWriteCard`、`updateTcDisplay`、`renderAnnoBox`、`handleAttachPick`、`renderAttachBox`、`tcDisplay`；`resetDraft` 改为清草稿后 `composer.refresh()`；`renderStatusCard` 填写中只留「本轮反馈结束」；`renderHeadSide` 文案；`startMarkup` 传 `player` 并 `composer.setMarkupOpen`）

- [ ] **Step 1: composer.js**

`createComposer(opts)` 内部：
- `markupBtn`、`attachBtn`（`label for=attachInput`，样式按钮）、`attachInput`（image/*，multiple，onChange → `pickAttachments`，逻辑同原 `handleAttachPick`）。
- `annoBox`（同原 `renderAnnoBox` 的预览分支）、`attachBox`（缩略图 + ✕，没有「＋ 参考图」占位）。
- `ta`（`maxlength=1000`，onInput → `draft.text`、`counter`、`syncSubmit()`）、`tcChip`（button，onClick → `draft.whole = !draft.whole; syncTime()`）、`counter`。
- `approveBtn`（onClick → `onApprove()`）、`submitBtn`（onClick → `onSubmit()`，`disabled = !hasContent()`）。
- `hint`。
- `refresh()`：`markupBtn.disabled = !player.hasFile() || markupOpen`；重画 annoBox / attachBox；`ta.value = draft.text`；`counter`；`syncSubmit()`；`syncTime()`。
- `syncTime()`：`tcChip.textContent = draft.whole ? '整片 · 不带时间码' : '时间码 ' + fmtTimecodeMs(draft.lockedTimecode ?? player.currentTime())`，`tcChip.classList.toggle('is-whole', draft.whole)`。
- `setSubmitting(on)`：按钮文字「正在提交…」/「提交意见」，disabled。
- `setMarkupOpen(on)`：按钮文字「正在画标记…」/「在当前帧画标记」，`refresh()`。

- [ ] **Step 2: review.js 接线**

```js
import { createComposer } from './composer.js';
let composer = null; let composerKey = '';
function getWriteCard(v) {
  const key = `v${v.number}`;
  if (composer && composerKey === key) return composer.el;
  composerKey = key;
  composer = createComposer({
    player, draft: state.draft, fps, maxAttachments: MAX_ATTACHMENTS, attachmentMaxEdge: ATTACHMENT_MAX_EDGE,
    onSubmit: submitFeedback, onApprove: approve, onMarkup: startMarkup,
  });
  return composer.el;
}
```
`onTime` → `composer?.syncTime()`；`handleFile`/`syncPlayerSource` 里的 `renderAnnoBox()` → `composer?.refresh()`；`submitFeedback` 用 `composer.setSubmitting`；`startMarkup` 开始时 `composer.setMarkupOpen(true)`，`onDone/onCancel` 时 `setMarkupOpen(false)` 并 `refresh()`。

- [ ] **Step 3: 状态卡与页头**

`renderStatusCard` 的 `collecting` 分支只 push「本轮反馈结束」。`renderHeadSide` 的 collecting+owner 分支：`n ? ['意见填写中 · 已写 n 条', '写完请点「本轮反馈结束」。'] : ['等待您的意见', '可逐条提交，之后仍能继续补充本轮。']`。

- [ ] **Step 4: CSS（composer）**

```css
/* 写意见内卡 */
.composer { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--card-solid); }
.composer__tools { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.composer__tool { display: grid; gap: 2px; place-items: center; min-height: 64px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--card-solid); color: var(--plum); font-weight: 800; font-size: var(--fs-md); cursor: pointer; text-align: center; }
.composer__tool:hover { border-color: var(--pink); }
.composer__tool:disabled, .composer__tool[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.composer__tool-sub { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
.composer__field { position: relative; display: grid; }
.composer__field textarea { min-height: 150px; padding-bottom: 46px; resize: vertical; }
.composer__meta { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; justify-content: space-between; align-items: center; pointer-events: none; }
.composer__meta > * { pointer-events: auto; }
.tc-chip { border: 0; border-radius: var(--r-pill); padding: 6px 10px; background: var(--cream); color: var(--ink); font-family: var(--mono); font-size: var(--fs-xs); font-weight: 700; cursor: pointer; }
.tc-chip.is-whole { background: var(--pink-soft); color: var(--plum); font-family: var(--sans); }
.composer__count { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted); background: var(--cream); padding: 6px 10px; border-radius: var(--r-pill); }
.composer__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.composer__actions .btn { min-height: 48px; font-size: var(--fs-md); border-radius: var(--r-md); }
.btn--outline { background: var(--card-solid); color: var(--plum); border: 1px solid var(--line); }
@media (max-width: 420px) { .composer__tools, .composer__actions { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: 行数红线**

Run: `wc -l js/review.js js/markup.js js/composer.js`
Expected: 每个 < 800。

- [ ] **Step 6: 提交**

```bash
git add js/composer.js js/review.js css/review.css
git commit -m "feat: 写意见区按参考站重排——并排入口、内嵌时间码与字数、并排确认通过/提交"
```

---

### Task 5: 本地验证与上线

- [ ] **Step 1: 本地库补迁移，起服务**

```bash
cd worker && npm run migrate:local
```
用 `preview_start` 起 `api` 与 `web`。

- [ ] **Step 2: 造测试视频并托管到本地项目**

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=25" -f lavfi -i "sine=frequency=440" -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/…/scratchpad/test10s.mp4
```
node 脚本（scratchpad）：`POST /api/admin/projects`（`X-Admin-Key: dev-admin`）→ `uploadStart` → 逐片 `PUT` → `uploadComplete`。输出审片链接。

- [ ] **Step 3: 浏览器走查**（见 spec 第 5 节 5 条），用 `read_page`/`screenshot` 留证。

- [ ] **Step 4: 远端冒烟**

```bash
cd worker && API_BASE=https://biscuit-review-api.biscuit-review-worker.workers.dev/api ADMIN_KEY="$(cat .admin-key.txt)" node --import <proxy-shim> test/smoke.mjs
```
Expected: `全部通过`。

- [ ] **Step 5: 推送并核对线上**

```bash
git push origin main
```
等 Pages 构建后在内置浏览器打开线上审片链接确认新界面。
