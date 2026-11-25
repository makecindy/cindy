import type { DagCanvasState, DagNode } from './types';

export type DagOperation = 'copy-path' | 'copy-subtree' | 'delete-subtree';

type Input = {
  operation: DagOperation;
  selectedId: string | null;
  /** All projected turns in the current owner/device/family, before UI filters. */
  nodes: readonly DagNode[];
  /** False during loading or on any family history read failure. */
  historyReady: boolean;
  canvasState?: Pick<DagCanvasState, 'references' | 'pendingBranches'>;
};

type Preview =
  | { status: 'unavailable'; reason: 'incomplete-history' | 'missing-selection' | 'invalid-ancestry' }
  | {
      status: 'preview-only';
      reason: 'fork-keeps-parent' | 'no-native-subtree-copy' | 'no-native-subtree-delete';
      /** Projected scope only. Never use these IDs as a host write manifest. */
      nodeIds: string[];
      projectedSessionCount: number;
      outsideTurnsInSameSessions: number;
      crossingReferences: number;
      attachedPendingBranches: number;
      /** Navigation only: the original chat owns the separate native fork action. */
      openOriginalReplyNodeId: string | null;
    };

/**
 * No IPC, transcript materialization or writes. Even a complete projection omits native rows.
 * maker-orchestration/fork.ts always records the parent; lib/sessionService.forkAtMessage
 * is a separate action on the original reply, not an independent-root or subtree copy.
 * localDb/ipc/sessions.ts deletes tasks and dependent side chats, while rewind changes a
 * single timeline. Neither implements a graph-scoped delete. Keep commit on the owning
 * host until it can preview, authorize and revalidate that exact native scope atomically.
 */
export function previewDagOperation({ operation, selectedId, nodes, historyReady, canvasState }: Input): Preview {
  if (!historyReady) return { status: 'unavailable', reason: 'incomplete-history' };
  const byId = new Map(nodes.map(n => [n.id, n]));
  const selected = selectedId === null ? undefined : byId.get(selectedId);
  if (!selected) return { status: 'unavailable', reason: 'missing-selection' };
  const invalid = { status: 'unavailable', reason: 'invalid-ancestry' } as const;
  if (byId.size !== nodes.length) return invalid;

  const path: DagNode[] = [];
  const seen = new Set<string>();
  for (let n = selected; ; ) {
    if (seen.has(n.id)) return invalid;
    seen.add(n.id);
    path.push(n);
    if (n.parentId === null) break;
    const parent = byId.get(n.parentId);
    if (!parent) return invalid;
    n = parent;
  }
  let scope: DagNode[];
  if (operation === 'copy-path') {
    scope = path.reverse();
  } else {
    const children = new Map<string, DagNode[]>();
    for (const n of nodes) {
      if (n.parentId === null) continue;
      const siblings = children.get(n.parentId);
      if (siblings) siblings.push(n); else children.set(n.parentId, [n]);
    }
    // Unique IDs and a validated path to a root rule out cycles reachable from selected.
    scope = [selected];
    for (let i = 0; i < scope.length; i++) {
      for (const child of children.get(scope[i].id) ?? []) scope.push(child);
    }
  }
  const ids = new Set(scope.map(n => n.id));
  const sessions = new Set(scope.map(n => n.sessionId));
  return {
    status: 'preview-only',
    reason: operation === 'copy-path' ? 'fork-keeps-parent'
      : operation === 'copy-subtree' ? 'no-native-subtree-copy' : 'no-native-subtree-delete',
    nodeIds: [...ids],
    projectedSessionCount: sessions.size,
    outsideTurnsInSameSessions: nodes.filter(n => sessions.has(n.sessionId) && !ids.has(n.id)).length,
    crossingReferences: (canvasState?.references ?? []).filter(r => ids.has(r.fromNodeId) !== ids.has(r.toNodeId)).length,
    attachedPendingBranches: (canvasState?.pendingBranches ?? []).filter(b => ids.has(b.parentId)).length,
    openOriginalReplyNodeId: operation === 'copy-path' && selected.answerMessageId ? selected.id : null,
  };
}
