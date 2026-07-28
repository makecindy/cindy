// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { ModelIconMark, ProviderMark } from '@/components/new-chat/ModelSelector';

function firstPath(ui: React.ReactNode): string | null {
  return render(ui).container.querySelector('path')?.getAttribute('d') ?? null;
}

describe('model mark semantics', () => {
  it('keeps the model-vendor marks monochrome and preserves the size/className API', () => {
    const anthropic = render(<AnthropicMark size={18} className="brand-mark" />);
    const anthropicSvg = anthropic.container.querySelector('svg');
    expect(anthropicSvg?.getAttribute('width')).toBe('18');
    expect(anthropicSvg?.getAttribute('height')).toBe('18');
    expect(anthropicSvg?.getAttribute('class')).toBe('brand-mark');
    expect(anthropic.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');

    const openai = render(<OpenAIMark size={16} className="brand-mark" />);
    expect(openai.container.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(openai.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('uses vendor marks for provider/model metadata and keeps Agent glyphs distinct', () => {
    const anthropicPath = firstPath(<AnthropicMark />);
    const openaiPath = firstPath(<OpenAIMark />);

    expect(firstPath(<ProviderMark providerId="anthropic" />)).toBe(anthropicPath);
    expect(firstPath(<ProviderMark providerId="openai" />)).toBe(openaiPath);
    expect(firstPath(<ProviderMark providerId="xai" />)).toBe(
      firstPath(<ProviderLogoMark providerId="xai" />),
    );
    expect(
      firstPath(<ProviderMark providerId="renamed-kimi" name="My Kimi" logoKind="moonshot" />),
    ).toBe(firstPath(<ProviderLogoMark providerId="renamed-kimi" logoKind="moonshot" />));
    const unknownLogo = render(
      <ProviderMark
        providerId="future-provider"
        name="My Provider"
        logoKind={'future-brand' as never}
      />,
    );
    expect(unknownLogo.container.querySelector('svg')).toBeNull();
    expect(unknownLogo.container.textContent).toBe('M');
    expect(firstPath(<ModelIconMark icon="claude" providerId="xd" />)).toBe(anthropicPath);
    expect(firstPath(<ModelIconMark icon="openai" providerId="xd" />)).toBe(openaiPath);

    expect(firstPath(<ClaudeMark />)).not.toBe(anthropicPath);
    expect(firstPath(<CodexMark />)).not.toBe(openaiPath);
  });

  it('optically strengthens the mono Codex glyph and adapts its sidebar stroke weight', () => {
    const small = render(<CodexMark size={12} />);
    const smallGroup = small.container.querySelector('g');
    const smallPaths = small.container.querySelectorAll('path');
    expect(smallGroup?.getAttribute('transform')).toBe(
      'translate(12 12) scale(1.1) translate(-12 -12)',
    );
    expect(smallPaths[0]?.getAttribute('stroke-width')).toBe('2');
    expect(smallPaths[1]?.getAttribute('fill')).toBe('currentColor');
    expect(smallPaths[1]?.getAttribute('stroke')).toBe('currentColor');
    expect(smallPaths[1]?.getAttribute('stroke-width')).toBe('0.5');

    const large = render(<CodexMark size={16} />);
    expect(large.container.querySelector('path')?.getAttribute('stroke-width')).toBe('1.6');

    const brand = render(<CodexMark size={12} variant="brand" />);
    expect(brand.container.querySelector('g')).toBeNull();
    expect(brand.container.querySelector('path')?.hasAttribute('stroke')).toBe(false);
  });
});
