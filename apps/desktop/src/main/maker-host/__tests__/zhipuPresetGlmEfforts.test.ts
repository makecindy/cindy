import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type CustomProviderConfig } from '@cindy/model-providers';
import { getActiveCatalog, setActiveCatalog, setCustomProviderConfigs, setCustomProviders } from '../active-catalog.js';

afterEach(() => {
  setCustomProviders([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('Zhipu preset GLM-5.3 thinking levels', () => {
  // GLM-5.3 thinks on every request; an empty list left preset connections without a
  // picker or default while GLM-5.3-Flash had both (#5402).
  it.each(['zhipu-glm-cn', 'zhipu-glm-global'])('%s inherits the public GLM-5.3 efforts like Flash', (presetId) => {
    setActiveCatalog(BUNDLED_CATALOG);
    const preset = BUNDLED_CATALOG.presets!.find((p) => p.id === presetId)!;
    const config: CustomProviderConfig = {
      id: `custom:${presetId}`,
      name: presetId,
      runtimes: Object.fromEntries((['claude-code', 'codex'] as const).map((agent) => {
        const runtime = preset.runtimes[agent]!;
        return [agent, {
          baseUrl: runtime.baseUrl,
          ...(runtime.wireProtocol ? { wireProtocol: runtime.wireProtocol } : {}),
          catalogPresetId: presetId,
          models: runtime.models.filter((model) => model.id.startsWith('glm-5.3')),
        }];
      })),
    };
    setCustomProviderConfigs([config]);
    const provider = getActiveCatalog().providers.find((p) => p.id === config.id)!;
    for (const agent of ['claude-code', 'codex'] as const) {
      for (const id of ['glm-5.3', 'glm-5.3-flash']) {
        expect(provider.models[agent]?.find((model) => model.id === id), `${agent}/${id}`).toMatchObject({
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'high',
        });
      }
    }
  });
});
