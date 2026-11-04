import assert from 'node:assert/strict';
export default {
  name: 'checkout',
  entry: './checkout-fixture.tsx',
  viewport: { width: 760, height: 680 },
  real: 'WorktreeChipsRow, useCheckout, CheckoutFeedback, branch menu, shared buttons and dialogs',
  notCovered: 'Real Git and remote devices; fixture reads only, all Git writes forbidden',
  cases: {
    default: { about: 'Actual branch while unchecked and an occupied branch in the menu' },
    busy: { about: 'Running session blocks checkout with an explicit worktree alternative' },
    idle: { about: 'Idle sessions are named without blocking branch choices' },
    dirty: { about: 'Scrollable dirty file list with fixed actions and worktree alternative' },
    conflict: { about: 'Carry option disabled for overlapping changes' },
  },
  async ready(page) {
    await page.getByTestId('create-agent-branch-chip').filter({ hasText: 'main' }).waitFor();
  },
  async check(page, ui) {
    assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    await page.getByTestId('create-agent-branch-chip').click();
    await page.getByRole('option', { name: /^feature/ }).waitFor();
    if (['dirty', 'conflict'].includes(ui.case)) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      const carry = page.getByRole('button', {
        name: await ui.t('newChat.checkout.carry', { branch: 'feature' }),
        exact: true,
      });
      assert.equal(await carry.isDisabled(), ui.case === 'conflict');
      assert.equal(
        await page
          .getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true })
          .isVisible(),
        true,
      );
    } else {
      assert.equal(
        await page.getByRole('option', { name: /^feature/ }).getAttribute('aria-disabled'),
        String(ui.case === 'busy'),
      );
      assert.equal(
        await page.getByRole('option', { name: /^release/ }).getAttribute('aria-disabled'),
        'true',
      );
    }
  },
};
