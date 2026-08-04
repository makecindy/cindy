// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    snapshot: {
      messages: [] as Array<Record<string, unknown>>,
      agentStatus: {
        status: 'Idle',
        tokenUsage: 0,
        costUsd: 0,
        contextTokens: 0,
        contextWindow: 0,
        isRunning: false,
        startedAt: null,
      },
    } as {
      messages: Array<Record<string, unknown>>;
      agentStatus: {
        status: string;
        tokenUsage: number;
        costUsd: number;
        contextTokens: number;
        contextWindow: number;
        isRunning: boolean;
        startedAt: number | null;
        sideTaskRunning?: boolean;
      };
    },
  };
});

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: () => chat.snapshot,
    subscribe: (_sessionId: string, listener: () => void) => {
      chat.listeners.add(listener);
      return () => chat.listeners.delete(listener);
    },
  },
}));

import { useLocalHtmlAutoReload } from '../useLocalHtmlAutoReload';

function setTurnState(
  isRunning: boolean,
  messages: Array<Record<string, unknown>>,
  sideTaskRunning = false,
): void {
  chat.snapshot = {
    messages,
    agentStatus: {
      ...chat.snapshot.agentStatus,
      status: isRunning ? 'Working' : 'Done',
      isRunning,
      startedAt: isRunning ? Date.now() : null,
      ...(sideTaskRunning ? { sideTaskRunning: true } : {}),
    },
  };
  act(() => {
    for (const listener of chat.listeners) listener();
  });
}

const userMessage = { clientId: 'u1', role: 'user', content: 'update preview' };

describe('useLocalHtmlAutoReload', () => {
  beforeEach(() => {
    chat.listeners.clear();
    chat.snapshot = {
      messages: [],
      agentStatus: {
        status: 'Idle',
        tokenUsage: 0,
        costUsd: 0,
        contextTokens: 0,
        contextWindow: 0,
        isRunning: false,
        startedAt: null,
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('reloads once when the completed turn changed the active HTML preview', () => {
    const reload = vi.fn();
    renderHook(() =>
      useLocalHtmlAutoReload({
        sessionId: 's1',
        workdir: '/repo',
        url: 'file:///repo/dist/preview.html',
        reload,
      }),
    );

    setTurnState(true, [userMessage]);
    const messages = [
      userMessage,
      {
        clientId: 't1',
        role: 'tool_use',
        content: '',
        toolName: 'Write',
        toolInput: { file_path: '/repo/dist/preview.html' },
      },
    ];
    setTurnState(true, messages);
    expect(reload).not.toHaveBeenCalled();

    setTurnState(false, messages);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the completed turn changed another file', () => {
    const reload = vi.fn();
    renderHook(() =>
      useLocalHtmlAutoReload({
        sessionId: 's1',
        workdir: '/repo',
        url: 'file:///repo/dist/preview.html',
        reload,
      }),
    );

    const messages = [
      userMessage,
      {
        clientId: 't1',
        role: 'tool_use',
        content: '',
        toolName: 'file_change',
        toolInput: { changes: [{ path: 'src/app.ts' }] },
      },
    ];
    setTurnState(true, messages);
    setTurnState(false, messages);

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reuse a previous turn edit when a later turn changes nothing', () => {
    const reload = vi.fn();
    renderHook(() =>
      useLocalHtmlAutoReload({
        sessionId: 's1',
        workdir: '/repo',
        url: 'file:///repo/preview.html',
        reload,
      }),
    );

    const firstTurnMessages = [
      userMessage,
      {
        clientId: 't1',
        role: 'tool_use',
        content: '',
        toolName: 'Write',
        toolInput: { file_path: '/repo/preview.html' },
      },
    ];
    setTurnState(true, [userMessage]);
    setTurnState(false, firstTurnMessages);
    expect(reload).toHaveBeenCalledTimes(1);

    setTurnState(true, firstTurnMessages);
    setTurnState(false, [
      ...firstTurnMessages,
      { clientId: 'a2', role: 'assistant', content: 'No further changes.' },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe for remote pages or inactive tabs', () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useLocalHtmlAutoReload({
          sessionId: 's1',
          workdir: '/repo',
          url: 'https://example.com/preview.html',
          reload: vi.fn(),
          enabled,
        }),
      { initialProps: { enabled: true } },
    );
    expect(chat.listeners.size).toBe(0);

    rerender({ enabled: false });
    expect(chat.listeners.size).toBe(0);
  });

  it('ignores side-task running transitions', () => {
    const reload = vi.fn();
    renderHook(() =>
      useLocalHtmlAutoReload({
        sessionId: 's1',
        workdir: '/repo',
        url: 'file:///repo/preview.html',
        reload,
      }),
    );

    const messages = [
      userMessage,
      {
        clientId: 't1',
        role: 'tool_use',
        content: '',
        toolName: 'Write',
        toolInput: { file_path: '/repo/preview.html' },
      },
    ];
    setTurnState(true, messages, true);
    setTurnState(false, messages);

    expect(reload).not.toHaveBeenCalled();
  });
});
