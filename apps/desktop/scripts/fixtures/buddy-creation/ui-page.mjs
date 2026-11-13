import assert from 'node:assert/strict';

export default {
  name: 'buddy-creation', entry: './fixture.tsx', viewport: { width: 800, height: 680 },
  real: 'BotRosterView, botStore optimistic creation, portrait picker, model editor, buttons, translations and themes',
  notCovered: 'Host persistence, account bootstrap, model execution and remote devices; unit tests cover completion and failure/retry',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ dataOwnerId: null });' },
    'src/renderer/hooks/useModelRouteDevices': 'export const useModelRouteDevices = () => ({ devices: [], leadAgentDeviceId: null });',
  },
  cases: { default: { about: 'Pending optimistic creation must not show a duplicate-name error (#10298)' } },
  async ready(page) {
    await page.getByRole('dialog').waitFor();
    await page.locator('input').fill('Mika');
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]')?.disabled);
  },
  async check(page, ui) {
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
    // Wait until the real store has emitted the optimistic row, not only the local busy state.
    await page.waitForFunction(() => window.__buddyCreationPending === true);
    await ui.capture('creating');
    assert.equal(await page.getByRole('alert').count(), 0, 'Its own optimistic profile is not a duplicate');
  },
};
