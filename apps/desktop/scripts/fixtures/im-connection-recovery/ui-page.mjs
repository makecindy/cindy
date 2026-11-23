import assert from 'node:assert/strict';

const channels = ['discord', 'telegram', 'dingtalk', 'wecom'];
export default {
  name: 'im-connection-recovery',
  entry: './fixture.tsx',
  viewport: { width: 660, height: 850 },
  real: 'Four bot settings sections, hooks, ErrorNotice, reconnect buttons and translations',
  notCovered: 'Live IM services, credentials and unrelated model/Telegram behavior settings',
  stubs: {
    'src/renderer/components/settings/ImDefaultSettingsSection':
      'export const ImDefaultSettingsSection = () => null;',
    'src/renderer/components/settings/TelegramBehaviorSettings':
      'export const TelegramBehaviorSettings = () => null; export const TelegramGroupActivationSettings = () => null; export const TelegramPersonaSettings = () => null;',
    'src/renderer/components/settings/TelegramRemoteDevices':
      'export const TelegramRemoteDevices = () => null;',
  },
  cases: Object.fromEntries(
    channels.flatMap((channel) => [
      [
        channel === 'discord' ? 'default' : channel,
        { about: `${channel}: failure retains binding and exposes retry`, data: { channel } },
      ],
      [
        `${channel}-narrow`,
        {
          about: `${channel}: recovery at 320px`,
          data: { channel },
          viewport: { width: 320, height: 850 },
        },
      ],
    ]).concat([
      [
        'telegram-save-timeout',
        {
          about: 'telegram: a new binding that only timed out keeps the input; the same input then connects',
          data: { channel: 'telegram', saveTimeout: true },
        },
      ],
      [
        'telegram-save-timeout-narrow',
        {
          about: 'telegram: save timeout at 320px',
          data: { channel: 'telegram', saveTimeout: true },
          viewport: { width: 320, height: 850 },
        },
      ],
    ]),
  ),
  async ready(page) {
    // Recovery cases open on a failure alert; the save-timeout case opens on an empty form.
    await page.locator('[role="alert"], [data-fixture="save-timeout"] input').first().waitFor();
  },
  async check(page, ui) {
    if (ui.data.saveTimeout) {
      const token = page.getByPlaceholder(await ui.t('settings.telegramBot.tokenPlaceholder'));
      const owner = page.getByPlaceholder(await ui.t('settings.telegramBot.ownerUserIdPlaceholder'));
      await token.fill('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      await owner.fill('4242');
      const connect = page.getByRole('button', { name: await ui.t('settings.telegramBot.connect'), exact: true });
      await connect.click();
      const alert = page.getByRole('alert');
      await alert.waitFor();
      assert.equal(await alert.innerText(), await ui.t('settings.telegramBot.connectTimedOut'));
      assert.equal(await token.inputValue(), '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      assert.equal(await owner.inputValue(), '4242');
      // Nothing was saved: no "reconnect saved binding" or unbind entry, only the same Connect.
      for (const key of ['settings.imConnection.reconnect', 'settings.telegramBot.disconnectAria']) {
        assert.equal(await page.getByRole('button', { name: await ui.t(key), exact: true }).count(), 0);
      }
      await ui.capture('timed-out');
      await connect.click();
      await alert.waitFor({ state: 'hidden' });
      await page.getByText(await ui.t('settings.telegramBot.status.connected'), { exact: true }).first().waitFor();
      await ui.capture('connected');
      return;
    }
    const channel = ui.data.channel;
    const reconnectKey =
      channel === 'wecom' || channel === 'dingtalk'
        ? `settings.${channel}Bot.reconnect`
        : 'settings.imConnection.reconnect';
    const retry = page.getByRole('button', { name: await ui.t(reconnectKey), exact: true });
    assert.ok(await retry.isEnabled());
    const details = page.getByRole('button', {
      name: await ui.t('chat.errorBanner.networkShowRaw'),
      exact: true,
    });
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    await details.click();
    assert.equal(await page.locator('pre').innerText(), 'Temporary network failure');
    await retry.click();
    assert.ok(await retry.isDisabled());
    await ui.capture('retrying');
    await ui.emit(`${channel}-status`, {
      status: { kind: 'connected', appId: 'example_bot' },
      ownerUserId: '12345678901234567',
      botId: 'example_bot',
    });
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await ui.capture('recovered');
  },
};
