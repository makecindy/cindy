import assert from 'node:assert/strict';

const MARGIN = 40;

export default {
  name: 'attachment-preview-frame',
  entry: './preview.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'TextLightbox, FileLightbox, FileBodyView, UnrenderablePlaceholder, OpenInSystemActions, ImageLightbox, PreviewChrome and imagePreviewWindow (non-modal image window geometry)',
  notCovered:
    'Native traffic lights and Electron drag regions (geometry only), real file reads, Windows window controls, video/model/Mermaid viewers and Mobile; dock labels are inline English defaults pending LQA; file stat, document text and image bytes are fixture data',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'export function PdfPreview() { throw new Error("PDF is outside this fixture"); }',
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview':
      'export function DrawioPreview() { throw new Error("draw.io is outside this fixture"); }',
  },
  cases: {
    default: { about: 'A spreadsheet that cannot be previewed opens in a compact centered panel over the dimmed conversation' },
    markdown: { about: 'A Markdown document in the same floating panel' },
    image: { about: 'An image opens as a right-docked non-modal floating window with the conversation still visible' },
    'image-narrow': {
      about: 'A 320px-wide viewport degrades the image window without horizontal overflow',
      viewport: { width: 320, height: 600 },
    },
  },
  async ready(page) {
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-preview-scrim]') || document.querySelector('[data-lightbox-layer]')) &&
        ([...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth === 1600) ||
          document.body.innerText.includes('核对步骤') ||
          document.querySelector('[role=dialog]')?.innerText.includes('59.7 KB')),
    );
    // 入场淡入结束后再截图。
    await page.waitForTimeout(300);
  },
  async check(page, ui) {
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const scrim = page.locator('[data-preview-scrim]');
    const isImage = ui.case === 'image' || ui.case === 'image-narrow';

    if (isImage) {
      assert.equal(await scrim.count(), 0, 'image preview must not dim or block the conversation');
      const panel = page.locator('[data-lightbox-layer]');
      assert.equal(await panel.count(), 1);
      const rect = () => panel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          radius: getComputedStyle(el).borderTopLeftRadius,
        };
      });
      const initial = await rect();
      assert.equal(initial.radius, '12px');
      assert(initial.left >= 0 && initial.right <= viewport.width, 'image window stays inside the viewport horizontally');
      assert(initial.top >= MARGIN - 1 && initial.bottom <= viewport.height, 'image window keeps the title-bar safe area');
      if (viewport.width >= 800) {
        assert(initial.left >= viewport.width * 0.45, 'right dock leaves the left conversation readable');
      }

      // Background text remains selectable while the non-modal preview is open.
      const selected = await page.evaluate(() => {
        const node = document.querySelector('[data-conversation-copy]');
        if (!node) return '';
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString() ?? '';
      });
      assert(selected.includes('已整理完成'), 'conversation text can still be selected and copied');

      // The image viewer must not lock the conversation scroller.
      const scroll = await page.evaluate(() => {
        const el = document.querySelector('[data-scroll-container]');
        if (!el) return { overflowY: 'missing', changed: false, scrollable: false };
        const overflowY = getComputedStyle(el).overflowY;
        const before = el.scrollTop;
        el.scrollTop = before + 80;
        const after = el.scrollTop;
        el.scrollTop = before;
        return { overflowY, changed: after > before, scrollable: el.scrollHeight > el.clientHeight };
      });
      assert.notEqual(scroll.overflowY, 'hidden');
      if (scroll.scrollable) assert(scroll.changed, 'conversation scroller still responds behind the preview');

      const header = page.locator('[data-preview-drag-handle]');
      const headerBox = await header.boundingBox();
      assert(headerBox, 'image preview has a drag handle');
      // 窄窗口里标题栏左侧只剩拖动把手，必须从它起手，避免落到停靠按钮上。
      const startX = headerBox.x + 12;
      const startY = headerBox.y + headerBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(
        Math.max(2, startX - 120),
        Math.min(viewport.height - 8, startY + 80),
        { steps: 6 },
      );
      await page.mouse.up();
      assert.equal(await panel.count(), 1, 'dragging the header does not close the preview');
      const dragged = await rect();
      assert(
        Math.abs(dragged.left - initial.left) > 8 || Math.abs(dragged.top - initial.top) > 8,
        'dragging the header moves the whole preview window',
      );
      assert(dragged.left >= 0 && dragged.right <= viewport.width, 'dragged window stays inside the viewport');
      assert(dragged.top >= MARGIN - 1 && dragged.bottom <= viewport.height, 'dragged window stays below the title bar');

      await page.getByRole('button', { name: 'Dock preview left' }).click();
      const docked = await rect();
      assert(docked.left <= 20, 'dock-left shortcut moves the window to the left edge');
      assert.equal(
        await page.getByRole('button', { name: await ui.t('chat.lightbox.close') }).count(),
        1,
        'close button remains available',
      );

      const resize = page.locator('[data-preview-resize-handle="se"]');
      const resizeBox = await resize.boundingBox();
      assert(resizeBox, 'image preview has a resize handle');
      const beforeResize = await rect();
      await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(Math.max(8, resizeBox.x - 70), Math.max(MARGIN, resizeBox.y - 50), { steps: 6 });
      await page.mouse.up();
      const afterResize = await rect();
      assert(
        afterResize.width < beforeResize.width || afterResize.height < beforeResize.height,
        'resize handle changes the preview window size',
      );
      assert(afterResize.right <= viewport.width && afterResize.bottom <= viewport.height);
      return;
    }

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
      // 其它查看器仍用四边 40px、顶部让出标题栏的模态预览窗。
      assert.equal(panel.top, MARGIN);
      assert.equal(panel.left, MARGIN);
      assert.equal(viewport.width - panel.right, MARGIN);
      assert.equal(viewport.height - panel.bottom, MARGIN);
    }
    if (ui.case !== 'default') return;
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByText(/cache-473d6dd49fb70e80510e/).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: await ui.t('ccAgent.workdirBrowse.unrenderable.openInSystem') }).count(), 1);
    await page.getByRole('button', { name: await ui.t('attachmentPreview.more') }).click();
    assert.equal(await page.getByRole('menuitem', { name: await ui.t('ccAgent.workdirBrowse.systemPreview') }).count(), 1);
    await page.getByRole('menuitem', { name: await ui.t('chat.lightbox.openInExplorer') }).click();
    // The menu replaced the button that reported a failed reveal.
    const revealError = await ui.t('ccAgent.common.openFolderFailed');
    await page.getByText(revealError, { exact: true }).waitFor({ state: 'visible', timeout: 3000 });
    // 点遮罩关闭预览。
    await page.mouse.click(viewport.width / 2, viewport.height - 12);
    await page.waitForFunction(() => !document.querySelector('[data-preview-scrim]'));
  },
};
