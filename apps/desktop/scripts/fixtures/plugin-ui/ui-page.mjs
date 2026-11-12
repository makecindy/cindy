import assert from 'node:assert/strict';

export default {
  name: 'plugin-ui',
  entry: './plugin-ui-fixture.tsx',
  viewport: { width: 840, height: 680 },
  real: 'PluginUiProvider, all eight placements, real MessageActionBar and More menu, native control subscription, body selector, themed Button and Select',
  notCovered: 'Live App iframe and Main/tool approval are verified by dedicated tests; this fixture supplies only installed metadata and local IPC snapshots',
  stubs: {
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => ({}) };',
    'src/renderer/features/device-link/stickySessionOrigin': 'export const getStickySessionDeviceId = () => undefined;',
    'src/renderer/features/device-link/remoteProjectsStore': 'export const getSessionDeviceId = () => undefined; export const remoteProjectsStore = { subscribe: () => () => {} };',
  },
  cases: { default: { about: 'Original message and tool result remain readable with plugin entry points and live native status' } },
  async ready(page) { await page.getByText('示例已就绪', { exact: true }).waitFor(); },
  async check(page, ui) {
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(await page.getByRole('combobox').count(), 2);
    await page.getByRole('button', { name: '同步示例状态', exact: true }).click();
    await page.getByText('最近同步已完成', { exact: true }).waitFor();
    assert.ok(await page.getByText('原始工具结果', { exact: true }).isVisible());
    await page.getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions'), exact: true }).click();
    await page.getByRole('menuitem', { name: '打开任务页面 · 插件界面示例', exact: true }).waitFor();
    assert.ok(await page.getByRole('menuitem', { name: await ui.t('chat.quote.addToChat'), exact: true }).isVisible());
  },
};
