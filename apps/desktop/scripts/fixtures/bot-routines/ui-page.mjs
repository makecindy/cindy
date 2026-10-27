import assert from 'node:assert/strict';
export default {
  name: 'bot-routines', entry: './routines-fixture.tsx',
  viewport: { width: 440, height: 900 },
  real: 'BotRoutines list/editor, BotAutonomySettings, cronToHuman and standard switches',
  notCovered: 'Host persistence, real scheduler execution, plugin events, routine model picker and native Mobile (no routine management entry)',
  stubs: {
    'src/renderer/features/bots/botStore': { partial: 'export const useBotProfiles=()=>[];' },
    // The model picker needs signed-in model access; its own page covers it.
    'src/renderer/features/bots/BotTaskModelEditor': 'export function BotTaskModelEditor(){return null;}',
  },
  cases: {
    default: { about: 'Paused, enabled, queued, running; exact hourly and selected-hour schedules; independent follow-up scope' },
    'save-error': { about: 'Failed pause keeps the enabled switch; retry saves without running' },
    history: { about: 'Failure result is readable before expanding run details' },
    'session-mode': { about: 'Run session choice: persistent context or a new isolated session per trigger' },
  },
  async ready(page) { await page.getByRole('button', { name: /Daily project summary/ }).waitFor(); },
  async check(page, ui) {
    const toggle = page.getByRole('switch', { name: 'Daily project summary', exact: true });
    if (ui.case === 'history') {
      await page.getByRole('button', { name: 'Daily project summary', exact: true }).click();
      await page.getByText(await ui.t('routines.status.failed'), { exact: true }).waitFor();
      await ui.capture('failed-run');
      return;
    }
    if (ui.case === 'session-mode') {
      await page.getByRole('button', { name: 'Daily project summary', exact: true }).click();
      const mode = page.getByRole('combobox', { name: await ui.t('routines.sessionMode') });
      await mode.click();
      const fresh = page.getByRole('option', { name: await ui.t('routines.sessionModeFresh') });
      await fresh.waitFor();
      await ui.capture('session-mode-open');
      await fresh.click();
      assert.equal((await mode.textContent())?.includes(await ui.t('routines.sessionModeFresh')), true);
      await ui.capture('session-mode-fresh');
      return;
    }
    await toggle.click();
    if (ui.case === 'save-error') {
      await page.getByRole('alert').waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await ui.capture('save-failed');
      await toggle.click();
    }
    await page.getByRole('switch', { name: 'Daily project summary', exact: true }).and(page.locator('[aria-checked="false"]')).waitFor();
    assert.equal(await page.getByLabel(await ui.t('routines.instructions')).count(), 0);
    await page.locator('details > summary').first().click();
    await ui.capture('paused-expanded');
  },
};
