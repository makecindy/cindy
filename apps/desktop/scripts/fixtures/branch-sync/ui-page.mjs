import assert from 'node:assert/strict';
export default {
  name: 'branch-sync',
  entry: './branch-sync-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'BranchWorktreeChip, sync hook, grouped combobox, tooltip, themes and locale strings',
  notCovered:
    'Git processes, device-link transport and native task creation; covered by unit and Git integration tests',
  cases: {
    default: {
      about: 'Main-task capsule, selected-branch details, remote group and successful fetch',
    },
    worker: { about: 'Compact Worker branch-only capsule', viewport: { width: 360, height: 400 } },
    unchecked: { about: 'Unchecked main-task worktree excludes remote sources' },
    conflict: { about: 'Disabled sync remains focusable and explains overlapping changes' },
    diverged: { about: 'Diverged branches keep local source and explain why sync is unavailable' },
    'old-host': { about: 'Old controlled host has neither refresh button nor remote group' },
  },
  async check(page, ui) {
    const trigger = page.getByRole('button', {
      name: await ui.t('newChat.branchChip.label'),
      exact: true,
    });
    await trigger.waitFor();
    await ui.capture('capsule');
    if (ui.case === 'default' || ui.case === 'worker') {
      const action = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.action', {
          remote: 'origin',
          remoteBranch: 'main',
        }),
        exact: false,
      });
      await action.hover();
      await page.getByRole('tooltip').waitFor();
      await ui.capture('action-hint');
    }
    if (ui.case === 'conflict' || ui.case === 'diverged') {
      const action = page.getByRole('button', {
        name: await ui.t(`newChat.branchSync.${ui.case}`, {
          branch: 'main',
          remote: 'origin',
          remoteBranch: 'main',
        }),
        exact: true,
      });
      assert.equal(await action.isDisabled(), true);
      await action.locator('..').hover();
      await page.getByRole('tooltip').waitFor();
      await ui.capture('disabled-reason');
    }
    await trigger.click();
    await page.getByRole('combobox').waitFor();
    const remote = page.getByRole('group', {
      name: await ui.t('newChat.branchSync.remoteGroup'),
      exact: true,
    });
    assert.equal(await remote.count(), ['unchecked', 'old-host'].includes(ui.case) ? 0 : 1);
    await ui.capture('branches');
    if (ui.case === 'unchecked') {
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', {
          name: await ui.t('newChat.branchSync.action', { remote: 'origin', remoteBranch: 'main' }),
          exact: false,
        })
        .click();
      const result = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.keptAhead', { count: 1 }),
        exact: true,
      });
      await page.mouse.move(340, 350);
      await result.hover();
      await page.getByRole('tooltip').waitFor();
      await ui.capture('kept-ahead');
    }
    if (ui.case === 'default' || ui.case === 'worker') {
      await page.getByRole('combobox').fill('origin/main');
      assert.equal(await page.getByRole('option').count(), 2);
      await page.keyboard.press('Enter');
      assert.match(await trigger.textContent(), /origin\/main/);
      const action = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.remoteAction', {
          remote: 'origin',
          remoteBranch: 'main',
        }),
        exact: false,
      });
      await action.click();
      await page
        .getByRole('button', {
          name: await ui.t('newChat.branchSync.updated', { count: ui.case === 'worker' ? 1 : 3 }),
          exact: true,
        })
        .waitFor();
      await page.mouse.move(340, 350);
      await page
        .getByRole('button', {
          name: await ui.t('newChat.branchSync.updated', { count: ui.case === 'worker' ? 1 : 3 }),
          exact: true,
        })
        .hover();
      await page.getByRole('tooltip').waitFor();
      await ui.capture('updated');
    }
  },
};
