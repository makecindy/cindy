import assert from 'node:assert/strict';

const MARGIN = 40;

export default {
  name: 'attachment-preview-frame',
  entry: './preview.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'TextLightbox, FileLightbox, FileBodyView, UnrenderablePlaceholder, OpenInSystemActions, ImageLightbox, PreviewChrome (floating panel, scrim, header) and MarkdownRenderer',
  notCovered:
    'Native traffic lights and Electron drag regions (geometry only), real file reads, Windows window controls, video/model/Mermaid viewers and Mobile; file stat, document text and image bytes are fixture data',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'export function PdfPreview() { throw new Error("PDF is outside this fixture"); }',
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview':
      'export function DrawioPreview() { throw new Error("draw.io is outside this fixture"); }',
  },
  cases: {
    default: { about: 'A zip that cannot be previewed opens in a compact centered panel over the dimmed conversation' },
    markdown: { about: 'A Markdown document in the same floating panel' },
    image: { about: 'An image in the same floating panel' },
  },
  async ready(page) {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-preview-scrim]') &&
        ([...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth === 1600) ||
          document.body.innerText.includes('核对步骤') ||
          document.body.innerText.includes('269.4 KB ·')),
    );
    // 入场淡入结束后再截图。
    await page.waitForTimeout(300);
  },
  async check(page, ui) {
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const scrim = page.locator('[data-preview-scrim]');
    assert.equal(await scrim.count(), 1);
    const header = page.locator('header').filter({ has: page.getByRole('button', { name: await ui.t('chat.lightbox.close') }) });
    const panel = await header.evaluate((el) => {
      let node = el.parentElement;
      while (node && getComputedStyle(node).position !== 'fixed') node = node.parentElement;
      const r = node.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, radius: getComputedStyle(node).borderTopLeftRadius };
    });
    assert.equal(panel.radius, '12px');
    if (ui.case === 'default') {
      // 打不开的文件用居中小窗。
      assert.equal(panel.right - panel.left, 480);
      assert.equal(panel.bottom - panel.top, 360);
      assert(Math.abs(panel.left - (viewport.width - panel.right)) <= 1);
      assert(Math.abs(panel.top - (viewport.height - panel.bottom)) <= 1);
    } else {
      // 预览窗四周露出原界面,顶部让出标题栏(红绿灯 / 拖动窗口)。
      assert.equal(panel.top, MARGIN);
      assert.equal(panel.left, MARGIN);
      assert.equal(viewport.width - panel.right, MARGIN);
      assert.equal(viewport.height - panel.bottom, MARGIN);
    }
    if (ui.case !== 'default') return;
    await page.getByRole('button', { name: await ui.t('ccAgent.workdirBrowse.unrenderable.revealFolder') }).click();
    // 点遮罩关闭预览。
    await page.mouse.click(viewport.width / 2, viewport.height - 12);
    await page.waitForFunction(() => !document.querySelector('[data-preview-scrim]'));
  },
};
