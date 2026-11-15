import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { deriveAvailableModels } from '../catalog-to-descriptors.js';

const build = vi.hoisted(() => ({ region: 'global' as 'global' | 'cn' | 'dev' }));
vi.mock('../../../shared/brandRegion.js', () => ({
  get CURRENT_CINDY_REGION() { return build.region; },
}));

import {
  getActiveCatalog,
  resolveXdPiGatewayApi,
  resolveXdPiGatewayServerApi,
  setActiveCatalog,
  setXdGatewayModels,
} from '../active-catalog.js';

const modelId = 'google/gemini-4-argon';

function gatewayModel(wireProtocol?: 'openai-responses' | 'google-generative-ai') {
  return {
    id: modelId,
    name: 'Gemini',
    contextWindow: 1_048_576,
    agents: ['claude-code', 'codex', 'pi'] as Array<'claude-code' | 'codex' | 'pi'>,
    ...(wireProtocol ? { perAgent: { pi: { wireProtocol } } } : {}),
  };
}

afterEach(() => {
  build.region = 'global';
  setXdGatewayModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

// Separate environment: mutable build-region mock checks Global/CN/dev without reloading modules.
describe('Gemini Gateway execution protocol (#9288)', () => {
  it.each(['google/gemini-4-argon', 'google/gemini-3.7-flash', 'gemini-3.8-flash'])(
    'uses the declared Responses route for %s without changing native model identity',
    (id) => {
      setActiveCatalog(BUNDLED_CATALOG);
      setXdGatewayModels([{ ...gatewayModel('openai-responses'), id }]);
      expect(resolveXdPiGatewayApi(id)).toBe('openai-responses');
      expect(resolveXdPiGatewayServerApi(id)).toBe('openai-responses');
      const provider = getActiveCatalog().providers.find((p) => p.id === 'xd')!;
      expect(provider.models.pi?.[0]).toMatchObject({
        nativeApi: 'google-generative-ai',
        piApi: 'openai-responses',
      });
      expect(provider.models['claude-code']?.[0].nativeApi).toBe('google-generative-ai');
      expect(provider.models.codex?.[0].nativeApi).toBe('google-generative-ai');
    },
  );

  // Unit regression: the public catalog resolvers must honor the advertised Responses route.
  // The previous CN/dev expectations preserved the /v1beta 404 bug; the smallest failing input
  // is a CN/dev Gemini Gateway member with perAgent.pi.wireProtocol = openai-responses.
  it.each(['cn', 'dev'] as const)('uses the declared Responses route on %s', (region) => {
    build.region = region;
    const id = 'google/gemini-3.8-flash';
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ ...gatewayModel('openai-responses'), id }]);
    expect(resolveXdPiGatewayApi(id)).toBe('openai-responses');
    expect(resolveXdPiGatewayServerApi(id)).toBe('openai-responses');
    expect(getActiveCatalog().providers.find((p) => p.id === 'xd')?.models.pi?.[0])
      .toMatchObject({ id, piApi: 'openai-responses', nativeApi: 'google-generative-ai' });
  });

  it.each([undefined, 'google-generative-ai'] as const)(
    'does not guess Responses when the Gateway declaration is %s',
    (api) => {
      setActiveCatalog(BUNDLED_CATALOG);
      setXdGatewayModels([gatewayModel(api)]);
      expect(resolveXdPiGatewayApi(modelId)).toBe('google-generative-ai');
    },
  );

  it('keeps retired models unavailable even when the Gateway advertises Responses', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.modelRegistry!.models.push({
      id: 'retired-gemini-route', name: 'Retired Gemini', status: 'retired',
      routes: [{ providerId: 'xd', modelId, agents: ['codex'] }],
    });
    setActiveCatalog(catalog, { authorityCatalog: catalog });
    setXdGatewayModels([gatewayModel('openai-responses')]);
    expect(resolveXdPiGatewayApi(modelId)).toBeNull();
    expect(getActiveCatalog().providers.find((p) => p.id === 'xd')?.models.pi).toEqual([]);
  });

  it('does not create a Pi route from another engine membership', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ ...gatewayModel('openai-responses'), agents: ['codex'] }]);
    expect(resolveXdPiGatewayApi(modelId)).toBeUndefined();
  });

  it('preserves explicit model settings and other providers when the Gateway route changes', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const before = getActiveCatalog().providers.filter((p) => p.id !== 'xd');
    setXdGatewayModels([{
      ...gatewayModel('openai-responses'),
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      modalities: { input: ['text', 'image'], output: ['text'] },
      perAgent: { pi: { wireProtocol: 'openai-responses', defaultEnabled: true } },
    }]);
    const after = getActiveCatalog();
    expect(after.providers.filter((p) => p.id !== 'xd')).toEqual(before);
    expect(after.providers.find((p) => p.id === 'xd')?.models.pi?.[0]).toMatchObject({
      id: modelId, piApi: 'openai-responses', nativeApi: 'google-generative-ai',
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      modalities: { input: ['text', 'image'], output: ['text'] },
      defaultEnabled: true, contextWindow: 1_048_576,
    });
    expect(deriveAvailableModels(after, 'pi').find((m) => m.id === modelId))
      .toMatchObject({ supportsImageInput: true });
  });
});
