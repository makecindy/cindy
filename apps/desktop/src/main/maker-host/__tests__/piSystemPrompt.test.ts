import { describe, expect, it } from 'vitest';

import { composePiSystemPrompt, desktopPiSystemPrompt } from '../pi-host.js';
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

  // 用户可见计划的写法是 vendor-neutral 规则，Pi 也画计划。走生产入口 desktopPiSystemPrompt
  // 断言真实接线：Pi 拿得到该段，且它追加在末尾——插入中间会把既有会话的缓存前缀
  // 全部作废（§3.1），「计划段是最后一个二级标题」守住这个不变量。
  it('appends the shared user-facing plan guidance to Pi after the Pi behavior section', () => {
    const prompt = desktopPiSystemPrompt();
    const plansStart = prompt.indexOf('## User-facing plans');
    expect(plansStart).toBeGreaterThan(-1);
    expect(prompt).toContain('Write for a general user, not as internal engineering notes.');
    expect(plansStart).toBeGreaterThan(prompt.indexOf('dedicated grep tool'));
    expect(prompt.slice(plansStart).match(/^## /gm)).toHaveLength(1);
  });
});
