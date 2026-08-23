import { describe, expect, it } from 'vitest';

import {
  applyKnownXaiCorrections,
  preferredDefaultEffort,
} from '../../../../tools/pi/xai-catalog-corrections.mjs';
import piCatalog from '../../catalog/pi-model-catalog.json';
import { BUNDLED_CATALOG } from '../catalog.js';

describe('Pi xAI catalog corrections', () => {
  it('keeps official Grok 4.6 xhigh + default high when pi.dev still ships no thinking map', () => {
    const stale = [
      {
        id: 'grok-4.6',
        provider: 'xai',
        reasoning: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ];
    const [corrected] = applyKnownXaiCorrections(stale);
    expect(corrected).toMatchObject({
      thinkingLevelMap: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
      },
      compat: { supportsReasoningEffort: true },
    });
    expect(
      preferredDefaultEffort('grok-4.6', ['low', 'medium', 'high', 'xhigh'], () => 'medium'),
    ).toBe('high');
  });

  it('pins the bundled snapshot and Pi fallback to the official Grok 4.6 ladder', () => {
    const snapshot = piCatalog.providers.xai.find((model) => model.id === 'grok-4.6');
    expect(snapshot).toMatchObject({
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      compat: { supportsReasoningEffort: true },
    });
    expect(
      BUNDLED_CATALOG.providers
        .find((provider) => provider.id === 'xai')
        ?.models.pi?.find((model) => model.id === 'grok-4.6'),
    ).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
  });

  it('keeps every online xAI Pi protocol aligned with the imported Pi catalog', () => {
    const online = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xai')?.models.pi;
    expect(online).toBeDefined();
    expect(Object.fromEntries(online!.map((model) => [model.id, model.piApi]))).toEqual(
      Object.fromEntries(piCatalog.providers.xai.map((model) => [model.id, model.api])),
    );
  });
});
