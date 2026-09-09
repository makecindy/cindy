import { describe, expect, it } from 'vitest';

import { CODEX_HISTORY_OVERSIZED_REASON } from '@cindy/maker-core';

import {
  canUpgradeStalledErrorContent,
  mergeOversizedHistoryReason,
  parsePersistedErrorContent,
} from '../codexHistoryOversizedUpgrade';

describe('codexHistoryOversizedUpgrade', () => {
  it('only upgrades persisted reconnect-stalled errors', () => {
    expect(canUpgradeStalledErrorContent({ reason: 'codex_reconnect_stalled' })).toBe(true);
    expect(canUpgradeStalledErrorContent({ reason: 'context-overflow' })).toBe(false);
    expect(canUpgradeStalledErrorContent({ reason: 'turn-failed' })).toBe(false);
    expect(canUpgradeStalledErrorContent(null)).toBe(false);
  });

  it('keeps original error fields when merging the oversized reason', () => {
    const next = mergeOversizedHistoryReason({
      reason: 'codex_reconnect_stalled',
      message: 'old',
      sdkError: 'raw',
      provider: 'openai',
    });
    expect(next.reason).toBe(CODEX_HISTORY_OVERSIZED_REASON);
    expect(next.sdkError).toBe('raw');
    expect(next.provider).toBe('openai');
    expect(String(next.message)).toContain('oversized');
  });

  it('parses object error content and rejects scalars', () => {
    expect(parsePersistedErrorContent(JSON.stringify({ reason: 'codex_reconnect_stalled' }))).toEqual({
      reason: 'codex_reconnect_stalled',
    });
    expect(parsePersistedErrorContent('"plain"')).toBeNull();
    expect(parsePersistedErrorContent('not-json')).toBeNull();
  });
});
