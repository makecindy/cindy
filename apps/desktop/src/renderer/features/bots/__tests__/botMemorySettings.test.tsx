// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

import { createIpcError } from '../../../../shared/ipc-errors';
import { BOT_MEMORY_CHANGED, type BotMemoryDetail, type BotMemorySummary } from '../../../../shared/botMemory';
import type {
  MakerMemoryTaskLocation,
  MakerMemoryTidyResult,
  MakerMemoryTidyRun,
} from '../../../../shared/makerMemoryEntries';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));

import { BotMemorySettings } from '../BotMemorySettings';
import { MemoryEntriesPanel } from '@/components/settings/MemoryEntriesPanel';
import { setMakerMemoryEnabled } from '@/lib/memorySettingsStore';

const summaries: BotMemorySummary[] = [
  { filename: 'user_quiet.md', type: 'user', title: '检查没事不说话', preview: '无变化时不播报。', updatedAt: '2026-09-23T09:35:33.152Z' },
  { filename: 'feedback_verify.md', type: 'feedback', title: '说结论前核实', preview: '回复前主动核实事实。', updatedAt: '2026-09-17T05:01:04.387Z' },
];
const detail: BotMemoryDetail = {
  filename: 'feedback_verify.md',
  type: 'feedback',
  title: '说结论前核实',
  body: '回复前主动核实事实。\n\n- 没核实的标待验证',
  updatedAt: '2026-09-17T05:01:04.387Z',
};

const api = {
  list: vi.fn<(botId: string, query?: string) => Promise<BotMemorySummary[]>>(async () => summaries),
  read: vi.fn(async () => detail),
  update: vi.fn(async (input: { title: string; body: string }) => ({
    ...detail,
    ...input,
    updatedAt: '2026-09-23T10:00:00.000Z',
  })),
  delete: vi.fn(async () => undefined),
};

function renderMemory(memoryEnabled = true) {
  const backRef: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  const leaveRef: MutableRefObject<(() => Promise<boolean>) | null> = { current: null };
  const onMemoryEnabledChange = vi.fn();
  render(
    <BotMemorySettings
      botId="bot-1"
      botName="Cindy"
      memoryEnabled={memoryEnabled}
      onMemoryEnabledChange={onMemoryEnabledChange}
      aboutMe={{ value: '', onChange: vi.fn(), onBlur: vi.fn() }}
      backRef={backRef}
      leaveRef={leaveRef}
    />,
  );
  return { backRef, leaveRef, onMemoryEnabledChange };
}

async function openDetail() {
  fireEvent.click(await screen.findByRole('button', { name: /说结论前核实/ }));
  await screen.findByTestId('markdown');
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  api.list.mockImplementation(async () => summaries);
  api.read.mockImplementation(async () => detail);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { localDb: { bots: { memory: api } } };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('BotMemorySettings', () => {
  it('groups memories by type and shows the content preview', async () => {
    renderMemory();
    const about = await screen.findByRole('region', { name: 'bots.memory.types.user' });
    expect(about.textContent).toContain('检查没事不说话');
    expect(about.textContent).toContain('无变化时不播报。');
    expect(screen.getByRole('region', { name: 'bots.memory.types.feedback' }).textContent).toContain('回复前主动核实事实。');
    expect(screen.queryByRole('region', { name: 'bots.memory.types.project' })).toBeNull();
  });

  it('shows the empty state without a search box', async () => {
    api.list.mockResolvedValueOnce([]);
    renderMemory();
    expect(await screen.findByText('bots.memory.empty')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'bots.memory.search' })).toBeNull();
  });

  it('searches through the host and reports no matches', async () => {
    renderMemory();
    await screen.findByRole('region', { name: 'bots.memory.types.user' });
    api.list.mockResolvedValueOnce([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.search' }), { target: { value: '报错' } });
    expect(await screen.findByText('bots.memory.noResults')).toBeTruthy();
    expect(api.list).toHaveBeenLastCalledWith('bot-1', '报错');
  });

  it('keeps the list visible and forwards the switch when memory is off', async () => {
    const { onMemoryEnabledChange } = renderMemory(false);
    expect(screen.getByText('bots.memory.disabledHint')).toBeTruthy();
    await screen.findByRole('region', { name: 'bots.memory.types.user' });
    fireEvent.click(screen.getByRole('switch', { name: 'bots.memory.enabled' }));
    expect(onMemoryEnabledChange).toHaveBeenCalledWith(true);
  });

  it('opens the full memory once and steps back to the list', async () => {
    // Each host reply is a new object; loading it must not retrigger another read.
    api.read.mockImplementation(async () => ({ ...detail }));
    const { backRef } = renderMemory();
    await openDetail();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.read).toHaveBeenCalledWith('bot-1', 'feedback_verify.md');
    expect(screen.getByTestId('markdown').textContent).toContain('没核实的标待验证');
    await act(async () => {
      expect(await backRef.current?.()).toBe(true);
    });
    expect(await screen.findByRole('region', { name: 'bots.memory.types.user' })).toBeTruthy();
    expect(await backRef.current?.()).toBe(false);
  });

  it('autosaves edits with the version that was opened', async () => {
    const { leaveRef } = renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), {
      target: { value: '先核实，再说结论。' },
    });
    await act(async () => {
      expect(await leaveRef.current?.()).toBe(true);
    });
    expect(api.update).toHaveBeenCalledWith({
      botId: 'bot-1',
      filename: 'feedback_verify.md',
      title: '说结论前核实',
      body: '先核实，再说结论。',
      expectedUpdatedAt: detail.updatedAt,
    });
    expect(screen.getByText('bots.autosave.saved')).toBeTruthy();
  });

  it('flushes edits typed during an in-flight save before allowing the page to close', async () => {
    const { leaveRef } = renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    let finish!: (value: BotMemoryDetail) => void;
    api.update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), { target: { value: 'First edit' } });
    let leaving!: Promise<boolean>;
    await act(async () => { leaving = leaveRef.current!(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), { target: { value: 'Second edit' } });
    await act(async () => {
      finish({ ...detail, body: 'First edit', updatedAt: '2026-09-23T12:00:00.000Z' });
      expect(await leaving).toBe(true);
    });
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({
      body: 'Second edit', expectedUpdatedAt: '2026-09-23T12:00:00.000Z',
    }));
  });

  it('does not save an over-limit body', async () => {
    const { leaveRef } = renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), {
      target: { value: '字'.repeat(3000) },
    });
    expect(screen.getByText('bots.memory.tooLong')).toBeTruthy();
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      expect(await leaveRef.current?.()).toBe(false);
    });
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'bots.memory.unsavedTitle' }),
    );
    // Choosing to discard lets the user leave without writing anything.
    await act(async () => {
      expect(await leaveRef.current?.()).toBe(true);
    });
    expect(api.update).not.toHaveBeenCalled();
  });

  it('stops on a teammate change and lets the user keep their edit', async () => {
    const latest = { ...detail, body: '伙伴刚写的', updatedAt: '2026-09-23T11:00:00.000Z' };
    api.update.mockRejectedValueOnce(createIpcError('PRECONDITION_FAILED', BOT_MEMORY_CHANGED));
    renderMemory();
    await openDetail();
    api.read.mockResolvedValue(latest);
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), {
      target: { value: '我的版本' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.done' }));
    expect(await screen.findByText('伙伴刚写的')).toBeTruthy();
    expect(screen.getByText('bots.memory.changedTitle:{"name":"Cindy"}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.keepMine' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(api.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: '我的版本', expectedUpdatedAt: latest.updatedAt }),
    );
  });

  it('explains an empty field and moves focus to it instead of silently ignoring Done', async () => {
    renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    const title = screen.getByRole('textbox', { name: 'bots.memory.titleLabel' });
    fireEvent.change(title, { target: { value: '  ' } });
    expect(screen.getByRole('alert').textContent).toBe('bots.memory.titleRequired');
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.done' }));
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' }), {
      target: { value: '' },
    });
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([
      'bots.memory.titleRequired',
      'bots.memory.bodyRequired',
    ]);
  });

  it('waits for IME text to be committed before autosaving a memory', async () => {
    vi.useFakeTimers();
    renderMemory();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.click(screen.getByRole('button', { name: /说结论前核实/ }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    const body = screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' });
    fireEvent.compositionStart(body);
    fireEvent.change(body, { target: { value: '先核实hexin' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.change(body, { target: { value: '先核实核心' } });
    fireEvent.compositionEnd(body);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ body: '先核实核心' }));
  });

  it('does not let a save finishing mid-composition or leaving send the IME text', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    api.update.mockImplementationOnce(
      (input: { title: string; body: string }) =>
        new Promise((resolve) => {
          finish = () => resolve({ ...detail, ...input, updatedAt: '2026-09-23T10:00:00.000Z' });
        }),
    );
    const { leaveRef } = renderMemory();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.click(screen.getByRole('button', { name: /说结论前核实/ }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.edit' }));
    const body = screen.getByRole('textbox', { name: 'bots.memory.bodyLabel' });
    fireEvent.change(body, { target: { value: '先核实' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    fireEvent.compositionStart(body);
    fireEvent.change(body, { target: { value: '先核实hexin' } });
    await act(async () => finish());
    let left: unknown;
    await act(async () => {
      left = await leaveRef.current?.();
    });
    expect(left).toBe(true);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({ body: '先核实' }));
  });

  it('deletes after confirmation with the opened version', async () => {
    renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.delete' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith({
      botId: 'bot-1',
      filename: 'feedback_verify.md',
      expectedUpdatedAt: detail.updatedAt,
    }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('bots.memory.deleted');
    expect(await screen.findByRole('region', { name: 'bots.memory.types.user' })).toBeTruthy();
  });

  it('keeps the memory when deletion is cancelled', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    renderMemory();
    await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.delete' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });
});

/**
 * 测试价值(Cindy 记忆「查看记忆」页, docs/product-rules/cindy-memory.md §3「需要时才整理」、§4)
 * - 生产入口与可观察结果: 真实的 MemoryEntriesPanel + MemoryTidyCard + 共用的 MemoryEntriesView;
 *   断言发给主机的范围键、版本、整理与撤销的入参, 以及页面显示和提示文案。
 * - 规则依据: 回执点开落在写入任务的项目; 读改删带当前范围键; 项目不在列表里时落在「关于你」;
 *   「现在整理」进行中不挡列表, 结束后重新读取列表、条数和记录; 撤销先确认, 整理后被改过的不恢复
 *   并如实告知; 总开关关闭或不足两条时不能整理。
 * - 现有覆盖缺口: 上面的用例只经伙伴的数据来源(botId), 不经范围选择, 也没有整理。
 * - 最小失败输入: 回执带来的任务位置; 一个还没有记忆的项目; 一次要等的整理; 各种整理结果;
 *   一条未撤销和一条已撤销的记录。
 * - tier: unit(jsdom, 与本文件共用替身; 列表 / 详情 / 编辑本身由上面的用例覆盖, 这里不重复)。
 */
describe('MemoryEntriesPanel (Cindy memory)', () => {
  const TASK: MakerMemoryTaskLocation = { workingDir: '/repo/packages/app' };
  const run: MakerMemoryTidyRun = {
    id: 'run-1',
    at: '2026-09-20T08:00:00.000Z',
    trigger: 'auto',
    undone: false,
    count: 3,
    changes: [
      { kind: 'merged', title: '统一用 pnpm', mergedTitles: ['用 pnpm', '不要用 npm'], reason: '说的是同一件事' },
      { kind: 'removed', title: '周三发版', mergedTitles: [], reason: '已被较新的记忆覆盖' },
    ],
  };
  const entries = {
    // 任务的项目解析到 /repo 时指向它; 解析不到(还没有记忆)为 null。
    scopes: vi.fn(async (task?: MakerMemoryTaskLocation) => ({
      scopes: [
        { scopeKey: 'user:account', kind: 'user' as const, count: 0 },
        { scopeKey: '/repo', kind: 'project' as const, count: 2, name: 'repo', path: '/repo' },
      ],
      taskScopeKey: task?.workingDir.startsWith('/repo') ? '/repo' : null,
    })),
    list: vi.fn<(scopeKey: string, query?: string) => Promise<BotMemorySummary[]>>(async () => summaries),
    read: vi.fn(async () => detail),
    update: vi.fn(),
    delete: vi.fn(async () => undefined),
    tidy: vi.fn<(scopeKey: string) => Promise<MakerMemoryTidyResult>>(async () => ({ status: 'done', run })),
    tidyRuns: vi.fn<(scopeKey: string) => Promise<MakerMemoryTidyRun[]>>(async () => []),
    tidyUndo: vi.fn(async () => ({ restored: 3, skipped: 0 })),
  };
  const renderPanel = (initialTask: MakerMemoryTaskLocation | null) =>
    render(
      <MemoryEntriesPanel
        initialTask={initialTask}
        onBack={vi.fn()}
        backRef={{ current: null }}
        leaveRef={{ current: null }}
      />,
    );
  const tidyButton = () => screen.findByRole('button', { name: 'settings.memory.entries.tidy.run' });

  beforeEach(() => {
    for (const fn of Object.values(entries)) fn.mockClear();
    entries.list.mockImplementation(async () => summaries);
    entries.tidy.mockImplementation(async () => ({ status: 'done', run }));
    entries.tidyRuns.mockImplementation(async () => []);
    setMakerMemoryEnabled(true);
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: { memoryEntries: entries } };
  });

  it('opens on the project of the task a receipt came from and deletes with that scope and the opened version', async () => {
    renderPanel(TASK);
    await openDetail();
    expect(entries.scopes).toHaveBeenCalledWith(TASK);
    expect(entries.list).toHaveBeenCalledWith('/repo', undefined);
    expect(entries.read).toHaveBeenCalledWith('/repo', 'feedback_verify.md');
    fireEvent.click(screen.getByRole('button', { name: 'bots.memory.delete' }));
    await waitFor(() => expect(entries.delete).toHaveBeenCalledWith({
      scopeKey: '/repo',
      filename: 'feedback_verify.md',
      expectedUpdatedAt: detail.updatedAt,
    }));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      description: 'settings.memory.entries.deleteConfirm:{"title":"说结论前核实"}',
    }));
    // 条数变了: 回到列表并重新读取范围; 任务位置只在第一次带。
    await waitFor(() => expect(entries.scopes).toHaveBeenCalledTimes(2));
    expect(entries.scopes).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to About you when the task has no project memory yet and shows an emptied scope as empty', async () => {
    entries.list.mockRejectedValue(createIpcError('NOT_FOUND', 'Memory scope not found'));
    renderPanel({ workingDir: '/gone' });
    expect(await screen.findByText('bots.memory.empty')).toBeTruthy();
    expect(entries.list).toHaveBeenCalledWith('user:account', undefined);
    expect(screen.getByText('settings.memory.entries.userScopeNote')).toBeTruthy();
  });

  it('tidies the selected scope without blocking the page, then re-reads the list, the counts and the history', async () => {
    let finish!: (result: MakerMemoryTidyResult) => void;
    entries.tidy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderPanel(TASK);
    fireEvent.click(await tidyButton());
    expect(entries.tidy).toHaveBeenCalledWith('/repo');
    // 进行中: 按钮写「正在整理…」, 再点不会发第二次; 列表照常能点进详情。
    fireEvent.click(await screen.findByRole('button', { name: 'settings.memory.entries.tidy.running' }));
    expect(entries.tidy).toHaveBeenCalledTimes(1);
    await openDetail();
    expect(entries.read).toHaveBeenCalledTimes(1);

    entries.tidyRuns.mockResolvedValue([run]);
    await act(async () => finish({ status: 'done', run }));
    expect(mocks.toastSuccess.mock.calls[0]?.[0]).toBe('settings.memory.entries.tidy.merged:{"count":3}');
    // 正在看的这条可能刚被合并: 详情重新读取; 条数与记录也重新读取。
    await waitFor(() => expect(entries.read).toHaveBeenCalledTimes(2));
    expect(entries.scopes).toHaveBeenCalledTimes(2);
    expect(entries.tidyRuns).toHaveBeenCalledTimes(2);
  });

  it.each<[string, MakerMemoryTidyResult | Error, 'toastInfo' | 'toastError', string]>([
    ['nothing to change', { status: 'done', run: null }, 'toastInfo', 'settings.memory.entries.tidy.nothing'],
    ['already running', { status: 'busy' }, 'toastInfo', 'settings.memory.entries.tidy.busy'],
    ['no auxiliary model', { status: 'unavailable' }, 'toastError', 'settings.memory.entries.tidy.unavailable'],
    ['no usable proposal', { status: 'failed' }, 'toastError', 'settings.memory.entries.tidy.failed'],
    ['a rejected call', new Error('account changed'), 'toastError', 'settings.memory.entries.tidy.failed'],
  ])('reports a tidy that ends with %s', async (_name, outcome, toast, message) => {
    entries.tidy.mockImplementationOnce(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    renderPanel(TASK);
    fireEvent.click(await tidyButton());
    await waitFor(() => expect(mocks[toast].mock.calls[0]?.[0]).toBe(message));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(await tidyButton()).toBeTruthy();
  });

  it('does not tidy a scope with fewer than two memories, or any scope while Cindy memory is off', async () => {
    renderPanel(null);
    fireEvent.click(await tidyButton());
    expect((await tidyButton()).getAttribute('aria-disabled')).toBe('true');
    cleanup();
    setMakerMemoryEnabled(false);
    renderPanel(TASK);
    fireEvent.click(await tidyButton());
    expect((await tidyButton()).getAttribute('aria-disabled')).toBe('true');
    expect(entries.tidy).not.toHaveBeenCalled();
  });

  it('lists what each tidy changed and undoes a run only after confirmation, saying what was left alone', async () => {
    entries.tidyRuns.mockResolvedValue([run, { ...run, id: 'run-0', trigger: 'manual', undone: true }]);
    entries.tidyUndo.mockResolvedValueOnce({ restored: 2, skipped: 1 });
    renderPanel(TASK);
    // 记录默认收起。
    const records = await screen.findByRole('button', { name: /settings\.memory\.entries\.tidy\.records/ });
    expect(records.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(records);
    const history = await screen.findByRole('list', { name: 'settings.memory.entries.tidy.records' });
    expect(history.textContent).toContain('settings.memory.entries.tidy.undone');
    fireEvent.click(await screen.findByRole('button', { name: /tidy\.auto/ }));
    const merged = await screen.findByText(/tidy\.mergedInto/);
    expect(merged.textContent).toMatch(/用 pnpm.*不要用 npm.*统一用 pnpm/);
    expect(history.textContent).toContain('说的是同一件事');
    expect(history.textContent).toMatch(/tidy\.removed.*周三发版/);

    // 已撤销的那次没有「撤销」; 取消确认不撤销。
    const undo = screen.getAllByRole('button', { name: /tidy\.undoAria/ });
    expect(undo).toHaveLength(1);
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(undo[0]!);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(entries.tidyUndo).not.toHaveBeenCalled();

    fireEvent.click(undo[0]!);
    await waitFor(() => expect(entries.tidyUndo).toHaveBeenCalledWith({ scopeKey: '/repo', runId: 'run-1' }));
    await waitFor(() => expect(mocks.toastSuccess.mock.calls[0]?.[0]).toBe(
      'settings.memory.entries.tidy.restoredSkipped:{"restored":2,"count":1}',
    ));
    await waitFor(() => expect(entries.scopes).toHaveBeenCalledTimes(2));
    expect(entries.list).toHaveBeenCalledTimes(2);
  });
});
