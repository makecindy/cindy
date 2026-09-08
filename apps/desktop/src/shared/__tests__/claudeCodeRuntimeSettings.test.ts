import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_CODE_RUNTIME_SETTINGS,
  MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH,
  normalizeClaudeCodeRuntimeSettings,
} from '../claudeCodeRuntimeSettings.js';

describe('Claude Code runtime settings', () => {
  it('defaults to the Cindy-managed runtime', () => {
    expect(normalizeClaudeCodeRuntimeSettings(null)).toEqual(DEFAULT_CLAUDE_CODE_RUNTIME_SETTINGS);
  });

  it('normalizes the system source and trims its optional path', () => {
    expect(
      normalizeClaudeCodeRuntimeSettings({
        source: 'system',
        customPath: '  /opt/claude  ',
      }),
    ).toEqual({ source: 'system', customPath: '/opt/claude' });
  });

  it('bounds persisted paths and rejects unknown source values by normalization', () => {
    const normalized = normalizeClaudeCodeRuntimeSettings({
      source: 'external',
      customPath: 'x'.repeat(MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH + 50),
    });
    expect(normalized.source).toBe('managed');
    expect(normalized.customPath).toHaveLength(MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH);
  });
});
