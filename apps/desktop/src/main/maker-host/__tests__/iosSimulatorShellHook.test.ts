import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@cindy/maker-core';

import { createIOSSimulatorShellGuardHook } from '../claude-hooks/ios-simulator-shell-hook.js';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

function createLoggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, warn };
}

describeMac('iOS Simulator shell guard hook', () => {
  it('denies bypass commands without persisting command text in logs', async () => {
    const { logger, warn } = createLoggerSpy();
    const hook = createIOSSimulatorShellGuardHook(logger);
    const command = 'API_TOKEN=super-secret xcrun simctl boot DEVICE';

    const result = await hook(
      {
        session_id: 'session-1',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      } as never,
      'tool-secret',
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(warn).toHaveBeenCalledWith(
      'shell command denied by embedded iOS Simulator policy',
      expect.objectContaining({
        toolUseId: 'tool-secret',
        toolName: 'Bash',
        reason: expect.any(String),
      }),
    );
    const persistedLog = JSON.stringify(warn.mock.calls);
    expect(persistedLog).not.toContain(command);
    expect(persistedLog).not.toContain('super-secret');
  });

  it('lets the command through when the capability is gated off', async () => {
    const { logger, warn } = createLoggerSpy();
    const shouldEnforce = vi.fn(() => false);
    const hook = createIOSSimulatorShellGuardHook(logger, shouldEnforce);

    const result = await hook(
      {
        session_id: 'session-1',
        transcript_path: '/tmp/transcript',
        cwd: '/repo',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'xcrun simctl boot DEVICE' },
      } as never,
      'tool-1',
      { signal: new AbortController().signal },
    );

    // The user's own Xcode tooling must run when there is no embedded simulator
    // to protect; denying here would point at a tool the gate has removed.
    expect(result).toEqual({ continue: true });
    expect(shouldEnforce).toHaveBeenCalledWith('/repo');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still denies while the capability is available', async () => {
    const { logger } = createLoggerSpy();
    const shouldEnforce = vi.fn(() => true);
    const hook = createIOSSimulatorShellGuardHook(logger, shouldEnforce);

    const result = await hook(
      {
        session_id: 'session-1',
        transcript_path: '/tmp/transcript',
        cwd: '   ',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'open -a Simulator' },
      } as never,
      'tool-2',
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    // A blank cwd is unknown, not the repository root.
    expect(shouldEnforce).toHaveBeenCalledWith(null);
  });
});
