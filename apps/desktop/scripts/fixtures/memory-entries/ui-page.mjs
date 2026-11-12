import assert from 'node:assert/strict';

/** 设置 › 个性化 › 记忆的「查看记忆」子页与普通任务的保存回执（docs/product-rules/cindy-memory.md §4）。 */
export default {
  name: 'memory-entries',
  entry: './memory-entries-fixture.tsx',
  viewport: { width: 900, height: 760 },
  real: 'MemoryEntriesPanel (scope selector, off notice), MemoryEntriesView (grouped list, search, detail, editor), BotLearningFooter for ordinary tasks, Select, SettingsPageHeader, theme and translations',
  notCovered: 'Main-process memory service and scope validation (botMemoryService.test.ts), autosave and conflict handling (botMemorySettings.test.tsx), SettingsView navigation and Escape, the message stream around the receipt, Mobile',
  cases: {
    default: { about: 'Opened from a receipt on a project scope: grouped memories with previews; then one memory in full and its editor' },
    off: { about: 'Cindy memory switched off: saved memories stay readable, dimmed, with a notice' },
    empty: { about: 'About you has no memories yet' },
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
