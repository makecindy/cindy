import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CATALOG,
  mergeWithBundled,
  modelProtocolComparison,
  parseCatalog,
  type Catalog,
} from '@cindy/model-providers';
import { getActiveCatalog, setActiveCatalog, setXdGatewayModels } from '../active-catalog.js';
import { deriveAvailableModels } from '../catalog-to-descriptors.js';

// Contract fixture extracted from cindy-server#581 providers.json at df0c1bd5b07e.
// Keep this independent of bundled values: remote data must survive a future registry revision.
function serverCatalog(): Catalog {
  const five = ['low', 'medium', 'high', 'xhigh', 'max'];
  const raw = structuredClone(BUNDLED_CATALOG);
  const openai = raw.providers.find((provider) => provider.id === 'openai')!;
  Object.assign(openai.models, {
    pi: [
      {
        id: 'chatgpt/gpt-6-astra',
        name: 'GPT-6 Astra',
        piApi: 'openai-responses',
        contextWindow: 272000,
        contextWindowVerified: true,
        maxOutput: 128000,
        efforts: five,
        defaultEffort: 'medium',
        supportsImageInput: true,
        reasoning: true,
        reasoningEfforts: five,
        reasoningDefaultEffort: 'medium',
      },
    ],
  });
  raw.modelRegistry = {
    schemaVersion: 2,
    updatedAt: '2099-09-05T00:00:00.000Z',
    models: [
      {
        id: 'openai/gpt-6-astra',
        name: 'GPT-6 Astra',
        status: 'active',
        contextWindow: 272000,
        maxOutputTokens: 128000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        perAgent: { codex: { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } },
        routes: [
          { providerId: 'openai', modelId: 'gpt-6-astra', agents: ['claude-code', 'codex'] },
        ],
      },
    ],
  };
  return parseCatalog(JSON.stringify(raw));
}

function accept(incoming: Catalog) {
  setActiveCatalog(mergeWithBundled(incoming), { authorityCatalog: incoming });
}

afterEach(() => {
  setXdGatewayModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('Server catalog updates with independent Cindy native protocols', () => {
  it('preserves each harness effort contract and local native metadata through an older schema', () => {
    accept(serverCatalog());
    const active = getActiveCatalog();
    const openai = active.providers.find((provider) => provider.id === 'openai')!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const model = openai.models[agent]!.find((model) => model.id.endsWith('gpt-6-astra'))!;
      const expected =
        agent === 'codex'
          ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
          : ['low', 'medium', 'high', 'xhigh', 'max'];
      expect(model).toMatchObject({
        contextWindow: 272000,
        maxOutput: 128000,
        defaultEffort: 'medium',
        efforts: expected,
        nativeApi: 'openai-responses',
      });
      expect(
        deriveAvailableModels(active, agent).find((item) => item.id === model.id)?.efforts,
      ).toEqual(expected);
    }
    expect(openai.models.pi!.find((model) => model.id.endsWith('gpt-6-astra'))).toMatchObject({
      supportsImageInput: true,
      reasoning: true,
    });
  });

  it('accepts future parameter updates without letting Gateway execution hints replace native APIs', () => {
    const incoming = serverCatalog();
    incoming.modelRegistry!.models[0].contextWindow = 300000;
    accept(incoming);
    const openai = getActiveCatalog().providers.find((provider) => provider.id === 'openai')!;
    expect(openai.models.codex!.find((model) => model.id === 'gpt-6-astra')?.contextWindowMax).toBe(
      300000,
    );
    // An explicit Pi override is independent of the Codex/root window.
    expect(openai.models.pi!.find((model) => model.id.endsWith('gpt-6-astra'))?.contextWindow).toBe(
      272000,
    );
    const id = 'google/gemini-99-pro-preview';
    setXdGatewayModels([
      {
        id,
        agents: ['claude-code', 'codex', 'pi'],
        contextWindow: 1234567,
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
    ]);
    const gateway = getActiveCatalog().providers.find((provider) => provider.id === 'xd')!;
    const models = {
      'claude-code': gateway.models['claude-code']!.find((model) => model.id === id)!,
      codex: gateway.models.codex!.find((model) => model.id === id)!,
      pi: gateway.models.pi!.find((model) => model.id === id)!,
    };
    expect(models.pi).toMatchObject({
      nativeApi: 'google-generative-ai',
      piApi: 'google-generative-ai',
      contextWindow: 1234567,
    });
    expect(models.codex.defaultEnabled).toBe(false);
    expect(models['claude-code'].defaultEnabled).toBe(false);
    const comparison = modelProtocolComparison(gateway, models);
    expect(comparison.forAgent('pi')?.mode).toBe('matching');
    expect(comparison.forAgent('codex')?.mode).toBe('compatibility');
    // Matching the model at the outbound end does not erase a local bridge conversion.
    expect(
      modelProtocolComparison(gateway, {
        codex: {
          ...models.codex,
          nativeApi: 'anthropic-messages',
          route: { baseUrl: 'https://example.invalid', wireProtocol: 'anthropic-messages' },
        },
      }).forAgent('codex'),
    ).toMatchObject({ localConversion: true, mode: 'compatibility' });
  });
});
