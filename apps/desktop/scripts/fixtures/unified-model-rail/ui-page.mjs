const customIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>circle{fill:#a02040}@media(prefers-color-scheme:dark){circle{fill:#ffcc44}}</style><circle cx="8" cy="8" r="7"/></svg>';

export default {
  name: 'unified-model-rail',
  entry: './unified-model-rail-fixture.tsx',
  viewport: { width: 780, height: 640 },
  real: 'ModelSelectorContent, UnifiedModelRail, unified list sections, recents/favorites state, themes and translations',
  notCovered: 'Account entitlement, live model calls, database persistence and native mobile controls',
  cases: {
    'uploaded-icon': { about: 'Uploaded SVG palette follows the selected source background and the idle theme', data: { customIcon } },
    default: { about: '「全部」视图:联合列表 + 侧栏 rail 全格' },
    'custom-ids': { about: '#10253: custom models with near-identical names and long IDs differing only at the end' },
    'custom-ids-legacy': { about: '#10253: the same custom IDs in the single-engine provider list' },
    recent: { about: '「最近」视图:三态 Fast 载体(`ultrafast`/`true`)的条目后缀原样保留' },
    'share-favorite-recovery': { about: 'The production picker hides a shared favorite on temporary unavailability and shows it again after recovery' },
    'cindy-personal': { about: 'Personal Cindy AI source identity in the real model selector' },
    'cindy-xd': { about: 'XD Cindy AI source identity beside the unchanged Auto model' },
    'cindy-organization': { about: 'Long organization name in the real provider rail' },
  },
  async check(page, ui) {
    await page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') }).waitFor();
    if (ui.case === 'uploaded-icon') {
      // E2E: the picker previously left an uploaded SVG in the page palette on selection.
      // Existing rail checks use built-in marks. Sample the painted SVG after real clicks.
      const { default: sharp } = await import('sharp');
      const source = page.locator('[data-rail-item="provider:anthropic"]');
      const icon = source.locator('img');
      const expectPalette = async (scheme) => {
        const image = sharp(await icon.screenshot()).removeAlpha();
        const { width, height } = await image.metadata();
        const pixel = await image.extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 }).raw().toBuffer();
        const expected = Buffer.from(scheme === 'dark' ? 'ffcc44' : 'a02040', 'hex');
        if (pixel.some((channel, i) => Math.abs(channel - expected[i]) > 1)) {
          throw new Error(`Expected ${scheme} SVG pixel #${expected.toString('hex')}, got #${pixel.toString('hex')}`);
        }
      };
      await source.click();
      await expectPalette(ui.theme === 'dark' ? 'light' : 'dark');
      await page.locator('[data-rail-item="provider:openai"]').click();
      await expectPalette(ui.theme);
      // A translucent accent leaves the selected surface in the page's own scheme.
      await page.evaluate(() => document.documentElement.style.setProperty(
        '--accent-cta-bg', 'light-dark(rgb(0 0 0 / 8%), rgb(255 255 255 / 8%))',
      ));
      await source.click();
      await expectPalette(ui.theme);
      return;
    }
    if (ui.case === 'share-favorite-recovery') {
      await page.locator('[data-rail-item="favorites"]').click();
      const favorite = page.getByRole('option').filter({ hasText: 'Opus 5' });
      await favorite.waitFor();
      await page.evaluate(() => window.setFixtureShareVisible(false));
      await favorite.waitFor({ state: 'hidden' });
      await page.evaluate(() => window.setFixtureShareVisible(true));
      await favorite.waitFor();
      await ui.capture('favorite-restored');
      return;
    }
    if (ui.case.startsWith('custom-ids')) {
      // Wait for the same rows on both sides of --compare; the old version has no ID text.
      await page.getByText('DeepSeek-V4.1-Flash', { exact: true }).waitFor();
      await page.getByText('DeepSeek V4.1 Flash', { exact: true }).waitFor();
      await ui.capture('custom-model-identities');
      return;
    }
    if (ui.case.startsWith('cindy-')) {
      const suffix = ui.case === 'cindy-personal' ? await ui.t('settings.providers.xd.personal')
        : ui.case === 'cindy-xd' ? await ui.t('settings.providers.xd.xdOrganization') : 'Example International Game Studio';
      await page.getByRole('button', { name: `Cindy AI · ${suffix}`, exact: true }).click();
      await page.getByText('Auto', { exact: true }).first().waitFor();
      await ui.capture('cindy-account-models');
      return;
    }
    if (ui.case === 'default') {
      await ui.capture('all-view');
      return;
    }
    // 切到「最近」格:三条最近使用,其中 GPT-5.6(codex) 带 Ultrafast、GPT-5.6(cc) 带 Fast。
    await page.getByRole('button', { name: await ui.t('newChat.modelSelector.unified.railRecent'), exact: true }).click();
    await page.getByText('GPT-5.6').first().waitFor();
    // 分别断言两种速度的三元组后缀(速度只存在 title="引擎 · 档位 · 速度" 里,
    // SpeedIcon 是纯图形):用 ui.t 取当前 locale 文案,$= 结尾匹配不会让「快速」误中「超快」。
    await page.locator(`[data-unified-triple][title$=" · ${await ui.t('newChat.modelSelector.speed.ultrafast')}"]`).waitFor();
    await page.locator(`[data-unified-triple][title$=" · ${await ui.t('newChat.modelSelector.speed.fast')}"]`).waitFor();
    await ui.capture('recent-view');
  },
};
