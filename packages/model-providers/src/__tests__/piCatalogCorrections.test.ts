import { describe, expect, it } from 'vitest';

import {
  applyKnownXaiCorrections,
  preferredDefaultEffort,
} from '../../../../tools/pi/xai-catalog-corrections.mjs';
import { applyAstraCatalogAdditions } from '../../../../tools/pi/openai-catalog-corrections.mjs';
import piCatalog from '../../catalog/pi-model-catalog.json';
import { BUNDLED_CATALOG } from '../catalog.js';
import { modelProtocolComparison } from '../modelProtocol.js';

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

describe('Pi Astra catalog additions', () => {
  it("projects subscription Responses without rewriting the specialized Pi transport", () => {
    const provider = BUNDLED_CATALOG.providers.find(
      (provider) => provider.id === "openai",
    )!;
    const models = provider.models.pi!;
    expect(models).not.toHaveLength(0);
    for (const model of models) {
      expect(model.piApi).toBe("openai-responses");
      expect(
        modelProtocolComparison(provider, {
          pi: { ...model, nativeApi: "openai-responses" },
        }).forAgent("pi"),
      ).toMatchObject({ outbound: "openai-responses", mode: "matching" });
    }
    expect(
      piCatalog.providers["openai-codex"].every(
        (model) => model.api === "openai-codex-responses",
      ),
    ).toBe(true);
  });

  it('regenerates separate API and subscription profiles and yields to upstream metadata', () => {
    const providers = applyAstraCatalogAdditions({});
    expect(providers.openai[0]).toMatchObject({
      api: 'openai-responses', contextWindow: 1_050_000,
      thinkingLevelMap: { off: 'low', max: 'max' },
      cost: { cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272_000, cacheWrite: 25 }] },
    });
    expect(providers['openai-codex'][0]).toMatchObject({ api: 'openai-codex-responses', contextWindow: 272_000 });
    const native = { id: 'gpt-6-astra', contextWindow: 872_000, upstreamField: true };
    expect(applyAstraCatalogAdditions({ openai: [native] }).openai).toEqual([native]);
    expect(applyAstraCatalogAdditions(providers)).toEqual(providers);
    expect(piCatalog.providers.openai).toEqual(providers.openai);
    expect(piCatalog.providers['openai-codex'].find((model) => model.id === 'gpt-6-astra')).toEqual(providers['openai-codex'][0]);
  });
});
