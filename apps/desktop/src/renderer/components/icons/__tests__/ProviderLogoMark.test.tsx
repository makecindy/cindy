// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { hasProviderLogo, ProviderLogoMark } from '../ProviderLogoMark';

/** 供应商目录里的每张预设卡都必须有真实 Logo，不能静默退回首字母。 */
describe('ProviderLogoMark', () => {
  it('covers every bundled provider and preset id', () => {
    const entries = [...BUNDLED_CATALOG.providers, ...(BUNDLED_CATALOG.presets ?? [])];

    for (const entry of entries) {
      expect(hasProviderLogo(entry.id), entry.id).toBe(true);
      const mark = render(<ProviderLogoMark providerId={entry.id} size={15} />);
      expect(mark.container.querySelector('svg'), entry.id).not.toBeNull();
      expect(mark.container.querySelector('path'), entry.id).not.toBeNull();
      mark.unmount();
    }
  });

  it('keeps provider logos monochrome and themeable', () => {
    const mark = render(
      <ProviderLogoMark providerId="deepseek" size={18} className="brand-mark" />,
    );
    const svg = mark.container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('18');
    expect(svg?.getAttribute('height')).toBe('18');
    expect(svg?.getAttribute('class')).toBe('brand-mark');
    expect(mark.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('keeps preset-backed provider logos after the user-facing id changes', () => {
    for (const preset of BUNDLED_CATALOG.presets ?? []) {
      // Editable self-hosted endpoints have no stable vendor hostname after a rename.
      if (Object.values(preset.runtimes).some((runtime) => runtime?.baseUrlEditable)) continue;
      const routing: Record<string, { upstream: string }> = {};
      for (const [agent, runtime] of Object.entries(preset.runtimes)) {
        if (runtime) routing[agent] = { upstream: runtime.baseUrl };
      }
      expect(hasProviderLogo('my-renamed-provider', routing), preset.id).toBe(true);
      expect(
        render(
          <ProviderLogoMark providerId="my-renamed-provider" routing={routing} />,
        ).container.querySelector('svg'),
        preset.id,
      ).not.toBeNull();
    }

    expect(
      hasProviderLogo('lookalike', {
        codex: { upstream: 'https://openrouter.ai.evil.example/v1' },
      }),
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

  it('returns no mark for an unknown future provider id', () => {
    expect(hasProviderLogo('future-provider')).toBe(false);
    expect(
      render(<ProviderLogoMark providerId="future-provider" />).container.firstChild,
    ).toBeNull();
  });

  it('ignores an unknown projected logo kind and falls back to provider identity', () => {
    const mark = render(
      <ProviderLogoMark providerId="xai" logoKind={'future-brand' as never} />,
    );
    expect(mark.container.querySelector('svg')).not.toBeNull();
    expect(mark.container.querySelector('path')).not.toBeNull();
  });
});
