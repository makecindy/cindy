// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import type { ChatMessage as Message } from '@/lib/makerChatStore';
import { BotWorkingStatus } from '../BotWorkingStatus';
import { WorkingStatusText, WORKING_STATUS_MIN_INTERVAL_MS } from '@/features/cc-agent/WorkingStatusText';
import { localizePlainAgentStatus } from '@/features/cc-agent/lib/localizeAgentStatus';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => motion.reduced }));
const startedAt = Date.parse('2026-09-17T00:00:00Z');
const message = (role: Message['role'], fields: Partial<Message> = {}): Message => ({
  clientId: role, role, content: '', createdAt: new Date(startedAt + 10).toISOString(), ...fields,
});
const props = { visible: true, status: 'Working…', messages: [] as Message[], startedAt, processingOnly: false, avatar: null };
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  motion.reduced = false;
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: () => '150ms',
  } as unknown as CSSStyleDeclaration);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Bot working lifecycle', () => {
  it('keeps the indicator through thinking → text → memory tool → thinking → reply → done', () => {
    const thinking = message('thinking', { isStreaming: true });
    const text = message('assistant', { content: '记住了…', isStreaming: true });
    const tool = message('tool_use', { toolName: 'mcp__cindy_memory__call_tool' });
    const view = render(<BotWorkingStatus {...props} messages={[thinking]} />);
    expect(screen.getByRole('status').textContent).toBe('正在思考…');
    const change = (messages: Message[], expected: string) => {
      view.rerender(<BotWorkingStatus {...props} messages={messages} />);
      expect(screen.getByRole('status')).toBeTruthy();
      advance(WORKING_STATUS_MIN_INTERVAL_MS);
      advance(150);
      expect(screen.getByRole('status').textContent).toBe(expected);
    };
    change([text], '正在回复…');
    change([{ ...text, isStreaming: false }, tool], '正在处理…');
    change([text, tool, message('tool_result'), thinking], '正在思考…');
    change([text, tool, message('tool_result'), { ...thinking, isStreaming: false }, text], '正在回复…');
    view.rerender(<BotWorkingStatus {...props} visible={false} status="Done" />);
    expect(screen.queryByRole('status')).toBeNull();
    advance(5000);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(['Done', 'Error', 'Stopped'])('immediately clears %s even during fade-out', (status) => {
    const view = render(<BotWorkingStatus {...props} status="Thinking…" />);
    view.rerender(<BotWorkingStatus {...props} />);
    advance(1000);
    view.rerender(<BotWorkingStatus {...props} visible={false} status={status} />);
    expect(screen.queryByRole('status')).toBeNull();
    advance(2000);
    view.rerender(<BotWorkingStatus {...props} startedAt={startedAt + 5000} status="Thinking…" />);
    expect(screen.getByRole('status').textContent).toBe('正在思考…');
  });

  it('ignores old turns, hidden subagent output, system cards and completed text', () => {
    const messages = [
      message('assistant', { content: '旧正文', isStreaming: true, createdAt: new Date(startedAt - 1000).toISOString() }),
      message('user'),
      message('assistant', { content: '内部正文', isStreaming: true, parentToolUseId: 'toolu_01J00000000000000000000000' }),
      message('assistant', { content: '状态卡', systemCardType: 'status' }),
    ];
    expect(localizePlainAgentStatus('Working…', messages, startedAt, i18n.t)).toBe('正在处理…');
    expect(localizePlainAgentStatus('Generating…', [message('assistant', { content: '记住了…' })], startedAt, i18n.t)).toBe('正在处理…');
  });

  it('does not leak tool names or infer a reply from translator fallback status', () => {
    for (const status of ['Running mcp__memory__write…', 'powershell running...', 'Generating...', 'Done']) {
      expect(localizePlainAgentStatus(status, [], startedAt, i18n.t)).toBe('正在处理…');
    }
  });

  it('recognizes resumed text in the same bubble after a thinking block closes', () => {
    expect(localizePlainAgentStatus('Working…', [
      message('assistant', { content: '继续回复', isStreaming: true }),
      message('thinking', { isStreaming: false }),
    ], startedAt, i18n.t)).toBe('正在回复…');
  });

  it('preserves pending-input semantics and background work after the turn', () => {
    expect(localizePlainAgentStatus('Waiting on input', [], startedAt, i18n.t))
      .toBe(i18n.t('ccAgent.sidebar.card.awaitingQuestion'));
    render(<BotWorkingStatus {...props} status="Done" processingOnly />);
    expect(screen.getByRole('status').textContent).toBe('正在处理…');
  });
});

describe('working copy cadence and alpha transition', () => {
  it('holds copy for a second, fades out, consumes the latest state and fades in', () => {
    const view = render(<WorkingStatusText text="思考" />);
    advance(100);
    view.rerender(<WorkingStatusText text="回复" />);
    advance(500);
    view.rerender(<WorkingStatusText text="处理" />);
    advance(399);
    expect(screen.getByText('思考').style.opacity).toBe('1');
    advance(1);
    expect(screen.getByText('思考').style.opacity).toBe('0');
    view.rerender(<WorkingStatusText text="再思考" />);
    advance(150);
    expect(screen.queryByText('回复')).toBeNull();
    expect(screen.queryByText('处理')).toBeNull();
    expect(screen.getByText('再思考').style.opacity).toBe('1');
    view.rerender(<WorkingStatusText text="回复" />);
    advance(999);
    expect(screen.getByText('再思考').style.opacity).toBe('1');
    advance(1);
    expect(screen.getByText('再思考').style.opacity).toBe('0');
    advance(150);
    expect(screen.getByText('回复').style.opacity).toBe('1');
  });

  it('cancels obsolete transitions if the current state returns', () => {
    const view = render(<WorkingStatusText text="思考" />);
    view.rerender(<WorkingStatusText text="处理" />);
    advance(1000);
    view.rerender(<WorkingStatusText text="思考" />);
    advance(2000);
    expect(screen.getByText('思考').style.opacity).toBe('1');
    expect(screen.queryByText('处理')).toBeNull();
  });

  it('retains the cadence with reduced motion, without alpha animation', () => {
    motion.reduced = true;
    const view = render(<WorkingStatusText text="思考" />);
    view.rerender(<WorkingStatusText text="处理" />);
    advance(999);
    expect(screen.getByText('思考').style.opacity).toBe('1');
    advance(1);
    expect(screen.getByText('处理').style.opacity).toBe('1');
  });

  it('honors enabling reduced motion during a fade and clears timers on unmount', () => {
    const view = render(<WorkingStatusText text="思考" />);
    view.rerender(<WorkingStatusText text="处理" />);
    advance(1000);
    motion.reduced = true;
    view.rerender(<WorkingStatusText text="处理" />);
    expect(screen.getByText('处理').style.opacity).toBe('1');
    view.rerender(<WorkingStatusText text="回复" />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
