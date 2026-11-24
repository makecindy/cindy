/** An append-only manual history overlays, but never mutates, native turns. */
import type { AnswerVersion, DagNode, DagRevision } from './types';

export function listVersions(node: DagNode, revisions: DagRevision[]): AnswerVersion[] {
  const origin: AnswerVersion = {
    key: 'origin',
    question: node.question,
    answer: node.answer,
    manual: false,
  };
  const manual = revisions
    .filter((revision) => revision.nodeId === node.id)
    .map((revision) => ({
      key: revision.id,
      question: revision.question,
      answer: revision.nativeAnswer ? node.answer : revision.answer,
      ...(revision.nativeAnswer && { nativeAnswer: true as const }),
      manual: true as const,
      createdAt: revision.createdAt,
    }));
  return [origin, ...manual];
}

export function getVersion(
  node: DagNode,
  revisions: DagRevision[],
  key: string | undefined,
): AnswerVersion {
  const versions = listVersions(node, revisions);
  if (!key || key === 'origin') return versions[0];
  return versions.find((version) => version.key === key) ?? versions[0];
}

export function appendManualRevision(
  revisions: DagRevision[],
  input: { nodeId: string; question: string; answer: string; id: string; createdAt: number },
): DagRevision[] {
  return [
    ...revisions,
    {
      id: input.id,
      nodeId: input.nodeId,
      question: input.question,
      answer: input.answer,
      createdAt: input.createdAt,
      source: 'manual',
    },
  ];
}

export function revisionsForNodes(
  revisions: DagRevision[],
  nodeIds: ReadonlySet<string>,
): DagRevision[] {
  return revisions.filter((revision) => nodeIds.has(revision.nodeId));
}
