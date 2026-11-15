import assert from 'node:assert/strict';

export default {
  name: 'cindy-ai-identity', entry: './fixture.tsx',
  viewport: { width: 1000, height: 760 },
  real: 'ProvidersSection, provider list and detail names, model list, translations and themes',
  notCovered: 'Live sign-in, key management, quota reads and actual gateway routing; identity is fixture data',
  stubs: Object.fromEntries([
    'contexts/AuthContext', 'hooks/useProviders', 'hooks/useApiKey', 'hooks/useModelAccessStatus',
    'hooks/useModelAccessCreditUsage', 'hooks/useClaudeAccountUsage', 'hooks/useXdAssetPrimaryAction',
    'hooks/useCodexAuth',
  ].map(module => [`src/renderer/${module}`, './state.ts'])),
  cases: {
    default: { about: 'Personal Cindy AI in provider list and details' },
    xd: { about: 'XD Cindy AI in provider list and details' },
    organization: { about: 'Long enterprise name with the original Auto model name' },
  },
  async check(page, ui) {
    const suffix = ui.case === 'default' ? await ui.t('settings.providers.xd.personal')
      : ui.case === 'xd' ? await ui.t('settings.providers.xd.xdOrganization') : 'Example International Game Studio';
    const name = `Cindy AI · ${suffix}`;
    await page.getByText(name, { exact: true }).first().waitFor();
    assert.ok(await page.getByText(name, { exact: true }).count() >= 2);
    if (ui.case !== 'organization') {
      assert.ok(await page.getByText(name, { exact: true }).first()
        .evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Account suffix must fit in the provider list');
    }
    await page.getByText('Auto', { exact: true }).first().waitFor();
  },
};
