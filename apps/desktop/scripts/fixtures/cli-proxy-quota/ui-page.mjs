import assert from 'node:assert/strict';

export default {
  name: 'cli-proxy-quota',
  entry: './fixture.tsx',
  viewport: { width: 700, height: 850 },
  real: 'CliProxyQuotaSection, production secret input/buttons/QuotaBar, translations and themes',
  notCovered: 'Real management authentication, credential encryption, network requests and full native settings navigation; uses synthetic accounts only',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: null, dataOwnerGeneration: 0 });',
  },
  cases: {
    default: { about: 'Independent Gemini and third-party windows plus a disabled account' },
    narrow: { about: 'Same quota at 320px', viewport: { width: 320, height: 900 } },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('cliProxyQuota.refresh') }).click();
    await page.getByText('Account A', { exact: true }).waitFor();
    assert.equal(await page.getByRole('progressbar').count(), 3);
    await page.getByText(await ui.t('cliProxyQuota.notApplicable'), { exact: true }).waitFor();
    await page.getByText(await ui.t('cliProxyQuota.disabled'), { exact: true }).waitFor();
    await ui.capture('quota');
  },
};
