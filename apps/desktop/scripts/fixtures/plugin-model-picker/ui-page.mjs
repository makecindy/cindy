export default {
  name: 'plugin-model-picker',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 760 },
  real: 'PluginModelPickerDialog, ConfirmDialog, ModelSelectorContent and the unified model panel',
  notCovered:
    'Plugin transport, real provider entitlement, account changes, mobile native controls and paid inference',
  cases: {
    default: { about: 'Plugin picker with a complete initial configuration' },
    'plugin-config': { about: 'Plugin picker with a complete initial configuration' },
    'plugin-narrow': {
      about: 'Plugin picker in a narrow viewport',
      viewport: { width: 360, height: 740 },
    },
  },
  async check(page, ui) {
    await page.getByRole('alertdialog').waitFor();
    await page
      .getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') })
      .waitFor();
    await page.getByText('Demo Model').first().waitFor();
    await ui.capture('picker');
  },
};
