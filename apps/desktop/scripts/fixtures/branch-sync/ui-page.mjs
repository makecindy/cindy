import assert from 'node:assert/strict';

export default {
  name: 'branch-sync',
  entry: './branch-sync-fixture.tsx',
  viewport: { width: 520, height: 640 },
  real: 'BranchWorktreeChip single capsule, BranchWorkspaceSubpanes, useBranchSync, useWorkspaceClutter, grouped combobox, tooltip, themes and locale strings',
  notCovered:
    'Git processes, device-link transport and native task creation; covered by unit and Git integration tests',
  cases: {
    default: {
      about: 'Single capsule beside project pill, behind remote sync card, remote group and successful fetch',
    },
    worker: { about: 'Compact Worker branch-only capsule', viewport: { width: 420, height: 480 } },
    unchecked: {
      about: 'Unchecked worktree switch inside popover with remote selection and sync',
    },
    ahead: { about: 'Checked worktree source retains unpushed commits after refresh' },
    conflict: { about: 'Blocked conflict status stays explained inside popover' },
    diverged: { about: 'Diverged branch with dirty edits explains why auto-sync paused' },
    'diverged-rebase': {
      about: 'Clean conflict-free diverged branch enables zero-token one-click rebase sync',
    },
    'diverged-conflict': {
      about: 'Conflicting diverged branch shows conflict files and one-click Agent handoff',
    },
    guide: {
      about: 'Inline 30-second visual guide for branches and worktrees',
    },
    'cleanup-urgent': {
      about: 'L2 severe clutter red dot on capsule, AI cleanup confirmation pane, and 7-day snooze',
    },
    'old-host': { about: 'Old controlled host hides sync header and remote group' },
  },
  async check(page, ui) {
    const trigger = page.getByRole('button', {
      name: await ui.t('newChat.branchChip.label'),
      exact: true,
    });
    await trigger.waitFor();
    await ui.capture('capsule');

    if (ui.case === 'cleanup-urgent') {
      await page.getByTestId('workspace-clutter-red-dot').waitFor();
      await trigger.click();
      await page.getByTestId('workspace-cleanup-entry').waitFor();
      await ui.capture('cleanup-entry');
      await page.getByTestId('workspace-cleanup-entry').click();
      await page.getByTestId('workspace-cleanup-pane').waitFor();
      await ui.capture('cleanup-pane');
      await page.getByTestId('snooze-cleanup-red-dot-btn').click();
      await page.getByTestId('workspace-clutter-red-dot').waitFor({ state: 'hidden' });
      await page.getByTestId('workspace-cleanup-entry').click();
      await page.getByTestId('start-ai-cleanup-btn').click();
      await page.getByTestId('cleanup-handoff').waitFor();
      return;
    }

    if (ui.case === 'guide') {
      await trigger.click();
      await page.getByTestId('workspace-guide-footer-btn').click();
      await page.getByTestId('workspace-guide-pane').waitFor();
      await ui.capture('guide-pane');
      await page.keyboard.press('Escape');
      await page.getByTestId('workspace-guide-pane').waitFor({ state: 'hidden' });
      return;
    }

    await trigger.click();
    await page.getByRole('combobox').waitFor();

    if (ui.case === 'diverged-rebase') {
      const rebaseBtn = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.rebaseNow'),
        exact: true,
      });
      await rebaseBtn.waitFor();
      assert.equal(await rebaseBtn.isDisabled(), false);
      await ui.capture('rebase-popover');
      await rebaseBtn.click();
      await page
        .getByTestId('workspace-sync-header-btn')
        .and(page.locator(`[aria-label="${await ui.t('newChat.branchSync.rebased', { count: 3 })}"]`))
        .waitFor();
      await ui.capture('rebased');
      return;
    }

    if (ui.case === 'diverged-conflict') {
      const resolveBtn = page.getByRole('button', {
        name: await ui.t('newChat.branchSync.askAgentResolve'),
        exact: true,
      });
      await resolveBtn.waitFor();
      await page
        .getByRole('button', { name: await ui.t('newChat.workspaceCapsule.filesAndDetails') })
        .click();
      await ui.capture('conflict-popover');
      await resolveBtn.click();
      await page.getByTestId('resolved-handoff').waitFor();
      return;
    }

    if (ui.case === 'conflict' || ui.case === 'diverged') {
      const headerSync = page.getByTestId('workspace-sync-header-btn');
      assert.equal(await headerSync.isDisabled(), true);
      await ui.capture('blocked-popover');
    }

    const remote = page.getByRole('group', {
      name: await ui.t('newChat.branchSync.remoteGroup'),
      exact: true,
    });
    assert.equal(await remote.count(), ui.case === 'old-host' ? 0 : 1);
    await ui.capture('branches');

    if (ui.case === 'unchecked') {
      const headerSync = page.getByTestId('workspace-sync-header-btn');
      await headerSync.waitFor();
      assert.equal(await headerSync.isDisabled(), false);
    }

    if (ui.case === 'ahead') {
      await page.getByTestId('workspace-sync-header-btn').click();
      await page
        .getByTestId('workspace-sync-header-btn')
        .and(page.locator(`[aria-label="${await ui.t('newChat.branchSync.keptAhead', { count: 1 })}"]`))
        .waitFor();
      await ui.capture('kept-ahead');
    }

    if (ui.case === 'default' || ui.case === 'worker') {
      await page.getByRole('combobox').fill('origin/main');
      assert.equal(await page.getByRole('option').count(), 2);
      await page.keyboard.press('Enter');
      assert.match(await page.getByTestId('create-agent-branch-name').innerText(), /origin\/main/);
      await trigger.click();
      await page.getByTestId('workspace-sync-header-btn').click();
      await page
        .getByTestId('workspace-sync-header-btn')
        .and(
          page.locator(
            `[aria-label="${await ui.t('newChat.branchSync.updated', {
              count: ui.case === 'worker' ? 1 : 3,
            })}"]`,
          ),
        )
        .waitFor();
      await ui.capture('updated');
    }
  },
};
