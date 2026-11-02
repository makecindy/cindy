import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@cindy/maker-core';
import { SHELL_DESKTOP_INPUT_DENIAL_REASON } from '@cindy/maker-core';

import {
  createDesktopInputShellGuardHooks,
  SHELL_DESKTOP_INPUT_DISABLED_REASON,
} from '../claude-hooks/desktop-input-shell-guard-hook';

const hookOptions = { signal: new AbortController().signal };

function preToolUseInput(toolName: string, command: unknown): never {
  return {
    session_id: 'session-1',
    transcript_path: '/tmp/t',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
    tool_use_id: 'tool-1',
  } as never;
}

/**
 * Rule basis: CU-014 — the deny must hold in Full access (hook, not canUseTool)
 * and must vanish when Cindy Computer Use is off (no replacement to point at).
 * Gap: no Bash-text guard existed in the host hook set. Tier: unit.
 */
describe('createDesktopInputShellGuardHooks', () => {
  const keystroke = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;

  it('denies shell-simulated desktop input with the cindy_computer reason', async () => {
    const hook = createDesktopInputShellGuardHooks(() => true).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected guard hook');
    await expect(hook(preToolUseInput('Bash', keystroke), 'tool-1', hookOptions)).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SHELL_DESKTOP_INPUT_DENIAL_REASON,
      },
    });
  });

  // Review (#8227 round 11): the typed text is the sensitive part; it must not reach the log.
  it('logs the denial without the command text', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const hook = createDesktopInputShellGuardHooks(() => true, logger).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected guard hook');
    const secret = 'hunter2-private-message';
    await hook(
      preToolUseInput(
        'Bash',
        `osascript -e 'tell application "System Events" to keystroke "${secret}"'`,
      ),
      'tool-1',
      hookOptions,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(warn.mock.calls[0]![1]).toMatchObject({ toolUseId: 'tool-1', computerUseEnabled: true });
  });

  it('passes other commands, other tools and malformed input through untouched', async () => {
    const hook = createDesktopInputShellGuardHooks(() => true).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected guard hook');
    await expect(
      hook(preToolUseInput('Bash', 'screencapture -x /tmp/a.png'), 'tool-1', hookOptions),
    ).resolves.toEqual({ continue: true });
    await expect(
      hook(preToolUseInput('BashOutput', keystroke), 'tool-1', hookOptions),
    ).resolves.toEqual({ continue: true });
    await expect(hook(preToolUseInput('Bash', 42), 'tool-1', hookOptions)).resolves.toEqual({
      continue: true,
    });
  });

  // 2026-10-31 sandbox run: with Computer Use off, the keystroke was not denied and
  // landed in the front window. Shell input is never the entry, so still deny; only
  // the reason changes to point at the setting instead of a tool that is absent.
  it('still denies while Cindy Computer Use is disabled, pointing at the setting', async () => {
    const enabled = vi.fn(() => false);
    const hook = createDesktopInputShellGuardHooks(enabled).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected guard hook');
    await expect(
      hook(preToolUseInput('Bash', keystroke), 'tool-1', hookOptions),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: SHELL_DESKTOP_INPUT_DISABLED_REASON,
      },
    });
    expect(SHELL_DESKTOP_INPUT_DISABLED_REASON).toContain('Computer Use is disabled');
    expect(enabled).toHaveBeenCalled();
  });
});
