// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BotGenerationLabel } from '../BotGenerationLabel';
import { BotWorkingStatus } from '../BotWorkingStatus';
import type { ChatMessage } from '@/lib/makerChatStore';

const request = vi.fn();
const props = { sessionId: 'test', visible: true, status: 'Thinking', startedAt: 1000, messages: [] as ChatMessage[], foregroundRunning: true, backgroundWorkActive: false, avatar: null };
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
  view.rerender(<BotWorkingStatus {...props} foregroundRunning={false} backgroundWorkActive messages={messages} />);
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

it('keeps foreground workflow copy specific, then falls back only when background work remains', async () => {
  request.mockResolvedValue({ text: '翻翻之前记下的事…' });
  const messages = [tool('bot_memory', { action: 'read' })];
  const view = render(<BotWorkingStatus {...props} backgroundWorkActive messages={messages} />);
  expect(screen.getByRole('status').textContent).toBe('正在读取记忆…');
  await act(async () => {});
  tick();
  expect(screen.getByRole('status').textContent).toBe('翻翻之前记下的事…');
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(<BotWorkingStatus {...props} backgroundWorkActive foregroundRunning={false} messages={messages} />);
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在处理…');
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(<BotWorkingStatus {...props} visible={false} foregroundRunning={false} />);
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([
  ['delete', 'deleting-memory', '正在删除记忆…'],
  ['review', 'reviewing-memory', '正在核对记忆…'],
  ['consolidate', 'organizing-memory', '正在整理记忆…'],
] as const)('keeps an accurate memory %s fallback and requests polishing', async (action, phase, text) => {
  request.mockRejectedValue(new Error('unavailable'));
  render(<BotWorkingStatus {...props} messages={[tool('bot_memory', { action })]} />);
  expect(screen.getByRole('status').textContent).toBe(text);
  expect(request).toHaveBeenCalledWith({ sessionId: 'test', phase, locale: 'zh-CN' });
  await act(async () => {});
  tick();
  expect(screen.getByRole('status').textContent).toBe(text);
});

it('remote chat gets polished copy from the host resource, never a local model request', async () => {
  const invoke = vi.fn().mockResolvedValue({ blocks: [{ id: 'working', fallbackMarkdown: '翻翻文件里的内容…' }] });
  Object.assign(window.electronAPI, { deviceLink: { invoke } });
  render(<BotWorkingStatus {...props} remote={{ deviceId: 'host', botId: 'writer' }} messages={[tool('read', { path: 'PRIVATE' })]} />);
  await act(async () => {});
  tick();
  expect(screen.getByRole('status').textContent).toBe('翻翻文件里的内容…');
  expect(request).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('host', expect.any(String), [{
    client: { protocolVersion: 1, primitives: ['status'], locale: 'zh-CN' },
    ref: { collectionId: 'teammates', kind: 'bot', id: 'working:writer/reading-file' },
  }]);
});


it.each(['Compacting...', 'Compacting context…'])('localizes %s before old live blocks and clears late copy through stop/resume', async (status) => {
  let resolve!: (value: { text: string }) => void;
  request.mockReturnValue(new Promise(r => { resolve = r; }));
  const messages = [tool('bot_memory', { action: 'read' })];
  const view = render(<BotWorkingStatus {...props} messages={messages} />);
  view.rerender(<BotWorkingStatus {...props} status={status} messages={messages} />);
  await act(async () => resolve({ text: '翻翻之前记下的事…' }));
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在整理对话…');
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(<BotWorkingStatus {...props} />);
  tick();
  expect(screen.getByRole('status').textContent).toBe('正在思考…');
  view.rerender(<BotWorkingStatus {...props} visible={false} />);
  expect(screen.queryByRole('status')).toBeNull();
});


it.each([
  ['en', 'Organizing the conversation…'], ['zh-CN', '正在整理对话…'],
  ['zh-TW', '正在整理對話…'], ['ja', '会話を整理しています…'], ['ko', '대화를 정리하는 중…'],
])('keeps the list and composer compaction caption identical in %s', async (locale, caption) => {
  await i18n.changeLanguage(locale);
  render(<><BotGenerationLabel sessionId="test" phase="compacting" startedAt={1000}/>
    <BotWorkingStatus {...props} status="Compacting context…" /></>);
  expect(screen.getAllByText(caption)).toHaveLength(2);
  expect(request).not.toHaveBeenCalled();
});
