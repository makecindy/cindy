import assert from 'node:assert/strict';
import console from 'node:console';
export default {
  name: 'checkout',
  entry: './checkout-fixture.tsx',
  viewport: { width: 760, height: 680 },
  real: 'WorktreeChipsRow, useCheckout, checkout dialog/menu, shared toast, buttons and themes',
  notCovered:
    'Real Git and remote devices; switch responses are simulated in memory, no Git executes',
  cases: {
    default: { about: 'Actual branch while unchecked and an occupied branch in the menu' },
    busy: { about: 'Running session blocks checkout with an explicit worktree alternative' },
    idle: { about: 'Idle sessions are named without blocking branch choices' },
    dirty: { about: 'Scrollable dirty file list with fixed actions and worktree alternative' },
    conflict: { about: 'Carry option disabled for overlapping changes' },
    ignored: { about: 'Clean checkout names ignored files that prevent switching' },
    success: { about: 'Successful checkout toast with undo leaves the controls aligned' },
    worktree: { about: 'Explicit worktree info toast leaves the controls aligned' },
    saved: { about: 'Saved changes toast and persistent menu entry leave the controls aligned' },
  },
  async ready(page) {
    await page.getByTestId('create-agent-branch-chip').filter({ hasText: 'main' }).waitFor();
  },
  async check(page, ui) {
    assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    const geometry = async () => {
      const result = {};
      for (const id of [
        'checkout-controls-row',
        'checkout-project',
        'create-agent-branch-chip',
        'checkout-input',
      ]) {
        const box = await page.getByTestId(id).boundingBox();
        assert.ok(box, id);
        result[id] = { x: box.x, y: box.y, height: box.height };
      }
      return result;
    };
    const before = await geometry();
    await ui.capture('before-feedback');
    await page.getByTestId('create-agent-branch-chip').click();
    await page.getByRole('option', { name: /^feature/ }).waitFor();
    if (ui.case === 'ignored') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      const feedback = page.getByRole('alert');
      await feedback.waitFor();
      assert.match(await feedback.innerText(), /private\/collision/);
      assert.match(await feedback.innerText(), /feature/);
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    } else if (['success', 'saved'].includes(ui.case)) {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.undo'), exact: true })
        .waitFor();
      if (ui.case === 'saved') {
        await page
          .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
          .waitFor();
        await ui.capture('saved-toast');
        await page.getByTestId('create-agent-branch-chip').click();
        await page.getByRole('listbox').waitFor();
        assert.equal(
          await page
            .getByRole('button', { name: await ui.t('newChat.checkout.restore'), exact: true })
            .count(),
          2,
        );
        await ui.capture('saved-menu');
        await page.keyboard.press('Escape');
      }
    } else if (ui.case === 'worktree') {
      await page
        .getByRole('button', { name: await ui.t('newChat.checkout.useWorktree'), exact: true })
        .click();
      await page
        .getByText(await ui.t('newChat.checkout.worktreeDefault'), { exact: true })
        .waitFor();
      assert.equal(await page.getByRole('listbox').isVisible(), true);
      await page.keyboard.press('Escape');
    } else if (['dirty', 'conflict'].includes(ui.case)) {
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
    const after = await geometry();
    assert.deepEqual(after, before, 'Feedback must not move or resize the controls row or input');
    console.log('CHECKOUT_ROW_GEOMETRY', JSON.stringify({ case: ui.case, before, after }));
  },
};
