export default {
  name: 'plugin-engines',
  entry: './fixture.tsx',
  viewport: { width: 560, height: 640 },
  real: 'ModelSelectorContent, ModelSelector trigger, PluginEnginesSection (available, unknown and unavailable engines) and the plugin-engine task panel',
  notCovered:
    'Engine processes, ACP sessions, task creation and sending, the composer around the picker, sidebar task icons and permission selector',
  cases: {
    default: { about: 'New-task picker with three engines: available (no models yet), unknown (models known) and unavailable with an install hint' },
    'draft-selected': { about: 'An engine model is the draft choice: its row carries the selected fill, no built-in model row is selected' },
    'effort-config': { about: 'A plugin engine model with reasoning levels: level at the row end and its configuration flyout with the level slider' },
    'agent-modes': { about: 'Permission menu of an engine whose agent publishes its own modes: the agent modes in its order, then Full access', viewport: { width: 560, height: 640 } },
    'task-icons': { about: 'Sidebar task identity: the plugin icon takes the row colour (idle grey, selected, running orange) next to a built-in mark', viewport: { width: 320, height: 200 } },
    task: { about: 'Task running on a plugin engine: trigger shows engine · model · level; the panel lists only that engine' },
    'task-engine-gone': { about: 'The plugin providing the task engine was removed: generic engine label and a notice' },
  },
  async check(page, ui) {
    if (ui.case === 'agent-modes') {
      // 2026-11-19:Agent 公布了自己的模式时，权限菜单列出这些模式并在末尾保留「全部允许」。
      await page.getByRole('button').first().click();
      const labels = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
      for (const id of labels) await page.getByText(await ui.t(`newChat.permissionSelector.modes.acp.${id}.label`), { exact: true }).last().waitFor();
      await ui.capture('menu');
      return;
    }
    if (ui.case === 'task-icons') {
      // 2026-11-19:插件图标不再显示品牌色，透明底的图标按剪影用侧栏状态色。
      await page.locator('[data-plugin-icon="silhouette"]').first().waitFor();
      if ((await page.locator('[data-task-icons] img').count()) !== 0) {
        throw new Error('plugin task icon is still drawn in its own colours');
      }
      await ui.capture('icons');
      return;
    }
    if (ui.case.startsWith('task')) {
      const trigger = page.locator('[data-plugin-engine-trigger]').locator('xpath=..');
      await trigger.waitFor();
      const text = await trigger.textContent();
      if (/Claude|Codex/.test(text ?? '')) throw new Error(`plugin engine task trigger names a built-in Harness: ${text}`);
      await ui.capture('trigger');
      await trigger.click();
      if (ui.case === 'task-engine-gone') {
        await page.locator('[data-plugin-engine-missing]').waitFor();
      } else {
        await page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') }).waitFor();
        await page.getByText('OpenCode Small').waitFor();
      }
      await ui.capture('panel');
      return;
    }
    const group = page.getByRole('group', { name: await ui.t('newChat.pluginEngines.group') });
    await group.waitFor();
    if (ui.case === 'effort-config') {
      // 2026-11-19:插件引擎模型的思考深度与内置模型同一位置、同一配置浮层。
      const row = page.locator('[data-plugin-engine-model="acp-plugin:opencode-plugin:opencode#oc-large"]').first();
      await row.scrollIntoViewIfNeeded();
      if ((await row.locator('[data-plugin-engine-effort]').getAttribute('data-plugin-engine-effort')) !== 'max') {
        throw new Error('plugin engine row does not show the chosen level');
      }
      await row.hover();
      await row.locator('[data-row-customize]').click();
      await page.locator('[data-plugin-engine-config] [role="slider"]').waitFor();
      await ui.capture('effort-flyout');
      return;
    }
    await page.locator('[data-plugin-engine-unavailable]').waitFor();
    const disabled = page.locator('[data-plugin-engine-model^="acp-plugin:gemini-plugin:gemini#"]');
    if ((await disabled.getAttribute('aria-disabled')) !== 'true') {
      throw new Error('unavailable plugin engine row is selectable');
    }
    await group.scrollIntoViewIfNeeded();
    await ui.capture('engines');
    // 每个引擎在左侧栏单独一格(插件图标)：停在供应商格时也能直达，只列这个引擎。
    const tab = page.getByRole('button', { name: 'DeepSeek Harness', exact: true });
    if ((await tab.locator('img').count()) !== 1) throw new Error('engine rail tab does not show the plugin icon');
    await tab.click();
    if ((await tab.getAttribute('aria-pressed')) !== 'true') throw new Error('engine rail tab did not activate');
    const list = page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') });
    if ((await list.getByText('Opus 5').count()) !== 0) throw new Error('engine tab still lists built-in models');
    if ((await list.getByText('OpenCode Large').count()) !== 0) throw new Error('engine tab lists another engine');
    await ui.capture('engines-tab');
  },
};
