import { describe, expect, it } from 'vitest';

import { parseSubagentModelSettingsPatch } from '../parse-subagent-model-settings-patch';

describe('parseSubagentModelSettingsPatch', () => {
  it.each([
    'gpt-5.6-luna',
    'codex/gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ])('rejects an explicit Codex default without a per-session eligibility contract: %s', (codex) => {
    expect(() => parseSubagentModelSettingsPatch({ codex })).toThrow(
      /explicit Codex subagent defaults are unavailable/,
    );
  });

  it('rejects an effort-only Codex default', () => {
    expect(() => parseSubagentModelSettingsPatch({ codexEffort: 'high' })).toThrow(
      /explicit Codex subagent defaults are unavailable/,
    );
  });

  it('rejects a provider-only Codex default', () => {
    expect(() => parseSubagentModelSettingsPatch({ codexProviderId: 'openai' })).toThrow(
      /explicit Codex subagent defaults are unavailable/,
    );
  });

  it('allows the historical Codex triple to be cleared atomically', () => {
    expect(
      parseSubagentModelSettingsPatch({
        codex: null,
        codexProviderId: null,
        codexEffort: null,
      }),
    ).toEqual({ codex: null, codexProviderId: null, codexEffort: null });
  });

  it('continues to accept unrelated guardrail changes', () => {
    expect(
      parseSubagentModelSettingsPatch({
        codexSubagentsEnabled: false,
        codexUseCindySubagentPolicy: false,
        codexMaxConcurrentSubagents: 4,
        codexAllowNestedSubagents: true,
      }),
    ).toEqual({
      codexSubagentsEnabled: false,
      codexUseCindySubagentPolicy: false,
      codexMaxConcurrentSubagents: 4,
      codexAllowNestedSubagents: true,
    });
  });
});
