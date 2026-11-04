// @vitest-environment jsdom

/**
 * FileTreeView 的 active prop —— RSB 多标签是 keep-alive（同时挂载、CSS hidden
 * 切换可见性），隐藏 tab 的树此前照常渲染全部行。
 *
 * 起因（实测）：每行（lucide 图标 + i18n wrapper + DOM 创建）约 0.25ms，`node_modules`
 * 展开后单棵树就有上千行 —— 两份并行渲染把展开时的主线程阻塞从 ~312-360ms 抬到
 * 570-740ms。数据层留在父组件（useFileTree 的 store / watcher / 展开态持久化），
 * 这里只规定「隐藏宿主不产出 DOM」。
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';
import {
  flushTreeVirtualizerScrollReset,
  installTreeViewportStub,
  resetTestViewportSize,
} from './treeViewportStub';

beforeAll(installTreeViewportStub);

const entries: DirEntry[] = [
  { name: 'index.ts', relPath: 'index.ts', type: 'file', size: 10, mtimeMs: 1 },
  { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 2 },
];

function makeTree(): UseFileTreeReturn {
  return {
    entries: new Map([['', entries]]),
    expanded: new Set(['']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    storeKey: 'test-store',
    treeIdentityKey: 'test-store',
    showIgnoredDirsSupported: true,
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

afterEach(async () => {
  // 先排干 react-virtual 的 150ms「滚动结束」debounce，再卸载（见 treeViewportStub 注释）。
  await flushTreeVirtualizerScrollReset();
  cleanup();
  resetTestViewportSize();
});

describe('FileTreeView active prop（隐藏 tab 不渲染行，容器保留）', () => {
  it('active 翻转时滚动容器同一节点，scrollTop 跨隐藏存活（评审 P2）', async () => {
    const { container, rerender } = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const scroller = container.querySelector('.tree-hscroll') as HTMLElement;
    expect(scroller).not.toBeNull();
    scroller.scrollTop = 200;

    rerender(
      <FileTreeView
        active={false}
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    // 虚拟化后隐藏保留最后一个视口的行（有界，见 scroll.test 的契约用例），
    // 这里只锁滚动容器不被卸载：return null 式实现会连容器卸掉，切回标签回到顶部。
    const hiddenScroller = container.querySelector('.tree-hscroll') as HTMLElement;
    expect(hiddenScroller).not.toBeNull();
    expect(hiddenScroller).toBe(scroller);
    expect(hiddenScroller.scrollTop).toBe(200);

    rerender(
      <FileTreeView
        active
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[data-relpath]')).toHaveLength(2);
    expect((container.querySelector('.tree-hscroll') as HTMLElement).scrollTop).toBe(200);
  });

  it('不传 active（doc 侧栏等单宿主场景）与 active=true 都照常渲染', () => {
    const defaulted = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    expect(defaulted.container.querySelectorAll('[data-relpath]')).toHaveLength(2);
    cleanup();

    const explicit = render(
      <FileTreeView
        active
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    expect(explicit.container.querySelectorAll('[data-relpath]')).toHaveLength(2);
  });
});