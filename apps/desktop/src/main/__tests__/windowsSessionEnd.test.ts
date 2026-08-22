import { describe, expect, it } from 'vitest';

import {
  markWindowsSessionEnding,
  shouldSuppressWindowsSessionEndClaudeError,
} from '../windowsSessionEnd';

describe('Windows session-end terminal error classification', () => {
  it('suppresses only an active Claude terminal after Windows session end is observed', () => {
    const activeClaudeTerminal = {
      sessionId: 'active-session',
      source: 'claude-code',
      isTerminalError: true,
    };

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(false);

    markWindowsSessionEnding(['active-session']);

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(true);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        source: 'codex',
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        isTerminalError: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        sessionId: 'already-idle-session',
      }),
    ).toBe(false);
  });
});
