import assert from 'node:assert/strict';

export default {
  name: 'explicit-file-links',
  entry: './fixture.tsx',
  viewport: { width: 560, height: 420 },
  real: 'MarkdownRenderer, path classification, click-time resolution, link context menu, error toast and FileLightbox navigation, and the TextLightbox CodeMirror viewport',
  notCovered: 'Real filesystem, remote transport, PDF decoding and OS opening; mobile native rendering.',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'import { createElement } from "react"; export function PdfPreview({workdir, relPath}) { return createElement("output", {"data-testid":"pdf-preview-path"}, workdir + "/" + relPath); }',
  },
  cases: {
    default: { about: 'Missing authored link remains clickable, explains failure, offers a copy menu and requests a fresh lookup after restoration' },
    'html-shortcut': { about: 'Cmd-click opens a restored relative HTML link in the system browser' },
    'source-line': {
      about: 'A source link opens a long Java file with its referenced line visible and highlighted',
      data: { sourceLine: true },
    },
    'source-line-classic': {
      about: 'Source line highlighting also works with the Classic theme’s opaque hover color',
      data: { sourceLine: true },
      storage: { 'theme.familyId': 'default' },
    },
    remote: { about: 'Missing remote link remains clickable without local filesystem access' },
    untrusted: { about: 'Content without privileged file access stays inert' },
  },
  async check(page, ui) {
    if (ui.data.sourceLine) {
      // UI regression: the existing lightbox unit test stubs the editor, so it
      // cannot verify the viewport or highlight for a Markdown :line link.
      await page.getByRole('link', { name: '方法入口', exact: true }).click();
      const editor = page.locator('[data-text-lightbox-overlay] .cm-editor');
      await editor.waitFor();
      await page.waitForFunction(() => {
        const editor = document.querySelector('[data-text-lightbox-overlay] .cm-editor');
        const target = Array.from(editor?.querySelectorAll('.cm-line') ?? [])
          .find((line) => line.textContent?.includes('void reconcileInventory()'));
        const scroller = editor?.querySelector('.cm-scroller');
        if (!target || !scroller) return false;
        const line = target.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        return line.top >= viewport.top && line.bottom <= viewport.bottom;
      });
      await ui.capture('referenced-source-line');
      const target = editor.locator('.cm-line').filter({ hasText: 'void reconcileInventory()' });
      assert.equal(await target.getAttribute('data-reference-line'), '975');
      const lineNumber = editor.locator('.cm-lineNumbers .cm-reference-line-number');
      assert.equal(await lineNumber.textContent(), '975');
      assert.equal(await lineNumber.evaluate((gutter) => getComputedStyle(gutter).fontWeight), '600');
      const { background, themeBackground, ordinaryBackground } = await target.evaluate((line) => {
        const parent = line.parentElement;
        const ordinary = parent.querySelector('.cm-line:not([data-reference-line])');
        const probe = document.createElement('span');
        probe.hidden = true;
        probe.style.backgroundColor = 'var(--surface-hover)';
        parent.append(probe);
        const themeBackground = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          background: getComputedStyle(line).backgroundColor,
          themeBackground,
          ordinaryBackground: getComputedStyle(ordinary).backgroundColor,
        };
      });
      assert.equal(background, themeBackground);
      assert.notEqual(background, ordinaryBackground);
      return;
    }
    if (ui.case === 'html-shortcut') {
      // DESIGN §14.5: unlike the DOM tests, this browser run sends a real
      // modified pointer click to MarkdownRenderer and observes the host boundary.
      await page.evaluate(() => localStorage.setItem('chat.localLinkOpenPreference', 'sidebar'));
      await page.getByTestId('restore-file').click();
      const demo = page.getByRole('link', { name: 'demo.html', exact: true });
      await demo.click({ modifiers: ['Meta'] });
      await page.waitForFunction(() =>
        document.documentElement.dataset.openedInBrowser === '/fixture/documents/demo.html',
      );
      return;
    }
    const report = page.getByRole('link', { name: '查看报告', exact: true });
    if (ui.case === 'untrusted') {
      assert.equal(await report.count(), 0);
      return;
    }
    assert.equal(await page.locator('a[href="/fixture/missing.txt"]').count(), 0);
    await report.click();
    await page.getByText(await ui.t('chat.markdownRenderer.fileUnavailable'), { exact: true }).waitFor();
    await ui.capture('missing-file');
    assert.equal(await report.count(), 1);
    await report.click({ button: 'right' });
    await page.getByRole('menuitem', { name: await ui.t('chat.markdownRenderer.copyLink'), exact: true }).waitFor();
    await page.keyboard.press('Escape');
    if (ui.case === 'remote') return;
    await page.getByTestId('restore-file').click();
    await page.getByRole('link', { name: '下载 PDF', exact: true }).focus();
    await page.keyboard.press('Enter');
    // The shared attachment contract now opens files in Cindy first. Preserve
    // the real keyboard/link/preview path, then request OS opening explicitly.
    const preview = page.getByRole('dialog', { name: 'report.pdf', exact: true });
    await preview.waitFor();
    assert.equal(await preview.getByTestId('pdf-preview-path').textContent(), '/fixture/report.pdf');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.openedFile), undefined);
    await ui.capture('restored-file-preview');
    await preview.getByRole('button', { name: await ui.t('attachmentPreview.more'), exact: true }).click();
    await page.getByRole('menuitem', { name: await ui.t('attachmentPreview.open'), exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.openedFile === '/fixture/report.pdf');
  },
};
