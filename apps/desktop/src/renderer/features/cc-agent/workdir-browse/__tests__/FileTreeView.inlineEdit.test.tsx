// @vitest-environment jsdom

/**
 * 行内编辑行在虚拟滚动下必须存活。
 *
 * 回归背景（reviewer 实机审查 P1）：虚拟化会把视口外的行卸载，而 InlineTreeRow
 * 的输入值是组件内 state、提交靠 blur —— 元素被移除时浏览器不派发 blur，用户
 * 打了一半的文件名会静默丢失；滚回来还会以空值重新挂载并抢焦点。修复方式是把
 * 「正在编辑的那一行」用 rangeExtractor 钉在虚拟窗口里，其余行照旧回收。
 *
 * 本文件锁两件事：
 *   1. 编辑行不在视口内时仍然渲染（含输入值与焦点不丢）；
 *   2. 滚动过程中输入的内容完整保留，且能正常提交。
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';
import { _resetTreeScrollAnchorsForTests } from '../lib/treeScrollStore';
import { installTreeViewportStub, resetTestViewportSize, setTestViewportSize } from './treeViewportStub';

beforeAll(installTreeViewportStub);

// 锚点是模块级 store：不复位的话上一条用例滚出的锚点会被下一条用例恢复，
// 用例间串初始位置（reviewer P3）。
beforeEach(() => {
  _resetTreeScrollAnchorsForTests();
});

afterEach(() => {
  cleanup();
  resetTestViewportSize();
});

function file(name: string, parent = ''): DirEntry {
  return {
    name,
    relPath: parent ? `${parent}/${name}` : name,
    type: 'file',
    size: 1,
    mtimeMs: 0,
  };
}

function directory(relPath: string): DirEntry {
  return { name: relPath, relPath, type: 'directory', size: 0, mtimeMs: 0 };
}

/** d 展开 + 200 个子文件：编辑行与视口之间可以隔很远。 */
const children: DirEntry[] = Array.from({ length: 200 }, (_, i) =>
  file(`f${String(i).padStart(3, '0')}.ts`, 'd'),
);

function makeTree(): UseFileTreeReturn {
  return {
    entries: new Map([
      ['', [directory('d')]],
      ['d', children],
    ]),
    expanded: new Set(['', 'd']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    showIgnoredDirsSupported: true,
    storeKey: '/repo::hidden',
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

describe('FileTreeView 行内编辑不受虚拟化回收影响', () => {
  it('重命名行不在视口内也渲染：滚走不丢草稿、不重挂载抢焦点', () => {
    setTestViewportSize(300);
    const onRenameSubmit = vi.fn();
    const onRenameCancel = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
        renamingPath="d/f150.ts"
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
      />,
    );

    // 行 index ≈ 151，远在 300px 视口（≈22 行）之外：普通行会被回收，编辑行不会。
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('f150.ts');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input!, { target: { value: 'renamed.ts' } });
    const scroller = container.firstElementChild as HTMLElement;
    scroller.scrollTop = 5000;
    fireEvent.scroll(scroller);

    const afterScroll = container.querySelector<HTMLInputElement>('input');
    expect(afterScroll).toBe(input); // 同一个 DOM 节点：没有卸载重挂载
    expect(afterScroll?.value).toBe('renamed.ts');
    expect(document.activeElement).toBe(afterScroll);

    fireEvent.keyDown(afterScroll!, { key: 'Enter' });
    expect(onRenameSubmit).toHaveBeenCalledWith('renamed.ts');
    expect(onRenameCancel).not.toHaveBeenCalled();
  });

  it('新建行同样被钉住：滚动后输入保留并可提交', () => {
    setTestViewportSize(300);
    const onPendingSubmit = vi.fn();
    const onPendingCancel = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
        pendingCreate={{ kind: 'file', parentRel: 'd' }}
        onPendingSubmit={onPendingSubmit}
        onPendingCancel={onPendingCancel}
      />,
    );
    const input = () => container.querySelector<HTMLInputElement>('input');
    expect(input()?.placeholder).toBe('untitled');
    expect(document.activeElement).toBe(input());

    const scroller = container.firstElementChild as HTMLElement;
    scroller.scrollTop = 5000;
    fireEvent.scroll(scroller);
    expect(input()).not.toBeNull();

    fireEvent.change(input()!, { target: { value: 'notes.md' } });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(input()?.value).toBe('notes.md');

    fireEvent.keyDown(input()!, { key: 'Enter' });
    expect(onPendingSubmit).toHaveBeenCalledWith('notes.md');
    expect(onPendingCancel).not.toHaveBeenCalled();
  });

  it('普通行照旧按视口回收（钉住的只有编辑行）', () => {
    setTestViewportSize(300);
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
        renamingPath="d/f150.ts"
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
      />,
    );
    const scroller = container.firstElementChild as HTMLElement;
    const rendered = () => scroller.querySelectorAll('[data-relpath]').length;

    expect(rendered()).toBeLessThan(60);
    scroller.scrollTop = 5000;
    fireEvent.scroll(scroller);
    expect(rendered()).toBeLessThan(60);
  });
});
