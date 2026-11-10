import assert from 'node:assert/strict';

/** 设置 › 个性化 › 记忆的「查看记忆」子页与普通任务的保存回执（docs/product-rules/cindy-memory.md §4）。 */
export default {
  name: 'memory-entries',
  entry: './memory-entries-fixture.tsx',
  viewport: { width: 900, height: 760 },
  real: 'MemoryEntriesPanel (scope selector, off notice), MemoryTidyCard (tidy action, its unavailable states, tidy history), MemoryEntriesView (grouped list, search, detail, editor), BotLearningFooter for ordinary tasks, Select, SettingsCard / SettingsRow, Collapse, SettingsPageHeader, theme and translations',
  notCovered: 'Running a tidy-up and undoing one (progress, toasts, confirm dialog, refresh; botMemorySettings.test.tsx), main-process memory service and scope validation (botMemoryService.test.ts), autosave and conflict handling (botMemorySettings.test.tsx), SettingsView navigation and Escape, the message stream around the receipt, Mobile',
  cases: {
    default: { about: 'Opened from a receipt on a project scope: grouped memories with previews; then one memory in full and its editor' },
    off: { about: 'Cindy memory switched off: saved memories stay readable, dimmed, with a notice' },
    empty: { about: 'About you has no memories yet' },
    records: { about: 'Tidy history expanded: an automatic run with a merge and a removal, and a manual run that was undone', viewport: { width: 900, height: 1080 } },
    receipt: { about: 'The note under an ordinary task reply: clickable on this computer, plain text for a task on another computer', viewport: { width: 720, height: 320 } },
  },
  async ready(page) {
    await page.getByRole('combobox').or(page.locator('[data-bot-learning-footer]')).first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'receipt') {
      assert.equal(await page.locator('[data-bot-learning-footer] button').count(), 1, 'only the local task receipt is clickable');
      return;
    }
    if (ui.case === 'records') {
      await page.getByRole('button', { name: await ui.t('settings.memory.entries.tidy.records') }).click();
      const history = page.getByRole('list', { name: await ui.t('settings.memory.entries.tidy.records') });
      // 每条记录一个展开按钮；已撤销的那条没有「撤销」按钮。
      const toggles = history.locator('button[aria-expanded]');
      await toggles.nth(1).waitFor();
      for (const toggle of await toggles.all()) await toggle.click();
      await history.getByText(/Release train leaves on Wednesday/).waitFor();
      assert.equal(await history.getByRole('button', { name: await ui.t('settings.memory.entries.tidy.undo') }).count(), 1, 'only the run that is not undone can be undone');
      return;
    }
    if (ui.case !== 'default') return;
    await page.getByRole('combobox').click();
    await page.getByRole('option').first().waitFor();
    await ui.capture('scopes');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /pnpm/ }).click();
    await page.getByRole('button', { name: await ui.t('bots.memory.edit'), exact: true }).waitFor();
    await ui.capture('detail');
    await page.getByRole('button', { name: await ui.t('bots.memory.edit'), exact: true }).click();
    await page.getByRole('button', { name: await ui.t('bots.memory.done'), exact: true }).waitFor();
  },
};
