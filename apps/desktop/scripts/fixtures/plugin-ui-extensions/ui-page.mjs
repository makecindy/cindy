import assert from 'node:assert/strict';
export default {
  name: 'plugin-ui-extensions', entry: './plugin-ui-extensions-fixture.tsx',
  viewport: { width: 900, height: 650 },
  real: 'PluginUiProvider, native navigation controls, SessionTaskMenu, SettingsSidebarNav, PluginSettingsFields',
  notCovered: 'MCP App iframe, real installation/approval and persistence; IPC state is supplied in memory',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: null });',
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => ({}) };',
    'src/renderer/features/device-link/stickySessionOrigin': 'export const getStickySessionDeviceId = () => undefined;',
    'src/renderer/features/device-link/remoteProjectsStore': { partial: 'export const getSessionDeviceId = () => undefined;' },
  },
  cases: {
    default: { about: 'Registered settings, plugin navigation and original Settings categories' },
    menu: { about: 'Original task menu with an approved plugin action' },
  },
  async ready(page) { await page.getByRole('spinbutton', { name: '显示条数' }).waitFor(); },
  async check(page, ui) {
    assert.equal(await page.locator('iframe').count(), 0);
    if (ui.case === 'menu') {
      await page.getByRole('button', { name: '任务操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '打开任务工作台 · 插件界面示例', exact: true }).waitFor();
      assert.ok(await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.rename'), exact: true }).isVisible());
    } else {
      const size = page.getByRole('spinbutton', { name: '显示条数' });
      await size.fill('12');
      await page.getByRole('button', { name: await ui.t('pluginUi.save'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true }).waitFor({ state: 'visible' });
      assert.equal(await size.inputValue(), '12');
    }
  },
};
