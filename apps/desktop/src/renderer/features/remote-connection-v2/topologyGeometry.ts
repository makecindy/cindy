/**
 * topologyGeometry —— 远程连接 V2 拓扑的几何(纯函数,可单测)。
 * ---------------------------------------------------------------------------
 * 这台电脑在中间,两边各一列路线:每组从上到下排行,整边垂直居中;中转站在它那组行的中点、
 * 靠中间一侧;每条线从中间圆盘边缘出发,先拐到这一行再直着走到图块边上(离得越远拐弯越宽),
 * 延迟标签贴在直的那一段中间。没有干线、没有直角。
 */

import { OFFLINE_FOLD_ID, type TopologyGroup } from './topologyModel';

export interface Point {
  x: number;
  y: number;
}

/** 紧凑模式下每组上方留给组名的高度。 */
const CAPTION_H = 16;

export interface TopologyMetrics {
  /** 中间圆盘半径 */
  R: number;
  /** 设备图块半边 */
  half: number;
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
    half: 18,
    bend: Math.round(104 * k),
    relay: Math.round(140 * k),
    tile: Math.round(266 * k),
    rowH: dense ? 46 : 56,
    gap: 14,
    top: 14,
  };
}

export function layoutTopology(groups: readonly TopologyGroup[], w: number, dense: boolean): TopologyLayout {
  const m = metricsFor(w, dense);
  const cx = w / 2;
  const sideHeight = (side: 1 | -1): number => {
    const list = groups.filter((g) => g.side === side);
    const rows = list.reduce((s, g) => s + g.rows.length, 0);
    return rows * m.rowH + Math.max(0, list.length - 1) * m.gap + (dense ? list.length * CAPTION_H : 0);
  };
  const hR = sideHeight(1);
  const hL = sideHeight(-1);
  const h = m.top * 2 + Math.max(hR, hL, 130);
  const rows = new Map<string, Point>();
  const out: TopologyLayout['groups'] = [];
  for (const side of [1, -1] as const) {
    let y = m.top + (h - m.top * 2 - (side === 1 ? hR : hL)) / 2;
    for (const g of groups) {
      if (g.side !== side) continue;
      if (dense) y += CAPTION_H;
      // 组名与这一组名字那一列同一边线(图块外侧 10px 处)。
      const caption = { x: cx + side * (m.tile + m.half + 10), y: y - 3 };
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

/** 先拐到这一行、再直着走:a 出发,拐弯在 k 结束,然后直线到 b;标签在直段中点。 */
export function lanePath(a: Point, b: Point, k: number, s: 1 | -1): { d: string; at: Point } {
  const bendW = Math.abs(k - a.x) * 0.55;
  return {
    d: `M ${a.x} ${a.y} C ${a.x + s * bendW} ${a.y}, ${k - s * bendW} ${b.y}, ${k} ${b.y} L ${b.x} ${b.y}`,
    at: { x: (k + b.x) / 2, y: b.y },
  };
}

/** 相邻两站之间的 S 形短接;标签在中点。 */
export function scurvePath(a: Point, b: Point): { d: string; at: Point } {
  const mx = (a.x + b.x) / 2;
  return {
    d: `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`,
    at: { x: mx, y: (a.y + b.y) / 2 },
  };
}

export interface RowLine {
  id: string;
  d: string;
  at: Point;
}

/** 一组里每一行的线(从中间或从中转站出发);中转组另给「中间 → 中转站」一段。 */
export function groupLines(
  layout: TopologyLayout,
  group: TopologyGroup,
): { toRelay: { d: string; at: Point } | null; rows: RowLine[] } {
  const { m, hub } = layout;
  const s = group.side;
  const g = layout.groups.find((x) => x.id === group.id);
  const hubEdge = { x: hub.x + s * (m.R + 2), y: hub.y };
  let toRelay: { d: string; at: Point } | null = null;
  let from = hubEdge;
  if (g?.relay) {
    toRelay = scurvePath(hubEdge, { x: g.relay.x - s * (m.half + 3), y: g.relay.y });
    from = { x: g.relay.x + s * (m.half + 3), y: g.relay.y };
  }
  const rows: RowLine[] = [];
  for (const id of group.rows) {
    const p = layout.rows.get(id);
    if (!p) continue;
    const end = { x: p.x - s * (m.half + 3), y: p.y };
    if (g?.relay) {
      const line = group.rows.length > 1 ? lanePath(from, end, from.x + s * 40, s) : scurvePath(from, end);
      rows.push({ id, ...line });
    } else {
      // 离这台电脑越远的行,拐弯放得越宽,曲线才不会陡得像直角。
      const k = layout.cx + s * (m.bend + Math.min(56, Math.abs(end.y - hubEdge.y) * 0.3));
      rows.push({ id, ...lanePath(hubEdge, end, k, s) });
    }
  }
  return { toRelay, rows };
}

export { OFFLINE_FOLD_ID };
