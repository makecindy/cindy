import assert from 'node:assert/strict';

export default {
  name: 'settings-conversation',
  entry: './settings-conversation-fixture.tsx',
  viewport: { width: 320, height: 500 },
  real: 'SettingsConversationButton, SettingsSidebarNav, Button, Tip and theme tokens',
  notCovered: 'Full SettingsView, native window creation, actual task contents and remote device connection',
  stubs: {
    'src/renderer/features/bots/useRemoteBots':
      'export const useRemoteBots = () => [];',
    'src/renderer/components/settings/settingsSearchCatalog':
      'export const buildSettingsSearchDocuments = () => []; export const searchSettings = () => [];',
    'src/renderer/features/device-link/stickySessionOrigin':
      'export const getStickySessionDeviceId = () => undefined;',
  },
  cases: { default: { about: 'Conversation reference action in the settings navigation column', data: {} } },
  async check(page, ui) {
    const button = page.getByRole('button', { name: await ui.t('settings.conversation.open'), exact: true });
    await button.hover();
    await page.getByRole('tooltip').waitFor();
    await ui.capture('hint');
    await button.click();
    assert.equal(await page.getByRole('tab', { name: await ui.t('settings.tabs.providers'), exact: true }).getAttribute('aria-selected'), 'true');
  },
};
