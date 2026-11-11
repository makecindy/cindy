import assert from 'node:assert/strict';

export default {
  name: 'explicit-file-links',
  entry: './fixture.tsx',
  viewport: { width: 560, height: 420 },
  real: 'MarkdownRenderer, path classification, click-time resolution, link context menu, error toast and FileLightbox navigation',
  notCovered: 'Real filesystem, remote transport, PDF decoding and OS opening; mobile native rendering.',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'import { createElement } from "react"; export function PdfPreview({workdir, relPath}) { return createElement("output", {"data-testid":"pdf-preview-path"}, workdir + "/" + relPath); }',
  },
  cases: {
    default: { about: 'Missing authored link remains clickable, explains failure, offers a copy menu and requests a fresh lookup after restoration' },
    remote: { about: 'Missing remote link remains clickable without local filesystem access' },
    untrusted: { about: 'Content without privileged file access stays inert' },
  },
  async check(page, ui) {
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
