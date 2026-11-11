export default {
  name: 'webhook-account', entry: './account-fixture.tsx', viewport: { width: 900, height: 760 },
  real: 'WebhookAccountManager, Radix Dialog, Cindy buttons, translations and theme',
  notCovered: 'Fixture account endpoints; no authentication, real server deletion, native IPC or network',
  stubs: { 'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration = () => 0;' },
  cases: { default: { about: '按设备查看、内联确认释放、名额更新', data: {} } },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('scheduler.webhook.account.manage'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('每日项目巡检', { exact: true }).waitFor();
    await ui.capture('account-list');
    const row = dialog.getByRole('listitem').filter({ hasText: '每日项目巡检' });
    await row.getByRole('button', { name: await ui.t('scheduler.webhook.account.release'), exact: true }).click();
    await ui.capture('confirm-release');
    await row.getByRole('button', { name: await ui.t('scheduler.webhook.account.confirmRelease'), exact: true }).click();
    await row.waitFor({ state: 'detached' });
    await dialog.getByText(await ui.t('scheduler.webhook.account.usage', { used: 2, limit: 10 }), { exact: true }).waitFor();
    await ui.capture('released');
  },
};
