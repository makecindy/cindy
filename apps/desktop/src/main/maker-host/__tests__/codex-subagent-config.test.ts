import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  type SubagentModelSettings,
} from '../../../shared/subagentModelSettings';
import {
  buildCodexSubagentSpawnArgs,
  codexHostUsesSmartSubagentRouting,
  resolveCodexSubagentRoutingProfile,
  type CodexSmartSubagentConfig,
} from '../codex-subagent-config';

function settings(partial: Partial<SubagentModelSettings> = {}): SubagentModelSettings {
  return { ...SUBAGENT_MODEL_SETTINGS_DEFAULTS, ...partial };
}

const smartConfig: CodexSmartSubagentConfig = {
  catalogPath: '/tmp/cindy smart models.json',
  modelCatalog: { models: [{ slug: 'gpt-5.6-sol' }] },
  routingSignature: 'smart:test',
  routes: [
    { providerId: 'openai', catalogModel: 'gpt-5.6-luna' },
    { providerId: 'xd', catalogModel: 'deepseek/deepseek-v4-flash' },
  ],
};

describe('buildCodexSubagentSpawnArgs', () => {
  it('leaves Codex native Subagent routing byte-for-byte untouched by default', () => {
    expect(buildCodexSubagentSpawnArgs(settings(), smartConfig)).toEqual([]);
    expect(resolveCodexSubagentRoutingProfile(settings(), smartConfig)).toBe('default');
  });

  it('adds the startup catalog and compact model menu only when smart routing is enabled', () => {
    const enabled = settings({ codexSmartSubagentRouting: true });
    const args = buildCodexSubagentSpawnArgs(enabled, smartConfig);
    expect(args).toEqual([
      '-c',
      'model_catalog_json="/tmp/cindy smart models.json"',
      '-c',
      'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
      '-c',
      expect.stringContaining('gpt-5.6-luna, deepseek/deepseek-v4-flash'),
    ]);
    expect(resolveCodexSubagentRoutingProfile(enabled, smartConfig)).toBe('smart');
  });

  it('fails back to native routing when no safe smart catalog was prepared', () => {
    const enabled = settings({ codexSmartSubagentRouting: true });
    expect(buildCodexSubagentSpawnArgs(enabled)).toEqual([]);
    expect(resolveCodexSubagentRoutingProfile(enabled)).toBe('default');
  });
});

describe('codexHostUsesSmartSubagentRouting', () => {
  const enabled = settings({ codexSmartSubagentRouting: true });

  it('applies smart routing to ordinary task hosts when enabled (unchanged)', () => {
    expect(codexHostUsesSmartSubagentRouting(enabled, {})).toBe(true);
    expect(codexHostUsesSmartSubagentRouting(enabled, { hostPurpose: 'custom-context' })).toBe(true);
    expect(codexHostUsesSmartSubagentRouting(settings(), {})).toBe(false);
    expect(codexHostUsesSmartSubagentRouting(enabled, { hostPurpose: 'control-plane' })).toBe(false);
    expect(codexHostUsesSmartSubagentRouting(enabled, { hostPurpose: 'review' })).toBe(false);
  });

  it('never applies it to a shared-provider guest host: no catalog, no spawn model overrides', () => {
    expect(codexHostUsesSmartSubagentRouting(enabled, { deviceHostedGuestProviderId: 'xd' })).toBe(false);
    // The host skips preparation, so the spawn arguments stay empty and the routing profile default.
    expect(buildCodexSubagentSpawnArgs(enabled, undefined)).toEqual([]);
    expect(resolveCodexSubagentRoutingProfile(enabled, undefined)).toBe('default');
  });
});
