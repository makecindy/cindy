import assert from 'node:assert/strict';

export default {
  name: 'plugin-install-progress', entry: './fixture.tsx', viewport: { width: 1000, height: 900 },
  real: 'Production installed and market plugin cards, the update-all dialog, the market detail page, the window-level install progress store and the DownloadRing.',
  notCovered: 'Main-side download reporting, IPC delivery and the install transaction; each state is seeded through the same store calls and push subscription the page uses.',
  cases: {
    default: { about: 'Every step on installed cards (update) and market cards (first install), including failure with retry and the done state.' },
    // The main window is at least 800px wide and the list splits into two columns from 704px, so
    // about 340px is the narrowest a plugin card gets.
    narrow: { about: 'Two columns at the narrowest card width (about 340px) keep the ring, words and buttons inside each card.', viewport: { width: 740, height: 1100 } },
    'update-all': { about: 'Update-all rows: done, running with a ring, failed with its reason, queued; the batch count.' },
    'market-detail': { about: 'Market detail header replaces the install button with the ring and explains a slow retry.' },
    'market-detail-failed': { about: 'A failed first install keeps the ring with its reason and offers Retry.' },
  },
  async check(page, ui) {
    const rings = page.getByRole('progressbar');
    if (ui.case === 'default' || ui.case === 'narrow') {
      const card = page.getByRole('button', { name: 'Waiting for confirmation', exact: true });
      const notice = card.getByText(await ui.t('settings.ghosts.installConsent.updateNeedsConsent'), { exact: true });
      const update = card.locator('button').filter({ hasText: await ui.t('settings.ghosts.installConsent.confirmUpdate') });
      assert.equal(await notice.count(), 0);
      const button = await update.boundingBox();
      assert.ok(button, 'The update button must be visible before confirmation');
      await update.click();
      const progress = card.getByRole('progressbar');
      await progress.waitFor();
      assert.equal(await notice.count(), 0);
      assert.equal(await rings.count(), 10);
      // No figures beside the ring: the percentage lives only in the accessible value.
      assert.equal(await page.getByText(/\d+%/).count(), 0);
      // The failed installed card and the failed market card keep the short word (the reason is on
      // hover) and offer a square retry icon button, so they are no wider than the button replaced.
      await page.getByText(await ui.t('settings.ghosts.updateAll.statusFailed'), { exact: true }).waitFor();
      await page.getByText(await ui.t('settings.ghosts.installProgress.installFailed'), { exact: true }).waitFor();
      assert.equal(await page.locator('button:has(svg.lucide-rotate-ccw)').count(), 2);
      if (ui.case === 'narrow') {
        const ring = await progress.boundingBox();
        assert.ok(ring && Math.abs(ring.width - button.width) <= 1, 'The progress indicator must keep the update button width');
        if (ui.locale === 'zh-CN') {
          const caption = progress.locator(':scope > span').last();
          assert.ok(await caption.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'The full Chinese confirmation state must fit');
        }
      }
    } else if (ui.case === 'update-all') {
      assert.equal(await rings.count(), 2);
      await page.getByText('Download timed out', { exact: true }).waitFor();
    } else if (ui.case === 'market-detail') {
      await page.getByText(await ui.t('downloadProgress.retry.slow'), { exact: true }).waitFor();
      assert.equal(await page.locator('.plugin-detail-primary-action').count(), 0);
    } else {
      // The detail page has room for the reason itself.
      await page.getByText('Download timed out', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('commonUi.retry') }).count(), 1);
    }
  },
};
