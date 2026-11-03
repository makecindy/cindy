import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const colorsSource = readFileSync(resolve(__dirname, '..', 'themes', 'colors.ts'), 'utf8');
const buttonSource = readFileSync(resolve(__dirname, '..', 'components', 'ui', 'button.tsx'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const makerExperimentalSource = readFileSync(
  resolve(__dirname, '..', 'features', 'maker-experimental', 'MakerExperimentalView.tsx'),
  'utf8',
);

describe('Desktop disabled cursor visual contract', () => {
  it('uses the ordinary arrow instead of a theme-provided SVG cursor', () => {
    const disabledCursorRule = globalsSource.match(
      /\.cursor-not-allowed,[^{}]*\{[^{}]*\}/,
    )?.[0];

    expect(colorsSource).not.toContain('createNotAllowedCursor');
    expect(colorsSource).not.toContain("registerColor('cursor-not-allowed'");
    expect(disabledCursorRule).toBeDefined();
    expect(disabledCursorRule).toContain('.cursor-not-allowed');
    expect(disabledCursorRule).toContain('.disabled\\:cursor-not-allowed:disabled');
    expect(disabledCursorRule).toContain(
      '.data-\\[disabled\\]\\:cursor-not-allowed[data-disabled]',
    );
    expect(disabledCursorRule).toContain('cursor: default;');
    expect(disabledCursorRule).not.toContain('var(--cursor-not-allowed');
    expect(globalsSource).not.toContain("html[data-platform='win32'] .cursor-not-allowed");
    expect(makerExperimentalSource).not.toContain('var(--cursor-not-allowed');
    expect(makerExperimentalSource).not.toContain("window.electronAPI.platform === 'win32'");
    // The migrated picker inherits the shared disabled cursor instead of
    // duplicating an inline cursor expression in the diagnostic page.
    const directoryPicker = makerExperimentalSource
      .match(/<Button\b[\s\S]*?<\/Button>/g)
      ?.find((button) => button.includes('showOpenDirectory'));
    expect(makerExperimentalSource).toContain("import { Button } from '@/components/ui/button'");
    expect(directoryPicker).toBeDefined();
    expect(directoryPicker).toContain('disabled={!!m.session}');
    expect(directoryPicker).not.toMatch(/cursor\s*:|cursor-/);
    expect(buttonSource).toContain('disabled:cursor-not-allowed');
  });
});
