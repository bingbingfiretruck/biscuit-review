// 标记编辑器几何纯函数单测：node --test test/
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
  assert.equal(clampScale(0.1), 0.5);
  assert.equal(clampScale(9), 4);
  assert.equal(clampScale(1.25), 1.25);
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
