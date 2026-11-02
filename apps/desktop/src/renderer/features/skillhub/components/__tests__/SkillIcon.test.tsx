/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillIcon } from '../SkillIcon';

afterEach(cleanup);

describe('SkillIcon', () => {
  it.each(['research', 'code', 'writing', 'creative', 'business'])('keeps %s category fallbacks on the neutral surface', (category) => {
    const { container } = render(<SkillIcon categories={[category]} />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.style.backgroundColor).toBe('');
    expect(avatar.className).toContain('bg-[var(--surface-elevated)]');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('keeps the existing neutral Package for missing or unknown local metadata', () => {
    const { container, rerender } = render(<SkillIcon />);
    const baseline = container.innerHTML;
    rerender(<SkillIcon frontmatter={{ tags: ['unknown'], category: null }} />);
    expect(container.innerHTML).toBe(baseline);
    expect(container.querySelector('.lucide-package')).not.toBeNull();
  });

  it('reads local frontmatter and removes the category treatment when metadata disappears', () => {
    const { container, rerender } = render(<SkillIcon frontmatter={{ tags: ['design'] }} />);
    expect(container.querySelector('.lucide-palette')).not.toBeNull();
    rerender(<SkillIcon frontmatter={{}} />);
    expect(container.querySelector('.lucide-package')).not.toBeNull();
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe('');
  });

  it('preserves configured artwork ahead of matched categories', () => {
    const { container } = render(<SkillIcon url="https://example.com/icon.png" categories={['research']} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/icon.png');
    expect(container.querySelector('svg')).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe('');
  });

  it('uses category artwork for server placeholders and failed images, and accepts a new URL', () => {
    const { container, rerender } = render(<SkillIcon url="https://example.com/assets/default-skill-icon-v2.svg" tags={[{ slug: 'code', name: '编程' }]} />);
    expect(container.querySelector('.lucide-code-xml')).not.toBeNull();
    rerender(<SkillIcon url="https://example.com/broken.png" categories={['research']} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('.lucide-book-open')).not.toBeNull();
    rerender(<SkillIcon url="https://example.com/new.png" categories={['research']} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/new.png');
  });

  it('falls back to Package when an image fails without recognized metadata', () => {
    const { container } = render(<SkillIcon url="https://example.com/broken.png" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('.lucide-package')).not.toBeNull();
  });
});
