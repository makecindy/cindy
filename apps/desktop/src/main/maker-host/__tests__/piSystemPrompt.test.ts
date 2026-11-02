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

  it('keeps dedicated file-tool guidance in the Pi behavior section', () => {
    expect(piSystemPrompt).toContain(
      'Use the dedicated grep tool for content search, the find tool for file discovery, the ls tool for directory listings, and the read tool for examining files.',
    );
    expect(piSystemPrompt).toContain(
      'Use Bash for Git, builds, tests, package managers, and shell operations not covered by a dedicated tool.',
    );
  });

  it('does not extend Claude/Codex Skill precedence into Pi', () => {
    expect(composePiSystemPrompt(hostSystemPrompt, piSystemPrompt)).not.toContain(
      '## Skill source precedence',
    );
  });

  // 用户可见计划的写法是 vendor-neutral 规则，Pi 也画计划，所以从 agent 专属段
  // 挪到了 host 段；这段断言防止它再被退回只对 Claude/Codex 生效的位置。
  it('gives Pi the same user-facing plan guidance as Claude and Codex', () => {
    expect(hostSystemPrompt).toContain('## User-facing plans');
    expect(composePiSystemPrompt(hostSystemPrompt, piSystemPrompt)).toContain(
      'Write for a general user, not as internal engineering notes.',
    );
  });
});
