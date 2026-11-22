import assert from 'node:assert/strict';
import runLocation from '../provider-run-location/ui-page.mjs';

/** 模型供应商页的「我的其他电脑可用」状态：只看这个供应商的「允许被远程调用」与本机是否允许被连接。 */
export default {
  name: 'provider-own-computers',
  entry: '../provider-run-location/fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection detail header subtitle with ProviderRunLocationSubtitle, translations and themes',
  notCovered: 'Live device catalogs; settings are fixture data',
  stubs: runLocation.stubs,
  cases: {
    default: { about: '允许被远程调用 is off (the default): no status' },
    'own-provider': { about: '允许被远程调用 is on: the header reads 我的其他电脑可用' },
    'own-remote-off': { about: '允许被远程调用 is on, but this computer does not allow connections: no status' },
    'merged-shared': { about: 'A connection merged into the OpenAI pool that still has shares: its switch shows the pool state, cannot be changed here, and says where to change it' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'merged-shared') {
      await page.getByText('OpenAI · old connection', { exact: true }).first().click();
      const row = page.getByTestId('provider-remote-access');
      await row.waitFor();
      assert.equal(await row.getByRole('switch').isDisabled(), true, 'the merged connection switch is read-only');
      await row.getByText(await ui.t('settings.providers.detail.remoteAccess.followsPool', { pool: 'OpenAI' }), { exact: true }).waitFor();
      await ui.capture('merged-row');
      return;
    }
    await page.getByTestId('provider-detail-metadata').waitFor();
    const status = page.getByTestId('provider-own-computers');
    if (ui.case === 'own-provider') await status.waitFor();
    else assert.equal(await status.count(), 0);
    await ui.capture('header');
  },
};
