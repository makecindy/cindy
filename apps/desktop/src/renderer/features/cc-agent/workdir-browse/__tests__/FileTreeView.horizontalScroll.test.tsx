// @vitest-environment jsdom

/**
 * FileTreeView 横向滚动契约（组件结构 + globals.css 规则两层）。
 *
 * jsdom 不做布局，这里锁的是「行宽由内容决定 + 容器承接横向滚动 + 横条常显」这组
 * 结构不变量；真实几何由实机 CDP 复测（2026-09-14，200px 面板 + 真实样式表）：
 * 修复前行 depth ≥9 名字宽 0、scrollWidth 只有 280；修复后行宽跟随内容，depth 15
 * 名字恢复全宽、scrollWidth 549，横滚可读到全名。
 *
 * 本用例在 p3（PR #4398）的虚拟化 FileTreeView 上同样成立：#4436 落地的是「行宽
 * 内容驱动 + 容器承接横滚 + 横条常显」契约，虚拟化只改行的定位方式，不改契约；
 * 行视图靠树视口替身（jsdom 无布局，否则虚拟器产 0 行）。
 *
 * 背景：窄面板（RSB 文件浏览器 200px）里深层目录会一路缩进，旧行 `w-full` +
 * 名字 `truncate` 只会把内容挤成 0 宽，永远撑不出滚动区 —— 深层目标"消失"且没有
 * 横向滚动条可救。CSS 规则存在性靠静态断言（jsdom 不加载样式表），与
 * __tests__/diffHorizontalScroll.test.tsx 的既有做法一致。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView, type FileTreeViewHandle } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';
import {
  flushTreeVirtualizerScrollReset,
  installTreeViewportStub,
  resetTestViewportSize,
  setTestViewportSize,
} from './treeViewportStub';

// jsdom 无布局：不装视口替身的话虚拟器产出 0 行（见 treeViewportStub 注释）。
beforeAll(installTreeViewportStub);

const globalsSrc = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', 'styles', 'globals.css'),
  'utf8',
);

const rootEntries: DirEntry[] = [
  { name: 'cat.png', relPath: 'cat.png', type: 'file', size: 10, mtimeMs: 1 },
  { name: 'deep', relPath: 'deep', type: 'directory', size: 0, mtimeMs: 2 },
];
const deepEntries: DirEntry[] = [
  { name: 'l2', relPath: 'deep/l2', type: 'directory', size: 0, mtimeMs: 3 },
];
const deeperEntries: DirEntry[] = [
  { name: 'l3', relPath: 'deep/l2/l3', type: 'directory', size: 0, mtimeMs: 4 },
];
const otherEntries: DirEntry[] = [
  { name: 'l2', relPath: 'other/l2', type: 'directory', size: 0, mtimeMs: 5 },
];
const otherDeeperEntries: DirEntry[] = [
  { name: 'l3', relPath: 'other/l2/l3', type: 'directory', size: 0, mtimeMs: 6 },
];

/**
 * 120 行文件 + deep / other 两棵深目录：目标行（`deep/l2/l3` = 行 122、
 * `other/l2/l3` = 行 125）都远在 300px 视口（约 10 行 + overscan）之外，
 * 初始不在 DOM 里 —— 用来覆盖「目标行要靠虚拟滚动才挂载」那条路径。
 */
function makeFarTargetsTree(): UseFileTreeReturn {
  const many: DirEntry[] = Array.from({ length: 120 }, (_, i) => ({
    name: `f${i}.ts`,
    relPath: `f${i}.ts`,
    type: 'file',
    size: 1,
    mtimeMs: 0,
  }));
  return {
    entries: new Map([
      ['', [...many, rootEntries[1], { name: 'other', relPath: 'other', type: 'directory', size: 0, mtimeMs: 5 }]],
      ['deep', deepEntries],
      ['deep/l2', deeperEntries],
      ['other', otherEntries],
      ['other/l2', otherDeeperEntries],
    ]),
    expanded: new Set(['', 'deep', 'deep/l2', 'other', 'other/l2']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    showIgnoredDirsSupported: true,
    storeKey: 'test-store',
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

function makeTree(): UseFileTreeReturn {
  return {
    entries: new Map([
      ['', rootEntries],
      ['deep', deepEntries],
      ['deep/l2', deeperEntries],
    ]),
    expanded: new Set(['', 'deep', 'deep/l2']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    showIgnoredDirsSupported: true,
    storeKey: 'test-store',
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

afterEach(async () => {
  // 先排干 react-virtual 的 150ms「滚动结束」debounce，再卸载：否则它会在 jsdom
  // 环境被拆掉之后触发 React 更新（见 treeViewportStub 注释）。
  await flushTreeVirtualizerScrollReset();
  cleanup();
  resetTestViewportSize();
});

/** jsdom 无布局：行/容器的矩形手工摆（left/right 足以驱动横轴计算）。 */
function rect(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 28,
    width: right - left,
    height: 28,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('FileTreeView 横向滚动契约', () => {
  it('滚动容器承接横向溢出，并挂常显横条样式钩子（tree-hscroll）', () => {
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );

    // 根节点即滚动容器（scrollToPath querySelector 也依赖它）。
    const scroll = container.firstElementChild as HTMLElement;
    expect(scroll.className).toContain('overflow-auto');
    expect(scroll.className).toContain('tree-hscroll');
  });

  it('文件行 / 重命名行 / 新建行都按内容撑宽（min-w-max），深层缩进不再挤没内容', () => {
    render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
        renamingPath="cat.png"
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        pendingCreate={{ kind: 'file', parentRel: '' }}
        onPendingSubmit={vi.fn()}
        onPendingCancel={vi.fn()}
      />,
    );

    // depth 2 的目录行（deep/l2/l3）：未处于编辑态的文件/文件夹行。
    const deepRow = screen.getByText('l3').closest('[data-relpath]');
    expect(deepRow?.className).toContain('min-w-max');

    // 重命名行：input 的父节点就是行容器。
    const renameRow = screen.getByDisplayValue('cat.png').parentElement;
    expect(renameRow?.className).toContain('min-w-max');

    // 新建行：placeholder 由 pending.kind 决定，这里 file → untitled。
    const pendingRow = screen.getByPlaceholderText('untitled').parentElement;
    expect(pendingRow?.className).toContain('min-w-max');
  });

  it('reveal 目标行时把横轴也拉进可见区（深层宽行不会停在视口右侧外面）', () => {
    const ref = createRef<FileTreeViewHandle>();
    const { container } = render(
      <FileTreeView
        ref={ref}
        tree={makeTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );

    const scroll = container.firstElementChild as HTMLElement;
    const row = scroll.querySelector<HTMLElement>('[data-relpath="deep/l2/l3"]');
    expect(row).toBeTruthy();

    // jsdom 无布局：手工摆出「容器 200px，目标行 40→320」的几何（行比容器宽 120px）。
    scroll.getBoundingClientRect = () => rect(0, 200);
    row!.getBoundingClientRect = () => rect(40, 320);

    ref.current?.scrollToPath('deep/l2/l3');

    // 修复前（只滚纵向）这里恒为 0：行名一直停在视口右侧外面。
    expect(scroll.scrollLeft).toBe(120);
  });

  it('目标行还没进虚拟窗口时，挂载后仍会把横轴对齐（不依赖固定时刻的尝试）', async () => {
    setTestViewportSize(300);
    const ref = createRef<FileTreeViewHandle>();
    const { container } = render(
      <FileTreeView
        ref={ref}
        tree={makeFarTargetsTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const scroll = container.firstElementChild as HTMLElement;
    expect(scroll.querySelector('[data-relpath="deep/l2/l3"]')).toBeNull();

    ref.current?.scrollToPath('deep/l2/l3');

    // 模拟虚拟器把目标行带进视口（真实里由 smooth 纵向滚动触发）。
    scroll.scrollTop = 122 * 29;
    fireEvent.scroll(scroll);
    const row = scroll.querySelector<HTMLElement>('[data-relpath="deep/l2/l3"]');
    expect(row).toBeTruthy();

    // 行挂载后才摆几何：容器 200px、行 40→320。
    scroll.getBoundingClientRect = () => rect(0, 200);
    row!.getBoundingClientRect = () => rect(40, 320);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(scroll.scrollLeft).toBe(120);
  });

  it('连续两次导航时，旧目标挂载不会把横轴从最新目标拉回去', async () => {
    setTestViewportSize(300);
    const ref = createRef<FileTreeViewHandle>();
    const { container } = render(
      <FileTreeView
        ref={ref}
        tree={makeFarTargetsTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const scroll = container.firstElementChild as HTMLElement;

    // 用户连点两个搜索结果：两次导航的目标都还没挂载。
    ref.current?.scrollToPath('deep/l2/l3');
    ref.current?.scrollToPath('other/l2/l3');

    // 只有旧目标进了视口（新目标还没到）——它的对齐任务必须已经失效。
    scroll.scrollTop = 122 * 29;
    fireEvent.scroll(scroll);
    const staleRow = scroll.querySelector<HTMLElement>('[data-relpath="deep/l2/l3"]');
    expect(staleRow).toBeTruthy();
    scroll.getBoundingClientRect = () => rect(0, 200);
    staleRow!.getBoundingClientRect = () => rect(40, 700);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // 旧任务若没被取消：这里会变成 500（旧行右缘 700 - 容器右缘 200）。
    expect(scroll.scrollLeft).toBe(0);
  });

  it('随后导航到树里不存在的路径，也会作废上一次的对齐任务', async () => {
    setTestViewportSize(300);
    const ref = createRef<FileTreeViewHandle>();
    const { container } = render(
      <FileTreeView
        ref={ref}
        tree={makeFarTargetsTree()}
        scrollScope="test-tab"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const scroll = container.firstElementChild as HTMLElement;

    // 第一次导航指向一个还没挂载的有效目标；第二次指向树里不存在的路径
    // （`index < 0` 提前返回）—— 这次「无效导航」也必须让旧任务失效。
    ref.current?.scrollToPath('deep/l2/l3');
    ref.current?.scrollToPath('nope/missing.ts');

    // 旧目标随后进了视口：它的对齐任务必须已经被作废。
    scroll.scrollTop = 122 * 29;
    fireEvent.scroll(scroll);
    const staleRow = scroll.querySelector<HTMLElement>('[data-relpath="deep/l2/l3"]');
    expect(staleRow).toBeTruthy();
    scroll.getBoundingClientRect = () => rect(0, 200);
    staleRow!.getBoundingClientRect = () => rect(40, 700);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // 若取消发生在 `index < 0` 检查之后：这里会变成 500。
    expect(scroll.scrollLeft).toBe(0);
  });
});

describe('globals.css 里的 .tree-hscroll 规则', () => {
  it('横向 thumb 用 --msg-scrollbar（不是透明）', () => {
    expect(globalsSrc).toMatch(
      /\.tree-hscroll::-webkit-scrollbar-thumb:horizontal\s*\{\s*background-color:\s*var\(--msg-scrollbar\);\s*\}/,
    );
  });

  it('横向槽厚 12px，与全局纵向槽宽对齐', () => {
    expect(globalsSrc).toMatch(
      /\.tree-hscroll::-webkit-scrollbar:horizontal\s*\{\s*height:\s*12px;\s*\}/,
    );
    expect(globalsSrc).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*12px;\s*\}/);
  });
});
