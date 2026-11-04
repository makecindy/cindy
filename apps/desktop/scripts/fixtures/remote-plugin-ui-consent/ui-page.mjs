import assert from 'node:assert/strict';
export default {
  name: 'remote-plugin-ui-consent', entry: '../mcp-app-approval/remote.tsx', viewport: { width: 560, height: 650 },
  real: 'RemotePluginUiEnablePrompt, GhostInstallConsentContent, ghostPermissionItems, confirmation Sheet and themed controls',
  notCovered: 'Device-link network, owner and receipt validation are covered by production transaction unit tests; this fixture supplies an online device and receipt.',
  stubs: {
    'src/renderer/features/plugin/PluginDevicePicker': "export const usePluginDeviceDirectory = () => ({ online: true, target: { name: '执行电脑' } });",
    'src/renderer/features/plugin/remotePluginManagementClient': '../mcp-app-approval/remote-client.ts',
  },
  cases: { default: { about: 'Remote confirmation lists pages, domains and app tools' }, narrow: { about: 'Same facts readable at 360 px', viewport: { width: 360, height: 650 } } },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('newChat.pluginUi.enable'), exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    for (const text of ['planner', 'planner.example', 'refresh_metrics', 'save_plan']) assert.ok((await dialog.innerText()).includes(text));
    await ui.capture('confirmation');
    await dialog.getByRole('button', { name: await ui.t('newChat.pluginUi.enable'), exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  },
};
