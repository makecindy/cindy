/**
 * treeScrollStore — 文件树滚动锚点的存取与换算。
 *
 * 锁的不变量：
 *   - 锚点按 scope 分片（视口 + store key），互不污染；
 *   - 锚点是「顶部行 key + 行内偏移」，换一批行（切开关 / 刷新）后落到同一行；
 *   - scope 数有上限（LRU 淘汰），长期不关的会话不会无限堆积。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { DirEntry } from '../../hooks/useFileTree';
import { flattenTree, TREE_ROW_PITCH } from '../treeRows';
import {
  _resetTreeScrollAnchorsForTests,
  computeTreeRestoreScrollTop,
  computeTreeScrollAnchor,
  loadTreeScrollAnchor,
  makeTreeScrollScope,
  saveTreeScrollAnchor,
} from '../treeScrollStore';

function file(name: string): DirEntry {
  return { name, relPath: name, type: 'file', size: 1, mtimeMs: 0 };
}

function dir(name: string): DirEntry {
  return { name, relPath: name, type: 'directory', size: 0, mtimeMs: 0 };
}

const rows = flattenTree(
  new Map([
    ['', [file('a.ts'), dir('src'), file('z.ts')]],
    ['src', [file('src/x.ts'), file('src/y.ts')]],
  ]),
  new Set(['']),
  null,
);

// 展开 src 后的行序：a.ts, src, src/x.ts, src/y.ts, z.ts
const expandedRows = flattenTree(
  new Map([
    ['', [file('a.ts'), dir('src'), file('z.ts')]],
    ['src', [file('src/x.ts'), file('src/y.ts')]],
  ]),
  new Set(['', 'src']),
  null,
);

describe('treeScrollStore', () => {
  beforeEach(() => {
    _resetTreeScrollAnchorsForTests();
  });

  it('save / load 在同一 scope 内往返', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo::reveal');
    saveTreeScrollAnchor(scope, { rowKey: 'src/x.ts', offset: 7 });

    expect(loadTreeScrollAnchor(scope)).toEqual({ rowKey: 'src/x.ts', offset: 7 });
  });

  it('不同视口 / 不同 store 互不污染', () => {
    const tabA = makeTreeScrollScope('tab-a', '/repo');
    const tabB = makeTreeScrollScope('tab-b', '/repo');
    const reveal = makeTreeScrollScope('tab-a', '/repo::reveal');

    saveTreeScrollAnchor(tabA, { rowKey: 'a.ts', offset: 0 });
    saveTreeScrollAnchor(tabB, { rowKey: 'z.ts', offset: 3 });
    saveTreeScrollAnchor(reveal, { rowKey: 'node_modules', offset: 1 });

    expect(loadTreeScrollAnchor(tabA)?.rowKey).toBe('a.ts');
    expect(loadTreeScrollAnchor(tabB)?.rowKey).toBe('z.ts');
    expect(loadTreeScrollAnchor(reveal)?.rowKey).toBe('node_modules');
  });

  it('scope 超上限时先淘汰最久未写入的（LRU）', () => {
    const first = 'scope-0';
    for (let i = 0; i < 129; i++) {
      saveTreeScrollAnchor(`scope-${i}`, { rowKey: `row-${i}`, offset: 0 });
    }
    expect(loadTreeScrollAnchor(first)).toBeNull();
    expect(loadTreeScrollAnchor('scope-128')?.rowKey).toBe('row-128');
  });

  it('重写已有 scope 会刷新它的新鲜度（不因早写入而被淘汰）', () => {
    saveTreeScrollAnchor('old', { rowKey: 'a', offset: 0 });
    for (let i = 0; i < 127; i++) {
      saveTreeScrollAnchor(`s-${i}`, { rowKey: `r-${i}`, offset: 0 });
    }
    // 再写一次 old，把它挪到队尾；随后再塞一条触发淘汰。
    saveTreeScrollAnchor('old', { rowKey: 'a2', offset: 0 });
    saveTreeScrollAnchor('newest', { rowKey: 'n', offset: 0 });

    expect(loadTreeScrollAnchor('old')?.rowKey).toBe('a2');
    expect(loadTreeScrollAnchor('s-0')).toBeNull();
  });
});

describe('computeTreeScrollAnchor / computeTreeRestoreScrollTop', () => {
  it('顶部行 + 行内偏移（含首尾留白）', () => {
    // 顶部留白 8px，行 pitch 29：scrollTop = 8 + 2*29 + 5 → 第 3 行、行内 5px。
    expect(computeTreeScrollAnchor(expandedRows, 8 + 2 * 29 + 5)).toEqual({
      rowKey: 'src/x.ts',
      offset: 5,
    });
    expect(computeTreeScrollAnchor(expandedRows, 0)).toEqual({
      rowKey: 'a.ts',
      offset: 0,
    });
  });

  it('滚动超出末尾时钳到最后一行，且 offset 不越界', () => {
    const anchor = computeTreeScrollAnchor(rows, 100_000);
    expect(anchor?.rowKey).toBe('z.ts');
    // 不变量：0 ≤ offset < pitch（scrollTop 越界时也不能让锚点记录失真）。
    expect(anchor!.offset).toBeGreaterThanOrEqual(0);
    expect(anchor!.offset).toBeLessThan(TREE_ROW_PITCH);
  });

  it('空树返回 null', () => {
    expect(computeTreeScrollAnchor([], 0)).toBeNull();
  });

  it('锚点行换一批行后仍定位到同一行', () => {
    // 展开 src 前后，z.ts 从索引 2 变 4。
    const anchor = computeTreeScrollAnchor(rows, 8 + 2 * 29);
    expect(anchor?.rowKey).toBe('z.ts');
    expect(computeTreeRestoreScrollTop(expandedRows, anchor!)).toBe(8 + 4 * 29);
  });

  it('锚点行不在当前树里返回 null（等数据 / 被折叠由调用方决定）', () => {
    const anchor = computeTreeScrollAnchor(expandedRows, 8 + 2 * 29);
    expect(anchor?.rowKey).toBe('src/x.ts');
    // rows 没展开 src：src/x.ts 不可见。
    expect(computeTreeRestoreScrollTop(rows, anchor!)).toBeNull();
  });
});
