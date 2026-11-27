export default {
  name: 'model-categories',
  entry: './model-categories-fixture.tsx',
  viewport: { width: 760, height: 900 },
  real: 'UnifiedModelList, shared mode classification, management filters/groups and localized labels',
  notCovered: 'Live catalog delivery and Decisions API execution; all seven models are fixture data',
  cases: {
    default: { about: 'Decision, rerank, OCR and image editing alongside image, video and speech models' },
    'two-axes': { about: 'Chat models have a picker-visibility switch and a 已隐藏 group; function-type models have one enable switch and stay in place when off' },
  },
  async check(page, ui) {
    for (const name of ['Jev', 'Reranker', 'Document OCR', 'Image Editor', 'Seedream']) {
      await page.getByText(name, { exact: true }).first().waitFor();
    }
    for (const name of ['Jev', 'Reranker']) {
      const toggle = page.getByRole('switch', { name, exact: true });
      await toggle.waitFor();
      if (!await toggle.isEnabled()) throw new Error(`${name} switch is unavailable`);
      const before = await toggle.getAttribute('aria-checked');
      for (const checked of [before === 'true' ? 'false' : 'true', before]) {
        await toggle.click();
        await page.waitForFunction(({ name, checked }) =>
          Array.from(document.querySelectorAll('[role="switch"]')).find(node =>
            node.getAttribute('aria-label') === name)?.getAttribute('aria-checked') === checked,
        { name, checked });
      }
    }
    if (ui.case === 'two-axes') {
      // Turning a function-type model off keeps its row in the same group, switch off.
      const reranker = page.getByRole('switch', { name: 'Reranker', exact: true });
      await reranker.click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="switch"]'))
        .find(node => node.getAttribute('aria-label') === 'Reranker')?.getAttribute('aria-checked') === 'false');
      await page.getByText(await ui.t('settings.providers.models.hiddenGroup'), { exact: true }).waitFor();
      await ui.capture('two-axes');
      return;
    }
    await ui.capture('categories');
  },
};
