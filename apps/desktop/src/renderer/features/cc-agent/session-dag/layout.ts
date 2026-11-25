/** Place turns by ancestry depth and retain explicit user positions. */
import type { DagNode, DagPoint, DagSize, DagSizes } from './types';

// Shared first-line geometry for history, editors and submitted placeholders.
export const QUESTION_INSET = 'pt-2';
export const QUESTION_LINE = 'text-13 leading-5';

export const CARD_HEIGHT = 104;
export const CARD_WIDTH = 280;
export const CARD_GAP_X = 72;
export const CARD_GAP_Y = 56;
export const LAYOUT_PADDING = 48;

export const DEFAULT_SIZE: DagSize = { width: CARD_WIDTH, height: CARD_HEIGHT };
export function normalizeSize(s?: DagSize): DagSize {
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return DEFAULT_SIZE;
  return {
    width: Math.min(8192, Math.max(200, Math.round(s.width))),
    height: Math.min(8192, Math.max(96, Math.round(s.height))),
  };
}
export function cardSize(sizes: DagSizes | undefined, id: string): DagSize {
  return sizes && Object.hasOwn(sizes, id) ? sizes[id] : DEFAULT_SIZE;
}
export function autoLayout(
  nodes: Pick<DagNode, 'id' | 'parentId'>[],
  sizes?: DagSizes,
): Record<string, DagPoint> {
  const known = new Set(nodes.map((node) => node.id));
  const children = new Map<string, typeof nodes>();
  const roots: typeof nodes = [];
  for (const node of nodes) {
    if (node.parentId === null || !known.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }
  const positions: Record<string, DagPoint> = Object.create(null);
  const colWidths: number[] = [],
    rowHeights: number[] = [];
  let nextLane = 0;
  // The first continuation stays on its parent's lane. Reserve later lanes
  // after its subtree, even when messages arrived out of tree order.
  for (const root of [...roots, ...nodes]) {
    if (positions[root.id]) continue;
    const stack = [{ node: root, depth: 0, lane: -1 }];
    while (stack.length) {
      const { node, depth, lane } = stack.pop()!;
      if (positions[node.id]) continue;
      const row = lane < 0 ? nextLane++ : lane;
      const size = cardSize(sizes, node.id);
      colWidths[depth] = Math.max(colWidths[depth] ?? 0, size.width);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.height);
      positions[node.id] = { x: depth, y: row };
      const siblings = children.get(node.id) ?? [];
      for (let i = siblings.length - 1; i >= 0; --i)
        stack.push({ node: siblings[i], depth: depth + 1, lane: i === 0 ? row : -1 });
    }
  }
  const offsets = (lengths: number[], gap: number) => {
    let offset = LAYOUT_PADDING;
    return lengths.map((length) => {
      const start = offset;
      offset += length + gap;
      return start;
    });
  };
  const xs = offsets(colWidths, CARD_GAP_X),
    ys = offsets(rowHeights, CARD_GAP_Y);
  for (const p of Object.values(positions)) {
    p.x = xs[p.x];
    p.y = ys[p.y];
  }
  return positions;
}

export function mergePositions(
  nodes: DagNode[],
  saved: Record<string, DagPoint>,
  sizes?: DagSizes,
): Record<string, DagPoint> {
  const computed = autoLayout(nodes, sizes);
  const merged: Record<string, DagPoint> = Object.create(null);
  for (const node of nodes) {
    const point = Object.hasOwn(saved, node.id) ? saved[node.id] : undefined;
    merged[node.id] =
      point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : computed[node.id];
  }
  return merged;
}

export function contentBounds(
  nodes: Pick<DagNode, 'id'>[],
  positions: Record<string, DagPoint>,
  sizes?: DagSizes,
): { left: number; top: number; width: number; height: number } {
  let left = Infinity,
    top = Infinity,
    right = 0,
    bottom = 0;
  for (const node of nodes) {
    const p = positions[node.id];
    if (!p) continue;
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    const size = cardSize(sizes, node.id);
    right = Math.max(right, p.x + size.width);
    bottom = Math.max(bottom, p.y + size.height);
  }
  return {
    left: Number.isFinite(left) ? left - LAYOUT_PADDING : 0,
    top: Number.isFinite(top) ? top - LAYOUT_PADDING : 0,
    width: right + LAYOUT_PADDING,
    height: bottom + LAYOUT_PADDING,
  };
}
