// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { runBotLifecycleAction, type BotProfile } from '../botStore';
import { BotLifecycleSettings } from '../BotLifecycleSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('../botStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../botStore')>();
  return { ...original, runBotLifecycleAction: vi.fn() };
});

function bot(status: BotProfile['status']): BotProfile {
  return {
    id: 'bot-1',
    name: 'Helper',
    description: '',
    avatar: '🤖',
    avatarColor: 'violet',
    enabled: true,
    status,
    skills: [],
    capabilities: {
      model: 'test-model',
      effort: '',
      fastMode: false,
      harness: 'pi',
      modelChain: [
        { harness: 'pi', model: 'test-model', providerId: null, effort: '', fastMode: false },
      ],
      skillMode: 'inherit',
      skillsExcluded: [],
      toolsetMode: 'inherit',
      toolsets: [],
      mcpMode: 'inherit',
      mcpServers: [],
      memory: true,
      permissions: 'ask',
    },
    createdAt: 1,
    sessions: [],
  };
}

beforeEach(() => {
  vi.mocked(runBotLifecycleAction).mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: {
        bots: {
          health: vi.fn(async () => null),
          lifecycleEvents: vi.fn(async () => []),
          searchHistory: vi.fn(async () => ({ results: [] })),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('BotLifecycleSettings v1 actions', () => {
  it('restarts from settings with pending and success feedback and no confirmation', async () => {
    let finish!: () => void;
    vi.mocked(runBotLifecycleAction).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ botId: 'bot-1', action: 'restart', status: 'active',
        affected: { sessions: 1, routes: 0, automations: 0, delegations: 0, deliveries: 0, worktrees: 0 } });
    }));
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
    expect(runBotLifecycleAction).toHaveBeenCalledWith({ botId: 'bot-1', action: 'restart' });
    const pending = screen.getByRole('button', { name: 'bots.lifecycle.restarting' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(runBotLifecycleAction).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('bots.lifecycle.restarted'));
  });

  it('keeps restart available after a failed attempt', async () => {
    vi.mocked(runBotLifecycleAction).mockRejectedValueOnce(new Error('unavailable'));
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'bots.lifecycle.restart' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders history search on its own settings page', async () => {
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    const restart = screen.getByRole('button', { name: 'bots.lifecycle.restart' });
    expect(restart.closest('details')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'bots.historySearch.title' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.historySearch.title' }), { target: { value: 'project' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.historySearch.search' }));
    await waitFor(() => expect(screen.getByText('bots.historySearch.empty')).toBeTruthy());
    expect(window.electronAPI.localDb.bots.searchHistory).toHaveBeenCalledWith({ botId: 'bot-1', query: 'project', limit: 20 });
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果：BotLifecycleSettings 的历史搜索（提交才查询）迁到 SearchInput 后，
   *   表单提交仍发起查询；点内置清空按钮后输入框清空、上一次的结果与报错一起消失。
   * - 规则依据：主人裁决 2026-11-27（所有搜索框都要有清空，提交式搜索清空后结果复位）。
   * - 现有覆盖缺口：上面的用例只覆盖点击「搜索」按钮，不覆盖清空后的复位。
   * - 最小失败输入：搜索 "project" 得到空结果后点清空，「bots.historySearch.empty」仍在。
   * - tier：unit（jsdom 渲染真实组件）。
   */
  it('submits the history search from the form and clears the last result with the clear button', async () => {
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    const box = screen.getByRole('textbox', { name: 'bots.historySearch.title' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'project' } });
    fireEvent.submit(box.form!);
    await waitFor(() => expect(screen.getByText('bots.historySearch.empty')).toBeTruthy());
    expect(window.electronAPI.localDb.bots.searchHistory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'commonUi.clearSearch' }));
    expect(box.value).toBe('');
    expect(screen.queryByText('bots.historySearch.empty')).toBeNull();
    expect(document.activeElement).toBe(box);
    // 清空按钮是 type="button"：没有再发起一次查询。
    expect(window.electronAPI.localDb.bots.searchHistory).toHaveBeenCalledTimes(1);
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果：查询还没返回时点清空，之后这次查询成功或失败都不能把结果 / 报错
   *   写回空输入框下面，「搜索中」也要立即复位。
   * - 规则依据：PR #13409 Greptile P2（清空后旧结果重新出现）。
   * - 现有覆盖缺口：上一条用例只覆盖查询返回之后再清空。
   * - 最小失败输入：提交 "project" → 点清空 → resolve({ results: [] }) 后出现
   *   「bots.historySearch.empty」，或 reject 后出现「bots.historySearch.failed」。
   * - tier：unit（jsdom 渲染真实组件）。
   */
  it.each(['resolve', 'reject'] as const)(
    'drops a pending history search cleared before it returns (%s)',
    async (outcome) => {
      let settle!: () => void;
      vi.mocked(window.electronAPI.localDb.bots.searchHistory).mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === 'resolve' ? resolve({ results: [] } as never) : reject(new Error('offline'));
          }),
      );
      render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
      const box = screen.getByRole('textbox', { name: 'bots.historySearch.title' }) as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'project' } });
      fireEvent.submit(box.form!);
      await waitFor(() => expect(screen.getByRole('button', { name: 'bots.historySearch.searching' })).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'commonUi.clearSearch' }));
      expect(box.value).toBe('');
      expect(screen.getByRole('button', { name: 'bots.historySearch.search' })).toBeTruthy();

      await act(async () => {
        settle();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText('bots.historySearch.empty')).toBeNull();
      expect(screen.queryByText('bots.historySearch.failed')).toBeNull();
      expect(screen.queryByRole('button', { name: 'bots.historySearch.searching' })).toBeNull();
      expect(screen.getByRole('button', { name: 'bots.historySearch.search' })).toBeTruthy();
    },
  );

  it('offers deletion and restart without a pause action', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'bots.lifecycle.pause' })).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });

  it('allows deleting a legacy stopped teammate but does not offer restart', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('archived')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restart' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });
});

it('only deletes after confirmation and retains task history and independent worktrees', async () => {
  const deleted = vi.fn();
  render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} mode="actions" onDeleted={deleted} onOpenSession={vi.fn()} /></MemoryRouter>);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' }));
  await screen.findByRole('alertdialog');
  expect(runBotLifecycleAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.delete' }));
  await waitFor(() => expect(deleted).toHaveBeenCalledWith('bot-1'));
  expect(runBotLifecycleAction).toHaveBeenCalledWith({ botId: 'bot-1', action: 'delete', confirmName: 'Helper', keepTaskHistory: true, worktreeDisposition: 'retain' });
});
it('does not restart when a pending settings save cannot finish', async () => {
  render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} mode="actions" beforeAction={async () => false} onOpenSession={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'bots.lifecycle.restart' }) as HTMLButtonElement).disabled).toBe(false));
  expect(runBotLifecycleAction).not.toHaveBeenCalled();
});
