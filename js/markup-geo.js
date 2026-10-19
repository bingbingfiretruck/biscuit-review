// 标记编辑器的纯几何：不碰 DOM，便于单测（test/markup-geo.test.mjs）。
// 坐标约定：画布坐标 = 抓帧像素；视图 view = { scale, tx, ty } 只影响显示与指针换算。

/** 画布在元素盒内按 object-fit: contain 摆放时的内容框；k = 内容框像素 / 画布像素 */
export function fitRect(boxW, boxH, W, H) {
  const k = Math.min(boxW / W, boxH / H);
  const w = W * k;
  const h = H * k;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, k };
}

/** 内容框像素 → 画布坐标（逆视图变换） */
export function toCanvas(view, px, py) {
  return [(px - view.tx) / view.scale, (py - view.ty) / view.scale];
}

/** 画布坐标 → 内容框像素 */
export function fromCanvas(view, x, y) {
  return [x * view.scale + view.tx, y * view.scale + view.ty];
}

export function clampScale(s) {
  return Math.min(4, Math.max(0.5, s));
}

/** 围绕内容框像素点 (cx, cy) 缩放，保持该点不动 */
export function zoomAround(view, factor, cx, cy) {
  const scale = clampScale(view.scale * factor);
  const r = scale / view.scale;
  return { scale, tx: cx - (cx - view.tx) * r, ty: cy - (cy - view.ty) * r };
}

/** 包围盒；文字标记的宽高由 textSize(s) 给出 */
export function strokeBounds(s, textSize = () => ({ w: 0, h: 0 })) {
  if (s.tool === 'text') {
    const [[x, y]] = s.points;
    const { w, h } = textSize(s);
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitsStroke(s, x, y, tol, textSize) {
  if (s.tool === 'pen' || s.tool === 'arrow') {
    for (let i = 1; i < s.points.length; i++) {
      if (segDist(x, y, s.points[i - 1], s.points[i]) <= tol) return true;
    }
    return s.points.length === 1 && Math.hypot(x - s.points[0][0], y - s.points[0][1]) <= tol;
  }
  const b = strokeBounds(s, textSize);
  return x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol;
}

/** 命中的最高层标记下标，没有则 -1 */
export function hitTest(strokes, x, y, tol, textSize) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (hitsStroke(strokes[i], x, y, tol, textSize)) return i;
  }
  return -1;
}

/** 平移一条标记，返回新对象 */
export function translate(s, dx, dy) {
  return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy]) };
}
