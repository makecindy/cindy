// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BotWorkingStatus } from '../BotWorkingStatus';
import type { ChatMessage } from '@/lib/makerChatStore';

const request = vi.fn();
const props = { sessionId: 'test', visible: true, status: 'Thinking', startedAt: 1000, messages: [] as ChatMessage[], processingOnly: false, avatar: null };
const tool = (name: string, input: unknown): ChatMessage => ({ clientId: 'tool', role: 'tool_use', content: '', toolName: name, toolInput: input });
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  request.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { polishWorkingStatus: request } } });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '150ms' } as unknown as CSSStyleDeclaration);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const tick = () => act(() => { vi.advanceTimersByTime(1150); });

it('displays specific default immediately, then model copy with the existing cadence and opacity', async () => {
  let resolve!: (value: { text: string }) => void;
  request.mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<BotWorkingStatus {...props} messages={[tool('bot_memory', { action: 'read' })]} />);
  expect(screen.getByRole('status').textContent).toBe('正在读取记忆…');
  await act(async () => resolve({ text: '翻翻之前记下的事…' }));
  expect(screen.getByRole('status').textContent).toBe('正在读取记忆…');
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText('正在读取记忆…').style.opacity).toBe('0');
  act(() => { vi.advanceTimersByTime(150); });
  expect(screen.getByText('翻翻之前记下的事…').style.opacity).toBe('1');
  expect(request).toHaveBeenCalledWith({ sessionId: 'test', phase: 'reading-memory', locale: 'zh-CN' });
});

it('changes matters, keeps defaults between them, and discards obsolete or terminal model results', async () => {
  const resolves: Array<(v: { text: string | null }) => void> = [];
  request.mockImplementation(() => new Promise((r) => resolves.push(r)));
  const memory = tool('bot_memory', { action: 'write', body: 'PRIVATE' });
  const file = tool('read', { path: 'PRIVATE' });
  const view = render(<BotWorkingStatus {...props} messages={[memory]} />);
  view.rerender(<BotWorkingStatus {...props} messages={[file]} />);
  await act(async () => resolves[0]({ text: '把这件事记下来…' }));
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在读取文件…');
  await act(async () => resolves[1]({ text: '翻翻文件里的内容…' }));
  tick();
  expect(screen.getByRole('status').textContent).toBe('翻翻文件里的内容…');
  view.rerender(<BotWorkingStatus {...props} />);
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在思考…');
  view.rerender(<BotWorkingStatus {...props} messages={[memory]} />);
  view.rerender(<BotWorkingStatus {...props} visible={false} />);
  await act(async () => resolves[2]({ text: '迟到的记忆文案' }));
  tick();
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps specific default on model failure and avoids requests without a public subject or local active turn', async () => {
  request.mockRejectedValue(new Error('unavailable'));
  const messages = [tool('read', { path: 'PRIVATE' })];
  const view = render(<BotWorkingStatus {...props} messages={messages} />);
  await act(async () => {});
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在读取文件…');
  view.rerender(<BotWorkingStatus {...props} sessionId={undefined} messages={messages} />);
  view.rerender(<BotWorkingStatus {...props} processingOnly messages={messages} />);
  view.rerender(<BotWorkingStatus {...props} status="Waiting on input" />);
  view.rerender(<BotWorkingStatus {...props} />);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps the memory subject while consuming the returned feedback', async () => {
  request.mockResolvedValue({ text: null });
  render(<BotWorkingStatus {...props} messages={[
    { ...tool('bot_memory', { action: 'read', filename: 'PRIVATE' }), toolUseId: 't' },
    { clientId: 'r', role: 'tool_result', content: 'PRIVATE', toolUseId: 't' },
    { clientId: 'th', role: 'thinking', content: 'PRIVATE', isStreaming: true },
  ]} />);
  expect(screen.getByRole('status').textContent).toBe('正在核对记忆…');
  expect(request).toHaveBeenCalledWith({ sessionId: 'test', phase: 'reviewing-memory', locale: 'zh-CN' });
  await act(async () => {});
});
