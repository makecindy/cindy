/** Capture only the selected source text. Never traverse references when producing a reference snapshot. */
import type { DagNode, DagReference, ReferenceSnapshot } from './types';
import { checkReferenceEdge } from './graph';

export const SUMMARY_MAX_LENGTH = 200;

export function summarizeAnswer(answer: string, maxLength = SUMMARY_MAX_LENGTH): string {
  const collapsed = answer.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

export type ReferenceCreateResult =
  | { ok: true; reference: DagReference }
  | { ok: false; reason: 'self' | 'duplicate' | 'cycle'; message: string };

export function createReference(input: {
  includedInQuestion?: true;
  id: string;
  createdAt: number;
  fromNodeId: string;
  toNodeId: string;
  snapshot: ReferenceSnapshot;
  nodes: DagNode[];
  references: DagReference[];
}): ReferenceCreateResult {
  const check = checkReferenceEdge(input.nodes, input.references, input.fromNodeId, input.toNodeId);
  if (!check.ok) return check;
  return {
    ok: true,
    reference: {
      id: input.id,
      ...(input.includedInQuestion && { includedInQuestion: true as const }),
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      snapshot: { ...input.snapshot },
      createdAt: input.createdAt,
    },
  };
}

export function snapshotsForNode(
  references: DagReference[],
  nodeId: string,
): { referenceId: string; toNodeId: string; snapshot: ReferenceSnapshot }[] {
  return references
    .filter((reference) => reference.fromNodeId === nodeId && !reference.includedInQuestion)
    .map((reference) => ({
      referenceId: reference.id,
      toNodeId: reference.toNodeId,
      snapshot: reference.snapshot,
    }));
}

export function buildAdvanceContext(
  summary: string,
  references: DagReference[],
  nodeId: string,
): string {
  const parts = summary ? [summary] : [];
  for (const item of snapshotsForNode(references, nodeId)) {
    parts.push(`引用快照（${item.snapshot.question}）：${item.snapshot.summary}`);
  }
  return parts.join('\n');
}
