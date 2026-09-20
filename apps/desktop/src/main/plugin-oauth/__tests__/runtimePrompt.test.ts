import { expect, it } from 'vitest';
import {
  buildDesktopClaudeRuntimeConfig,
  desktopCodexRuntimeConfig,
} from '../../maker-host/runtime-configs.js';
import { PLUGIN_AUTHORIZATION_PROMPT } from '../prompt.js';
it('adds stable guidance to actual Claude/Codex Host configs without instance configuration', () => {
  for (const config of [
    buildDesktopClaudeRuntimeConfig(() => 'https://model.example'),
    desktopCodexRuntimeConfig,
  ]) {
    const prompt = config.systemPrompt!;
    expect(prompt.endsWith(PLUGIN_AUTHORIZATION_PROMPT)).toBe(true);
    expect(prompt.split(PLUGIN_AUTHORIZATION_PROMPT)).toHaveLength(2);
    expect(config.systemPrompt).toBe(prompt);
  }
});
