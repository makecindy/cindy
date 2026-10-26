import assert from 'node:assert/strict';

const list = {
  activeAccountId: 'acct_work0001',
  accounts: [
    { id: 'master', kind: 'master', label: 'Master', email: 'me@example.com', subscriptionType: 'pro', active: false },
    { id: 'acct_work0001', kind: 'extra', label: 'Work', email: 'work.account@example.com', subscriptionType: 'max', active: true },
    {
      id: 'acct_side0001',
      kind: 'extra',
      label: 'A very long account name to test wrap',
      email: 'someone.with.a.really.long.address@example-company.example',
      active: false,
    },
  ],
};

const health = [
  { accountId: 'master', label: 'Master', loggedIn: true, email: 'me@example.com' },
  { accountId: 'acct_work0001', label: 'Work', loggedIn: true, profile: { healthy: true, mode: 'linked', problems: [] } },
  {
    accountId: 'acct_side0001',
    label: 'A very long account name to test wrap',
    loggedIn: false,
    profile: { healthy: false, mode: 'linked', problems: [{ name: 'skills', state: 'missing' }] },
  },
];

export default {
  name: 'claude-accounts',
  entry: './claude-accounts-fixture.tsx',
  viewport: { width: 760, height: 620 },
  real: 'ClaudeAccountsPanel (badges, switch/remove/add controls, health text, ownership notice), shared Button/Input, themes',
  notCovered: 'Real sign-in, switching, removal and session rebuild (main process); the handoff dialog',
  cases: {
    default: { about: 'Master + active extra + long-name extra', data: { list, health } },
    checked: { about: 'After "Check accounts": one account needs repair and is signed out', data: { list, health } },
    adding: { about: 'Add-account form open', data: { list, health } },
    narrow: { about: 'Account rows at 360 px', viewport: { width: 360, height: 760 }, data: { list, health } },
  },
  async ready(page) {
    await page.getByText('Work', { exact: true }).waitFor();
  },
  async check(page, ui) {
    // The master account can never be removed; the active account cannot be switched to.
    const remove = ui.t('claudeAccounts.settings.remove');
    assert.equal(await page.getByRole('button', { name: remove }).count(), 2);
    assert.equal(await page.getByRole('button', { name: ui.t('claudeAccounts.settings.switch') }).count(), 2);
    if (ui.case === 'checked') {
      await page.getByRole('button', { name: ui.t('claudeAccounts.settings.check') }).click();
      await page.getByText(ui.t('claudeAccounts.settings.health.loggedOut')).waitFor();
      await page.getByText(ui.t('claudeAccounts.settings.health.ok')).first().waitFor();
    }
    if (ui.case === 'adding') {
      await page.getByRole('button', { name: ui.t('claudeAccounts.settings.add') }).click();
      await page.getByRole('textbox', { name: ui.t('claudeAccounts.settings.nameLabel') }).waitFor();
      // Sign in stays disabled until a name is entered.
      assert.equal(await page.getByRole('button', { name: ui.t('claudeAccounts.settings.signIn') }).isDisabled(), true);
    }
  },
};
