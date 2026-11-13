import { expect, it } from 'vitest';
import { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } from '../../maker-host/runtime-configs.js';
import hostPrompt from '../../maker-host/host-system-prompt.md?raw';
import ownership from '../../maker-host/business-ownership-prompt.md?raw';
import precedence from '../../maker-host/skill-source-precedence-prompt.md?raw';
import claudePrompt from '../../maker-host/claude-system-prompt.md?raw';
import codexPrompt from '../../maker-host/codex-system-prompt.md?raw';

// Guard tier: cindy-bots-runtime.md §6 and engineering-conventions.md §3.2.
// The exact cross-file prompt contract keeps host ownership and native engine
// guidance intact without injecting remote-authorization policy into either.
// Runtime model-choice behavior is separately exercised in the isolated Desktop.
it('keeps the upstream Desktop system prompt unchanged by remote authorization', () => {
  const cases = [
    [buildDesktopClaudeRuntimeConfig(() => 'https://model.example'), claudePrompt],
    [desktopCodexRuntimeConfig, codexPrompt],
  ] as const;
  for (const [config, harnessPrompt] of cases) {
    expect(config.systemPrompt).toBe([hostPrompt, ownership, precedence, harnessPrompt]
      .map(section => section.trim()).filter(Boolean).join('\n\n'));
    expect(config.systemPrompt).not.toContain('Plugin accounts and remote authorization');
  }
});
