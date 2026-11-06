/**
 * topologyGeometry —— 远程连接 V2 拓扑的几何(纯函数,可单测)。
 * ---------------------------------------------------------------------------
 * 这台电脑在中间(圆盘 + 一圈细环),两边各一列路线:每组上方一行组名,组内从上到下排行,
 * 整边垂直居中;中转站是一个小圆点,在它那组行的中点、贴近中间,给扇出的线留足横向空间;
 * 每条线从细环(或中转站)出发,先拐到这一行再直着走到图块边上(离得越远拐弯越宽),
 * 延迟标签贴在直段靠图块的一端,两边各自对齐成一列。
 * 每条线同时给出形状(三次曲线 + 直段):有消息在走时,线上一排空隙沿它匀速流,看着是流动的虚线
 * (samplePath / speckKeyframes)。
 */

import { OFFLINE_FOLD_ID, type TopologyGroup } from './topologyModel';

export interface Point {
  x: number;
  y: number;
}

/** 每组上方留给组名的高度。 */
const CAPTION_H = 18;

export interface TopologyMetrics {
  /** 中间圆盘半径 */
  R: number;
  /** 圆盘外细环半径;线从这里出发 */
  ring: number;
  /** 设备图块半边 */
  half: number;
  /** 中转站圆点半径 */
  relayR: number;
  /** 直走段从中间算起的起点 */
  bend: number;
  /** 中转站离中间的距离 */
  relay: number;
  /** 图块中心离中间的距离 */
  tile: number;
  rowH: number;
  gap: number;
  top: number;
}

export interface TopologyLayout {
  w: number;
  h: number;
  cx: number;
  m: TopologyMetrics;
  hub: Point;
  /** 每行(设备 / 折叠行)的图块中心 */
  rows: Map<string, Point>;
  /** 每组:中转站位置(只有 relay 组有)、组名位置 */
  groups: Array<{ id: string; side: 1 | -1; caption: Point; relay: Point | null; mid: number }>;
}

/** 按可用宽度缩放:设计稿按 920 宽定的距离,窄一些就按比例收,最窄收到六成。 */
export function metricsFor(w: number, dense: boolean): TopologyMetrics {
  const k = Math.max(0.6, Math.min(1, w / 920));
  return {
    R: 28,
    ring: 36,
    half: 18,
    relayR: 15,
    bend: Math.round(104 * k),
    relay: Math.round(104 * k),
    tile: Math.round(280 * k),
    rowH: dense ? 46 : 54,
    gap: 16,
    top: 12,
  };
}

export function layoutTopology(groups: readonly TopologyGroup[], w: number, dense: boolean): TopologyLayout {
  const m = metricsFor(w, dense);
  const cx = w / 2;
  const sideHeight = (side: 1 | -1): number => {
    const list = groups.filter((g) => g.side === side);
    const rows = list.reduce((s, g) => s + g.rows.length, 0);
    return rows * m.rowH + Math.max(0, list.length - 1) * m.gap + list.length * CAPTION_H;
  };
  const hR = sideHeight(1);
  const hL = sideHeight(-1);
  const h = m.top * 2 + Math.max(hR, hL, 150);
  const rows = new Map<string, Point>();
  const out: TopologyLayout['groups'] = [];
  for (const side of [1, -1] as const) {
    let y = m.top + (h - m.top * 2 - (side === 1 ? hR : hL)) / 2;
    for (const g of groups) {
      if (g.side !== side) continue;
      y += CAPTION_H;
      // 组名与这一组名字那一列同一边线(图块外侧 12px 处)。
      const caption = { x: cx + side * (m.tile + m.half + 12), y: y - 4 };
      const first = y + m.rowH / 2;
      for (const id of g.rows) {
        rows.set(id, { x: cx + side * m.tile, y: y + m.rowH / 2 });
        y += m.rowH;
      }
      const last = y - m.rowH / 2;
      const mid = (first + last) / 2;
      out.push({ id: g.id, side, caption, relay: g.key === 'relay' ? { x: cx + side * m.relay, y: mid } : null, mid });
      y += m.gap;
    }
  }
  return { w, h, cx, m, hub: { x: cx, y: h / 2 }, rows, groups: out };
}

/** 一条线的形状:a 出发,三次曲线 (c1, c2) 到 k,再直线到 b(没有直段时 b 为 null)。 */
export interface LineShape {
  a: Point;
  c1: Point;
  c2: Point;
  k: Point;
  b: Point | null;
}

export interface LineSpec {
  shape: LineShape;
  d: string;
  /** 延迟标签位置:中转段是中点;设备行是线尾往回 10px(标签从这里朝中间排,贴着图块对齐成一列) */
  at: Point;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

export function shapeD(s: LineShape): string {
  const curve = `M ${r1(s.a.x)} ${r1(s.a.y)} C ${r1(s.c1.x)} ${r1(s.c1.y)}, ${r1(s.c2.x)} ${r1(s.c2.y)}, ${r1(s.k.x)} ${r1(s.k.y)}`;
  return s.b ? `${curve} L ${r1(s.b.x)} ${r1(s.b.y)}` : curve;
}

/** 先拐到这一行、再直着走:a 出发,拐弯在 k 结束,然后直线到 b;标签在直段中点。 */
export function lanePath(a: Point, b: Point, k: number, s: 1 | -1): LineSpec {
  const bendW = Math.abs(k - a.x) * 0.55;
  const shape: LineShape = {
    a,
    c1: { x: a.x + s * bendW, y: a.y },
    c2: { x: k - s * bendW, y: b.y },
    k: { x: k, y: b.y },
    b,
  };
  return { shape, d: shapeD(shape), at: { x: (k + b.x) / 2, y: b.y } };
}

/** 相邻两站之间的 S 形短接;标签在中点。 */
export function scurvePath(a: Point, b: Point): LineSpec {
  const mx = (a.x + b.x) / 2;
  const shape: LineShape = { a, c1: { x: mx, y: a.y }, c2: { x: mx, y: b.y }, k: b, b: null };
  return { shape, d: shapeD(shape), at: { x: mx, y: (a.y + b.y) / 2 } };
}

export interface RowLine extends LineSpec {
  id: string;
}

/**
 * 一组里每一行的线(从中间或从中转站出发);中转组另给「中间 → 中转站」一段。
 * halfOf 给出这一行图块的半宽(手机是竖条,比电脑方块窄),线一直画到图块边上;
 * 延迟标签仍按电脑方块的边对齐,同一边保持一列。
 */
export function groupLines(
  layout: TopologyLayout,
  group: TopologyGroup,
  halfOf: (id: string) => number = () => layout.m.half,
): { toRelay: LineSpec | null; rows: RowLine[] } {
  const { m, hub } = layout;
  const s = group.side;
  const g = layout.groups.find((x) => x.id === group.id);
  const hubEdge = { x: hub.x + s * m.ring, y: hub.y };
  let toRelay: LineSpec | null = null;
  let from = hubEdge;
  if (g?.relay) {
    toRelay = scurvePath(hubEdge, { x: g.relay.x - s * (m.relayR + 3), y: g.relay.y });
    from = { x: g.relay.x + s * (m.relayR + 3), y: g.relay.y };
  }
  const rows: RowLine[] = [];
  for (const id of group.rows) {
    const p = layout.rows.get(id);
    if (!p) continue;
    const end = { x: p.x - s * (halfOf(id) + 4), y: p.y };
    const at = { x: p.x - s * (m.half + 14), y: p.y };
    if (g?.relay) {
      // 中转站扇出:离中转站越远的行拐弯越宽,扇面才是一把匀称的扇子而不是一排梳齿。
      const k = from.x + s * (20 + Math.min(44, Math.abs(end.y - from.y) * 0.22));
      const line = group.rows.length > 1 ? lanePath(from, end, k, s) : scurvePath(from, end);
      rows.push({ id, ...line, at });
    } else {
      // 离这台电脑越远的行,拐弯放得越宽,曲线才不会陡得像直角。
      const k = layout.cx + s * (m.bend + Math.min(56, Math.abs(end.y - hubEdge.y) * 0.3));
      rows.push({ id, ...lanePath(hubEdge, end, k, s), at });
    }
  }
  return { toRelay, rows };
}

// ─── 消息流动:沿线等速取样 ─────────────────────────────────────────────────────

export interface PathSample {
  x: number;
  y: number;
  /** 切线角度(度),流动虚线的空隙顺着它摆 */
  angle: number;
}

function cubicAt(s: LineShape, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * s.a.x + b * s.c1.x + c * s.c2.x + d * s.k.x,
    y: a * s.a.y + b * s.c1.y + c * s.c2.y + d * s.k.y,
  };
}

/** 把线按弧长等距取样(约每 step px 一点);返回点列与总长。 */
export function samplePath(s: LineShape, step = 8): { points: PathSample[]; length: number } {
  const dense: Point[] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) dense.push(cubicAt(s, i / N));
  if (s.b) dense.push(s.b);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(dense[i]!.x - dense[i - 1]!.x, dense[i]!.y - dense[i - 1]!.y));
  }
  const length = cum[cum.length - 1]!;
  const count = Math.max(8, Math.round(length / step));
  const at = (dist: number): Point => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < dist) i++;
    const span = cum[i]! - cum[i - 1]! || 1;
    const t = Math.min(1, Math.max(0, (dist - cum[i - 1]!) / span));
    return {
      x: dense[i - 1]!.x + (dense[i]!.x - dense[i - 1]!.x) * t,
      y: dense[i - 1]!.y + (dense[i]!.y - dense[i - 1]!.y) * t,
    };
  };
  const pts: Point[] = [];
  for (let i = 0; i <= count; i++) pts.push(at((length * i) / count));
  // 角度保持连续:水平朝左的线 atan2 会在 +180° / -180° 之间跳(浮点的正负零),
  // 关键帧在两者之间插值会让空隙原地转半圈,所以相邻两点差不超过 180°。
  let prevAngle: number | null = null;
  const points = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    let angle = (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI;
    if (prevAngle !== null) {
      while (angle - prevAngle > 180) angle -= 360;
      while (angle - prevAngle < -180) angle += 360;
    }
    prevAngle = angle;
    return { x: p.x, y: p.y, angle };
  });
  return { points, length };
}

/** 流动虚线的一个空隙(px):顺着线摆的 5×3 小段,比 2px 的线略粗,把线整齐切开。 */
export const SPECK_W = 5;
export const SPECK_H = 3;
/** 空隙在线头冒出、在线尾没入时淡入淡出的路程(px)。 */
const SPECK_FADE_PX = 6;

/**
 * 一个空隙沿线走完全程的关键帧(只动 transform / opacity),时间以走一趟为 1:匀速,顺着线的方向摆。
 * 线头线尾各 SPECK_FADE_PX 内淡入淡出,一排空隙错开相位循环时看不出接缝;peak 是最不透明时的透明度。
 * reverse 时从线尾走回线头。
 */
export function speckKeyframes(points: readonly PathSample[], length: number, reverse: boolean, peak = 1): Keyframe[] {
  const list = reverse ? [...points].reverse() : points;
  const last = list.length - 1;
  const fade = Math.min(SPECK_FADE_PX, length / 4);
  return list.map((p, i) => {
    const s = last === 0 ? 1 : i / last;
    const d = length * s;
    const angle = reverse ? p.angle + 180 : p.angle;
    const opacity = fade > 0 ? Math.max(0, Math.min(1, d / fade, (length - d) / fade)) : 1;
    return {
      offset: s,
      opacity: Math.round(opacity * peak * 100) / 100,
      transform: `translate(${r1(p.x)}px, ${r1(p.y)}px) rotate(${r1(angle)}deg) translate(${-SPECK_W / 2}px, ${-SPECK_H / 2}px)`,
    };
  });
}

export { OFFLINE_FOLD_ID };
