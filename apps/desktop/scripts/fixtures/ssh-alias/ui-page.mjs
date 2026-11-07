import assert from 'node:assert/strict';

export default {
  name: 'ssh-alias',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'RemoteSection, FormField, SettingsTextInput and localized alias guidance',
  notCovered: 'Real SSH connections, persistence, imported-host editing and relay deployment',
  cases: {
    default: { about: 'Alias rules stay visible before typing' },
    'alias-invalid': { about: 'Chinese alias shows inline error and disables Add' },
    'alias-valid': { about: 'English alias with Chinese display name enables Add' },
  },
  async check(page, ui) {
    await page
      .getByRole('button', { name: await ui.t('settings.remote.button.add'), exact: true })
      .click();
    const alias = page.getByLabel(await ui.t('settings.remote.add.alias'), { exact: true });
    const hint = page.getByText(await ui.t('settings.remote.add.aliasHint'), { exact: true });
    await hint.waitFor();
    await page
      .getByLabel(await ui.t('settings.remote.add.hostname'), { exact: true })
      .fill('example.com');
    await page.getByLabel(await ui.t('settings.remote.add.user'), { exact: true }).fill('ubuntu');
    const submit = page.getByRole('button', {
      name: await ui.t('settings.remote.add.submit'),
      exact: true,
    });
    if (ui.case === 'alias-invalid') {
      await alias.fill('测试服务器');
      await page
        .getByText(await ui.t('settings.remote.add.aliasInvalid'), { exact: true })
        .waitFor();
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await alias.getAttribute('aria-invalid'), 'true');
    } else if (ui.case === 'alias-valid') {
      await alias.fill('my-server');
      await page
        .getByLabel(await ui.t('settings.remote.add.displayName'), { exact: true })
        .fill('测试服务器');
      assert.equal(await submit.isDisabled(), false);
    } else {
      assert.equal(await submit.isDisabled(), true);
    }
    assert.ok(
      (await alias.getAttribute('aria-describedby'))?.includes(await hint.getAttribute('id')),
    );
  },
};
