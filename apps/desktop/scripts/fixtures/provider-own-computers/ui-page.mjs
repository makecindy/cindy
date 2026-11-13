import assert from 'node:assert/strict';
import runLocation from '../provider-run-location/ui-page.mjs';

/** 模型供应商页只显示「我的其他电脑可用」这一个状态；开关只在「远程连接」里。 */
export default {
  name: 'provider-own-computers',
  entry: '../provider-run-location/fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection detail header subtitle with ProviderRunLocationSubtitle, translations and themes',
  notCovered: 'The 远程连接 switch itself (remote-connection-v2 covers it) and live device catalogs; settings are fixture data',
  stubs: runLocation.stubs,
  cases: {
    default: { about: 'The switch in 远程连接 is off (the default): no status' },
    'own-on': { about: 'Turned on in 远程连接: the header reads 我的其他电脑可用' },
    'own-remote-off': { about: 'Turned on, but this computer no longer allows remote control: no status' },
    'own-provider': { about: 'Switch off, but this provider was opened on its own (允许被远程调用): the status still shows' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    await page.getByTestId('provider-detail-metadata').waitFor();
    const status = page.getByTestId('provider-own-computers');
    if (ui.case === 'own-on' || ui.case === 'own-provider') await status.waitFor();
    else assert.equal(await status.count(), 0);
    await ui.capture('header');
  },
};
