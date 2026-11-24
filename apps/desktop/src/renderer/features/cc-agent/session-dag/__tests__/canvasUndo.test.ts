import { describe, expect, it } from 'vitest';
import { inverseCanvasEdit } from '../canvasUndo';
import { createEmptyState } from '../types';

const base = () => ({
  ...createEmptyState(),
  positions: { a: { x: 1, y: 2 } },
  labels: { a: 'label' },
  revisions: [
    { id: 'rev', nodeId: 'a', question: 'q', answer: 'a', createdAt: 1, source: 'manual' as const },
  ],
});

describe('画布手工编辑撤销', () => {
  it('还原卡位置、标签和修订，且不动其他字段', () => {
    const before = base();
    const after = {
      ...before,
      positions: { a: { x: 9, y: 8 } },
      labels: {},
      revisions: [],
      references: [
        {
          id: 'r',
          fromNodeId: 'a',
          toNodeId: 'b',
          snapshot: { question: 'q', summary: 's' },
          createdAt: 1,
        },
      ],
    };
    expect(inverseCanvasEdit(before, after)?.(after)).toEqual(before);
  });
  it('后续新写入时不回退整份旧快照，而是明确拒绝', () => {
    const before = base();
    const after = { ...before, labels: { a: 'new' } };
    const undo = inverseCanvasEdit(before, after)!;
    const newer = { ...after, labels: { a: 'even newer' } };
    expect(() => undo(newer)).toThrow(/已经变化/);
  });
  it('没有可识别手工编辑时不产生撤销记录', () => {
    expect(inverseCanvasEdit(base(), base())).toBeUndefined();
  });
});
