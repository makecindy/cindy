// @vitest-environment jsdom

/**
 * FileTreeView 的虚拟滚动与滚动位置保持（组件集成层）。
 *
 * 需求对应：
 *   - 使用虚拟滚动：长列表只渲染视口内 + overscan 的行；
 *   - 切 tab 保留原 tab 的滚动位置：同一 store 上不同 scrollScope 各自记位置；
 *   - 隐藏被忽略的目录再显示时恢复原滚动位置：开关切 store（storeKey 变），
 *     放行态自己的锚点仍在，切回来恢复。
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';
import {
  _resetTreeScrollAnchorsForTests,
  loadTreeScrollAnchor,
  makeTreeScrollScope,
  saveTreeScrollAnchor,
} from '../lib/treeScrollStore';
import { installTreeViewportStub, resetTestViewportSize, setTestViewportSize } from './treeViewportStub';

beforeAll(installTreeViewportStub);

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

function makeTree(opts: {
  entries: Array<readonly [string, readonly DirEntry[]]>;
  expanded?: string[];
  storeKey?: string;
}): UseFileTreeReturn {
  return {
    entries: new Map(opts.entries),
    expanded: new Set(opts.expanded ?? ['']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    showIgnoredDirsSupported: true,
    storeKey: opts.storeKey ?? 'workdir::hidden',
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

/** FileTreeView 的根节点就是滚动容器。 */
function viewportOf(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe('FileTreeView 虚拟滚动', () => {
  it('长列表只渲染视口内的行（视口 300px / 200 行）', () => {
    setTestViewportSize(300);
    const entries: DirEntry[] = Array.from({ length: 200 }, (_, i) =>
      file(`f${String(i).padStart(3, '0')}.ts`),
    );
    const { container } = render(
      <FileTreeView
        tree={makeTree({ entries: [['', entries]] })}
        scrollScope="tab-a"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const el = viewportOf(container);

    const rendered = el.querySelectorAll('[data-relpath]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(entries.length);
    expect(rendered[0].getAttribute('data-relpath')).toBe('f000.ts');

    // 滚到近底部：末尾行进入 DOM，顶部行被回收。
    el.scrollTop = 200 * 29;
    fireEvent.scroll(el);
    const afterScroll = el.querySelectorAll('[data-relpath]');
    expect(
      [...afterScroll].some(
        (row) => row.getAttribute('data-relpath') === 'f199.ts',
      ),
    ).toBe(true);
    expect(
      [...afterScroll].some((row) => row.getAttribute('data-relpath') === 'f000.ts'),
    ).toBe(false);
  });

  it('首挂载即隐藏（active=false，滚动元素未交给虚拟器）不渲染任何行', () => {
    const entries: DirEntry[] = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`));
    const { container } = render(
      <FileTreeView
        tree={makeTree({ entries: [['', entries]] })}
        scrollScope="tab-a"
        active={false}
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );

    // 真实隐藏 tab 的机制：getScrollElement 返回 null → 从未测量 → initialRect
    // {0,0} → range null → 0 行（而不是依赖容器高度为 0 这条等价路径）。
    expect(viewportOf(container).querySelectorAll('[data-relpath]')).toHaveLength(0);
  });

  /**
   * keep-alive 的另一半：可见过再隐藏的 tab，virtual-core 的 cleanup() 不清
   * scrollRect，会保留最后一个视口的行。这是**当前实际行为**（成本有界，且顺带
   * 让编辑行切 tab 不卸载），不是「隐藏即 0 行」——用测试锁住，避免以后有人按
   * 错误理解改动 getScrollElement / range 逻辑。
   */
  it('可见过再隐藏（active 翻转）保留最后一个视口的行，且行数有界', () => {
    setTestViewportSize(300);
    const entries: DirEntry[] = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`));
    const tree = makeTree({ entries: [['', entries]] });
    const { container, rerender } = render(
      <FileTreeView tree={tree} scrollScope="tab-a" active selectedPath={null} onSelectFile={vi.fn()} />,
    );
    const el = viewportOf(container);
    expect(el.querySelectorAll('[data-relpath]').length).toBeGreaterThan(0);

    rerender(
      <FileTreeView
        tree={tree}
        scrollScope="tab-a"
        active={false}
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const hiddenRows = el.querySelectorAll('[data-relpath]').length;
    expect(hiddenRows).toBeGreaterThan(0); // 保留陈旧视口，不是 0
    expect(hiddenRows).toBeLessThan(60); // 有界，不回退全量渲染
  });
});

describe('FileTreeView 滚动位置保持', () => {
  it('同一 store 上不同 tab（scrollScope）各自恢复各自的位置', () => {
    const storeKey = '/repo::hidden';
    const tree = makeTree({
      entries: [
        ['', [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts')]],
      ],
      storeKey,
    });
    // 只给 tab-a 存锚点；tab-b 没有锚点应停在顶部。
    saveTreeScrollAnchor(makeTreeScrollScope('tab-a', storeKey), {
      rowKey: 'c.ts',
      offset: 5,
    });

    const { container } = render(
      <>
        <div data-testid="tab-a">
          <FileTreeView
            tree={tree}
            scrollScope="tab-a"
            selectedPath={null}
            onSelectFile={vi.fn()}
          />
        </div>
        <div data-testid="tab-b">
          <FileTreeView
            tree={tree}
            scrollScope="tab-b"
            selectedPath={null}
            onSelectFile={vi.fn()}
          />
        </div>
      </>,
    );
    const elA = container.querySelector<HTMLElement>('[data-testid="tab-a"]')!
      .firstElementChild as HTMLElement;
    const elB = container.querySelector<HTMLElement>('[data-testid="tab-b"]')!
      .firstElementChild as HTMLElement;

    expect(elA.scrollTop).toBe(8 + 2 * 29 + 5);
    expect(elB.scrollTop).toBe(0);

    // tab-b 自己滚到别处：只写 tab-b 的锚点，不污染 tab-a。
    elB.scrollTop = 8 + 3 * 29;
    fireEvent.scroll(elB);
    expect(loadTreeScrollAnchor(makeTreeScrollScope('tab-b', storeKey))).toEqual({
      rowKey: 'd.ts',
      offset: 0,
    });
    expect(loadTreeScrollAnchor(makeTreeScrollScope('tab-a', storeKey))).toEqual({
      rowKey: 'c.ts',
      offset: 5,
    });
  });

  it('隐藏被忽略的目录再显示时，回到放行态原来的位置', () => {
    const hiddenKey = '/repo::hidden';
    const revealKey = '/repo::reveal';
    const hiddenTree = makeTree({
      entries: [['', [file('src.ts'), directory('node_modules')]]],
      expanded: [''],
      storeKey: hiddenKey,
    });
    // 放行态：node_modules 展开，行序 src.ts / node_modules / node_modules/pkg.json。
    const revealTree = makeTree({
      entries: [
        ['', [file('src.ts'), directory('node_modules')]],
        ['node_modules', [file('pkg.json', 'node_modules')]],
      ],
      expanded: ['', 'node_modules'],
      storeKey: revealKey,
    });

    const { container, rerender } = render(
      <FileTreeView
        tree={revealTree}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const el = viewportOf(container);

    // 用户在放行态滚到 node_modules/pkg.json。
    el.scrollTop = 8 + 2 * 29;
    fireEvent.scroll(el);

    // 关掉「显示被忽略的目录」→ 换 store；此刻视角可被浏览器/新布局复位。
    rerender(
      <FileTreeView
        tree={hiddenTree}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    el.scrollTop = 0;
    fireEvent.scroll(el);

    // 再打开开关 → 回到放行态自己的锚点。
    rerender(
      <FileTreeView
        tree={revealTree}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    expect(el.scrollTop).toBe(8 + 2 * 29);
  });

  it('锚点行不存在（首帧数据未到）时不乱滚，行到达后恢复', () => {
    const storeKey = '/repo::reveal';
    // 直接预置锚点：模拟上一次会话留下的位置（滚动记录路径已由上一条用例覆盖）。
    saveTreeScrollAnchor(makeTreeScrollScope('tab-1', storeKey), {
      rowKey: 'e.ts',
      offset: 0,
    });

    const seedTree = makeTree({
      entries: [['', [file('a.ts')]]],
      storeKey,
    });
    const fullTree = makeTree({
      entries: [['', [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts'), file('e.ts')]]],
      storeKey,
    });

    const { container, rerender } = render(
      <FileTreeView
        tree={seedTree}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    const el = viewportOf(container);
    expect(el.scrollTop).toBe(0);

    rerender(
      <FileTreeView
        tree={fullTree}
        scrollScope="tab-1"
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );
    expect(el.scrollTop).toBe(8 + 4 * 29);
  });
});
