import assert from 'node:assert/strict';
import sidebar from '../teammates-section/ui-page.mjs';

const profile = { id: 'mia', name: 'Mia', description: 'Synthetic companion', avatar: '', avatarColor: 'violet', channel: 'local', status: 'active', enabled: true, skills: [], capabilities: { harness: 'claude', model: 'synthetic-model', effort: 'medium', fastMode: false }, createdAt: 1, sessions: [] };
const cloud = { enabled: true, selfDeviceId: 'fixture-desk', demotedBotIds: ['mia'], actors: [{ id: 'fixture-actor', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: 'fixture-desk', homeDevice: { deviceId: 'fixture-desk', name: 'Example computer', online: false, isSelf: true } }] };
export default {
  name: 'companion-recovery', entry: './fixture.tsx', viewport: { width: 1040, height: 720 },
  real: 'TeammatesSection, search results, RemoteBotSessionView and CloudCompanionOfflineView with synthetic host responses',
  notCovered: 'Full search shell, real accounts, cloud, device connections, persistence, model settings contents, recovery execution and ownership',
  stubs: { ...sidebar.stubs, 'src/renderer/features/cc-agent/CCAgentSessionView': 'export const CCAgentSessionView=()=>null;', 'src/renderer/features/bots/useRemoteBots': { partial: 'export const useRemoteBots=()=>window.__uiPage.ctx.data.remoteBots;' }, 'src/renderer/features/bots/companionCloudStore': { partial: `import { useSyncExternalStore } from 'react';
    const subscribe = listener => { window.addEventListener('fixture-cloud-changed', listener); return () => window.removeEventListener('fixture-cloud-changed', listener); };
    export const useCompanionCloud=()=>useSyncExternalStore(subscribe, () => window.__uiPage.ctx.data.cloud);` } },
  cases: { default: { about: 'Demoted self home, read-only history and simulated automatic recovery', data: { profiles: [profile], remoteBots: [], cloud } } },
  async check(page, ui) {
    const sidebarRow = page.locator('[data-ui-frame="sidebar"]').getByText('Mia', { exact: true });
    const result = page.locator('[data-teammate-search-results]').getByText('Mia', { exact: true });
    assert.equal(await sidebarRow.count(), 1); assert.equal(await result.count(), 1);
    await sidebarRow.click();
    const route = '/bots/remote/fixture-desk/mia';
    await page.waitForFunction(expected => document.querySelector('[data-testid="fixture-route"]')?.textContent === expected, route);
    await page.getByText('Synthetic answer').waitFor();
    assert.equal(await page.getByText('Synthetic question').count(), 1);
    assert.equal(await page.getByText(await ui.t('bots.cloud.readOnlyNote'), { exact: true }).count(), 1);
    assert.equal(await page.locator('textarea, [contenteditable="true"]').count(), 0);
    await ui.capture('history');
    await page.getByRole('button', { name: 'Fixture back' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-route"]')?.textContent === '/bots');
    await result.click();
    await page.waitForFunction(expected => document.querySelector('[data-testid="fixture-route"]')?.textContent === expected, route);
    await page.getByRole('button', { name: await ui.t('bots.globalSettings.defaultModel'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-route"]')?.textContent === '/settings?tab=general&section=general.botModel');
    await page.getByRole('button', { name: 'Fixture back' }).click();
    await page.getByTestId('cloud-companion-offline').getByText(await ui.t('bots.cloud.recoveryNotReady'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: await ui.t('bots.retry'), exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: await ui.t('bots.cloud.continueHere'), exact: true }).count(), 0);
    await ui.capture('recovery');
    await page.evaluate(() => window.fixtureCompleteRecovery());
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-route"]')?.textContent === '/bots/mia');
    assert.deepEqual(await page.evaluate(() => window.fixtureRecovery.profileReads), ['mia']);
    assert.deepEqual(await page.evaluate(() => window.__uiPage.ctx.data.cloud.demotedBotIds), []);
    await ui.capture('success');
  },
};
