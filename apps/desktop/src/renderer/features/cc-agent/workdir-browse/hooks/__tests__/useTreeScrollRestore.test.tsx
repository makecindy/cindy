// @vitest-environment jsdom

/**
 * useTreeScrollRestore — 文件树滚动位置的保存与恢复。
 *
 * 覆盖三条需求路径：
 *   1. onScroll 持续记录锚点（顶部行 + 行内偏移）；
 *   2. scope（视口 + store key）变化 / 锚点行稍后才出现时恢复；
 *   3. 容器重新可见（隐藏 tab / 隐藏视图切回）时恢复，且隐藏态的 scrollTop
 *      复位不会覆盖已有锚点。
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DirEntry } from '../../hooks/useFileTree';
import { flattenTree, type TreeRow } from '../../lib/treeRows';
import {
  _resetTreeScrollAnchorsForTests,
  loadTreeScrollAnchor,
  makeTreeScrollScope,
  saveTreeScrollAnchor,
} from '../../lib/treeScrollStore';
import { useTreeScrollRestore } from '../useTreeScrollRestore';
import { installTreeViewportStub, resetTestViewportSize, setTestViewportSize } from '../../__tests__/treeViewportStub';

function file(name: string): DirEntry {
  return { name, relPath: name, type: 'file', size: 1, mtimeMs: 0 };
}

function makeRows(names: string[]): TreeRow[] {
  return flattenTree(
    new Map([['', names.map((n) => file(n))]]),
    new Set(['']),
    null,
  );
}

const rows5 = makeRows(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);

// jsdom 无布局：clientHeight 接替身变量（见 treeViewportStub），并装一个可手动
// 触发的 ResizeObserver，模拟「隐藏 → 重新可见」。
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const originalResizeObserver = globalThis.ResizeObserver;

// jsdom 无布局：不装视口替身的话 clientHeight 恒为 0，恢复分支会被当成「不可见」。
beforeAll(installTreeViewportStub);

beforeEach(() => {
  _resetTreeScrollAnchorsForTests();
  resetTestViewportSize();
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
});

function Harness({
  scope,
  rows,
  active = true,
}: {
  scope: string;
  rows: TreeRow[];
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useTreeScrollRestore(scope, rows, ref, active);
  return <div ref={ref} onScroll={onScroll} data-testid="viewport" />;
}

function viewportOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector<HTMLDivElement>('[data-testid="viewport"]')!;
}

describe('useTreeScrollRestore', () => {
  it('滚动时把「顶部行 + 行内偏移」写进锚点', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    const { container } = render(<Harness scope={scope} rows={rows5} />);
    const el = viewportOf(container);

    // 顶部留白 8 + 2 行 + 行内 4px。
    el.scrollTop = 8 + 2 * 29 + 4;
    fireEvent.scroll(el);

    expect(loadTreeScrollAnchor(scope)).toEqual({ rowKey: 'c.ts', offset: 4 });
  });

  it('挂载时恢复锚点（赶在绘制前）', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'd.ts', offset: 3 });

    const { container } = render(<Harness scope={scope} rows={rows5} />);

    expect(viewportOf(container).scrollTop).toBe(8 + 3 * 29 + 3);
  });

  it('锚点行稍后才进树（数据未到）时保持等待，行出现即恢复', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'e.ts', offset: 0 });

    const { container, rerender } = render(
      <Harness scope={scope} rows={rows5.slice(0, 3)} />,
    );
    expect(viewportOf(container).scrollTop).toBe(0);

    rerender(<Harness scope={scope} rows={rows5} />);
    expect(viewportOf(container).scrollTop).toBe(8 + 4 * 29);
  });

  it('scope 变化后恢复新 scope 的锚点', () => {
    const scopeA = makeTreeScrollScope('tab-1', '/repo');
    const scopeB = makeTreeScrollScope('tab-1', '/repo::reveal');
    saveTreeScrollAnchor(scopeA, { rowKey: 'a.ts', offset: 0 });
    saveTreeScrollAnchor(scopeB, { rowKey: 'e.ts', offset: 0 });

    const { container, rerender } = render(
      <Harness scope={scopeA} rows={rows5} />,
    );
    expect(viewportOf(container).scrollTop).toBe(8);

    rerender(<Harness scope={scopeB} rows={rows5} />);
    expect(viewportOf(container).scrollTop).toBe(8 + 4 * 29);
  });

  it('容器不可见时忽略 scroll（隐藏态 scrollTop 复位不算用户位置）', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'c.ts', offset: 2 });
    setTestViewportSize(0);

    const { container } = render(<Harness scope={scope} rows={rows5} />);
    const el = viewportOf(container);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    expect(loadTreeScrollAnchor(scope)).toEqual({ rowKey: 'c.ts', offset: 2 });
  });

  it('非激活 tab 不恢复；切回激活时恢复（RSB 多标签）', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'd.ts', offset: 2 });

    const { container, rerender } = render(
      <Harness scope={scope} rows={rows5} active={false} />,
    );
    const el = viewportOf(container);
    expect(el.scrollTop).toBe(0);

    rerender(<Harness scope={scope} rows={rows5} active />);
    expect(el.scrollTop).toBe(8 + 3 * 29 + 2);
  });

  it('重新可见（0 → 非 0）时恢复锚点', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'd.ts', offset: 1 });
    setTestViewportSize(0);

    const { container } = render(<Harness scope={scope} rows={rows5} />);
    expect(viewportOf(container).scrollTop).toBe(0);

    setTestViewportSize(600);
    FakeResizeObserver.instances[0].trigger();

    expect(viewportOf(container).scrollTop).toBe(8 + 3 * 29 + 1);
  });

  it('锚点行因上方插入而位移时，视图继续跟随锚点行（直到用户滚动）', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'c.ts', offset: 0 });

    const { container, rerender } = render(
      <Harness scope={scope} rows={makeRows(['a.ts', 'b.ts', 'c.ts'])} />,
    );
    const el = viewportOf(container);
    expect(el.scrollTop).toBe(8 + 2 * 29);

    // 上方插入两行：锚点行仍在顶部（换 store 后数据分批到达的缩影）。
    rerender(<Harness scope={scope} rows={makeRows(['x.ts', 'y.ts', 'a.ts', 'b.ts', 'c.ts'])} />);
    expect(el.scrollTop).toBe(8 + 4 * 29);
  });

  it('用户滚动后，后续 rows 变化不再把视图拉回旧锚点', () => {
    const scope = makeTreeScrollScope('tab-1', '/repo');
    saveTreeScrollAnchor(scope, { rowKey: 'e.ts', offset: 0 });

    const { container, rerender } = render(<Harness scope={scope} rows={rows5} />);
    const el = viewportOf(container);
    expect(el.scrollTop).toBe(8 + 4 * 29);

    // 用户滚回顶部：锚点被覆盖，之后的 rows 更新不应把视图拉回旧位置。
    el.scrollTop = 0;
    fireEvent.scroll(el);
    rerender(<Harness scope={scope} rows={makeRows(['a.ts', 'b.ts'])} />);

    expect(el.scrollTop).toBe(0);
    expect(loadTreeScrollAnchor(scope)).toEqual({ rowKey: 'a.ts', offset: 0 });
  });
});
