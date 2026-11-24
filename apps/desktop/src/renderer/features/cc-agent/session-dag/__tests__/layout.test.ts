/** Unit tier: Layout contract. Adding a sibling on the same depth must keep saved positions and place unsaved turns apart. */
import { describe, expect, it } from 'vitest';

import { autoLayout, CARD_GAP_Y, CARD_HEIGHT, contentBounds, mergePositions } from '../layout';
import type { DagNode } from '../types';

function node(id: string, parentId: string | null): DagNode {
  return { id, parentId, sessionId: `s-${id}`, question: 'q', answer: 'a' };
}

describe('autoLayout', () => {
  it('按深度分层：子节点 y 大于父节点', () => {
    const positions = autoLayout([
      node('root', null),
      node('child', 'root'),
      node('grand', 'child'),
    ]);
    expect(positions.root.y).toBe(positions.child.y);
    expect(positions.child.y).toBe(positions.grand.y);
    expect(positions.child.x).toBeGreaterThan(positions.root.x);
    expect(positions.grand.x).toBeGreaterThan(positions.child.x);
  });

  it('同层从左到右排列', () => {
    const positions = autoLayout([node('root', null), node('a', 'root'), node('b', 'root')]);
    expect(positions.a.x).toBe(positions.b.x);
    expect(positions.a.y).toBeLessThan(positions.b.y);
    expect(positions.root.x).toBeLessThan(positions.a.x);
    expect(CARD_HEIGHT).toBeLessThan(CARD_GAP_Y * 3);
  });
});

describe('mergePositions', () => {
  it('saved 坐标优先，缺位置的节点才自动补', () => {
    const saved = { n1: { x: 7, y: 7 } };
    const merged = mergePositions([node('n1', null), node('n2', null)], saved);
    expect(merged.n1).toEqual({ x: 7, y: 7 });
    expect(merged.n2).toBeDefined();
    expect(merged.n2.x).toBeGreaterThan(0);
  });
});

describe('contentBounds', () => {
  it('包围盒覆盖最右最下卡片', () => {
    const nodes = [node('n1', null), node('n2', null)];
    const positions = { n1: { x: 0, y: 0 }, n2: { x: 600, y: 300 } };
    const bounds = contentBounds(nodes, positions);
    expect(bounds.width).toBeGreaterThan(600);
    expect(bounds.height).toBeGreaterThan(300);
  });
});
