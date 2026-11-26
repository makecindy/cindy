import assert from 'node:assert/strict';

const MARGIN = 40;

export default {
  name: 'attachment-preview-frame',
  entry: './preview.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'TextLightbox, FileLightbox, FileBodyView, UnrenderablePlaceholder, OpenInSystemActions, ImageLightbox, PreviewWindow (shared non-modal shell), PreviewChrome header/footer, ToastContainer and MarkdownRenderer',
  notCovered:
    'Native traffic lights and Electron drag regions (geometry only), real file reads, Windows window controls, video/model/Mermaid viewers and Mobile; file stat, document text and image bytes are fixture data',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'export function PdfPreview() { throw new Error("PDF is outside this fixture"); }',
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview':
      'export function DrawioPreview() { throw new Error("draw.io is outside this fixture"); }',
  },
  cases: {
    default: { about: 'A spreadsheet that cannot be previewed opens in a compact centered non-modal window' },
    markdown: { about: 'A Markdown document in a movable window beside the conversation' },
    image: { about: 'An image still uses the existing modal preview shell' },
  },
  async ready(page) {
    await page.waitForFunction(
      () => {
        const floating = document.querySelector('[data-preview-window-panel]');
        const scrim = document.querySelector('[data-preview-scrim]');
        const panel = floating ?? (scrim && document.querySelector('.modal-panel'));
        if (!panel) return false;
        return (
          [...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth === 1600) ||
          document.body.innerText.includes('核对步骤') ||
          Math.round(panel.getBoundingClientRect().width) === 480 ||
          document.querySelector('[role=dialog]')?.innerText.includes('59.7 KB')
        );
      },
    );
    // 入场淡入结束后再截图。
    await page.waitForTimeout(300);
  },
  async check(page, ui) {
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const closeLabel = await ui.t('chat.lightbox.close');
    const header = page.locator('header').filter({ has: page.getByRole('button', { name: closeLabel }) });
    const readPanel = () =>
      header.evaluate((el) => {
        let node = el.parentElement;
        while (
          node &&
          getComputedStyle(node).position !== 'fixed' &&
          getComputedStyle(node).position !== 'absolute'
        )
          node = node.parentElement;
        const r = node.getBoundingClientRect();
        return {
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          radius: getComputedStyle(node).borderTopLeftRadius,
        };
      });
    const panel = await readPanel();
    assert.equal(panel.radius, '12px');

    if (ui.case === 'image') {
      // 图片查看器仍沿用原模态外壳；它的非模态改造在另一张 PR。
      assert.equal(await page.locator('[data-preview-scrim]').count(), 1);
      assert.equal(panel.top, MARGIN);
      assert.equal(panel.left, MARGIN);
      assert.equal(viewport.width - panel.right, MARGIN);
      assert.equal(viewport.height - panel.bottom, MARGIN);
      return;
    }

    // 其它查看器：没有整屏遮罩、没有 aria-modal、背景层不吃点击。
    assert.equal(await page.locator('[data-preview-scrim]').count(), 0);
    assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
    const layerPointerEvents = await page
      .locator('[data-preview-window-layer]')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    assert.equal(layerPointerEvents, 'none');
    const background = await page.evaluate(() => {
      const hit = document.elementFromPoint(80, 300);
      const scroller = document.querySelector('[data-scroll-container]');
      return {
        insideConversation: Boolean(hit?.closest('main')),
        insidePreviewLayer: Boolean(hit?.closest('[data-preview-window-layer]')),
        text: document.querySelector('main')?.textContent ?? '',
        scrollLocked: scroller?.style.overflowY === 'hidden',
      };
    });
    assert.equal(background.insideConversation, true);
    assert.equal(background.insidePreviewLayer, false);
    assert.equal(background.scrollLocked, false);
    assert(background.text.includes('信用卡发票整理'));

    if (ui.case === 'default') {
      // 打不开的文件用同外观的居中小窗,仍可拖动。
      assert.equal(panel.right - panel.left, 480);
      assert.equal(panel.bottom - panel.top, 360);
      assert(Math.abs(panel.left - (viewport.width - panel.right)) <= 1);
      assert(Math.abs(panel.top - (viewport.height - panel.bottom)) <= 1);
      // The compact panel shows the original name, the size and one primary
      // action; the cached copy's internal name never leaks into the UI.
      const dialog = page.locator('[data-preview-window-panel]');
      assert.equal(await dialog.getByText(/cache-473d6dd49fb70e80510e/).count(), 0);
      assert.equal(
        await dialog.getByRole('button', { name: await ui.t('ccAgent.workdirBrowse.unrenderable.openInSystem') }).count(),
        1,
      );
      await page.getByRole('button', { name: await ui.t('attachmentPreview.more') }).click();
      assert.equal(
        await page.getByRole('menuitem', { name: await ui.t('ccAgent.workdirBrowse.systemPreview') }).count(),
        1,
      );
      await page.getByRole('menuitem', { name: await ui.t('chat.lightbox.openInExplorer') }).click();
      const revealError = await ui.t('ccAgent.common.openFolderFailed');
      await page.getByText(revealError, { exact: true }).waitFor({ state: 'visible', timeout: 3000 });
    } else {
      // 默认贴右,左侧对话仍露出;标题栏把手可以移动浮窗。
      assert(panel.left > viewport.width / 2);
      assert(panel.right <= viewport.width);
      const grip = await page.locator('[data-preview-window-drag-handle]').boundingBox();
      assert(grip, 'drag handle is visible');
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 - 80, grip.y + grip.height / 2 + 24, { steps: 6 });
      await page.mouse.up();
      const moved = await readPanel();
      assert(moved.left < panel.left - 20, 'header drag moves the preview window');
    }

    // 关闭只走标题栏按钮；非模态预览没有遮罩,点背景对话不再关闭预览。
    await page.getByRole('button', { name: closeLabel }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-preview-window-panel]') &&
        !document.querySelector('[data-preview-scrim]'),
    );
  },
};
