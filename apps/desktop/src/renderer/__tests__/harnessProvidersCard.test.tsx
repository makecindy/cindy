import {
  parseProvidersFile,
  projectProviderFileEndpoints,
} from '@cindy/model-providers';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  formatEndpointCapabilities,
  HarnessProvidersCardView,
} from '../components/settings/HarnessProvidersCard';

describe('HarnessProvidersCard (ROADMAP 2.1b)', () => {
  it('renders an empty state when no endpoints or issues exist', () => {
    const html = renderToStaticMarkup(
      <HarnessProvidersCardView endpoints={[]} issues={[]} />,
    );
    expect(html).toContain('data-testid="harness-providers-card"');
    expect(html).toContain('No endpoints configured in ~/.cindy-harness/providers.yaml.');
  });

  it('lists configured endpoints with kind, base URL, keyEnv variable name, capabilities, and probe status', () => {
    const parsed = parseProvidersFile({
      providers: [
        {
          id: 'lmstudio-local',
          kind: 'lmstudio',
          baseUrl: 'http://127.0.0.1:1234/v1',
          capabilities: { tools: true, vision: false, contextLength: 32_768 },
        },
        {
          id: 'deepseek',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          keyEnv: 'DEEPSEEK_API_KEY',
          capabilities: { tools: true, vision: true },
        },
        {
          id: 'bad-entry',
          kind: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          keyEnv: 'sk-not-an-env-name',
        },
      ],
    });

    const endpoints = projectProviderFileEndpoints(parsed.providers, [
      {
        id: 'lmstudio-local',
        status: 'online',
        models: ['qwen3-8b'],
        latencyMs: 8,
      },
      {
        id: 'deepseek',
        status: 'offline',
        models: [],
        error: 'no reply within 2000 ms',
      },
    ]);

    const html = renderToStaticMarkup(
      <HarnessProvidersCardView endpoints={endpoints} issues={parsed.issues} />,
    );

    expect(html).toContain('lmstudio-local');
    expect(html).toContain('http://127.0.0.1:1234/v1');
    expect(html).toContain('keyless · tools · ctx 32k');
    expect(html).toContain('Models: qwen3-8b');
    expect(html).toContain('deepseek');
    expect(html).toContain('env: DEEPSEEK_API_KEY · tools · vision');
    expect(html).toContain('no reply within 2000 ms');
    expect(html).toContain('bad-entry:');
    expect(html).toContain('NAME of an environment variable');
    expect(formatEndpointCapabilities({ tools: false, vision: false })).toBe('text only');
  });
});
