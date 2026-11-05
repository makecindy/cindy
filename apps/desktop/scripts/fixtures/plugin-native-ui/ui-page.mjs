import assert from 'node:assert/strict';
export default {
  name: 'plugin-native-ui', entry: './native-ui-fixture.tsx', viewport: { width: 560, height: 400 },
  real: 'PluginUiStatusBar and its adapter/hook; PluginUiControls, plugin page Popover, visibility projection, PluginUiRendererView, MessageActionBar, command shortcuts, ChatBubble and the production appearance consumer with theme tokens',
  notCovered: 'Named views use the real TabBar and registered titles, with placeholder page bodies; authored HTML/bridge behavior has separate tests. Real WebView, installation, IPC, popout and file font decoding are not covered; statusbar neighbours are fixture content and remote/mobile flows stay outside this fixture',
  cases: {
    'header-actions': { about: '顶部插件操作、页面入口和更多按钮沿用原生轻量样式；等待动作时保留按钮文字' },
    'tab-views': { about: '两个命名视图使用真实页签标题与关闭控件；作者页面显示定位并保留各自的交互' },
    statusbar: { about: '插件内容直接出现在现有底栏行，点击更新，移除后高度与原生内容位置保持' },
    'statusbar-long': { about: '长底栏内容在剩余空间内截断，不另起一行或挤出原生信息' },
    visibility: { about: '隐藏工作区时侧栏隐藏、插件 Popover 关闭，壁纸保留；恢复后可重新打开示例' },
    'visibility-critical': { about: '工作区隐藏仍保留必要权限提示，普通插件弹层隐藏' },
    appearance: { about: '原消息组件消费外观字段；深浅色和窄屏保持可读' },
    'shortcut-trigger': { about: '真实按键只调用焦点所在消息的插件命令' },
    'command-menu': { about: '插件命令进入现有消息菜单并保持原调用绑定' },
    'renderer-body': { about: '插件展示与原文切换，原文始终可查看' },
    default: { about: '选择格式并点击按钮，只触发明确的本地交互' },
    pending: { about: '等待动作回执时控件禁用，已选值保持可读' },
    disabled: { about: '不可用状态保留内容并禁用操作' },
    long: { about: '长名称与窄屏布局能够换行且不横向溢出' },
    fallback: { about: '不支持交互时保留可读说明' },
  },
  async check(page, ui) {
    if (ui.case === 'header-actions') {
      const action = page.getByRole('button', { name: '插件操作', exact: true });
      const native = page.getByRole('button', { name: '原生操作', exact: true });
      await action.waitFor();
      const face = button => button.evaluate(node => {
        const style = getComputedStyle(node, '::before');
        return { background: style.backgroundColor, border: style.borderColor, height: node.getBoundingClientRect().height };
      });
      for (const name of ['插件操作', '插件页面', await ui.t('pluginUi.more')]) {
        assert.deepEqual(await face(page.getByRole('button', { name, exact: true })), await face(native));
      }
      await ui.capture('header-actions');
      await action.click();
      assert.equal(await action.isDisabled(), true);
      assert.equal(await action.evaluate(node => [...node.querySelectorAll('*')].some(child => getComputedStyle(child).opacity === '0')), false);
      await ui.capture('pending-label-preserved');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-action-complete')));
      await action.waitFor({ state: 'visible' });
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(node => node.textContent === '插件操作')?.disabled);
      await ui.capture('action-completed'); return;
    }
    if (ui.case === 'tab-views') {
      const log = page.locator('[data-view="build-log"]');
      const preview = page.locator('[data-view="result-preview"]');
      await log.getByText('构建：example-17', { exact: false }).waitFor();
      await preview.getByText('定位条目：example-17', { exact: false }).waitFor();
      await log.getByRole('button', { name: '点击示例' }).click();
      await log.getByText('此视图已点击 1 次').waitFor();
      await page.getByRole('button', { name: '定位到构建 18' }).click();
      await log.getByText('构建：example-18', { exact: false }).waitFor();
      await log.getByText('此视图已点击 1 次').waitFor();
      await preview.getByText('尚未点击').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await ui.capture('two-named-views');
      await page.locator('[data-view="build-log"]').getByRole('button', { name: await ui.t('rightSidebar.tabs.tabCloseAria'), exact: true }).click();
      assert.equal(await page.locator('[data-view="build-log"]').count(), 0);
      await preview.getByText('定位条目：example-18', { exact: false }).waitFor();
      await ui.capture('closed-independently'); return;
    }
    if (ui.case.startsWith('statusbar')) {
      const item = page.locator('[data-plugin-ui-statusbar]').getByRole('button');
      await item.waitFor();
      const row = page.locator('[data-statusbar-row]');
      const before = await row.boundingBox();
      const nativeY = await page.locator('[data-statusbar-original]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
      assert.equal(before.height, 20);
      await ui.capture('inline-statusbar');
      await item.click();
      await item.filter({ hasText: '已暂停' }).waitFor();
      assert.equal((await row.boundingBox()).height, before.height);
      await ui.capture('plugin-state-changed');
      await page.evaluate(() => {
        document.documentElement.dataset.statusbarEmpty = 'true';
        window.__uiPage.emit('statusbarChanged', { sessionId: 'task' });
      });
      await page.locator('[data-plugin-ui-statusbar]').waitFor({ state: 'detached' });
      assert.equal((await row.boundingBox()).height, before.height);
      assert.deepEqual(await page.locator('[data-statusbar-original]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y)), nativeY);
      await ui.capture('original-row-preserved');
      return;
    }
    if (ui.case.startsWith('visibility')) {
      await page.getByRole('button', { name: '打开示例弹层' }).click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-visibility-sidebar]').isVisible(), true);
      const apply = workspace => page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-visibility', {
        detail: { workspace: value, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true },
      })), workspace);
      await apply(false);
      await page.waitForFunction(() => document.documentElement.dataset.pluginUiHidden?.includes('workspace'));
      assert.equal(await page.locator('[data-visibility-sidebar]').isVisible(), false);
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-visibility-wallpaper]').isVisible(), true);
      assert.equal(await page.locator('[data-visibility-wallpaper] video').isVisible(), true);
      if (ui.case === 'visibility-critical') assert.equal(await page.locator('[data-visibility-critical]').isVisible(), true);
      await ui.capture('wallpaper-only');
      await apply(true);
      await page.waitForFunction(() => document.documentElement.dataset.pluginUiHidden === '');
      assert.equal(await page.locator('[data-visibility-sidebar]').isVisible(), true);
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: '打开示例弹层' }).click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      await ui.capture('restored');
      return;
    }
    if (ui.case === 'renderer-body') {
      await page.getByRole('button', { name: await ui.t('pluginUi.renderer') }).click();
      await page.getByRole('menuitem', { name: 'Writer · body' }).click();
      await page.getByText('Plugin display of the saved message.').waitFor();
      await page.getByText(await ui.t('chat.ghostHook.viewOriginal')).click();
      await page.getByText('Original message stays available.').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await ui.capture('renderer-and-original');
      await page.getByRole('button', { name: await ui.t('pluginUi.renderer') }).click();
      await page.getByRole('menuitem', { name: await ui.t('pluginUi.original') }).click();
      await page.getByText('Original message stays available.').waitFor();
      assert.equal(await page.getByText('Plugin display of the saved message.').count(), 0);
      return;
    }
    if (ui.case === 'command-menu') {
      await page.waitForFunction(() => Number(document.documentElement.dataset.shortcutReads ?? 0) >= 1);
      await page.getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions') }).click();
      await page.getByRole('menuitem', { name: 'Format' }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: 'Format' }).locator('img').evaluate(image => image.naturalWidth > 0), true);
      await ui.capture('command-menu');
      await page.getByRole('menuitem', { name: 'Format' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.shortcutInvoked === 'view-first');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.shortcutReleases ?? '0'), '0');
      return;
    }
    if (ui.case === 'shortcut-trigger') {
      await page.waitForFunction(() => Number(document.documentElement.dataset.shortcutReads ?? 0) >= 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const first = page.locator('[data-shortcut-target="first"]');
      await first.focus();
      await first.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, code: 'KeyJ', altKey: true, shiftKey: true,
      })));
      assert.equal(await page.evaluate(() => document.documentElement.dataset.shortcutInvoked ?? ''), '');
      await page.keyboard.press('Alt+Shift+J');
      await page.waitForFunction(() => document.documentElement.dataset.shortcutInvoked === 'view-first');
      await page.locator('[data-shortcut-target="second"]').focus();
      await page.keyboard.press('Alt+Shift+J');
      await page.waitForFunction(() => document.documentElement.dataset.shortcutInvoked === 'view-second');
      await ui.capture('shortcut-target'); return;
    }
    if (ui.case === 'appearance') {
      await page.locator('[data-appearance-ready="true"]').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await ui.capture('appearance'); return;
    }
    await ui.capture('controls');
    if (ui.case === 'fallback') { await page.getByText('The original plugin tool remains available.').waitFor(); return; }
    const picker = page.getByRole('combobox', { name: 'Output format' });
    if (ui.case === 'pending' || ui.case === 'disabled') { assert.equal(await picker.isDisabled(), true); return; }
    await picker.click(); await ui.capture('choices');
    await page.getByRole('option', { name: 'Markdown', exact: true }).click();
    await page.locator('output').getByText('markdown', { exact: true }).waitFor();
    await page.getByRole('button', { name: ui.case === 'long' ? 'Preview the current task using the selected output format' : 'Preview text', exact: true }).click();
    await page.getByText('Preview requested', { exact: true }).waitFor(); await ui.capture('changed');
  },
};
