/** Unit tier: Manual provenance contract. One edit must leave both the native answer and the edited version selectable. */
import { describe, expect, it } from 'vitest';

import { appendManualRevision, getVersion, listVersions, revisionsForNodes } from '../revisions';
import type { DagNode, DagRevision } from '../types';

const node: DagNode = {
  id: 'n1',
  parentId: null,
  sessionId: 's1',
  question: '原始问题',
  answer: '模型原答',
};

describe('listVersions / getVersion', () => {
  it('无修订时只有模型原答，manual=false', () => {
    const versions = listVersions(node, []);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      key: 'origin',
      question: '原始问题',
      answer: '模型原答',
      manual: false,
    });
  });

  it('手动修订追加在后且标记 manual，原答不被改写', () => {
    const revisions: DagRevision[] = [
      {
        id: 'r1',
        nodeId: 'n1',
        question: '原始问题',
        answer: '第一次修订',
        createdAt: 2,
        source: 'manual',
      },
    ];
    const versions = listVersions(node, revisions);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ key: 'origin', answer: '模型原答', manual: false });
    expect(versions[1]).toMatchObject({ key: 'r1', answer: '第一次修订', manual: true });

    expect(node.answer).toBe('模型原答');
    expect(revisions[0].source).toBe('manual');
  });

  it('getVersion 按 key 取修订版，无效 key 回落模型原答', () => {
    const revisions: DagRevision[] = [
      {
        id: 'r1',
        nodeId: 'n1',
        question: '改后问题',
        answer: '改后回答',
        createdAt: 3,
        source: 'manual',
      },
    ];
    expect(getVersion(node, revisions, 'r1')).toMatchObject({
      question: '改后问题',
      answer: '改后回答',
      manual: true,
    });
    expect(getVersion(node, revisions, 'missing')).toMatchObject({
      key: 'origin',
      answer: '模型原答',
    });
    expect(getVersion(node, revisions, undefined)).toMatchObject({ key: 'origin' });
  });
});

describe('appendManualRevision', () => {
  it('不可变追加：旧数组不变，新修订 source 恒为 manual', () => {
    const before: DagRevision[] = [];
    const after = appendManualRevision(before, {
      nodeId: 'n1',
      question: 'q',
      answer: 'a',
      id: 'r1',
      createdAt: 10,
    });
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'r1', question: 'q', answer: 'a', source: 'manual' });
  });
});

describe('revisionsForNodes', () => {
  it('按现存节点过滤，节点消失后修订不物理删除（可追溯性）', () => {
    const revisions: DagRevision[] = [
      { id: 'r1', nodeId: 'gone', question: 'q', answer: 'a', createdAt: 1, source: 'manual' },
    ];

    expect(revisionsForNodes(revisions, new Set(['n1']))).toHaveLength(0);
    expect(revisions).toHaveLength(1);
  });
});
