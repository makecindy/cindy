import assert from 'node:assert/strict';

export default {
  name: 'named-plugin-history',
  entry: './replay.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'MessageStream, local HistoryView transport adapter and controller, work groups, plugin card store and iframe.',
  notCovered: 'Model execution, plugin discovery and authorization, preview tabs, real persistence and Windows.',
  cases: {
    default: { about: 'Codex live card before the result' },
    'codex-together': { about: 'Codex result and live card in the same frame' },
    'claude-first': { about: 'Claude Code live card before the result' },
    'claude-together': { about: 'Claude Code result and live card in the same frame' },
    completed: { about: 'Open completed named card history directly' },
    legacy: { about: 'Legacy ghost_call live card' },
    pi: { about: 'Pi named card with its result already in history' },
  },
  async ready(page) {
    await page.locator('[data-replay-ready]').waitFor();
  },
  async check(page, ui) {
    const card = page.frameLocator('iframe[sandbox="allow-same-origin"]').getByText('startup-ping-ok');
    const readChanges = () => page.evaluate(() => Number(document.documentElement.dataset.replayExpansionChanges ?? 0));
    if (!['legacy', 'completed', 'pi'].includes(ui.case)) {
      await page.locator('html[data-replay-preview="loaded"]').waitFor();
    }
    const before = await readChanges();
    if (await page.getByRole('button', { name: 'Deliver fixture frame' }).count()) {
      await page.getByRole('button', { name: 'Deliver fixture frame' }).click();
    }
    await card.waitFor({timeout: 3000});
    if (await page.getByRole('button', { name: 'Deliver result' }).count()) {
      await page.getByRole('button', { name: 'Deliver result' }).click();
      await card.waitFor({timeout: 3000});
    }
    const changes = await readChanges() - before;
    assert.ok(changes <= 4, `Expected bounded preview registration, observed ${changes} changes`);
  },
};
