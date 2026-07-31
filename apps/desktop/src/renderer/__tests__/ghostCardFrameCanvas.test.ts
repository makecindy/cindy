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

  /**
   * 上面那条"不强铺背景"只有在明暗档下发时才成立,两者是一对:iframe canvas 只在
   * guest 的 used color-scheme 与 embedder 一致时才透明,而 color-scheme 不跨文档
   * 继承 —— srcDoc 里没有它时 guest 按 light,宿主暗色时两者不一致,canvas 被填成
   * **不透明白**,不铺底色的全出血卡整张变白且切主题不变(白来自 UA、不是任何
   * token,xd-mivo 实撞)。明暗档搭在主题变量块里(ghostPanelTheme
   * .buildGhostThemeVarsBlock,值域与回落在那儿单测),这里只锁住"变量块确实被注进
   * srcDoc 的 <style>"这一环 —— 摘掉它白 canvas 就回来。
   */
  it('keeps the host theme block (which carries color-scheme) inside the srcDoc', () => {
    expect(source).toContain('buildCardSrcDoc(renderedCardHtml, themeVars)');
    expect(source).toMatch(/themeVars \? `<style>\$\{themeVars\}<\/style>` : ''/);
    expect(source).toContain('useGhostCardThemeVars()');
  });

  it('bridges iframe images into the host conversation gallery without widening the sandbox', () => {
    expect(source).toContain('extractGhostCardGallerySrcs(renderedCardHtml)');
    expect(source).toContain('data-gallery-src={src}');
    expect(source).toMatch(/<ImageLightbox[\s\S]*galleryId=\{lightbox\.galleryId\}[\s\S]*enableGallery/);
    expect(source).toContain("img.closest('[data-ghost-action], [data-ghost-link]')");
    expect(source).toContain('sandbox="allow-same-origin"');
  });
});
