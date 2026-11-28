import assert from 'node:assert/strict';

export default {
  name: 'teammate-feishu',
  entry: './teammate-feishu-fixture.tsx',
  viewport: { width: 720, height: 900 },
  real: 'BotChannelsPage add/edit dialogs and group controls, shared QR authorization card, Button, SegmentedControl and localized text',
  notCovered: 'Live Feishu/Lark login, application provisioning, external browser navigation, credential persistence and connection handshake; host writes are forbidden, group-edit saves and queries use in-memory fixture state',
  cases: {
    'imessage-denied': { about: 'A denied send explains macOS Automation and keeps the delivery check visible', data: { imessage: true, denied: true } },
    'imessage-edit': { about: 'Populated iMessage editor keeps its password write-only', data: { imessage: true } },
    'imessage-narrow': { about: 'iMessage editor remains usable at 320px', data: { imessage: true }, viewport: { width: 320, height: 700 } },
    'imessage-group-add': { about: 'The first group appears immediately after a simulated settings save', data: { imessage: true, groupEdit: 'add' } },
    'imessage-group-replace': { about: 'Editing chat GUIDs removes old group controls and shows new ones', data: { imessage: true, groupEdit: 'replace' } },
    default: { about: 'Feishu shows QR authorization instead of credential fields', data: {} },
    'feishu-lark': { about: 'Lark switches the authorization service', data: { lark: true } },
    'feishu-narrow': { about: '320px viewport keeps the authorization card scrollable', data: { lark: true }, viewport: { width: 320, height: 700 } },
  },
  async check(page, ui) {
    if (ui.data.denied) {
      await page.getByText(await ui.t('bots.channels.add.imessage.automationDenied'), { exact: true }).waitFor();
      await ui.capture('imessage-send-permission');
      return;
    }
    if (ui.data.imessage) {
      if (ui.data.groupEdit === 'replace') await page.getByText('Old group', { exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('bots.channels.edit.button'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByLabel(await ui.t('bots.channels.add.imessage.passwordLabel'), { exact: true }).inputValue(), '');
      assert.equal(await dialog.getByRole('button', { name: await ui.t('bots.channels.edit.save'), exact: true }).isEnabled(), true);
      await ui.capture('imessage-edit');
      if (ui.data.groupEdit) {
        await dialog.getByLabel(await ui.t('bots.channels.add.imessage.chatGuidsLabel'), { exact: true }).fill('any;-;owner@example.test, any;+;new-group');
        await dialog.getByRole('button', { name: await ui.t('bots.channels.edit.save'), exact: true }).click();
        await page.getByText('New group', { exact: true }).waitFor();
        assert.equal(await page.getByText('Old group', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('radio', { name: await ui.t('bots.channels.groups.mode.always'), exact: true }).isVisible(), true);
        await ui.capture('groups-refreshed');
      }
      return;
    }
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
