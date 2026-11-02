import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionContextGuardBannerView,
  buildConversationSummaryPrompt,
  resolveSessionContextLength,
  resolveSessionUsedTokens,
} from '@/features/cc-agent/SessionContextGuardBanner';
import { guardContext, type ProbeLike, type ProviderFileEntry, type RoutingFile } from '@cindy/model-providers';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';

describe('SessionContextGuardBanner (ROADMAP 2.5b)', () => {
  const providers: ProviderFileEntry[] = [
    {
      id: 'ollama-local',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      local: true,
      capabilities: { tools: true, vision: false, contextLength: 32_768 },
    },
    {
      id: 'lmstudio-local',
      kind: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      local: true,
      capabilities: { tools: true, vision: false, contextLength: 65_536 },
    },
    {
      id: 'deepseek-api',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      keyEnv: 'DEEPSEEK_API_KEY',
      local: false,
      capabilities: { tools: true, vision: false, contextLength: 128_000 },
    },
  ];

  const routing: RoutingFile = {
    routes: {
      'local-small': { provider: 'ollama-local', model: 'qwen3:8b' },
      'local-backup': { provider: 'lmstudio-local', model: 'qwen3-8b' },
      'cloud-flash': { provider: 'deepseek-api', model: 'deepseek-chat' },
    },
    rules: {
      summary: 'local-small',
      'chat.default': 'local-backup',
    },
  };

  it('extracts latest assistant turn token usage and resolves active model contextLength from providers.yaml', () => {
    const messages = [
      { role: 'user' as const, content: 'First prompt' },
      {
        role: 'assistant' as const,
        content: 'First reply',
        turnUsageDetails: buildTurnUsageDetails({
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        })!,
      },
      { role: 'user' as const, content: 'Second prompt' },
      {
        role: 'assistant' as const,
        content: 'Second reply',
        turnUsageDetails: buildTurnUsageDetails({
          inputTokens: 54_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        })!,
      },
    ];

    const usedTokens = resolveSessionUsedTokens(messages, {
      contextTokens: 12_000,
      totalTokenUsage: 69_000,
    });
    expect(usedTokens).toBe(57_000);

    const contextLength = resolveSessionContextLength({
      sessionModel: 'qwen3-8b',
      routing,
      providers,
    });
    expect(contextLength).toBe(65_536);

    const explicitContext = resolveSessionContextLength({
      sessionModel: 'hermes-default',
      sessionContextWindow: 200_000,
      routing,
      providers,
    });
    expect(explicitContext).toBe(200_000);
  });

  it('takes the limit from the online endpoint serving a discovered model, not chat.default', () => {
    // Owner repro 2026-11-01: Gemma discovered on LM Studio (262k) was measured against
    // chat.default's Ollama route (32k), so 35k tokens showed as "108% full".
    const discoveredModel = 'google/gemma-4-26b-a4b-qat';
    const probes: ProbeLike[] = [
      { id: 'ollama-local', status: 'online', models: ['qwen3:8b'] },
      { id: 'lmstudio-local', status: 'online', models: ['qwen3-8b', discoveredModel] },
    ];
    const ollamaDefault: RoutingFile = { ...routing, rules: { ...routing.rules, 'chat.default': 'local-small' } };
    expect(resolveSessionContextLength({
      sessionModel: discoveredModel,
      routing: ollamaDefault,
      providers,
      probes,
    })).toBe(65_536);
    // An offline endpoint's stale list is not evidence of where the model runs.
    expect(resolveSessionContextLength({
      sessionModel: discoveredModel,
      routing: ollamaDefault,
      providers,
      probes: [{ id: 'lmstudio-local', status: 'offline', models: [discoveredModel] }],
    })).toBe(32_768);
  });

  it('never measures the Hermes home model against a local route (ROADMAP 3.7b)', () => {
    // Owner repro 2026-11-02: a hermes-default (DeepSeek) Orca lead at 57k tokens showed
    // "174% full" because the 32k chat.default/provider limit was used.
    const ollamaDefault: RoutingFile = { ...routing, rules: { ...routing.rules, 'chat.default': 'local-small' } };
    expect(resolveSessionContextLength({
      sessionModel: 'hermes-default',
      sessionProviderId: 'ollama-local',
      sessionContextWindow: 200_000,
      routing: ollamaDefault,
      providers,
    })).toBe(200_000);
    // No reported window: no limit (no banner), not a borrowed 32k.
    expect(resolveSessionContextLength({
      sessionModel: 'hermes-default',
      sessionProviderId: 'ollama-local',
      sessionContextWindow: 0,
      routing: ollamaDefault,
      providers,
    })).toBeUndefined();
    // A routed local model still uses its endpoint's limit.
    expect(resolveSessionContextLength({
      sessionModel: 'qwen3:8b',
      sessionContextWindow: 200_000,
      routing: ollamaDefault,
      providers,
    })).toBe(32_768);
  });

  it('renders warning banner with "Summarise and continue" button when context is >= 80% and summary route is healthy', () => {
    const probes: ProbeLike[] = [
      { id: 'ollama-local', status: 'online', models: ['qwen3:8b'] },
    ];
    const guard = guardContext({
      usedTokens: 28_000,
      contextLength: 32_768,
      routing,
      providers,
      probes,
    });

    expect(guard.context.level).toBe('warn');
    expect(guard.summarise).toEqual({
      ok: true,
      routeName: 'local-small',
      provider: 'ollama-local',
      model: 'qwen3:8b',
    });

    const html = renderToStaticMarkup(
      <SessionContextGuardBannerView
        guard={guard}
        onSummariseAndContinue={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="session-context-guard-banner"');
    expect(html).toContain('data-context-level="warn"');
    expect(html).toContain('Context is 85% full (4768 tokens left)');
    expect(html).toContain('data-testid="summarise-and-continue-btn"');
    expect(html).toContain('Summarise and continue (ollama-local/qwen3:8b)');
  });

  it('shows blocked summary route notice and one-click alternatives without auto-switching when summariser is offline', () => {
    const probes: ProbeLike[] = [
      { id: 'ollama-local', status: 'offline', models: [], error: 'ECONNREFUSED' },
      { id: 'lmstudio-local', status: 'online', models: ['qwen3-8b'] },
      { id: 'deepseek-api', status: 'online', models: ['deepseek-chat'] },
    ];
    const guard = guardContext({
      usedTokens: 31_500,
      contextLength: 32_768,
      routing,
      providers,
      probes,
    });

    expect(guard.context.level).toBe('critical');
    expect(guard.summarise?.ok).toBe(false);

    const onSummarise = vi.fn();
    const html = renderToStaticMarkup(
      <SessionContextGuardBannerView
        guard={guard}
        onSummariseAndContinue={onSummarise}
      />,
    );

    expect(onSummarise).not.toHaveBeenCalled();
    expect(html).toContain('data-context-level="critical"');
    expect(html).toContain('Summary route blocked: Route &quot;local-small&quot;: &quot;ollama-local&quot; is offline (ECONNREFUSED)');
    expect(html).toContain('Use local-backup (lmstudio-local/qwen3-8b) (local) instead');
    expect(html).toContain('Use cloud-flash (deepseek-api/deepseek-chat) (paid) instead');
  });

  it('builds a bounded conversation summary prompt from user and assistant messages', () => {
    const prompt = buildConversationSummaryPrompt(
      [
        { role: 'user', content: 'Old message that exceeds budget' },
        { role: 'assistant', content: 'Newest assistant reply' },
      ],
      40,
    );

    expect(prompt).toContain('Assistant: Newest assistant reply');
    expect(prompt).not.toContain('Old message that exceeds budget');
  });
});
