/** Provider branding contract shared by desktop and mobile. */
import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '../catalog.js';
import {
  hasProviderLogo,
  isProviderLogoKind,
  PROVIDER_LOGO_PATHS,
  resolveProviderLogoKind,
} from '../providerBranding.js';

describe('provider branding', () => {
  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['xd', 'xd'],
  ] as const)('maps built-in provider %s to its official mark', (providerId, logoKind) => {
    expect(resolveProviderLogoKind(providerId)).toBe(logoKind);
  });

  it('covers every bundled provider and preset id', () => {
    const entries = [...BUNDLED_CATALOG.providers, ...(BUNDLED_CATALOG.presets ?? [])];
    for (const entry of entries) {
      expect(hasProviderLogo(entry.id), entry.id).toBe(true);
    }
  });

  it('uses a dedicated xAI mark', () => {
    expect(resolveProviderLogoKind('xai')).toBe('xai');
    expect(PROVIDER_LOGO_PATHS.xai).not.toBe(PROVIDER_LOGO_PATHS.openrouter);
  });

  it('only infers Vercel branding from the exact AI Gateway host', () => {
    expect(resolveProviderLogoKind('renamed', {
      codex: { upstream: 'https://ai-gateway.vercel.sh/v1' },
    })).toBe('vercel');
    expect(resolveProviderLogoKind('renamed', {
      codex: { upstream: 'https://my-openrouter-proxy.vercel.sh/v1' },
    })).toBeNull();
    expect(resolveProviderLogoKind('renamed', {
      codex: { upstream: 'https://tenant.ai-gateway.vercel.sh/v1' },
    })).toBeNull();
  });

  it('guards runtime logo values before indexing shared paths', () => {
    expect(isProviderLogoKind('vercel')).toBe(true);
    expect(isProviderLogoKind('future-brand')).toBe(false);
    expect(isProviderLogoKind(null)).toBe(false);
  });

  it('keeps preset branding after a user-facing provider id changes', () => {
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      // Self-hosted presets can be moved to any host; after the id is renamed there is
      // intentionally no trustworthy hostname from which to infer the vendor mark.
      if (Object.values(preset.runtimes).some((runtime) => runtime?.baseUrlEditable)) continue;
      const routing: Record<string, { upstream: string }> = {};
      for (const [agent, runtime] of Object.entries(preset.runtimes)) {
        if (runtime) routing[agent] = { upstream: runtime.baseUrl };
      }
      expect(hasProviderLogo('renamed-provider', routing), preset.id).toBe(true);
    }
  });

  it('rejects spoofed hosts, malformed URLs, and mixed-brand routing deterministically', () => {
    expect(
      hasProviderLogo('lookalike', {
        codex: { upstream: 'https://openrouter.ai.evil.example/v1' },
      }),
    ).toBe(false);
    expect(
      hasProviderLogo('malformed', { codex: { upstream: 'not a url' } }),
    ).toBe(false);
    expect(
      hasProviderLogo('mixed-brands', {
        codex: { upstream: 'https://api.openai.com/v1' },
        'claude-code': { upstream: 'https://api.anthropic.com/v1' },
      }),
    ).toBe(false);
    expect(
      hasProviderLogo('mixed-brands-reversed', {
        'claude-code': { upstream: 'https://api.anthropic.com/v1' },
        codex: { upstream: 'https://api.openai.com/v1' },
      }),
    ).toBe(false);
  });
});
