// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { BotGenerationLabel } from '../BotGenerationLabel';

// The composer-top bot status line was retired (bot chats now show the normal
// work group and RunningStatusBar). Sidebar/group rows keep the polished copy.
const request = vi.fn();
const props = { sessionId: 'test', startedAt: 1000 };
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
  render(<BotGenerationLabel {...props} phase="reading-memory" />);
  expect(screen.getByText('正在读取记忆…')).toBeTruthy();
  await act(async () => resolve({ text: '翻翻之前记下的事…' }));
  expect(screen.getByText('正在读取记忆…')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText('正在读取记忆…').style.opacity).toBe('0');
  act(() => { vi.advanceTimersByTime(150); });
  expect(screen.getByText('翻翻之前记下的事…').style.opacity).toBe('1');
  expect(request).toHaveBeenCalledWith({ sessionId: 'test', phase: 'reading-memory', locale: 'zh-CN' });
});

it('discards obsolete model results after the phase changes', async () => {
  const resolves: Array<(v: { text: string | null }) => void> = [];
  request.mockImplementation(() => new Promise((r) => resolves.push(r)));
  const view = render(<BotGenerationLabel {...props} phase="saving-memory" />);
  view.rerender(<BotGenerationLabel {...props} phase="reading-file" />);
  await act(async () => resolves[0]({ text: '把这件事记下来…' }));
  tick();
  expect(screen.getByText('正在读取文件…')).toBeTruthy();
  expect(screen.queryByText('把这件事记下来…')).toBeNull();
  await act(async () => resolves[1]({ text: '翻翻文件里的内容…' }));
  tick();
  expect(screen.getByText('翻翻文件里的内容…')).toBeTruthy();
});

it('keeps the specific default on model failure and avoids requests without a session', async () => {
  request.mockRejectedValue(new Error('unavailable'));
  const view = render(<BotGenerationLabel {...props} phase="reading-file" />);
  await act(async () => {});
  tick();
  expect(screen.getByText('正在读取文件…')).toBeTruthy();
  view.rerender(<BotGenerationLabel {...props} sessionId={undefined} phase="reading-file" />);
  expect(request).toHaveBeenCalledTimes(1);
});

it('remote rows get polished copy from the host resource, never a local model request', async () => {
  const invoke = vi.fn().mockResolvedValue({ blocks: [{ id: 'working', fallbackMarkdown: '翻翻文件里的内容…' }] });
  Object.assign(window.electronAPI, { deviceLink: { invoke } });
  render(<BotGenerationLabel {...props} phase="reading-file" remote={{ deviceId: 'host', botId: 'writer' }} />);
  await act(async () => {});
  tick();
  expect(screen.getByText('翻翻文件里的内容…')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('host', expect.any(String), [{
    client: { protocolVersion: 1, primitives: ['status'], locale: 'zh-CN' },
    ref: { collectionId: 'teammates', kind: 'bot', id: 'working:writer/reading-file' },
  }]);
});

it.each([
  ['en', 'Organizing the conversation…'], ['zh-CN', '正在整理对话…'],
  ['zh-TW', '正在整理對話…'], ['ja', '会話を整理しています…'], ['ko', '대화를 정리하는 중…'],
])('localizes the compaction caption in %s without a model request', async (locale, caption) => {
  await i18n.changeLanguage(locale);
  render(<BotGenerationLabel sessionId="test" phase="compacting" startedAt={1000} />);
  expect(screen.getByText(caption)).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
});
