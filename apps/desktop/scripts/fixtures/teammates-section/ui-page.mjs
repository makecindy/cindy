import assert from 'node:assert/strict';

const data = 'window.__uiPage.ctx.data';
const profiles = ['Cindy', 'Writer', 'Researcher', 'Designer', 'Translator', 'Reviewer'].map((name, index) => ({
  id: `mate-${index + 1}`, name, avatar: '', avatarColor: 'violet', channel: 'local',
  status: 'active', enabled: true, skills: [], capabilities: {}, createdAt: 0,
  lastMessageAt: 600 - index, lastMessagePreview: 'Ready',
  sessions: [{ id: `chat-${index}`, kind: 'chat', role: 'canonical' }],
}));

export default {
  name: 'teammates-section',
  entry: './teammates-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'TeammatesSection rows, current-chat preview, show-all/show-less controls, avatar strip, theme and translations',
  notCovered: 'Roster loading, cloud/device connections, create/delete menus and message delivery',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth=()=>({dataOwnerId:"ui-fixture"});' },
    'src/renderer/features/bots/botStore': { partial: `export const useBotProfiles=()=>${data}.profiles; export const useBotUnreadCounts=()=>({});` },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteBots=()=>${data}.remoteBots;`,
    'src/renderer/features/bots/companionCloudStore': { partial: 'const snapshot={enabled:false,actors:[],demotedBotIds:[]}; export const useCompanionCloud=()=>snapshot;' },
    'src/renderer/features/bots/botGroupStore': { partial: `export const useBotGroupList=()=>({groups:${data}.groups||[],loaded:true});` },
    'src/renderer/features/device-link/useDeviceLinkDeviceList': 'export const useDeviceLinkDeviceList=()=>[];',
    'src/renderer/state/agentIslandActivity': { partial: 'const activity=new Map(); export const useAgentIslandActivityMap=()=>activity;' },
    'src/renderer/features/bots/BotCreateMenu': 'export const BotCreateMenu=()=>null;',
    'src/renderer/features/bots/BotDeleteDialog': 'export const BotDeleteDialog=()=>null;',
  },
  cases: { ...Object.fromEntries([
    ['default', '/bots/mate-6'],
    ['session', '/bots/mate-6/session/session-6'],
    ['history', '/bots/mate-6/history/session-6'],
    ['direct', '/bots/mate-6/direct/thread-6'],
    ['remote', '/bots/remote/remote-device/mate-6'],
    ['merged-cindy', '/bots/remote/remote-device/cindy-default'],
  ].map(([name, route]) => {
    const merged = name === 'merged-cindy';
    const localProfiles = merged
      ? profiles.map((bot, index) => index === 5 ? { ...bot, id: 'cindy-default', name: 'Cindy', templateId: 'cindy' } : bot)
      : name === 'remote' ? profiles.slice(0, 5) : profiles;
    const remoteBots = name === 'remote' || merged ? [{
      id: merged ? 'cindy-default' : 'mate-6', name: merged ? 'Cindy' : 'Reviewer',
      deviceId: 'remote-device', deviceName: 'Studio', online: true, avatar: '', avatarColor: 'violet',
      preview: 'Ready', activityAt: 595, sessionId: 'remote-session',
    }] : [];
    return [name, {
      about: `Shell-mounted sidebar on ${name} route; selected sixth row and reversible collapse`,
      data: { profiles: localProfiles, remoteBots, route },
    }];
  })),
    ...Object.fromEntries([11, 999].map(count => [`long-speakers-${count}`, {
      about: 'Long speaking member names ellipsize before the unread count in a narrow sidebar',
      data: { profiles: [], remoteBots: [], route: count === 11 ? '/bots' : '/bots/groups/long-speakers', groups: [{
        id: 'long-speakers', name: 'Cindy开发', replyMode: 'all', speakingMode: 'auto',
        members: ['Cindy (dash)', 'orik (kiro)', '另一个名字很长的伙伴'].map((name, index) => ({
          botId: `speaker-${index}`, name, avatar: '', avatarColor: 'violet', status: 'active',
        })),
        speakingBotIds: ['speaker-0', 'speaker-1', 'speaker-2'],
        organizerBotId: 'speaker-0', projectDir: null, lastMessage: null,
        planningBotId: null, openPlan: null, createdAt: 1, updatedAt: 1,
        serverUnread: { count, mentioned: count > 99 },
      }] },
    }])),
    'device-names': {
      about: 'Duplicate and missing computer names never expose device fingerprints in teammate rows',
      data: { profiles: [], route: '/bots', remoteBots: [
        { id: 'writer', name: 'Writer', deviceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', deviceName: 'Mac Studio', online: true, preview: 'Ready', activityAt: 0 },
        { id: 'researcher', name: 'Researcher', deviceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', deviceName: 'Mac Studio', online: true, preview: 'Ready', activityAt: 0 },
        { id: 'designer', name: 'Designer', deviceId: 'cccccccccccccccccccccccccccccccc', deviceName: '', online: false, preview: 'Ready', activityAt: 0 },
      ] },
    },
  },
  async check(page, ui) {
    if (ui.case.startsWith('long-speakers-')) {
      const running = page.getByTestId('bot-group-running');
      const label = running.locator('[title]');
      const badge = page.getByLabel(await ui.t('sidebar.teammateUnreadCount', { count: ui.data.groups[0].serverUnread.count }));
      const metrics = await label.evaluate(node => ({
        width: node.clientWidth, fullWidth: node.scrollWidth,
        right: node.getBoundingClientRect().right, overflow: getComputedStyle(node).overflow,
        textOverflow: getComputedStyle(node).textOverflow,
      }));
      const badgeBox = await badge.boundingBox();
      assert.ok(metrics.width > 0 && metrics.fullWidth > metrics.width, 'long names reach the text boundary');
      assert.equal(metrics.overflow, 'hidden');
      assert.equal(metrics.textOverflow, 'ellipsis');
      assert.ok(badgeBox && metrics.right < badgeBox.x, 'preview leaves space before the unread badge');
      assert.equal(await badge.innerText(), ui.data.groups[0].serverUnread.count > 99 ? '99+' : '11');
      return;
    }
    if (ui.case === 'device-names') {
      const text = await page.locator('body').innerText();
      assert.match(text, /Mac Studio \(1\)/);
      assert.match(text, /Mac Studio \(2\)/);
      assert.ok(text.includes(await ui.t('bots.cloud.unknownDevice')));
      assert.doesNotMatch(text, /[abc]{32}/);
      return;
    }
    const rows = page.getByText('Ready', { exact: true });
    assert.equal(await rows.count(), 5);
    assert.equal(await page.getByText('Translator', { exact: true }).count(), 0);
    await page.locator('[aria-current="page"]').waitFor();
    const showAllLabel = await ui.t('ccAgent.sidebar.showAllSessions', { count: 6 });
    const showAll = () => page.getByRole('button', { name: showAllLabel, exact: true });
    await showAll().click();
    assert.equal(await rows.count(), 6);
    await ui.capture('all');
    await page.getByRole('button', { name: await ui.t('bots.list.showLess'), exact: true }).click();
    assert.equal(await rows.count(), 5);
    await ui.capture('preview');
    await showAll().click();
    const header = page.getByRole('button', { name: await ui.t('bots.title'), exact: true });
    await header.click();
    await rows.first().waitFor({ state: 'detached' });
    await ui.capture('avatars');
    await header.click();
    assert.equal(await rows.count(), 5, 'reopening the section restores its compact preview');
  },
};
