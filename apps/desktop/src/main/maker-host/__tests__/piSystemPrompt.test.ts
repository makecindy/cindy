import { describe, expect, it } from 'vitest';

import { composePiSystemPrompt } from '../pi-host.js';
import hostSystemPrompt from '../host-system-prompt.md?raw';
import piSystemPrompt from '../pi-system-prompt.md?raw';
import userFacingPlansPrompt from '../user-facing-plans-prompt.md?raw';

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

  // 用户可见计划的写法是 vendor-neutral 规则，Pi 也画计划。但必须追加在拼接末尾：
  // 既有会话的缓存前缀是「到上一段为止的字节」，插进中间会把它们全部作废（§3.1）；
  // 这段断言同时防两件事——Pi 拿不到该段、以及该段不再落在末尾破坏前缀稳定性。
  it('appends the shared user-facing plan guidance to Pi after the Pi behavior section', () => {
    const prompt = composePiSystemPrompt(hostSystemPrompt, piSystemPrompt, userFacingPlansPrompt);
    expect(prompt).toContain('## User-facing plans');
    expect(prompt).toContain('Write for a general user, not as internal engineering notes.');
    expect(prompt.endsWith(userFacingPlansPrompt.trim())).toBe(true);
  });
});
