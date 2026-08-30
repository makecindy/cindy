// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';

const chat = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    snapshot: { messages: [] as ChatMessage[] },
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

import {
  absoluteToRepoRelative,
  collectLastTurnPaths,
  useLastTurnFilter,
} from '../useLastTurnFilter';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    clientId: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    ...partial,
  } as ChatMessage;
}

function publish(messages: ChatMessage[]): void {
  chat.snapshot = { messages };
  act(() => {
    for (const listener of chat.listeners) listener();
  });
}

beforeEach(() => {
  chat.listeners.clear();
  chat.snapshot = { messages: [] };
});

afterEach(() => {
  cleanup();
});

describe('useLastTurnFilter path collection', () => {
  it('converts absolute paths to repo-relative paths', () => {
    expect(absoluteToRepoRelative('/repo/src/app.ts', '/repo')).toBe('src/app.ts');
    expect(absoluteToRepoRelative('/other/app.ts', '/repo')).toBeNull();
  });

  it('collects Codex file_change paths from absolute and repo-relative change entries', () => {
    const paths = collectLastTurnPaths(
      [
        msg({ role: 'user', content: 'change files' }),
        msg({
          role: 'tool_use',
          toolName: 'file_change',
          toolInput: {
            changes: [
              { path: '/repo/src/absolute.ts', kind: { type: 'update' } },
              { path: 'src/relative.ts', kind: { type: 'add' } },
              { path: 'src/delete.ts', kind: { type: 'delete' } },
            ],
          },
        }),
      ],
      '/repo',
    );

    expect([...paths].sort()).toEqual(['src/absolute.ts', 'src/delete.ts', 'src/relative.ts']);
  });

  it('collects defensive move path fields from Codex update changes', () => {
    const paths = collectLastTurnPaths(
      [
        msg({ role: 'user', content: 'move files' }),
        msg({
          role: 'tool_use',
          toolName: 'file_change',
          toolInput: {
            changes: [
              { path: 'src/old.ts', kind: { type: 'update', move_path: 'src/new.ts' } },
              { path: 'docs/old.md', kind: { type: 'update', movePath: '/repo/docs/new.md' } },
            ],
          },
        }),
      ],
      '/repo',
    );

    expect([...paths].sort()).toEqual(['docs/new.md', 'docs/old.md', 'src/new.ts', 'src/old.ts']);
  });

  it('only scans messages after the latest user turn', () => {
    const paths = collectLastTurnPaths(
      [
        msg({ role: 'user', content: 'first' }),
        msg({
          role: 'tool_use',
          toolName: 'file_change',
          toolInput: { changes: [{ path: 'old.ts' }] },
        }),
        msg({ role: 'user', content: 'second' }),
        msg({
          role: 'tool_use',
          toolName: 'file_change',
          toolInput: { changes: [{ path: 'new.ts' }] },
        }),
      ],
      '/repo',
    );

    expect([...paths]).toEqual(['new.ts']);
  });
});

describe('useLastTurnFilter subscriptions', () => {
  it('does not render again when streaming text changes but the last-turn paths stay the same', () => {
    const messages = [
      msg({ role: 'user', content: 'change a file' }),
      msg({
        role: 'tool_use',
        toolName: 'Write',
        toolInput: { file_path: '/repo/src/app.ts' },
      }),
      msg({ role: 'assistant', content: 'Starting' }),
    ];
    chat.snapshot = { messages };
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useLastTurnFilter('session-1', '/repo');
    });
    const initialResult = view.result.current;

    publish([
      ...messages.slice(0, -1),
      { ...messages.at(-1)!, content: 'Starting and still working' },
    ]);

    expect(renders).toBe(1);
    expect(view.result.current).toBe(initialResult);
    expect([...view.result.current]).toEqual(['src/app.ts']);
  });

  it('renders again when the last-turn path set changes', () => {
    const messages = [
      msg({ role: 'user', content: 'change files' }),
      msg({
        role: 'tool_use',
        toolName: 'Write',
        toolInput: { file_path: '/repo/src/app.ts' },
      }),
    ];
    chat.snapshot = { messages };
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useLastTurnFilter('session-1', '/repo');
    });
    const initialResult = view.result.current;

    publish([
      ...messages,
      msg({
        role: 'tool_use',
        toolName: 'Write',
        toolInput: { file_path: '/repo/src/new.ts' },
      }),
    ]);

    expect(renders).toBe(2);
    expect(view.result.current).not.toBe(initialResult);
    expect([...view.result.current].sort()).toEqual(['src/app.ts', 'src/new.ts']);
  });
});
