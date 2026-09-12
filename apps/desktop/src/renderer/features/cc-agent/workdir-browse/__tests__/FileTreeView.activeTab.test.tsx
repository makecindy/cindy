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

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';

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
    showIgnoredDirsSupported: true,
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

afterEach(() => cleanup());

describe('FileTreeView active prop（隐藏 tab 不渲染行）', () => {
  it('active=false 时不产出任何行 DOM', () => {
    const { container } = render(
      <FileTreeView active={false} tree={makeTree()} selectedPath={null} onSelectFile={vi.fn()} />,
    );

    expect(container.querySelectorAll('[data-relpath]')).toHaveLength(0);
    expect(container.firstChild).toBeNull();
  });

  it('不传 active（doc 侧栏等单宿主场景）与 active=true 都照常渲染', () => {
    const defaulted = render(
      <FileTreeView tree={makeTree()} selectedPath={null} onSelectFile={vi.fn()} />,
    );
    expect(defaulted.container.querySelectorAll('[data-relpath]')).toHaveLength(2);
    cleanup();

    const explicit = render(
      <FileTreeView active tree={makeTree()} selectedPath={null} onSelectFile={vi.fn()} />,
    );
    expect(explicit.container.querySelectorAll('[data-relpath]')).toHaveLength(2);
  });
});
