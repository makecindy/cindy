export default {
  name: 'model-categories',
  entry: './model-categories-fixture.tsx',
  viewport: { width: 760, height: 900 },
  real: 'UnifiedModelList, shared mode classification, management filters/groups and localized labels',
  notCovered: 'Live catalog delivery and Decisions API execution; all six models are fixture data',
  cases: { default: { about: 'Decision, OCR and image editing alongside image, video and speech models' } },
  async check(page, ui) {
    for (const name of ['Jev', 'Document OCR', 'Image Editor', 'Seedream']) {
      await page.getByText(name, { exact: true }).first().waitFor();
    }
    await ui.capture('categories');
  },
};
