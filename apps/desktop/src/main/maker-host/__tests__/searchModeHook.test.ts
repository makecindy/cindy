import { describe, expect, it, vi } from 'vitest';

import { createSearchModeHooks } from '../claude-hooks/search-mode-hook';

const logger = {
  child: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
} as never;

describe('createSearchModeHooks', () => {
  it('denies ritual tools when search mode is on', async () => {
    const hooks = createSearchModeHooks(
      {
        resolveCindySessionId: () => 'sess-1',
        isSearchModeEnabled: async () => true,
      },
      logger,
    );
    const deny = hooks.PreToolUse?.[0]?.hooks[0];
    const result = await deny?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 't1',
        session_id: 'sdk-1',
      } as never,
      't1',
      { signal: new AbortController().signal } as never,
    );
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('denies ritual tools when search mode lookup fails', async () => {
    const hooks = createSearchModeHooks(
      {
        resolveCindySessionId: () => 'sess-1',
        isSearchModeEnabled: async () => {
          throw new Error('db unavailable');
        },
      },
      logger,
    );
    const deny = hooks.PreToolUse?.[0]?.hooks[0];
    const result = await deny?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 't1',
        session_id: 'sdk-1',
      } as never,
      't1',
      { signal: new AbortController().signal } as never,
    );
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('leaves ritual tools alone when search mode is off', async () => {
    const hooks = createSearchModeHooks(
      {
        resolveCindySessionId: () => 'sess-1',
        isSearchModeEnabled: async () => false,
      },
      logger,
    );
    const deny = hooks.PreToolUse?.[0]?.hooks[0];
    const result = await deny?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: {},
        tool_use_id: 't1',
        session_id: 'sdk-1',
      } as never,
      't1',
      { signal: new AbortController().signal } as never,
    );
    expect(result).toEqual({ continue: true });
  });
});
