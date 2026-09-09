import { describe, expect, it } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  buildCodexSmartModelCatalog,
  selectCodexSmartSubagentCandidates,
} from '../codex-smart-subagent-routing';

function model(id: string, group = 'china'): CatalogModel {
  return {
    id,
    name: id,
    group,
    contextWindow: 200_000,
    efforts: ['low', 'medium'],
    defaultEffort: 'medium',
    capabilities: { toolCall: true },
  };
}

function provider(
  id: string,
  models: CatalogModel[],
  opts: { connected?: boolean; authStrategy?: 'gateway-key' | 'oauth-passthrough' } = {},
): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    connected: opts.connected ?? true,
    agents: ['codex'],
    auth: { method: opts.authStrategy === 'oauth-passthrough' ? 'oauth' : 'managed' },
    routing: {
      codex: {
        upstream: `https://${id}.invalid/v1`,
        authStrategy: opts.authStrategy ?? 'gateway-key',
      },
    },
    models: { codex: models },
  } as ProviderView;
}

const baseCatalog = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'Sol',
      priority: 6,
      multi_agent_version: 'v2',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'Terra',
      priority: 7,
      multi_agent_version: 'v2',
      base_instructions: 'codex instructions',
      use_responses_lite: true,
      tool_mode: 'code_mode_only',
      include_skills_usage_instructions: false,
      supported_reasoning_levels: [{ effort: 'medium', description: 'medium' }],
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'Luna',
      priority: 8,
      multi_agent_version: 'v1',
      supported_reasoning_levels: [{ effort: 'medium', description: 'medium' }],
    },
  ],
};

describe('Codex smart Subagent catalog', () => {
  it('preserves a newly discovered native v2 model including its larger maximum window', () => {
    const astra = {
      slug: 'gpt-6-astra',
      multi_agent_version: 'v2',
      context_window: 272_000,
      max_context_window: 872_000,
      supported_reasoning_levels: [{ effort: 'ultra', description: 'native delegation' }],
    };
    const built = buildCodexSmartModelCatalog({ models: [astra] }, [
      { providerId: 'openai', model: model('gpt-6-astra', 'gpt') },
      { providerId: 'xd', model: model('deepseek/deepseek-v4-flash') },
    ]);
    expect(built?.models[0]).toEqual(astra);
    expect(built?.models[1]).toMatchObject({
      slug: 'deepseek/deepseek-v4-flash',
      context_window: 200_000,
      max_context_window: 200_000,
    });
  });

  it('keeps native Sol/Terra and selects additional connected Codex chat models', () => {
    const candidates = selectCodexSmartSubagentCandidates(
      [
        provider('openai', [model('gpt-5.6-sol'), model('gpt-5.6-luna', 'gpt-budget')], {
          authStrategy: 'oauth-passthrough',
        }),
        provider('xd', [model('deepseek/deepseek-v4-flash')]),
        provider('offline', [model('z-ai/glm-5.2')], { connected: false }),
      ],
      { allowChatGptOAuth: true },
    );
    expect(candidates.map(({ providerId, model: entry }) => [providerId, entry.id])).toEqual([
      ['openai', 'gpt-5.6-luna'],
      ['xd', 'deepseek/deepseek-v4-flash'],
    ]);
  });

  it('excludes ChatGPT passthrough routes when the host does not own that OAuth credential', () => {
    const candidates = selectCodexSmartSubagentCandidates(
      [
        provider('openai', [model('gpt-5.6-luna', 'gpt-budget')], {
          authStrategy: 'oauth-passthrough',
        }),
      ],
      { allowChatGptOAuth: false },
    );
    expect(candidates).toEqual([]);
  });

  it('falls back to another connected source for the same model without ChatGPT OAuth', () => {
    const shared = model('gpt-5.6-luna', 'gpt-budget');
    const candidates = selectCodexSmartSubagentCandidates(
      [
        provider('openai', [shared], { authStrategy: 'oauth-passthrough' }),
        provider('xd', [shared]),
      ],
      { allowChatGptOAuth: false },
    );
    expect(candidates.map(({ providerId, model: entry }) => [providerId, entry.id])).toEqual([
      ['xd', 'gpt-5.6-luna'],
    ]);
  });

  it('upgrades Luna to the parent V2 backend and clones safe metadata for routed models', () => {
    const candidates = [
      { providerId: 'openai', model: model('gpt-5.6-luna', 'gpt-budget') },
      { providerId: 'xd', model: model('deepseek/deepseek-v4-flash') },
    ];
    const built = buildCodexSmartModelCatalog(baseCatalog, candidates);
    expect(built?.routes).toEqual([
      { providerId: 'openai', catalogModel: 'gpt-5.6-luna' },
      { providerId: 'xd', catalogModel: 'deepseek/deepseek-v4-flash' },
    ]);
    expect(built?.models.find((entry) => entry.slug === 'gpt-5.6-luna')).toMatchObject({
      multi_agent_version: 'v2',
      display_name: 'gpt-5.6-luna',
    });
    expect(
      built?.models.find((entry) => entry.slug === 'deepseek/deepseek-v4-flash'),
    ).toMatchObject({
      multi_agent_version: 'v2',
      base_instructions: 'codex instructions',
      context_window: 200_000,
      use_responses_lite: false,
      tool_mode: null,
      include_skills_usage_instructions: true,
    });
  });

  it('recognizes a namespaced codex/gpt model as GPT while keeping full prompts for non-GPT routes', () => {
    const built = buildCodexSmartModelCatalog(baseCatalog, [
      { providerId: 'xd', model: model('codex/gpt-5.6-luna', 'gpt-budget') },
      { providerId: 'xd', model: model('z-ai/glm-5.2') },
    ]);
    expect(built?.models.find((entry) => entry.slug === 'codex/gpt-5.6-luna')).toMatchObject({
      use_responses_lite: true,
      tool_mode: 'code_mode_only',
      include_skills_usage_instructions: false,
      multi_agent_version: 'v2',
    });
    expect(built?.models.find((entry) => entry.slug === 'z-ai/glm-5.2')).toMatchObject({
      use_responses_lite: false,
      tool_mode: null,
      include_skills_usage_instructions: true,
      multi_agent_version: 'v2',
    });
  });
});
