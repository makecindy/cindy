import assert from 'node:assert/strict';

export default {
  name: 'explicit-file-links',
  entry: './fixture.tsx',
  viewport: { width: 560, height: 420 },
  real: 'MarkdownRenderer, path classification, click-time resolution, link context menu and error toast',
  notCovered: 'Real filesystem, remote transport and OS opening; mobile native rendering.',
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
    await page.waitForFunction(() => document.documentElement.dataset.openedFile === '/fixture/report.pdf');
  },
};
