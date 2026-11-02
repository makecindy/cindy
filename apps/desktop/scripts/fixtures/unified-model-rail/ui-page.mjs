export default {
  name: 'unified-model-rail',
  entry: './unified-model-rail-fixture.tsx',
  viewport: { width: 780, height: 640 },
  real: 'ModelSelectorContent, UnifiedModelRail, unified list sections, recents/favorites state, themes and translations',
  notCovered: 'Account entitlement, live model calls, database persistence and native mobile controls',
  cases: {
    default: { about: '「全部」视图:联合列表 + 侧栏 rail 全格' },
    recent: { about: '「最近」视图:三态 Fast 载体(`ultrafast`/`true`)的条目后缀原样保留' },
    'cindy-personal': { about: 'Personal Cindy AI source identity in the real model selector' },
    'cindy-xd': { about: 'XD Cindy AI source identity beside the unchanged Auto model' },
    'cindy-organization': { about: 'Long organization name in the real provider rail' },
  },
  async check(page, ui) {
    await page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') }).waitFor();
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
