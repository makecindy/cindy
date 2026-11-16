import { buildPiRuntimeConfig } from '../../maker-host/runtimeConfigsCore';
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

// Guard: the approved settings-navigation rule must reach every production engine once.
// This verifies assembly, not live model compliance or real prompt-cache hit rates.
it('includes device-bound settings guidance in Claude, Codex and Pi', () => {
  const configs = [
    buildDesktopClaudeRuntimeConfig(() => 'https://model.example'), desktopCodexRuntimeConfig,
    buildPiRuntimeConfig({ ripgrepPath: '/fixture/rg', userDataPath: '/fixture/data',
      endpoint: () => 'https://model.example', remoteEndpoint: () => 'https://model.example' }),
  ];
  for (const config of configs) {
    expect(config.systemPrompt?.match(/host-generated settings link from get_settings_link/g)).toHaveLength(1);
    expect(config.systemPrompt).toContain('use connect_account with the discovered plugin identity to present its native connection button');
    expect(config.systemPrompt).toContain('use a settings link only if the Host reports no supported setup action');
    expect(config.systemPrompt).toContain('Preserve the target device.');
    expect(config.systemPrompt).toContain('Opening settings does not mean configuration or sign-in is complete.');
  }
});
