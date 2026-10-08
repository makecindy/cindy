import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileTypeIcon } from '../components/ui/file-type-icon';
import { FileTypeTile } from '../components/ui/file-type-tile';
import { contrastRatio, parseCssColor } from '../../shared/theme-import/color';
import { colorRegistry } from '../themes/color-registry';
import '../themes/colors';

describe('file identity at compact and tile sizes', () => {
  it.each(['notes.txt', 'photo.png', 'sound.mp3', 'movie.mp4', 'bundle.zip', 'data.db'])(
    'keeps the small neutral label readable in both themes: %s',
    (name) => {
      const html = renderToStaticMarkup(<FileTypeTile name={name} />);
      expect(html).toMatch(/<text[^>]+fill="var\(--text-primary\)"/);
      expect(html).toMatch(/<rect[^>]+fill="var\(--surface-chip\)"/);
      for (const theme of ['light', 'dark'] as const) {
        const foreground = parseCssColor(colorRegistry.resolveDefault('text-primary', theme)!);
        const background = parseCssColor(colorRegistry.resolveDefault('surface-chip', theme)!);
        expect(contrastRatio(foreground!, background!), theme).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
  it('keeps compact icons decorative, without an unreadable format label', () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="report.pdf" size={12} />);
    expect(html).toContain('lucide-file-text');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="12"');
    expect(html).not.toContain('<text');
    expect(html).not.toContain('PDF');
  });
  it('renders a legible format label only on large tiles using theme tokens', () => {
    const html = renderToStaticMarkup(<FileTypeTile name="report.PDF" />);
    expect(html).toContain('>PDF</text>');
    expect(html).toContain('font-size="10"');
    expect(html).toContain('var(--file-badge-pdf)');
    expect(html).toContain('var(--surface-elevated)');
  });
  it('does not confuse renames, file paths, or generic MIME hints with the type', () => {
    expect(
      renderToStaticMarkup(<FileTypeIcon name="new/diagram.svg" mimeType="text/plain" />),
    ).toContain('lucide-file-image');
    expect(renderToStaticMarkup(<FileTypeIcon name="C:\\dir.ts\\unknown" />)).toContain(
      'lucide-file',
    );
    expect(renderToStaticMarkup(<FileTypeTile name="unknown" />)).not.toContain('<text');
  });
});
