import assert from 'node:assert/strict';

async function checkSidebarSection(page, ui) {
  await page.emulateMedia({ colorScheme: ui.theme, reducedMotion: 'no-preference' });
  const toggle = page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true });
  const following = page.getByRole('button', { name: '任务操作', exact: true });
  const frame = page.locator('aside iframe');
  const panel = page.locator('aside dialog');
  const spinner = panel.locator('.lucide-loader-circle');
  const followingY = async () => (await following.boundingBox()).y;
  const closedY = await followingY();
  const loading = await toggle.evaluate(element => new Promise(resolve => {
    let before;
    const sample = () => {
      const dialog = element.nextElementSibling.querySelector('dialog');
      if (dialog?.querySelector('iframe')) {
        const height = dialog.getBoundingClientRect().height;
        if (dialog.querySelector('.lucide-loader-circle')) {
          resolve({ before, height });
          return;
        }
        before = height;
      }
      requestAnimationFrame(sample);
    };
    element.click();
    requestAnimationFrame(sample);
  }));
  assert.ok(loading.before > 0 && loading.before < 80, 'Cold open should reserve a compact loading area before showing the spinner');
  assert.equal(loading.height, loading.before, 'Showing the spinner must not grow the panel');
  await ui.capture('sidebar-loading');

  const notifyApp = (method, params) => frame.evaluate((element, { method, params }) => {
    window.dispatchEvent(new MessageEvent('message', {
      source: element.contentWindow,
      data: { jsonrpc: '2.0', method: `ui/notifications/${method}`, params },
    }));
  }, { method, params });
  const reportHeight = (height) => notifyApp('size-changed', { height });
  await reportHeight(100);
  await notifyApp('initialized');
  await spinner.waitFor({ state: 'detached' });
  assert.equal(await panel.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return element.getBoundingClientRect().height;
  }), loading.before,
    'An early size should settle through the existing fallback without expanding to 320px first');
  await page.waitForFunction(() => document.querySelector('aside dialog')?.getBoundingClientRect().height === 100);
  const at100 = await followingY();
  await reportHeight(132);
  const frames = await following.evaluate(element => new Promise(resolve => {
    const samples = [];
    const start = performance.now();
    const measure = () => {
      samples.push(element.getBoundingClientRect().y);
      if (performance.now() - start < 350) requestAnimationFrame(measure);
      else resolve(samples);
    };
    requestAnimationFrame(measure);
  }));
  assert.ok(Math.abs(frames.at(-1) - at100 - 32) < 1, 'The following row should move by one row height');
  assert.ok(frames.some(y => y > at100 && y < at100 + 32), 'Content height should pass through intermediate frames');
  await ui.capture('sidebar-expanded');

  const collapse = await toggle.evaluate(element => new Promise(resolve => {
    element.click();
    requestAnimationFrame(() => {
      const collapsing = element.nextElementSibling;
      resolve({
        frameKept: Boolean(collapsing.querySelector('iframe')),
        height: collapsing.getBoundingClientRect().height,
        inert: collapsing.inert,
      });
    });
  }));
  assert.ok(collapse.frameKept && collapse.height > 0 && collapse.inert, 'The closing section should retain the iframe without accepting interaction');
  await frame.waitFor({ state: 'detached' });
  assert.equal(await followingY(), closedY);
  await toggle.click();
  await frame.waitFor({ state: 'attached' });
  assert.equal(await panel.evaluate(element => element.getBoundingClientRect().height), 132);
  await spinner.waitFor();
  await notifyApp('initialized');
  await reportHeight(132);
  await spinner.waitFor({ state: 'detached' });
  assert.equal(await panel.evaluate(element => element.getBoundingClientRect().height), 132);
}

export default {
  name: 'plugin-ui-extensions', entry: './plugin-ui-extensions-fixture.tsx',
  viewport: { width: 900, height: 650 },
  real: 'PluginUiProvider, navigation controls, collapsible plugin sections, McpAppCard, titlebar controls/ContentHeaderSlot, SessionTaskMenu, SettingsSidebarNav, PluginSettingsFields, completion bridge/AtMentionPanel, attachment hook and tray',
  notCovered: 'Live MCP App sandbox transport, editor selection, real file handoff, installation/approval and persistence; IPC state is supplied in memory',
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
    'sidebar-section': { about: 'Slow sidebar App, animated resizing and collapse, and in-memory height reuse' },
  },
  async ready(page) { await page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true }).waitFor(); },
  async check(page, ui) {
    assert.equal(await page.locator('iframe').count(), 0);
    assert.ok(await page.getByRole('button', { name: '打开示例工作台 · 插件界面示例', exact: true }).isVisible());
    assert.ok(await page.getByRole('button', { name: '示例摘要 · 插件界面示例', exact: true }).isVisible());
    if (ui.case === 'sidebar-section') return checkSidebarSection(page, ui);
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
