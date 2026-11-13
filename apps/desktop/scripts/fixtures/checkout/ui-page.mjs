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
    'default-source': { about: 'Worktree without a saved source defaults to origin/main' },
    'sync-off': { about: 'Unchecked worktree still exposes remote branch refresh' },
    default: { about: 'Actual branch while unchecked and an occupied branch in the menu' },
    busy: { about: 'Running session blocks checkout with an explicit worktree alternative' },
    idle: { about: 'Idle sessions are named without blocking branch choices' },
    dirty: { about: 'Scrollable dirty file list with fixed actions and worktree alternative' },
    conflict: { about: 'Carry option disabled for overlapping changes' },
    ignored: { about: 'Clean checkout names ignored files that prevent switching' },
    ordinary: { about: 'A plain checkout updates the branch without a success toast' },
    carried: { about: 'Carried changes produce a success toast with undo' },
    occupied: {
      about: 'An occupied branch is clickable and explains the rejection after preflight',
    },
    success: { about: 'Successful checkout toast with undo leaves the controls aligned' },
    switching: {
      about: 'Pending checkout keeps the right-aligned branch button width and position',
    },
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
        result[id] = {
          x: box.x,
          y: box.y,
          height: box.height,
          ...(ui.case === 'switching' || ui.case === 'sync-off' ? { width: box.width } : {}),
        };
      }
      return result;
    };
    const before = await geometry();
    await ui.capture('before-feedback');
    if (ui.case === 'default-source') {
      await page.getByTestId('create-agent-worktree-chip').click();
      await page
        .getByTestId('create-agent-branch-chip')
        .filter({ hasText: 'origin/main' })
        .waitFor();
      assert.equal(
        await page.getByTestId('create-agent-worktree-chip').getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await page.locator('[data-toast-id]').count(), 0);
      return;
    }
    if (ui.case === 'sync-off') {
      const refresh = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.action', {
          branch: 'main',
          remote: 'origin',
          remoteBranch: 'main',
        }),
      });
      await refresh.waitFor();
      assert.equal(await refresh.isDisabled(), false);
      await ui.capture('unchecked-refresh');
      await page.getByTestId('create-agent-worktree-chip').click();
      await page
        .getByRole('button', {
          name: await ui.t('newChat.branchSync.action', {
            branch: 'main',
            remote: 'origin',
            remoteBranch: 'main',
          }),
        })
        .waitFor();
      const after = await geometry();
      assert.deepEqual(after, before, 'Toggling worktree must not hide refresh or resize the row');
      await ui.capture('checked-refresh');
      return;
    }
    await page.getByTestId('create-agent-branch-chip').click();
    await page.getByRole('option', { name: /^feature/ }).waitFor();
    if (ui.case === 'ordinary') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.getByTestId('create-agent-branch-chip').filter({ hasText: 'feature' }).waitFor();
      assert.equal(await page.locator('[data-toast-id]').count(), 0);
    } else if (ui.case === 'carried') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page
        .getByRole('button', {
          name: await ui.t('newChat.checkout.carry', { branch: 'feature' }),
          exact: true,
        })
        .click();
      const feedback = page.getByRole('status');
      await feedback.waitFor();
      assert.ok((await feedback.innerText()).includes(await ui.t('newChat.checkout.carried')));
      assert.equal(
        await feedback
          .getByRole('button', { name: await ui.t('newChat.checkout.undo'), exact: true })
          .count(),
        1,
      );
    } else if (ui.case === 'occupied') {
      const option = page.getByRole('option', { name: 'release', exact: true });
      assert.equal(await option.getAttribute('aria-disabled'), 'false');
      await option.click();
      const feedback = page.getByRole('alert');
      await feedback.waitFor();
      assert.equal(
        await feedback.innerText(),
        await ui.t('newChat.checkout.errors.occupied', { branch: 'release' }),
      );
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
    } else if (ui.case === 'switching') {
      await page.getByRole('option', { name: 'feature', exact: true }).click();
      await page.locator('[data-testid="create-agent-branch-chip"][aria-busy="true"]').waitFor();
      assert.equal(await page.getByTestId('create-agent-branch-chip').innerText(), 'main');
      assert.equal(
        await page.getByTestId('create-agent-branch-chip').getAttribute('aria-disabled'),
        'true',
      );
    } else if (ui.case === 'ignored') {
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
        String(ui.case === 'busy'),
      );
    }
    const after = await geometry();
    assert.deepEqual(after, before, 'Feedback must not move or resize the controls row or input');
    console.log('CHECKOUT_ROW_GEOMETRY', JSON.stringify({ case: ui.case, before, after }));
  },
};
