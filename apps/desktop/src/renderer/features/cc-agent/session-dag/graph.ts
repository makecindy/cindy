/** Cycle checks use the union of ancestry and snapshot dependencies. References store the consumer as fromNodeId and the source as toNodeId. */
import type { DagNode, DagReference } from './types';

export type GraphEdgeKind = 'inherit' | 'reference';

export type GraphEdge = {
  from: string;
  to: string;
  kind: GraphEdgeKind;
};

export type RejectionReason = 'self' | 'duplicate' | 'cycle';

export type EdgeCheckResult =
  { ok: true } | { ok: false; reason: RejectionReason; message: string };

export function buildMergedEdges(nodes: DagNode[], references: DagReference[]): GraphEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId)) {
      edges.push({ from: node.parentId, to: node.id, kind: 'inherit' });
    }
  }
  for (const reference of references) {
    if (ids.has(reference.fromNodeId) && ids.has(reference.toNodeId)) {
      edges.push({ from: reference.toNodeId, to: reference.fromNodeId, kind: 'reference' });
    }
  }
  return edges;
}

function collectAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.from);
    if (next) next.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  return adjacency;
}

export function mergedPathExists(
  nodes: DagNode[],
  references: DagReference[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const adjacency = collectAdjacency(buildMergedEdges(nodes, references));
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export function checkReferenceEdge(
  nodes: DagNode[],
  references: DagReference[],
  fromNodeId: string,
  toNodeId: string,
): EdgeCheckResult {
  if (fromNodeId === toNodeId) {
    return { ok: false, reason: 'self', message: '不能引用自身' };
  }
  const duplicate = references.some(
    (reference) => reference.fromNodeId === fromNodeId && reference.toNodeId === toNodeId,
  );
  if (duplicate) {
    return { ok: false, reason: 'duplicate', message: '已存在相同的引用，无需重复添加' };
  }

  const inheritsFromTarget = nodes.some(
    (node) => node.id === fromNodeId && node.parentId === toNodeId,
  );
  if (inheritsFromTarget) {
    return { ok: false, reason: 'duplicate', message: '已存在同向的继承边，无需重复引用' };
  }

  if (mergedPathExists(nodes, references, fromNodeId, toNodeId)) {
    return {
      ok: false,
      reason: 'cycle',
      message: '该引用会让实线继承与虚线引用合并后形成循环，已拒绝',
    };
  }
  return { ok: true };
}

export function findMergedCycle(nodes: DagNode[], references: DagReference[]): string | null {
  const adjacency = collectAdjacency(buildMergedEdges(nodes, references));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const targets of adjacency.values()) {
    for (const to of targets) degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      const count = degree.get(next)! - 1;
      degree.set(next, count);
      if (!count) queue.push(next);
    }
  }
  if (queue.length !== degree.size) return '实线继承与虚线引用合并后存在循环，请删除造成循环的引用';
  return null;
}
