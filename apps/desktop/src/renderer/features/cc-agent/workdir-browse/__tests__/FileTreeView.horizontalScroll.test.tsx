// @vitest-environment jsdom

/**
 * FileTreeView 横向滚动契约（组件结构层）。
 *
 * jsdom 不做布局，这里锁的是「行宽由内容决定 + 容器承接横向滚动 + 横条常显」这组
 * 结构不变量；真实几何由实机 CDP 复测（2026-09-14，200px 面板 + 真实样式表）：
 * 修复前行 depth ≥9 名字宽 0、scrollWidth 只有 280；修复后行宽跟随内容，depth 15
 * 名字恢复全宽、scrollWidth 549，横滚可读到全名。
 *
 * 背景：窄面板（RSB 文件浏览器 200px）里深层目录会一路缩进，旧行 `w-full` +
 * 名字 `truncate` 只会把内容挤成 0 宽，永远撑不出滚动区 —— 深层目标"消失"且没有
 * 横向滚动条可救（回归防护见下方断言）。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';

const entries: DirEntry[] = [
  { name: 'cat.png', relPath: 'cat.png', type: 'file', size: 10, mtimeMs: 1 },
  { name: 'deep', relPath: 'deep', type: 'directory', size: 0, mtimeMs: 2 },
];

function makeTree(): UseFileTreeReturn {
  return {
    entries: new Map([['', entries]]),
    expanded: new Set(['']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

afterEach(() => cleanup());

describe('FileTreeView 横向滚动契约', () => {
  it('滚动容器承接横向溢出，并挂常显横条样式钩子（tree-hscroll）', () => {
    const { container } = render(
      <FileTreeView tree={makeTree()} selectedPath={null} onSelectFile={vi.fn()} />,
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

    // 未处于编辑态的文件/文件夹行。
    const deepRow = screen.getByText('deep').closest('[data-relpath]');
    expect(deepRow?.className).toContain('min-w-max');

    // 重命名行：input 的父节点就是行容器。
    const renameRow = screen.getByDisplayValue('cat.png').parentElement;
    expect(renameRow?.className).toContain('min-w-max');

    // 新建行：placeholder 由 pending.kind 决定，这里 file → untitled。
    const pendingRow = screen.getByPlaceholderText('untitled').parentElement;
    expect(pendingRow?.className).toContain('min-w-max');
  });
});
