import assert from 'node:assert/strict';
export default {
  name: 'bot-capabilities', entry: './capabilities-fixture.tsx', viewport: { width: 640, height: 1400 },
  real: 'BotCapabilitySettings groups (core, system, learned, local skills, built-in tools, MCP, permissions), folding, BotSkillPage core/system/learned pages and standard switches',
  notCovered: 'Teammate runtime, prompt and tool gating, persistence, remote computers and the phone page; covered by vitest and the isolated Desktop.',
  cases: {
    default: { about: 'All groups with the owner’s real skills and tools; unfold the local skills' },
    'system-off': { about: 'Todos turned off: the switch and the group count follow' },
    core: { about: 'Core skill page with the plain-language summary and the original text' },
    system: { about: 'A system skill page explains what turning it off stops' },
    learned: { about: 'A learned skill page with its switch, content, edit and delete' },
    empty: { about: 'No learned skills yet' },
  },
  async ready(page) { await page.getByRole('switch').first().waitFor(); },
  async check(page, ui) {
    if (ui.case === 'default') {
      await page.getByRole('button', { name: await ui.t('bots.capabilities.showRest', { count: 8 }) }).first().click();
      await page.getByRole('switch', { name: 'x-ops' }).waitFor();
      await ui.capture('unfolded');
    }
    if (ui.case === 'core' || ui.case === 'system' || ui.case === 'learned') {
      const name = ui.case === 'core' ? await ui.t('bots.capabilities.core.name')
        : ui.case === 'system' ? await ui.t('bots.capabilities.system.items.todo.name') : 'review-personal-memory';
      await page.getByRole('button', { name: new RegExp(name) }).first().click();
      if (ui.case === 'core') {
        await page.getByText(await ui.t('bots.capabilities.core.raw')).click();
        await page.getByText('teammate-guide', { exact: false }).first().waitFor();
      }
      if (ui.case === 'learned') await page.getByRole('button', { name: await ui.t('bots.capabilities.learned.edit') }).waitFor();
      await ui.capture('page');
    }
    if (ui.case === 'system-off') {
      const todo = page.getByRole('switch', { name: await ui.t('bots.capabilities.system.items.todo.name') });
      assert.equal(await todo.getAttribute('aria-checked'), 'false');
    }
  },
};
