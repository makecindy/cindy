import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

import { setActiveCatalog, setCustomProviders } from '../active-catalog.js';
import { xaiModelSupportsReasoning } from '../anthropic-responses-bridge-host.js';

const xaiProvider = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xai')!;

afterEach(() => {
  setCustomProviders([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('xaiModelSupportsReasoning', () => {
  it('keeps the complete legacy blacklist when reasoning metadata is missing', () => {
    expect(xaiModelSupportsReasoning('grok-4.5')).toBe(true);
    expect(xaiModelSupportsReasoning('grok-code-fast')).toBe(false);
    expect(xaiModelSupportsReasoning('grok-build-preview')).toBe(false);
  });

  it('prefers an explicit catalog reasoning capability', () => {
    setActiveCatalog({
      ...BUNDLED_CATALOG,
      providers: BUNDLED_CATALOG.providers.map((provider) =>
        provider.id === 'xai'
          ? {
              ...xaiProvider,
              models: {
                ...xaiProvider.models,
                'claude-code': (xaiProvider.models['claude-code'] ?? []).map((model) =>
                  model.id === 'xai/grok-code-fast'
                    ? { ...model, capabilities: { ...model.capabilities, reasoning: true } }
                    : model,
                ),
              },
            }
          : provider,
      ),
    });

    expect(xaiModelSupportsReasoning('grok-code-fast')).toBe(true);
  });
});
