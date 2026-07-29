import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/chat/GhostToolCard.tsx', import.meta.url),
  'utf8',
);

describe('ghost card iframe canvas styling', () => {
  it('removes frame chrome without forcing a background onto transparent cards', () => {
    expect(source).toContain("border: 'none'");
    expect(source).toContain("outline: 'none'");
    expect(source).toContain("boxShadow: 'none'");
    expect(source).not.toContain(
      'background:var(--msg-tool-card-bg,var(--surface-elevated,transparent))',
    );
    expect(source).not.toContain(
      "backgroundColor: 'var(--msg-tool-card-bg, var(--surface-elevated))'",
    );
  });

  it('bridges iframe images into the host conversation gallery without widening the sandbox', () => {
    expect(source).toContain('extractGhostCardGallerySrcs(renderedCardHtml)');
    expect(source).toContain('data-gallery-src={src}');
    expect(source).toMatch(/<ImageLightbox[\s\S]*galleryId=\{lightbox\.galleryId\}[\s\S]*enableGallery/);
    expect(source).toContain("img.closest('[data-ghost-action], [data-ghost-link]')");
    expect(source).toContain('sandbox="allow-same-origin"');
  });
});
