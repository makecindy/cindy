import assert from 'node:assert/strict';

export default {
  name: 'review-push-diverged',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 320 },
  real: 'ConfirmDialogProvider, ConfirmDialog three-action diverged push confirmation, themes and locale strings',
  notCovered: 'Git push IPC and composer draft insertion; covered by pushOps.git-integration and unit tests',
  cases: {
    default: {
      about: 'Clean conflict-free diverged push offers Sync and push as primary action alongside Force push',
    },
    conflict: {
      about: 'Conflicting diverged push lists conflicting files and offers Resolve with Agent alongside Force push',
    },
  },
  async check(page, ui) {
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    const primaryLabel =
      ui.case === 'default'
        ? await ui.t('rightSidebar.review.push.syncAndPushConfirm')
        : await ui.t('rightSidebar.review.push.askAgentSyncConfirm');
    await dialog.getByRole('button', { name: primaryLabel, exact: true }).waitFor();
    await dialog
      .getByRole('button', { name: await ui.t('rightSidebar.review.push.forceConfirm'), exact: true })
      .waitFor();
    await ui.capture(ui.case);
    await dialog.getByRole('button', { name: primaryLabel, exact: true }).click();
    assert.equal(await page.getByTestId('push-choice').textContent(), 'confirm');
  },
};
