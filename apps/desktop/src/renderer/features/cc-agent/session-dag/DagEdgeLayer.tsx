/** Both arrows follow the flow of content, from the source to the consuming turn. */
import { useId } from 'react';
import { cardSize } from './layout';
import type { DagNode, DagPoint, DagReference, DagSize, DagSizes } from './types';

type Props = {
  nodes: Pick<DagNode, 'id' | 'parentId'>[];
  positions: Record<string, DagPoint>;
  references: DagReference[];
  sizes?: DagSizes;
  width: number;
  height: number;
};

function edgePath(from: DagPoint, to: DagPoint, source: DagSize, target: DagSize): string {
  const x1 = from.x + source.width,
    y1 = from.y + source.height / 2;
  const x2 = to.x,
    y2 = to.y + target.height / 2;
  const bend = Math.max(36, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function DagEdgeLayer({ nodes, positions, sizes, references, width, height }: Props) {
  const markerId = useId();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const solid = [];
  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = byId.get(node.parentId);
    const parentPos = parent ? positions[parent.id] : undefined;
    const pos = positions[node.id];
    if (!parentPos || !pos) continue;
    solid.push(
      <path
        key={`inherit-${node.id}`}
        d={edgePath(parentPos, pos, cardSize(sizes, node.parentId), cardSize(sizes, node.id))}
        className="stroke-[var(--text-tertiary)]"
        pointerEvents="visibleStroke"
        strokeWidth={1.5}
        fill="none"
      />,
    );
  }

  const dashed = [];
  for (const reference of references) {
    const from = positions[reference.toNodeId];
    const to = positions[reference.fromNodeId];
    if (!from || !to) continue;
    dashed.push(
      <path
        key={`ref-${reference.id}`}
        d={edgePath(from, to, cardSize(sizes, reference.toNodeId), cardSize(sizes, reference.fromNodeId))}
        className="stroke-[var(--text-secondary)]"
        pointerEvents="visibleStroke"
        strokeWidth={1.5}
        strokeDasharray="6 5"
        fill="none"
        markerEnd={`url(#${markerId})`}
      />,
    );
  }

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={width}
      height={height}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-[var(--text-secondary)]" />
        </marker>
      </defs>
      {solid}
      {dashed}
    </svg>
  );
}
