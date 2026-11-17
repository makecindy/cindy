// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaintextEditor } from '@/components/markdown/PlaintextEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

afterEach(cleanup);

/**
 * 色块是装饰，不能成为超长单行的成本：压缩成单行的 CSS/JSON 不该触发整行扫描
 * （review #10955 P2）。
 */
describe('PlaintextEditor hex swatches', () => {
  it('draws a swatch for a normal line with a hex colour', () => {
    const { container } = render(
      createElement(PlaintextEditor, {
        initialValue: 'const accent = "#22863a";',
        language: 'typescript',
      }),
    );
    expect(container.querySelectorAll('.cm-hex-color-swatch')).toHaveLength(1);
  });

  it('skips swatches on a minified single line', () => {
    const minified = `const css = "${'a{color:#22863a}'.repeat(400)}";`;
    const { container } = render(
      createElement(PlaintextEditor, { initialValue: minified, language: 'javascript' }),
    );
    expect(container.querySelectorAll('.cm-hex-color-swatch')).toHaveLength(0);
  });
});
