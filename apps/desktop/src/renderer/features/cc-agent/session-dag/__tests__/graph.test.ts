/** Unit tier: Merged-edge invariant. The minimal mixed cycle is a back reference along a parent edge; ancestry-only tests miss it. */
import { describe, expect, it } from 'vitest';

import { checkReferenceEdge, findMergedCycle, mergedPathExists } from '../graph';
import type { DagNode, DagReference } from '../types';

function node(id: string, parentId: string | null, side = false): DagNode {
  return {
    id,
    parentId,
    sessionId: `session-${id}`,
    question: `question-${id}`,
    answer: `answer-${id}`,
    side,
  };
}

function reference(id: string, fromNodeId: string, toNodeId: string): DagReference {
  return {
    id,
    fromNodeId,
    toNodeId,
    snapshot: { question: `question-${toNodeId}`, summary: `summary-${toNodeId}` },
    createdAt: 1,
  };
}

describe('checkReferenceEdge', () => {
  const nodes = [node('root', null), node('a', 'root'), node('b', 'root'), node('a1', 'a')];

  it('拒绝自引并解释', () => {
    const result = checkReferenceEdge(nodes, [], 'a', 'a');
    expect(result).toEqual({ ok: false, reason: 'self', message: '不能引用自身' });
  });

  it('拒绝重复边并解释', () => {
    const refs = [reference('r1', 'a', 'b')];
    const result = checkReferenceEdge(nodes, refs, 'a', 'b');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('duplicate');
      expect(result.message).toContain('重复');
    }
  });

  it('虚线与已有实线继承同向视为重复边，拒绝', () => {
    const result = checkReferenceEdge(nodes, [], 'a', 'root');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('duplicate');
      expect(result.message).toContain('继承');
    }
  });

  it('实线父 + 虚线反向引用合并成环，拒绝并解释', () => {
    const result = checkReferenceEdge(nodes, [], 'root', 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
      expect(result.message).toContain('循环');
    }
  });

  it('虚线链引用合并成环，拒绝', () => {
    const refs = [reference('r1', 'a', 'b')];
    const result = checkReferenceEdge(nodes, refs, 'b', 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cycle');
  });

  it('跨支合法引用放行', () => {
    const result = checkReferenceEdge(nodes, [], 'a', 'b');
    expect(result).toEqual({ ok: true });
  });

  it('深层实线祖先反向引用成环，拒绝', () => {
    const result = checkReferenceEdge(nodes, [], 'root', 'a1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cycle');
  });
});

describe('mergedPathExists', () => {
  it('实线与虚线共同构成可达路径', () => {
    const nodes = [node('root', null), node('a', 'root'), node('b', 'root')];

    const refs = [reference('r1', 'a', 'b')];
    expect(mergedPathExists(nodes, refs, 'root', 'a')).toBe(true);
    expect(mergedPathExists(nodes, refs, 'b', 'a')).toBe(true);
    expect(mergedPathExists(nodes, refs, 'a', 'b')).toBe(false);
  });
});

describe('findMergedCycle', () => {
  it('无环时返回 null', () => {
    const nodes = [node('root', null), node('a', 'root'), node('b', 'root')];
    const refs = [reference('r1', 'a', 'b')];
    expect(findMergedCycle(nodes, refs)).toBeNull();
  });

  it('持久化状态被篡改成环时给出解释', () => {
    const nodes = [node('root', null), node('a', 'root')];

    const refs = [reference('r1', 'root', 'a')];
    const message = findMergedCycle(nodes, refs);
    expect(message).not.toBeNull();
    expect(message).toContain('循环');
  });
});
