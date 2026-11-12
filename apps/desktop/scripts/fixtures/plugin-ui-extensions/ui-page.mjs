import assert from 'node:assert/strict';
export default {
  name: 'plugin-ui-extensions', entry: './plugin-ui-extensions-fixture.tsx',
  viewport: { width: 900, height: 650 },
  real: 'PluginUiProvider, navigation controls, collapsed sidebar sections, titlebar controls/ContentHeaderSlot, SessionTaskMenu, SettingsSidebarNav, PluginSettingsFields, completion bridge/AtMentionPanel, attachment hook and tray',
  notCovered: 'MCP App iframe, editor selection, real file handoff, installation/approval and persistence; IPC state is supplied in memory',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: null }); export const useOptionalAuthDeviceId = () => null;',
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => ({}) };',
    'src/renderer/features/device-link/stickySessionOrigin': 'export const getStickySessionDeviceId = () => undefined;',
    'src/renderer/features/device-link/remoteProjectsStore': { partial: 'export const getSessionDeviceId = () => undefined;' },
  },
  cases: {
    default: { about: 'Registered settings, plugin navigation and original Settings categories' },
    menu: { about: 'Original task menu with an approved plugin action' },
    input: { about: 'Provider completion in the real suggestion panel and processed attachment in the original tray' },
    'attachment-error': { about: 'Localized processing error keeps the original attachment' },
  },
  async ready(page) { await page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true }).waitFor(); },
  async check(page, ui) {
    assert.equal(await page.locator('iframe').count(), 0);
    assert.ok(await page.getByRole('button', { name: '打开示例工作台 · 插件界面示例', exact: true }).isVisible());
    assert.ok(await page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true }).isVisible());
    if (ui.case === 'input' || ui.case === 'attachment-error') {
      await page.getByText('示例引用：记录 · 插件界面示例', { exact: true }).waitFor();
      await page.getByRole('button', { name: '添加示例附件', exact: true }).click();
      if (ui.case === 'input') await page.getByText('prepared-notes.md', { exact: true }).waitFor();
      else {
        await page.getByText(await ui.t('pluginUi.attachmentFailed', { name: 'notes.md' }), { exact: true }).waitFor();
        assert.ok(await page.getByText('notes.md', { exact: true }).isVisible());
      }
    } else if (ui.case === 'menu') {
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
    if (ui.case !== 'menu') await page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true }).hover();
  },
};
