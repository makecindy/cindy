import assert from 'node:assert/strict';

export default {
  name: 'teammate-feishu',
  entry: './teammate-feishu-fixture.tsx',
  viewport: { width: 720, height: 900 },
  real: 'BotChannelsPage add/edit dialogs and group controls, shared Input, Button, SegmentedControl, Collapse and localized text',
  notCovered: 'Live platform login, credential persistence and connection handshake; real host writes are forbidden, group-edit saves and queries use in-memory fixture state',
  cases: {
    'imessage-edit': { about: 'Populated iMessage editor keeps its password write-only', data: { imessage: true } },
    'imessage-narrow': { about: 'iMessage editor remains usable at 320px', data: { imessage: true }, viewport: { width: 320, height: 700 } },
    'imessage-group-add': { about: 'The first group appears immediately after a simulated settings save', data: { imessage: true, groupEdit: 'add' } },
    'imessage-group-replace': { about: 'Editing chat GUIDs removes old group controls and shows new ones', data: { imessage: true, groupEdit: 'replace' } },
    default: { about: 'Feishu creation prompt and link share one row', data: {} },
    'feishu-onboarding': { about: 'Feishu creation prompt and link share one row', data: {} },
    'feishu-lark': { about: 'Lark updates the link, description and submit label', data: { lark: true } },
    'feishu-expanded': { about: 'Expanded setup guide above the credential inputs', data: { expanded: true } },
    'feishu-narrow': { about: '320px viewport wraps guidance and keeps the form scrollable', data: { expanded: true }, viewport: { width: 320, height: 700 } },
  },
  async check(page, ui) {
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
      await dialog.getByRole('radio', { name: await ui.t('bots.channels.platform.lark'), exact: true }).click();
    }
    const service = await ui.t('bots.channels.platform.' + (ui.data.lark ? 'lark' : 'feishu'));
    const link = dialog.getByRole('link', { name: await ui.t('bots.channels.add.feishu.createLink', { service }), exact: true });
    assert.equal(await link.getAttribute('href'), ui.data.lark
      ? 'https://open.larksuite.com/page/launcher?from=backend_oneclick'
      : 'https://open.feishu.cn/page/launcher?from=backend_oneclick');
    assert.equal(await dialog.getByRole('button', { name: await ui.t('bots.channels.add.feishu.confirm', { service }), exact: true }).isDisabled(), true);
    assert.equal(await dialog.locator('span.truncate').evaluateAll((labels) =>
      labels.some((label) => label.scrollWidth > label.clientWidth)), false, 'platform names fit without truncation');
    if (ui.locale === 'zh-CN' && ui.viewport.width >= 600) {
      const prompt = await dialog.getByText(await ui.t('bots.channels.add.feishu.createPrompt', { service }), { exact: true }).boundingBox();
      const anchor = await link.boundingBox();
      assert.ok(Math.abs(prompt.y - anchor.y) < 2, 'Chinese creation prompt and link stay on one row');
    }
    const steps = dialog.getByRole('button', { name: await ui.t('bots.channels.add.feishu.stepsLabel'), exact: true });
    if (ui.data.expanded) {
      await steps.click();
      await dialog.getByText(await ui.t('bots.channels.add.feishu.stepCreate'), { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await steps.getAttribute('aria-expanded'), 'true');
    }
    await ui.capture('onboarding');
    if (ui.viewport.width < 400) {
      const secret = dialog.getByLabel(await ui.t('bots.channels.add.feishu.appSecretLabel'), { exact: true });
      await secret.scrollIntoViewIfNeeded();
      assert.equal(await secret.isVisible(), true, 'credential inputs remain reachable below the guide');
      await ui.capture('credentials');
    }
  },
};
