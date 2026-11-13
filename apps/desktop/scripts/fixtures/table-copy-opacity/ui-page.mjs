import assert from 'node:assert/strict';
import sharp from 'sharp';

// #10177: a translucent hover fill exposed header text through the floating
// actions. Existing jsdom clipboard tests cannot observe composited pixels.
// UI/e2e: render a right-aligned header through the real MarkdownRenderer, then
// hide only that content and verify each hovered button's interior is unchanged.
export default {
  name: 'table-copy-opacity',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 320 },
  real: 'MarkdownRenderer, CopyAsImageBlock, Button, Tip and production themes',
  notCovered: 'Full application, OS clipboard and annotation workflow; checked separately in isolated Desktop mock.',
  cases: {
    default: { about: 'Header text beneath copy and annotate cannot bleed through on hover' },
  },
  async check(page, ui) {
    const table = page.locator('table');
    for (const [key, name] of [['copy', 'copy'], ['annotateImage', 'annotate']]) {
      const button = page.getByRole('button', { name: await ui.t(`chat.markdownRenderer.${key}`), exact: true });
      await button.hover();
      await page.waitForFunction(() => {
        const toolbar = document.querySelector('[data-chat-copy-exclude]');
        return toolbar && getComputedStyle(toolbar).opacity === '1';
      });
      await ui.capture(`${name}-hover`);
      const rect = await button.boundingBox();
      // Stay inside the face, excluding the rounded outline and focus ring.
      const clip = { x: Math.round(rect.x) + 6, y: Math.round(rect.y) + 6, width: 16, height: 16 };
      const withHeader = await sharp(await page.screenshot({ clip })).raw().toBuffer();
      await table.evaluate(node => { node.style.visibility = 'hidden'; });
      let withoutHeader;
      try {
        withoutHeader = await sharp(await page.screenshot({ clip })).raw().toBuffer();
      } finally {
        await table.evaluate(node => { node.style.visibility = ''; });
      }
      assert.deepEqual(withHeader, withoutHeader, `${name} must fully cover the header beneath its face`);
    }
  },
};
