import { describe, expect, it } from 'vitest';
import {
  mergeVisibleReorder,
  moveVisibleProjectOrder,
  normalizeManualProjectOrder,
  projectDropIndexFromY,
  reorderVisibleProjectByDropIndex,
  reorderVisibleProjectToIndex,
  resolveVirtualizedDropIndex,
  snapshotManualProjectOrder,
} from '@/session/homeProjectOrder';

describe('normalizeManualProjectOrder', () => {
  it('keeps known keys and appends new ones', () => {
    expect(normalizeManualProjectOrder(['b', 'a'], ['a', 'c', 'b'])).toEqual(['b', 'a', 'c']);
  });

  it('drops keys that are no longer active', () => {
    expect(normalizeManualProjectOrder(['gone', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('snapshotManualProjectOrder', () => {
  it('fills visible slots with the pre-switch visual order and keeps hidden keys in place', () => {
    expect(
      snapshotManualProjectOrder(['local:b', 'local:a'], ['local:a', 'local:hidden', 'local:b']),
    ).toEqual(['local:b', 'local:hidden', 'local:a']);
  });

  it('falls back to baseline when the visual snapshot is empty', () => {
    expect(snapshotManualProjectOrder([], ['local:a', 'local:b'])).toEqual(['local:a', 'local:b']);
  });
});

describe('mergeVisibleReorder', () => {
  it('reorders only the visible subset in place', () => {
    expect(mergeVisibleReorder(['a', 'hidden', 'b'], ['b', 'a'])).toEqual(['b', 'hidden', 'a']);
  });
});

describe('moveVisibleProjectOrder', () => {
  it('swaps a visible project with its neighbor and keeps hidden keys', () => {
    expect(moveVisibleProjectOrder(['a', 'hidden', 'b'], ['a', 'b'], 'a', 1))
      .toEqual(['b', 'hidden', 'a']);
    expect(moveVisibleProjectOrder(['a', 'hidden', 'b'], ['a', 'b'], 'a', -1)).toBeNull();
  });
});

describe('reorderVisibleProjectToIndex', () => {
  it('moves a visible project to an arbitrary index and keeps hidden keys', () => {
    expect(reorderVisibleProjectToIndex(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], 'c', 0))
      .toEqual(['c', 'hidden', 'a', 'b']);
    expect(reorderVisibleProjectToIndex(['a', 'hidden', 'b'], ['a', 'b'], 'a', 0)).toBeNull();
  });
});

describe('reorderVisibleProjectByDropIndex', () => {
  it('inserts into the remaining list so dragging down does not skip a slot', () => {
    expect(reorderVisibleProjectByDropIndex(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 1))
      .toEqual(['b', 'a', 'c']);
    expect(reorderVisibleProjectByDropIndex(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 2))
      .toEqual(['b', 'c', 'a']);
  });
});

describe('projectDropIndexFromY', () => {
  const layouts = [
    { height: 56, y: 100 },
    { height: 56, y: 160 },
    { height: 56, y: 220 },
  ];

  it('uses midpoints so crossing the lower half of a row targets the next slot', () => {
    expect(projectDropIndexFromY(layouts, 110)).toBe(0);
    expect(projectDropIndexFromY(layouts, 190)).toBe(2);
    expect(projectDropIndexFromY(layouts, 400)).toBe(3);
  });
});

describe('resolveVirtualizedDropIndex', () => {
  const visible = ['a', 'b', 'c', 'd', 'e']; // 完整可见项目序

  it('passes the drop index through when every visible row is mounted', () => {
    // 全挂载:mounted(含源) = 全量;拖 e 到子集去掉源后的第 1 位。
    expect(resolveVirtualizedDropIndex(visible, visible, 'e', 1)).toBe(1);
  });

  it('adds the scrolled-past prefix so a drop does not jump to the front', () => {
    // 只挂载 c/d/e(a、b 滚过未挂载),拖 e。已挂载去掉源 = [c, d],
    // mountedDropIndex=0 表示落在 c 之前。完整去掉源 = [a, b, c, d],
    // c 的真实位置是 2 —— 必须回 2,而不是 0(旧 bug 会甩到最前)。
    expect(resolveVirtualizedDropIndex(visible, ['c', 'd', 'e'], 'e', 0)).toBe(2);
    // 落在已挂载子集末尾(d 之后)→ 紧跟 d,即完整去掉源里的 index 3+1=4? d 在 [a,b,c,d] 的 index 是 3,末尾插入 → 4。
    expect(resolveVirtualizedDropIndex(visible, ['c', 'd', 'e'], 'e', 2)).toBe(4);
  });

  it('aborts (null) when the dragged row itself was not measured', () => {
    expect(resolveVirtualizedDropIndex(visible, ['a', 'b'], 'e', 0)).toBeNull();
  });
});
