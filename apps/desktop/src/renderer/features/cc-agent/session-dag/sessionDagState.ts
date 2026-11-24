/** Immutable transitions for the family-scoped snapshot owned by the host. */
import type { DagCanvasState, DagNode, DagPoint, DagReference, DagRevision } from './types';
import { createEmptyState } from './types';
import { mergePositions, normalizeSize } from './layout';
import { findMergedCycle } from './graph';
import { appendManualRevision } from './revisions';
import { createReference } from './references';
import type { ReferenceSnapshot } from './types';

export function hydrateState(nodes: DagNode[], saved: DagCanvasState | undefined): DagCanvasState {
  const base = saved ?? createEmptyState();
  const sizes = base.sizes && Object.fromEntries(Object.entries(base.sizes).map(([id, size]) => [id, normalizeSize(size)]));
  return {
    ...(sizes && { sizes }),
    ...(Array.isArray(base.pendingBranches) && {
      pendingBranches: base.pendingBranches.filter(
        (b) =>
          b &&
          typeof b.id === 'string' &&
          typeof b.parentId === 'string' &&
          typeof b.sessionId === 'string' &&
          typeof b.question === 'string' &&
          Number.isFinite(b.point?.x) &&
          Number.isFinite(b.point?.y),
      ),
    }),
    ...(Array.isArray(base.asides) && { asides: base.asides.filter(a => a && [a.id, a.nodeId, a.sessionId, a.userMessageId].every(x => typeof x === 'string' && x.length > 0) && typeof a.question === 'string' && (a.projected === true || a.question.length > 0)) }),
    ...(base.summaries && { summaries: Object.fromEntries(Object.entries(base.summaries).filter(([, s]) => typeof s === 'string' && s)) }),
    ...(base.labels && {
      labels: Object.fromEntries(
        Object.entries(base.labels).filter(([, label]) => typeof label === 'string'),
      ),
    }),
    ...(base.selectedVersions && { selectedVersions: { ...base.selectedVersions } }),
    positions: { ...base.positions, ...mergePositions(nodes, base.positions ?? {}, sizes) },
    revisions: [...(base.revisions ?? [])],
    references: [...(base.references ?? [])],
  };
}

export function reconcileNodes(state: DagCanvasState, nodes: DagNode[]): DagCanvasState {
  return { ...state, positions: { ...state.positions, ...mergePositions(nodes, state.positions, state.sizes) } };
}

export function setNodePosition(
  state: DagCanvasState,
  nodeId: string,
  point: DagPoint,
): DagCanvasState {
  return {
    ...state,
    positions: { ...state.positions, [nodeId]: point },
  };
}

export type EditResult =
  { ok: true; state: DagCanvasState; revision: DagRevision } | { ok: false; message: string };

export function editVersion(
  state: DagCanvasState,
  input: { nodeId: string; question: string; answer: string; id: string; createdAt: number },
): EditResult {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question) return { ok: false, message: '问题不能为空' };
  if (!answer) return { ok: false, message: '回答不能为空' };
  const revisions = appendManualRevision(state.revisions, { ...input, question, answer });
  return {
    ok: true,
    state: {
      ...state,
      revisions,
      selectedVersions: { ...state.selectedVersions, [input.nodeId]: input.id },
    },
    revision: revisions[revisions.length - 1],
  };
}

export type ReferenceResult =
  { ok: true; state: DagCanvasState; reference: DagReference } | { ok: false; message: string };

export function addReference(
  state: DagCanvasState,
  input: {
    id: string;
    createdAt: number;
    fromNodeId: string;
    toNodeId: string;
    snapshot: ReferenceSnapshot;
    includedInQuestion?: true;
    nodes: DagNode[];
  },
): ReferenceResult {
  const created = createReference({
    id: input.id,
    createdAt: input.createdAt,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    snapshot: input.snapshot,
    includedInQuestion: input.includedInQuestion,
    nodes: input.nodes,
    references: state.references,
  });
  if (!created.ok) return { ok: false, message: created.message };
  const next: DagCanvasState = {
    ...state,
    references: [...state.references, created.reference],
  };

  const cycle = findMergedCycle(input.nodes, next.references);
  if (cycle) return { ok: false, message: cycle };
  return { ok: true, state: next, reference: created.reference };
}

export function removeReference(state: DagCanvasState, referenceId: string): DagCanvasState {
  return {
    ...state,
    references: state.references.filter((reference) => reference.id !== referenceId),
  };
}
