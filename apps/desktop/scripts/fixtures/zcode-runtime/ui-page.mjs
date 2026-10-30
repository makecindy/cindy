import assert from 'node:assert/strict';

export default {
  name: 'zcode-runtime', entry: './fixture.tsx', viewport: { width: 1000, height: 760 },
  real: 'ProvidersSection, ZCode native source, connection controls, model list, translations and themes',
  notCovered: 'Native login, entitlement, model requests and owner persistence; all account data is synthetic',
  stubs: Object.fromEntries([
    'contexts/AuthContext', 'hooks/useProviders', 'hooks/useApiKey', 'hooks/useModelAccessStatus',
    'hooks/useModelAccessCreditUsage', 'hooks/useClaudeAccountUsage', 'hooks/useXdAssetPrimaryAction',
    'hooks/useCodexAuth',
  ].map(module => [`src/renderer/${module}`, './state.ts'])),
  cases: {
    default: { about: 'Installed native runtime awaiting explicit account connection' },
    connected: { about: 'Connected native Team source with an available model' },
  },
  async check(page, ui) {
    await page.getByText('ZCode', { exact: true }).first().click();
    const managed = page.getByText(await ui.t('settings.providers.zcode.managed'), { exact: false }).first();
    await managed.waitFor();
    assert.ok((await managed.textContent()).includes(await ui.t('settings.providers.detail.singleAgentNote', { agent: 'ZCode' })));
    const action = await ui.t(ui.case === 'connected' ? 'settings.providers.byok.refresh' : 'settings.providers.zcode.connect');
    await page.getByRole('button', { name: action, exact: true }).waitFor();
    if (ui.case === 'connected') {
      await page.getByText('Example Team Model', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.models.advanced.openAria', { name: 'Example Team Model' }), exact: true }).count(), 0);
    }
    assert.equal(await page.getByRole('textbox', { name: /API Key/i }).count(), 0);
  },
};
