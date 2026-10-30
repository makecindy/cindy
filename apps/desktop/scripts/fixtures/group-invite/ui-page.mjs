import assert from 'node:assert/strict';

export default {
  name: 'group-invite',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 560 },
  real: 'BotGroupCreateDialog, ChatInviteDialog, BotAvatar and shared input/button/dialog components',
  notCovered: 'Real accounts, group creation, invitation service, clipboard and route transitions; host replies use example data',
  cases: {
    default: { about: 'New group success, creator avatar, invitation slot and copy action' },
    manual: { about: 'Group invitation with close, revoke and copy actions in the footer' },
    loading: { about: 'Automatic invitation generation pending' },
    failed: { about: 'Invitation generation failure with retry' },
    create: { about: 'Private-chat group creation with a focused name and no member picker' },
    'name-error': { about: 'Required group name and its unclipped error ring' },
  },
  async ready(page) {
    await page.getByRole('dialog').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'create' || ui.case === 'name-error') {
      assert.equal(await page.getByRole('checkbox').count(), 0);
      if (ui.case === 'name-error') await page.getByText(await ui.t('bots.groupChat.create.nameRequired'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'loading') await page.getByRole('status').waitFor();
    else if (ui.case === 'failed') await page.getByRole('alert').waitFor();
    else {
      await page.getByRole('button', { name: await ui.t('bots.groupChat.server.copyLink'), exact: true }).waitFor();
      assert.equal(await page.getByRole('button').count(), ui.case === 'manual' ? 3 : 2);
    }
  },
};
