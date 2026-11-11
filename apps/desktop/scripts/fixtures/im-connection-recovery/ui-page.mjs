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
    ]),
  ),
  async ready(page) {
    await page.getByRole('alert').waitFor();
  },
  async check(page, ui) {
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
