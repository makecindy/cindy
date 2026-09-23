// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

import { createIpcError } from '../../../../shared/ipc-errors';
import { BOT_MEMORY_CHANGED, type BotMemoryDetail, type BotMemorySummary } from '../../../../shared/botMemory';

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
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { BotMemorySettings } from '../BotMemorySettings';

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
  list: vi.fn(async (_botId: string, _query?: string) => summaries),
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
