export default {
  name: 'model-protocol-paths', entry: './model-protocol-paths-fixture.tsx',
  viewport: { width: 1000, height: 800 },
  real: 'ModelAdvancedDrawer engine rows, modelProtocolComparison paths, recommended engine, interface menu, themes and translations',
  notCovered: 'Saving an interface choice, live catalog delivery and real requests; interface lists and recommendations are fixture inputs',
  cases: {
    default: { about: 'DeepSeek official: three direct APIs, Pi recommended (community default)' },
    'cindy-deepseek': { about: 'Cindy AI DeepSeek: the gateway offers three APIs, every engine is direct' },
    'cindy-gemini': { about: 'Cindy AI Gemini: four APIs including Google, Pi recommended' },
    chatgpt: { about: 'ChatGPT subscription: Claude Code uses local compatibility mode' },
    narrow: { about: 'ChatGPT subscription at phone width: compatibility mode on its own line', viewport: { width: 320, height: 800 } },
  },
  async check(page, ui) {
    await page.getByText('Claude Code', { exact: true }).first().waitFor();
    await ui.capture('initial');
    if (await page.locator('[data-interface-trigger], [aria-haspopup="menu"][aria-label*="Pi ·"]').count())
      throw Error('Catalog sources must not offer interface switching');
    const compat = page.locator('[data-compatibility-notice]');
    if (await compat.count()) {
      await compat.first().click();
      await page.getByRole('tooltip').first().waitFor();
      await ui.capture('compatibility-hint');
    }
    const help = page.getByRole('button', { name: await ui.t('settings.providers.models.advanced.enginesHint'), exact: true });
    await help.hover();
    await page.getByRole('tooltip').first().waitFor();
    await ui.capture('engines-hint');
  },
};
