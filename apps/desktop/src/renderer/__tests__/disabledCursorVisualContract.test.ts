import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const colorsSource = readFileSync(resolve(__dirname, '..', 'themes', 'colors.ts'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const makerExperimentalSource = readFileSync(
  resolve(__dirname, '..', 'features', 'maker-experimental', 'MakerExperimentalView.tsx'),
  'utf8',
);

describe('Desktop disabled cursor visual contract', () => {
  it('uses the ordinary arrow instead of a theme-provided SVG cursor', () => {
    expect(colorsSource).not.toContain('createNotAllowedCursor');
    expect(colorsSource).not.toContain("registerColor('cursor-not-allowed'");
    expect(globalsSource).toContain('.cursor-not-allowed');
    expect(globalsSource).not.toContain("html[data-platform='win32'] .cursor-not-allowed");
    expect(globalsSource).toContain('cursor: default;');
    expect(globalsSource).not.toContain('var(--cursor-not-allowed');
    expect(makerExperimentalSource).not.toContain('var(--cursor-not-allowed');
    expect(makerExperimentalSource).not.toContain("window.electronAPI.platform === 'win32'");
    expect(makerExperimentalSource).toContain("cursor: m.session ? 'default' : 'pointer'");
  });
});
