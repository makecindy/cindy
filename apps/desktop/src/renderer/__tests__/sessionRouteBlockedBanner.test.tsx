import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionRouteBlockedBannerView,
  assessSessionRouteHealth,
  formatRouteAlternativeLabel,
} from '@/features/cc-agent/SessionRouteBlockedBanner';
import type { ProbeLike, ProviderFileEntry, RoutingFile } from '@cindy/model-providers';

describe('SessionRouteBlockedBanner (ROADMAP 2.4b)', () => {
  const providers: ProviderFileEntry[] = [
    {
      id: 'ollama-local',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      local: true,
      capabilities: { tools: true, vision: false },
    },
    {
      id: 'lmstudio-local',
      kind: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      local: true,
      capabilities: { tools: true, vision: false },
    },
    {
      id: 'deepseek-api',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      keyEnv: 'DEEPSEEK_API_KEY',
      local: false,
      capabilities: { tools: true, vision: false },
    },
  ];

  const routing: RoutingFile = {
    routes: {
      'local-coder': { provider: 'ollama-local', model: 'qwen2.5-coder:7b' },
      'local-backup': { provider: 'lmstudio-local', model: 'qwen3-8b' },
      'cloud-flash': { provider: 'deepseek-api', model: 'deepseek-chat' },
    },
    rules: {
      'chat.default': 'local-coder',
    },
  };

  it('blocks when the routed local endpoint is offline, lists healthy local alternatives before paid ones, and never auto-switches', () => {
    const probes: ProbeLike[] = [
      { id: 'ollama-local', status: 'offline', models: [], error: 'ECONNREFUSED' },
      { id: 'lmstudio-local', status: 'online', models: ['qwen3-8b'] },
      { id: 'deepseek-api', status: 'online', models: ['deepseek-chat'] },
    ];

    const onSelect = vi.fn();
    const health = assessSessionRouteHealth({
      sessionModel: 'hermes-default',
      routing,
      providers,
      probes,
    });

    expect(health).not.toBeNull();
    expect(health?.ok).toBe(false);
    if (health && !health.ok) {
      expect(health.reason).toBe('provider-offline');
      expect(health.alternatives).toEqual([
        {
          routeName: 'local-backup',
          provider: 'lmstudio-local',
          model: 'qwen3-8b',
          paid: false,
        },
        {
          routeName: 'cloud-flash',
          provider: 'deepseek-api',
          model: 'deepseek-chat',
          paid: true,
        },
      ]);
    }

    const html = renderToStaticMarkup(
      <SessionRouteBlockedBannerView health={health} onSelectAlternative={onSelect} />,
    );

    expect(onSelect).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="session-route-blocked-banner"');
    expect(html).toContain('ollama-local');
    expect(html).toContain('ECONNREFUSED');
    expect(html).toContain(
      'Use local-backup (lmstudio-local/qwen3-8b) (local) instead',
    );
    expect(html).toContain(
      'Use cloud-flash (deepseek-api/deepseek-chat) (paid) instead',
    );
  });

  it('matches an explicit per-session model override against routing.yaml routes and returns null when healthy', () => {
    const probes: ProbeLike[] = [
      { id: 'lmstudio-local', status: 'online', models: ['qwen3-8b'] },
    ];

    const health = assessSessionRouteHealth({
      sessionModel: 'qwen3-8b',
      routing,
      providers,
      probes,
    });

    expect(health).toEqual({
      ok: true,
      routeName: 'local-backup',
      provider: 'lmstudio-local',
      model: 'qwen3-8b',
    });

    const html = renderToStaticMarkup(
      <SessionRouteBlockedBannerView health={health} onSelectAlternative={() => undefined} />,
    );
    expect(html).toBe('');
  });

  it('returns null for hermes sessions using hermes-default (home config owns route)', () => {
    const probes: ProbeLike[] = [
      { id: 'ollama-local', status: 'offline', models: [], error: 'ECONNREFUSED' },
    ];
    const health = assessSessionRouteHealth({
      agentKind: 'hermes',
      sessionModel: 'hermes-default',
      routing,
      providers,
      probes,
    });
    expect(health).toBeNull();
  });

  it('formats local vs paid alternative labels explicitly', () => {
    expect(
      formatRouteAlternativeLabel({
        routeName: 'local-backup',
        provider: 'lmstudio-local',
        model: 'qwen3-8b',
        paid: false,
      }),
    ).toBe('Use local-backup (lmstudio-local/qwen3-8b) (local) instead');
    expect(
      formatRouteAlternativeLabel({
        routeName: 'cloud-flash',
        provider: 'deepseek-api',
        model: 'deepseek-chat',
        paid: true,
      }),
    ).toBe('Use cloud-flash (deepseek-api/deepseek-chat) (paid) instead');
  });
});
