// @vitest-environment jsdom

/**
 * branchPickerSearch.test.tsx — 分支 chip 下拉里搜索框的交互契约。
 *
 * 这些行为光读源码看不出来(焦点归属、按键归属、面板开合时的状态清理),所以用真
 * Radix Popover 渲染,不 mock 容器:
 *
 *   1. 打开面板 → 焦点直接落在搜索框(不是面板本体),可以立刻打字;
 *      同时通知上层解锁分支列表懒加载
 *   2. 打字实时过滤,大小写不敏感;搜中间段 `cindy/auto` 能命中
 *   3. 一个都没命中 → 出"没有匹配的分支",且不残留任何 option 行
 *   4. Enter 选第一个匹配项并关面板;**没有匹配时 Enter 什么都不做、也不关面板**
 *      (手一快不该把输错的搜索词连面板一起丢掉)
 *   5. 关闭再打开 → 搜索框为空、列表回到全量(搜索词不跨次留存)
 *   6. roving tabIndex:只有首项在 Tab 序里,其余 -1 —— 分支上百条时逐项 Tab 是灾难
 *   7. 搜索框按 ↓ 把焦点交给列表首项;列表里 Home / End 跳首尾
 *   8. loading / failed 两态各自的呈现,以及重试不关面板
 *
 * 选分支的 effect 语义(选中当前源分支是 no-op 等)属于 branchPick 纯函数,回归在
 * branchPick.test.ts;这里只验证"点了哪一项就把哪一项交出去"。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BranchWorktreeChip } from '@/components/new-chat/WorktreeChipsRow';

const TEXT: Record<string, string> = {
  'newChat.branchChip.label': '分支',
  'newChat.branchChip.searchPlaceholder': '搜索分支…',
  'newChat.branchChip.noMatch': '没有匹配的分支',
  'newChat.branchChip.loading': '加载分支中…',
  'newChat.branchChip.loadFailed': '分支列表加载失败，点此重试',
  'newChat.branchChip.currentTooltip': '当前分支',
  'newChat.branchChip.sourceTooltip': 'worktree 源分支',
  'newChat.worktree.toggleAria': '切换 worktree',
  'newChat.worktree.chipTooltip': '为本次会话创建独立 worktree',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => TEXT[key] ?? key }),
}));

// Radix Popper 用 ResizeObserver 测位置;jsdom 没有这个全局,缺了会在挂载面板时抛。
// 位置计算本身在 jsdom 下没有意义,给个不回调的空壳即可。
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    });
  }
});

const BRANCHES = [
  'cindy/auto-k6cgvq',
  'cindy/auto-nv69fk',
  'fix/feishu-ack-emoji',
  'main',
];

function setup(
  overrides: Partial<React.ComponentProps<typeof BranchWorktreeChip>> = {},
): {
  onPick: ReturnType<typeof vi.fn>;
  onOpenRequested: ReturnType<typeof vi.fn>;
  onRetryBranches: ReturnType<typeof vi.fn>;
  onToggle: ReturnType<typeof vi.fn>;
} {
  const onPick = vi.fn();
  const onOpenRequested = vi.fn();
  const onRetryBranches = vi.fn();
  const onToggle = vi.fn();
  render(
    <BranchWorktreeChip
      branchLabel="main"
      branches={BRANCHES}
      branchesLoading={false}
      branchesFailed={false}
      onRetryBranches={onRetryBranches}
      checked={false}
      branchSourceSelected={false}
      branchInteractive
      onPick={onPick}
      onOpenRequested={onOpenRequested}
      onToggle={onToggle}
      {...overrides}
    />,
  );
  return { onPick, onOpenRequested, onRetryBranches, onToggle };
}

/** 点开分支半区,等搜索框拿到焦点后把它交回调用方。 */
async function openPanel(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByTestId('create-agent-branch-chip'));
  const input = await screen.findByPlaceholderText<HTMLInputElement>('搜索分支…');
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

const optionNames = (): string[] =>
  screen.queryAllByRole('option').map((el) => el.textContent ?? '');

afterEach(() => {
  cleanup();
});

describe('分支下拉搜索框', () => {
  it('打开面板即聚焦搜索框,并通知上层解锁分支列表', async () => {
    const { onOpenRequested } = setup();
    expect(screen.queryByPlaceholderText('搜索分支…')).toBeNull();

    await openPanel();

    expect(onOpenRequested).toHaveBeenCalledTimes(1);
    expect(optionNames()).toEqual(BRANCHES);
  });

  it('打字实时过滤,大小写不敏感,能搜中间段', async () => {
    setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'feishu' } });
    expect(optionNames()).toEqual(['fix/feishu-ack-emoji']);

    fireEvent.change(input, { target: { value: 'FEISHU' } });
    expect(optionNames()).toEqual(['fix/feishu-ack-emoji']);

    fireEvent.change(input, { target: { value: 'cindy/auto' } });
    expect(optionNames()).toEqual(['cindy/auto-k6cgvq', 'cindy/auto-nv69fk']);

    // 清空回到全量。
    fireEvent.change(input, { target: { value: '' } });
    expect(optionNames()).toEqual(BRANCHES);
  });

  it('一个都没命中时给出无匹配提示,且不残留 option 行', async () => {
    setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'zzz' } });

    expect(screen.getByText('没有匹配的分支')).toBeTruthy();
    expect(optionNames()).toEqual([]);
    // 与"加载失败,点此重试"是两回事,不能混用文案。
    expect(screen.queryByText('分支列表加载失败，点此重试')).toBeNull();
  });

  it('Enter 选中第一个匹配项并关掉面板', async () => {
    const { onPick } = setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'cindy' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).toHaveBeenCalledExactlyOnceWith('cindy/auto-k6cgvq');
    await waitFor(() => expect(screen.queryByPlaceholderText('搜索分支…')).toBeNull());
  });

  it('无匹配时 Enter 不选也不关面板', async () => {
    const { onPick } = setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).not.toHaveBeenCalled();
    // 面板还在,搜索词也还在 —— 用户可以接着改,不用重新点开。
    expect(screen.getByPlaceholderText<HTMLInputElement>('搜索分支…').value).toBe('zzz');
  });

  it('点击某一项就把那一项交给上层', async () => {
    const { onPick } = setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('option', { name: 'cindy/auto-nv69fk' }));

    expect(onPick).toHaveBeenCalledExactlyOnceWith('cindy/auto-nv69fk');
  });

  it('关闭再打开时搜索词已清空,列表回到全量', async () => {
    setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'feishu' } });
    expect(optionNames()).toEqual(['fix/feishu-ack-emoji']);

    // 选一项收起面板,再重新点开。
    fireEvent.click(screen.getByRole('option', { name: 'fix/feishu-ack-emoji' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('搜索分支…')).toBeNull());

    const reopened = await openPanel();
    expect(reopened.value).toBe('');
    expect(optionNames()).toEqual(BRANCHES);
  });

  it('只有首项在 Tab 序里,其余 tabIndex 为 -1', async () => {
    setup();
    await openPanel();

    const tabIndexes = screen.getAllByRole('option').map((el) => el.getAttribute('tabindex'));
    expect(tabIndexes).toEqual(['0', '-1', '-1', '-1']);
  });

  it('过滤后首项仍然是那条唯一在 Tab 序里的', async () => {
    setup();
    const input = await openPanel();

    fireEvent.change(input, { target: { value: 'cindy' } });

    expect(screen.getAllByRole('option').map((el) => el.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
    ]);
  });

  it('搜索框按 ↓ 把焦点交给列表首项,列表里 Home / End 跳首尾', async () => {
    setup();
    const input = await openPanel();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(document.activeElement).toBe(options[0]);

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'End' });
    expect(document.activeElement).toBe(options[options.length - 1]);

    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(document.activeElement).toBe(options[0]);
  });

  it('列表里 ↓ 逐项下移,到末项停住不环绕;↑ 越过首项回搜索框', async () => {
    setup();
    const input = await openPanel();
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');

    for (let i = 1; i < options.length; i += 1) {
      fireEvent.keyDown(listbox, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(options[i]);
    }
    // 末项继续往下停在末项,不跳回头部。
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[options.length - 1]);

    fireEvent.keyDown(listbox, { key: 'Home' });
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
  });

  it('加载中只显示 loading 文案,不出搜索结果', async () => {
    setup({ branchesLoading: true, branches: [] });
    await openPanel();

    expect(screen.getByText('加载分支中…')).toBeTruthy();
    expect(optionNames()).toEqual([]);
    // 搜索框照常渲染,不闪烁。
    expect(screen.getByPlaceholderText('搜索分支…')).toBeTruthy();
  });

  it('加载失败给重试入口,点重试不关面板', async () => {
    const { onRetryBranches } = setup({ branchesFailed: true, branches: [] });
    await openPanel();

    fireEvent.click(screen.getByText('分支列表加载失败，点此重试'));

    expect(onRetryBranches).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('搜索分支…')).toBeTruthy();
  });

  it('分支半区不可交互时根本不出下拉', () => {
    setup({ branchInteractive: false });

    fireEvent.click(screen.getByTestId('create-agent-branch-chip'));

    expect(screen.queryByPlaceholderText('搜索分支…')).toBeNull();
  });
});
