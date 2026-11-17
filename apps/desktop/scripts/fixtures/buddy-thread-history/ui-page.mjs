import assert from 'node:assert/strict';

export default {
  name: 'buddy-thread-history',
  entry: './fixture.tsx',
  viewport: { width: 620, height: 700 },
  real: 'BotLifecycleSettings, settings section/card/row, botRouteForOwnedSession, themes and translations',
  notCovered: 'Database startup, root-message preview/menu, task transcript/runtime, remote/mobile transport and model sends. Saved profile is synthetic JSON; navigation uses the original linked task ID.',
  stubs: {
    'src/renderer/features/bots/BotDeleteDialog': 'export const BotDeleteDialog=()=>null;',
    'src/renderer/features/bots/useBotSettingsTarget': `export const useBotSettingsTarget=()=>({kind:'local',history:{search:()=>{throw new Error('No search in this scenario')}}});`,
  },
  cases: { default: { about: '#10873: recover old-root, current-root and unresolved-root topics from a cold profile projection' } },
  async ready(page) {
    await page.getByRole('button', { name: /Launch plan/ }).waitFor();
  },
  async check(page, ui) {
    await page.getByRole('button', { name: 'Reload saved profile', exact: true }).click();
    for (const [title, id] of [
      ['Launch plan', 'saved-launch'],
      ['Review notes', 'saved-review'],
      ['Original discussion', 'saved-unresolved'],
    ]) {
      const button = page.getByRole('button', { name: new RegExp(title) });
      const box = await button.boundingBox();
      assert(box.height >= 44, 'The whole settings row is a click target');
      await button.click();
      await page.waitForFunction(path => document.querySelector('[data-destination]')?.textContent === path, `/cc-agent/${id}`);
      assert.equal(await page.locator('[data-destination]').textContent(), `/cc-agent/${id}`);
      await page.getByRole('button', { name: 'Back to history', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-destination]')?.textContent === '/bots/fixture-buddy');
    }
    assert.equal(await page.getByText('Deleted topic', { exact: true }).count(), 0);
    assert.equal(await page.getByText('IM lane', { exact: true }).count(), 0);
    await ui.capture('reloaded-history');
  },
};
