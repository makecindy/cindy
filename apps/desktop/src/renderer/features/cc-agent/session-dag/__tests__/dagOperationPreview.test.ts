import { describe, expect, it } from 'vitest';
import { previewDagOperation, type DagOperation } from '../dagOperationPreview';
import type { DagNode } from '../types';

// Unit, in memory (isolated file: 3.94s): the entry point reports scope, never a mutation. Native fork keeps
// its parent; terminal status affects a whole task and can also clean up side chats.
// Export tests cover text selection, not these safety boundaries. A sibling in the
// same task or one reference to another branch suffices to expose a scope mistake.
const turn = (id: string, parentId: string | null, sessionId: string): DagNode => ({
  id, parentId, sessionId, question: 'same text', answer: 'same text', answerMessageId: `reply-${id}`,
});
const nodes = [turn('a', null, 'main'), turn('b', 'a', 'main'), turn('c', 'b', 'child'), turn('d', 'a', 'side')];
const base = { nodes, selectedId: 'b', historyReady: true };

describe('previewDagOperation', () => {
  it('offers the original reply separately, not a detached root or a fork at the question', () => {
    expect(previewDagOperation({ ...base, operation: 'copy-path', selectedId: 'c' })).toMatchObject({
      status: 'preview-only', reason: 'fork-keeps-parent', nodeIds: ['a', 'b', 'c'],
      projectedSessionCount: 2, openOriginalReplyNodeId: 'c',
    });
    expect(previewDagOperation({ ...base, nodes: [{ ...nodes[0], answerMessageId: undefined }],
      selectedId: 'a', operation: 'copy-path' })).toMatchObject({ openOriginalReplyNodeId: null });
  });

  it.each(['copy-subtree', 'delete-subtree'] as const)('%s counts only inheritance descendants, not references or drafts', operation => {
    expect(previewDagOperation({ ...base, operation, canvasState: {
      references: [{ id: 'ref', fromNodeId: 'b', toNodeId: 'd', snapshot: { question: '', summary: '' }, createdAt: 1 }],
      pendingBranches: [{ id: 'draft', parentId: 'c', sessionId: 'empty-fork', question: '', point: { x: 0, y: 0 } }],
    } })).toEqual({
      status: 'preview-only', reason: operation === 'copy-subtree' ? 'no-native-subtree-copy' : 'no-native-subtree-delete',
      nodeIds: ['b', 'c'], projectedSessionCount: 2, outsideTurnsInSameSessions: 1, crossingReferences: 1,
      attachedPendingBranches: 1, openOriginalReplyNodeId: null,
    });
  });

  it('does not promote a selection spanning all visible turns to whole-task deletion', () => {
    expect(previewDagOperation({ ...base, operation: 'delete-subtree', selectedId: 'a' })).toMatchObject({
      status: 'preview-only', outsideTurnsInSameSessions: 0, projectedSessionCount: 3,
    });
  });

  it.each([
    [{ historyReady: false }, 'incomplete-history'],
    [{ selectedId: 'gone' }, 'missing-selection'],
    [{ nodes: [turn('b', 'not-loaded', 'main')] }, 'invalid-ancestry'],
    [{ nodes: [turn('b', null, 'main'), turn('b', null, 'other')] }, 'invalid-ancestry'],
    [{ nodes: [turn('a', 'b', 'main'), turn('b', 'a', 'main')] }, 'invalid-ancestry'],
  ] as const)('withholds the scope if the selection cannot be resolved (%s)', (override, reason) => {
    for (const operation of ['copy-path', 'copy-subtree', 'delete-subtree'] as const satisfies readonly DagOperation[]) {
      expect(previewDagOperation({ ...base, ...override, operation })).toEqual({ status: 'unavailable', reason });
    }
  });
});
