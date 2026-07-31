import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@cindy/maker-core';

import {
  createBashConcurrencyHooks,
  mergeClaudeHooks,
} from '../claude-hooks/bash-concurrency-hook';
import type { CommandConcurrencyGate } from '../command-concurrency-gate';

const fakeLogger = {
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
} as unknown as Logger;

function makeGate(): CommandConcurrencyGate & {
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  releaseSession: ReturnType<typeof vi.fn>;
} {
  return {
    acquire: vi.fn().mockResolvedValue('immediate'),
    release: vi.fn(),
    releaseSession: vi.fn(),
    snapshot: vi.fn(() => ({ running: 0, queued: 0 })),
  };
}

const hookOptions = { signal: new AbortController().signal };

const baseInput = {
  session_id: 'session-1',
  transcript_path: '/tmp/t',
  cwd: '/tmp',
};

function preToolUseInput(toolName: string): never {
  return {
    ...baseInput,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command: 'pnpm test' },
  } as never;
}

describe('bash concurrency hooks', () => {
  it('acquires a slot for Bash PreToolUse and always continues', async () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const pre = hooks.PreToolUse![0];
    expect(pre.matcher).toBe('Bash');

    const result = await pre.hooks[0](preToolUseInput('Bash'), 'tool-1', hookOptions);
    expect(result).toEqual({ continue: true });
    expect(gate.acquire).toHaveBeenCalledWith({
      toolUseId: 'tool-1',
      sessionId: 'session-1',
      signal: hookOptions.signal,
    });
  });

  it('ignores non-Bash tools that the regex matcher can still hit (BashOutput)', async () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const result = await hooks.PreToolUse![0].hooks[0](
      preToolUseInput('BashOutput'),
      'tool-1',
      hookOptions,
    );
    expect(result).toEqual({ continue: true });
    expect(gate.acquire).not.toHaveBeenCalled();
  });

  it('skips gating when toolUseID is missing (no way to pair the release)', async () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const result = await hooks.PreToolUse![0].hooks[0](
      preToolUseInput('Bash'),
      undefined,
      hookOptions,
    );
    expect(result).toEqual({ continue: true });
    expect(gate.acquire).not.toHaveBeenCalled();
  });

  it('fails open when gate.acquire throws', async () => {
    const gate = makeGate();
    gate.acquire.mockRejectedValueOnce(new Error('boom'));
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const result = await hooks.PreToolUse![0].hooks[0](
      preToolUseInput('Bash'),
      'tool-1',
      hookOptions,
    );
    expect(result).toEqual({ continue: true });
  });

  it.each([
    ['PostToolUse' as const],
    ['PostToolUseFailure' as const],
    ['PermissionDenied' as const],
  ])('releases the slot on %s', async (eventName) => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const matcher = hooks[eventName]![0];
    expect(matcher.matcher).toBe('Bash');

    const input = {
      ...baseInput,
      hook_event_name: eventName,
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'tool-9',
    } as never;
    const result = await matcher.hooks[0](input, 'tool-9', hookOptions);
    expect(result).toEqual({ continue: true });
    expect(gate.release).toHaveBeenCalledWith('tool-9', expect.any(String));
  });

  it('does not release for non-Bash tool events', async () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const input = {
      ...baseInput,
      hook_event_name: 'PostToolUse',
      tool_name: 'BashOutput',
      tool_input: {},
      tool_use_id: 'tool-9',
    } as never;
    await hooks.PostToolUse![0].hooks[0](input, 'tool-9', hookOptions);
    expect(gate.release).not.toHaveBeenCalled();
  });

  it('cleans up the whole session on SessionEnd', async () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    const input = {
      ...baseInput,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    } as never;
    const result = await hooks.SessionEnd![0].hooks[0](input, undefined, hookOptions);
    expect(result).toEqual({ continue: true });
    expect(gate.releaseSession).toHaveBeenCalledWith('session-1', 'session-end');
  });

  it('sets a PreToolUse matcher timeout comfortably above the queue wait ceiling', () => {
    const gate = makeGate();
    const hooks = createBashConcurrencyHooks(gate, fakeLogger);
    // gate 默认排队上限 120s;matcher timeout 必须显著大于它,否则 SDK 会先掐 hook
    expect(hooks.PreToolUse![0].timeout).toBeGreaterThanOrEqual(300);
  });
});

describe('mergeClaudeHooks', () => {
  it('concatenates matchers of the same event and keeps distinct events', () => {
    const a = {
      PreToolUse: [{ matcher: 'Read', hooks: [vi.fn()] }],
    };
    const b = {
      PreToolUse: [{ matcher: 'Bash', hooks: [vi.fn()] }],
      SessionEnd: [{ hooks: [vi.fn()] }],
    };
    const merged = mergeClaudeHooks(a, b);
    expect(merged.PreToolUse?.map((m) => m.matcher)).toEqual(['Read', 'Bash']);
    expect(merged.SessionEnd).toHaveLength(1);
  });

  it('skips empty matcher arrays', () => {
    const merged = mergeClaudeHooks({ PreToolUse: [] }, {});
    expect(merged.PreToolUse).toBeUndefined();
  });
});
