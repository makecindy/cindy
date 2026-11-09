export default {
  name: 'plugin-model-picker',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 760 },
  real: 'PluginModelPickerDialog, PluginModelPickerPopover, ModelRouteSelectorContent and the unified model panel',
  notCovered:
    'Plugin transport, native WebView embedding, real provider entitlement, account changes, mobile and paid inference',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial:
        'export function useAuth() { return { deviceId: null, user: null, mode: "local" }; }',
    },
  },
  cases: {
    default: { about: 'Plugin picker with a complete initial configuration' },
    'plugin-config': { about: 'Plugin picker with a complete initial configuration' },
    'plugin-narrow': {
      about: 'Plugin picker in a narrow viewport',
      viewport: { width: 360, height: 740 },
    },
    'page-popover': { about: 'Plugin page button opens the real Host popover' },
    'page-popover-narrow': {
      about: 'Host popover in a narrow plugin panel',
      viewport: { width: 360, height: 740 },
    },
    'page-popover-bottom': { about: 'Bottom anchor flips within the viewport' },
  },
  async check(page, ui) {
    if (!ui.case.startsWith('page-popover')) await page.getByRole('alertdialog').waitFor();
    await page
      .getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') })
      .waitFor();
    await page.getByText('Demo Model').first().waitFor();
    await ui.capture('picker');
  },
};
