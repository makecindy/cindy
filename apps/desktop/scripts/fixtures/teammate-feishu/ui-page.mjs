import assert from 'node:assert/strict';

export default {
  name: 'teammate-feishu',
  entry: './teammate-feishu-fixture.tsx',
  viewport: { width: 720, height: 900 },
  real: 'BotChannelsPage add-platform dialog, shared QR authorization card, Button, SegmentedControl and five-locale translations',
  notCovered: 'Live Feishu/Lark login, application provisioning, external browser navigation, credential persistence and connection handshake; host writes are forbidden',
  cases: {
    default: { about: 'Feishu shows QR authorization instead of credential fields', data: {} },
    'feishu-lark': { about: 'Lark switches the authorization service', data: { lark: true } },
    'feishu-narrow': { about: '320px viewport keeps the authorization card scrollable', data: { lark: true }, viewport: { width: 320, height: 700 } },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('bots.channels.add.button'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: await ui.t('bots.channels.platform.feishu'), exact: true }).click();
    if (ui.data.lark) {
      await dialog.getByRole('radio', { name: await ui.t('settings.feishuBot.services.lark'), exact: true }).click();
    }
    // 不再出现 App ID / App Secret 手填框, 扫码是唯一入口。
    assert.equal(await dialog.getByLabel(await ui.t('bots.channels.add.feishu.appIdLabel'), { exact: true }).count(), 0);
    assert.equal(await dialog.getByLabel(await ui.t('bots.channels.add.feishu.appSecretLabel'), { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: await ui.t('settings.feishuBot.qr.begin'), exact: true }).click();
    await dialog.getByAltText(await ui.t('settings.feishuBot.qr.qrAlt'), { exact: true }).waitFor({ state: 'visible' });
    await dialog.getByText('ABCD-EFGH', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('span.truncate').evaluateAll((labels) =>
      labels.some((label) => label.scrollWidth > label.clientWidth)), false, 'platform names fit without truncation');
    await ui.capture('authorize');
    if (ui.viewport.width < 400) {
      const hint = dialog.getByText(await ui.t('settings.feishuBot.qr.cardActionHint'), { exact: false });
      await hint.scrollIntoViewIfNeeded();
      assert.equal(await hint.isVisible(), true, 'authorization guidance stays reachable on narrow screens');
      await ui.capture('narrow');
    }
  },
};
