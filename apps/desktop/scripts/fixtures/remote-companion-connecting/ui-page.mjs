import assert from 'node:assert/strict';

// Issue #12014 / PR #11991: a companion homed on another computer, opened inside the first
// connection window (relay still `connecting`, device directory not read yet), reads
// "connecting" with a spinner instead of the offline banner and "continue on this computer".
const writer = {
  id: 'writer', deviceId: 'home', deviceName: 'Home iMac', name: 'Writer', avatar: '🦉', avatarColor: 'gray',
  description: '', preview: '', sessionId: 'writer-chat', online: false, activityAt: 0,
};
const cloud = {
  enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [{ id: 'a-writer', externalId: 'writer', name: 'Writer', avatar: '🦉', homeDeviceId: 'home' }],
};

export default {
  name: 'remote-companion-connecting',
  entry: './remote-companion-connecting-fixture.tsx',
  viewport: { width: 1040, height: 560 },
  real: 'RemoteBotSessionView, deviceLinkFirstConnection (relay status + window), useDeviceLinkDeviceList, BotAvatar, Spinner and translations',
  notCovered: 'Real relay connection, window expiry, wake from sleep, the cloud conversation itself and the takeover action. Roster and cloud snapshot are fixture data.',
  stubs: {
    'src/renderer/features/cc-agent/CCAgentSessionView': { partial: 'export function CCAgentSessionView() { throw new Error("Unexpected chat"); }' },
    'src/renderer/features/bots/useRemoteBots': { partial: `export const useRemoteBots = () => window.__uiPage.ctx.data.listed ? [${JSON.stringify(writer)}] : [];
      export const retryRemoteBotRoster = () => {};
      export const markRemoteBotRead = () => {};` },
    'src/renderer/features/bots/companionCloudStore': { partial: `export const useCompanionCloud = () => (${JSON.stringify(cloud)});` },
    'src/renderer/features/bots/botStore': { partial: 'export const useBotProfilesLoadState = () => "ready";' },
  },
  cases: {
    default: { about: 'Cached companion row: avatar, "connecting" and spinner; no offline banner or takeover', data: { listed: true } },
    'cloud-only': { about: 'Only the cloud entry (never listed here): "connecting" and spinner', data: { listed: false } },
    'roster-timeout': { about: 'Reachable home with no roster entry offers retry after 30 seconds', data: { listed: false, reachable: true } },
  },
  async ready(page) {
    await page.locator('main p').waitFor();
  },
  async check(page, ui) {
    const main = page.locator('main');
    if (ui.case === 'roster-timeout') {
      const preparing = main.getByText(await ui.t('bots.remote.preparing'), { exact: true });
      await preparing.waitFor();
      await ui.capture('preparing');
      const retry = main.getByRole('button', { name: await ui.t('bots.retry') });
      await retry.waitFor({ timeout: 35_000 });
      await ui.capture('timed-out');
      await retry.click();
      await preparing.waitFor();
      return;
    }
    await main.getByText(await ui.t('ccAgent.sidebar.machineSwitcher.connecting'), { exact: true }).waitFor();
    assert.equal(await main.locator('.animate-spinner').count(), 1, 'one spinner while connecting');
    assert.equal(await page.getByText(await ui.t('bots.remote.offlineDescription', { name: 'Writer', device: 'Home iMac' })).count(), 0,
      'no offline copy while connectivity is undetermined');
  },
};
