import { describe, expect, it } from 'vitest';

import { composePiSystemPrompt } from '../pi-host.js';
import hostSystemPrompt from '../host-system-prompt.md?raw';
import piSystemPrompt from '../pi-system-prompt.md?raw';

describe('composePiSystemPrompt', () => {
  it('keeps the shared identity first and appends the Pi language behavior', () => {
    const prompt = composePiSystemPrompt(
      'You are Cindy.',
      "Infer the user's primary language and use it for reasoning and user-facing content.",
    );

    expect(prompt).toBe(
      "You are Cindy.\n\nInfer the user's primary language and use it for reasoning and user-facing content.",
    );
  });

  it('trims sections and omits empty ones', () => {
    expect(composePiSystemPrompt('  You are Cindy.  ', '   ')).toBe('You are Cindy.');
  });

  it('does not extend Claude/Codex Skill precedence into Pi', () => {
    expect(composePiSystemPrompt(hostSystemPrompt, piSystemPrompt)).not.toContain(
      '## Skill source precedence',
    );
  });
});
