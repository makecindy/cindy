import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const pluginMotionCss = readFileSync(resolve(__dirname, '..', 'plugin-motion.css'), 'utf8');

describe('plugin motion design contracts', () => {
  it('separates collapsed plugin previews without an ad-hoc in-page shadow', () => {
    const previewCardRule = pluginMotionCss.match(
      /\.plugin-installed-preview-card\s*\{(?<body>[\s\S]*?)\}/,
    )?.groups?.body;

    expect(previewCardRule).toBeTruthy();
    expect(previewCardRule).toContain('background: var(--surface-elevated);');
    expect(previewCardRule).toContain('outline: 2px solid var(--surface-elevated);');
    expect(previewCardRule).not.toContain('box-shadow');
    expect(previewCardRule).not.toContain('color-mix');
  });

  it('wraps recommended filters against the actual catalog content width', () => {
    const contentQueryStart = pluginMotionCss.indexOf(
      '@container plugin-management-content (max-width: 720px)',
    );
    const layoutQueryStart = pluginMotionCss.indexOf(
      '@container plugin-management (max-width: 720px)',
    );
    const contentQuery = pluginMotionCss.slice(contentQueryStart, layoutQueryStart);

    expect(contentQueryStart).toBeGreaterThanOrEqual(0);
    expect(layoutQueryStart).toBeGreaterThan(contentQueryStart);
    expect(contentQuery).toContain('.plugin-catalog-toolbar');
    expect(contentQuery).toContain('flex-direction: column;');
    expect(contentQuery).toContain('.plugin-catalog-filters');
    expect(contentQuery).toContain('flex-wrap: wrap;');
  });
});
