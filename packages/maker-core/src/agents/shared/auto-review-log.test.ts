import { describe, expect, it, vi } from 'vitest';

import { logAutoReviewDecision } from './auto-review-log.js';

describe('auto-review decision log redaction', () => {
  it('keeps known commands as fixed labels without logging their arguments', () => {
    const debug = vi.fn();
    const command = 'C:\\tools\\PNPM.CMD --filter private-package test';
    logAutoReviewDecision({ debug } as never, {
      agentKind: 'codex',
      action: { kind: 'exec', command },
      source: 'reviewer',
      verdict: 'allow',
      elapsedMs: 3,
    });

    expect(debug).toHaveBeenCalledWith('auto-review decision', expect.objectContaining({
      bin: 'pnpm',
      commandChars: command.length,
    }));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private-package');
  });

  it('collapses an unknown or secret-looking first word to a fixed other label', () => {
    const debug = vi.fn();
    const suspiciousFirstWord = ['gh', 'p_', 'x'.repeat(40)].join('');
    logAutoReviewDecision({ debug } as never, {
      agentKind: 'pi',
      action: { kind: 'exec', command: `${suspiciousFirstWord} --version` },
      source: 'static',
      verdict: 'block',
      elapsedMs: 0,
    });

    expect(debug).toHaveBeenCalledWith('auto-review decision', expect.objectContaining({
      bin: 'other',
    }));
    expect(JSON.stringify(debug.mock.calls)).not.toContain(suspiciousFirstWord);
  });
});
