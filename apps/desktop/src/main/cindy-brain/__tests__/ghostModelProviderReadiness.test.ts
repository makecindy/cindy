import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import { deriveCindyMediaConfig } from '../cindyMediaCatalog';
import {
  ghostRequiresModelProvider,
  isGhostModelProviderReady,
  type GhostModelProviderReadinessProbes,
} from '../ghostModelProviderReadiness';
import { ImageChannelRegistry } from '../imageChannelRegistry';

const ART_MANIFEST: GhostManifest = {
  schemaVersion: 3,
  id: 'art-shaped-plugin',
  name: 'Art-shaped plugin',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  tools: [{ name: 'run', description: 'run' }],
  cindy: {
    image: ['generate', 'edit'],
    video: ['generate', 'edit'],
  },
};

function probes(
  overrides: Partial<GhostModelProviderReadinessProbes> = {},
): GhostModelProviderReadinessProbes {
  return {
    imageGenerate: () => false,
    imageEdit: () => false,
    videoGenerate: () => false,
    videoEdit: () => false,
    textOneshot: () => false,
    embedText: () => false,
    webSearch: () => false,
    ...overrides,
  };
}

function imageCatalogProbe(
  providerId: string,
  state: 'ready' | 'reconnect-required' | 'disabled',
): Pick<GhostModelProviderReadinessProbes, 'imageGenerate' | 'imageEdit'> {
  const registry = new ImageChannelRegistry();
  registry.register(providerId, {
    ready: () => state === 'ready',
    generateImage: async () => {
      throw new Error('not used by readiness test');
    },
    editImage: async () => {
      throw new Error('not used by readiness test');
    },
  });
  const config = deriveCindyMediaConfig(
    [{ id: providerId, imageModels: [{ id: `${providerId}/image`, name: 'Image' }] }],
    'image',
    () => state === 'disabled',
    (id) => registry.isProviderReady(id),
    (id) => registry.isProviderEditReady(id),
  );
  return {
    imageGenerate: () => config.models.length > 0,
    imageEdit: () => config.models.some((model) => model.supportsEdit),
  };
}

describe('ghost model-provider readiness', () => {
  it('recognizes media-backed Cindy permissions and ignores deposit-only access', () => {
    expect(ghostRequiresModelProvider(ART_MANIFEST)).toBe(true);
    expect(ghostRequiresModelProvider({ ...ART_MANIFEST, cindy: { media: ['deposit'] } })).toBe(
      false,
    );
  });

  it.each(['OpenAI', 'xAI'])(
    'allows Art-shaped callers when the xd gateway is unavailable but %s image models are ready',
    (providerId) => {
      expect(
        isGhostModelProviderReady(
          ART_MANIFEST,
          probes(imageCatalogProbe(providerId.toLowerCase(), 'ready')),
        ),
      ).toBe(true);
    },
  );

  it('allows image generation when a configured video route is unavailable', () => {
    expect(
      isGhostModelProviderReady(
        ART_MANIFEST,
        probes({ imageGenerate: () => true, imageEdit: () => true }),
      ),
    ).toBe(true);
  });

  it('does not let generate-only providers satisfy an edit-only plugin', () => {
    const editOnly: GhostManifest = {
      ...ART_MANIFEST,
      cindy: { image: ['edit'] },
    };
    expect(
      isGhostModelProviderReady(editOnly, probes({ imageGenerate: () => true })),
    ).toBe(false);
    expect(isGhostModelProviderReady(editOnly, probes({ imageEdit: () => true }))).toBe(true);
  });

  it('stays missing when every provider is unavailable, disabled, or needs reconnection', () => {
    expect(isGhostModelProviderReady(ART_MANIFEST, probes())).toBe(false);
    expect(
      isGhostModelProviderReady(ART_MANIFEST, probes(imageCatalogProbe('openai', 'disabled'))),
    ).toBe(false);
    expect(
      isGhostModelProviderReady(
        ART_MANIFEST,
        probes(imageCatalogProbe('xai', 'reconnect-required')),
      ),
    ).toBe(false);
  });
});
