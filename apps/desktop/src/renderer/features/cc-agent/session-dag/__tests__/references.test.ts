/** Unit tier: Direct snapshot contract. For A referencing B referencing C, the context for A must not contain C. */
import { describe, expect, it } from 'vitest';

import { buildAdvanceContext, createReference, summarizeAnswer } from '../references';
import type { DagNode, DagReference } from '../types';

function node(id: string, parentId: string | null): DagNode {
  return { id, parentId, sessionId: `s-${id}`, question: `question-${id}`, answer: `answer-${id}` };
}

describe('summarizeAnswer', () => {
  it('压空白并在超长时截断', () => {
    expect(summarizeAnswer('多行\n\n文本   压缩')).toBe('多行 文本 压缩');
    const long = 'x'.repeat(300);
    const summary = summarizeAnswer(long, 10);
    expect(summary).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('createReference', () => {
  const nodes = [node('a', null), node('b', null)];

  it('只保留问题 + 确认后摘要（快照），不携带其它字段', () => {
    const result = createReference({
      id: 'r1',
      createdAt: 5,
      fromNodeId: 'a',
      toNodeId: 'b',
      snapshot: { question: 'question-b', summary: '用户确认后的摘要' },
      nodes,
      references: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reference.snapshot).toEqual({
        question: 'question-b',
        summary: '用户确认后的摘要',
      });

      expect(Object.keys(result.reference.snapshot).sort()).toEqual(['question', 'summary']);
    }
  });

  it('成环引用被拒', () => {
    const refs: DagReference[] = [
      {
        id: 'r0',
        fromNodeId: 'a',
        toNodeId: 'b',
        snapshot: { question: 'q', summary: 's' },
        createdAt: 1,
      },
    ];
    const result = createReference({
      id: 'r1',
      createdAt: 2,
      fromNodeId: 'b',
      toNodeId: 'a',
      snapshot: { question: 'q', summary: 's' },
      nodes,
      references: refs,
    });
    expect(result.ok).toBe(false);
  });
});

describe('buildAdvanceContext（不递归）', () => {
  it('只展开一层引用快照，二层引用不出现', () => {
    const nodes = [node('a', null), node('b', null), node('c', null)];

    const refs: DagReference[] = [
      {
        id: 'r1',
        fromNodeId: 'a',
        toNodeId: 'b',
        snapshot: { question: 'qb', summary: 'sb' },
        createdAt: 1,
      },
      {
        id: 'r2',
        fromNodeId: 'b',
        toNodeId: 'c',
        snapshot: { question: 'qc', summary: 'sc' },
        createdAt: 2,
      },
    ];
    const context = buildAdvanceContext('sa', refs, 'a');
    expect(context).toContain('sa');
    expect(context).toContain('sb');

    expect(context).not.toContain('sc');
    expect(buildAdvanceContext('sa', [{ ...refs[0], includedInQuestion: true }], 'a')).toBe('sa');
    expect(nodes).toHaveLength(3);
  });

  it('无引用时上下文就是摘要本身', () => {
    expect(buildAdvanceContext('sa', [], 'a')).toBe('sa');
  });
});
