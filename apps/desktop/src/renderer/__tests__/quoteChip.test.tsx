// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteChip } from '@/components/chat/QuoteChip';

afterEach(() => {
  cleanup();
});

describe('QuoteChip', () => {
  it('collapses multiline quote text into a single-line summary', () => {
    const { container } = render(<QuoteChip quote={{ text: 'first line\n\nsecond line' }} />);

    const chip = container.querySelector<HTMLElement>('[aria-label]');
    expect(chip?.getAttribute('aria-label')).toBe('first line\n\nsecond line');
    expect(chip?.textContent).toBe('first line second line');
    // 引用 chip 是消息内 chip 里唯一保留 select-none 的:它展示的是折叠成单行的
    // 摘要而非原文,不该跟着复制出去(其余 chip 默认可选中,见 inlineReferenceChip
    // 的剪贴板契约测试)。
    expect(chip?.className).toContain('select-none');
  });

  it('uses the compact primary-text shell without a close button', () => {
    const { container } = render(<QuoteChip quote={{ text: 'quoted' }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      container.querySelector('[data-inline-reference-chip]')?.className,
    ).toContain('text-[var(--text-primary)]');
  });
});
