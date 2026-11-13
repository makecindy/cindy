import assert from 'node:assert/strict';

export default {
  name: 'task-runtime-plugins',
  entry: './fixture.tsx',
  viewport: { width: 520, height: 620 },
  real: 'SessionTaskMenu, TaskRuntimePluginsDialog and the installed-plugin window snapshot',
  notCovered: 'Main-process settings persistence, account switching, real plugins and the surrounding task list; scene data only',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export function useAuth() { return { dataOwnerId: "fixture-owner", isAuthenticated: true }; }',
    },
  },
  cases: {
    default: { about: 'No relevant plugin: original task menu without a task-plugins entry' },
    'one-control': { about: 'A context provider: only its nonempty group is shown' },
    'removed-selection': { about: 'An uninstalled selected provider remains visible and clearable' },
  },
  async check(page, ui) {
    const entry = page.getByRole('menuitem', { name: await ui.t('runtimePlugins.title'), exact: true });
    if (ui.case === 'default') {
      assert.equal(await entry.count(), 0);
      return;
    }
    await entry.click();
    await page.getByRole('dialog').waitFor();
    const label = ui.case === 'removed-selection'
      ? await ui.t('scheduler.editor.preRunPlugin.unavailable') : 'Context fixture plugin';
    const checkbox = page.getByRole('checkbox', { name: label, exact: true });
    await checkbox.waitFor();
    assert.equal(await page.getByRole('group').count(), 1);
    assert.equal(await checkbox.isChecked(), ui.case === 'removed-selection');
  },
};
