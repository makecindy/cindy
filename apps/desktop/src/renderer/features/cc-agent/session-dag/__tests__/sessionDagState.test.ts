/** Unit tier: Host snapshot contract. Adding or moving a turn must not discard its manually revised answer or replace saved coordinates. */
import { describe, expect, it } from 'vitest';

import {
  addReference,
  editVersion,
  hydrateState,
  reconcileNodes,
  removeReference,
  setNodePosition,
} from '../sessionDagState';
import { createEmptyState } from '../types';
import type { DagNode } from '../types';

function node(id: string, parentId: string | null): DagNode {
  return { id, parentId, sessionId: `s-${id}`, question: `question-${id}`, answer: `answer-${id}` };
}

describe('hydrateState / reconcileNodes（位置持久）', () => {
  it('已保存位置原样保留，新节点才走自动布局', () => {
    const n1 = node('n1', null);
    const saved = { positions: { n1: { x: 999, y: 888 } }, revisions: [], references: [] };
    const state = hydrateState([n1], saved);
    expect(state.positions.n1).toEqual({ x: 999, y: 888 });

    const n2 = node('n2', null);
    const next = reconcileNodes(state, [n1, n2]);
    expect(next.positions.n1).toEqual({ x: 999, y: 888 });
    expect(next.positions.n2).toBeDefined();
  });

  it('无 initialState 时全量自动布局', () => {
    const state = hydrateState([node('n1', null)], undefined);
    expect(state.positions.n1).toBeDefined();
    expect(state.revisions).toEqual([]);
    expect(state.references).toEqual([]);
    expect(createEmptyState()).toEqual({ positions: {}, revisions: [], references: [] });
  });
});

describe('setNodePosition', () => {
  it('只改目标节点坐标，不丢修订/引用', () => {
    const base = hydrateState([node('n1', null)], undefined);
    const edited = editVersion(base, {
      nodeId: 'n1',
      question: 'q',
      answer: 'a',
      id: 'r1',
      createdAt: 1,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const moved = setNodePosition(edited.state, 'n1', { x: 1, y: 2 });
    expect(moved.positions.n1).toEqual({ x: 1, y: 2 });
    expect(moved.revisions).toHaveLength(1);
  });
});

describe('editVersion（手动修订红线）', () => {
  const base = hydrateState([node('n1', null)], undefined);

  it('追加 manual 修订并保留旧内容', () => {
    const result = editVersion(base, {
      nodeId: 'n1',
      question: 'q1',
      answer: 'a1',
      id: 'r1',
      createdAt: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision.source).toBe('manual');
      expect(result.state.revisions).toHaveLength(1);
    }
  });

  it('空问题/空回答拒绝', () => {
    expect(
      editVersion(base, { nodeId: 'n1', question: '  ', answer: 'a', id: 'r1', createdAt: 1 }).ok,
    ).toBe(false);
    expect(
      editVersion(base, { nodeId: 'n1', question: 'q', answer: '', id: 'r1', createdAt: 1 }).ok,
    ).toBe(false);
  });
});

describe('addReference / removeReference（防环兜底）', () => {
  const n1 = node('n1', null);
  const n2 = node('n2', 'n1');
  const base = hydrateState([n1, n2], undefined);

  it('父子互引被拒（同向重复 / 反向成环）', () => {
    const result = addReference(base, {
      id: 'ref1',
      createdAt: 1,
      fromNodeId: 'n2',
      toNodeId: 'n1',
      snapshot: { question: 'q', summary: 's' },
      nodes: [n1, n2],
    });
    expect(result.ok).toBe(false);

    const ok = addReference(base, {
      id: 'ref2',
      createdAt: 2,
      fromNodeId: 'n1',
      toNodeId: 'n2',
      snapshot: { question: 'q', summary: 's' },
      nodes: [n1, n2],
    });
    expect(ok.ok).toBe(false);
  });

  it('跨支引用落状态后可移除', () => {
    const side = node('n3', null);
    const state = hydrateState([n1, n2, side], undefined);
    const result = addReference(state, {
      id: 'ref3',
      createdAt: 3,
      fromNodeId: 'n2',
      toNodeId: 'n3',
      snapshot: { question: 'question-n3', summary: 'summary-n3' },
      nodes: [n1, n2, side],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.references).toHaveLength(1);
      const removed = removeReference(result.state, 'ref3');
      expect(removed.references).toHaveLength(0);
    }
  });
});
