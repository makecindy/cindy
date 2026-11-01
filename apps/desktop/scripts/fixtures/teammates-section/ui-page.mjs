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
    'src/renderer/features/bots/botStore': { partial: `export const useBotProfiles=()=>${data}.profiles; export const useBotUnreadCounts=()=>(${data}.unread||{});` },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteBots=()=>${data}.remoteBots;`,
    'src/renderer/features/bots/companionCloudStore': { partial: 'const snapshot={enabled:false,actors:[],demotedBotIds:[]}; export const useCompanionCloud=()=>snapshot;' },
    'src/renderer/features/bots/botGroupStore': { partial: `export const useBotGroupList=()=>({groups:${data}.groups||[],loaded:true});` },
    'src/renderer/features/device-link/useDeviceLinkDeviceList': 'export const useDeviceLinkDeviceList=()=>[];',
    'src/renderer/state/agentIslandActivity': { partial: `export const useAgentIslandActivityMap=()=>new Map(${data}.activities||[]);` },
    'src/renderer/features/bots/BotCreateMenu': 'export const BotCreateMenu=()=>null;',
    'src/renderer/features/bots/BotDeleteDialog': 'export const BotDeleteDialog=()=>null;',
  },
  cases: {
    'group-avatars': {
      about: 'Collapsed one-to-five-member groups keep their composition and corner-dot space',
      data: { profiles: [], remoteBots: [], route: '/bots/groups/group-2', groups: [1, 2, 3, 4, 5].map(count => ({
        id: `group-${count}`, name: `Group ${count}`, replyMode: 'all', speakingMode: 'auto',
        members: profiles.slice(0, count).map(bot => ({ botId: bot.id, name: bot.name, avatar: '', avatarColor: bot.avatarColor, status: 'active' })),
        speakingBotIds: ['mate-1'], organizerBotId: 'mate-1', projectDir: null, lastMessage: null,
        planningBotId: null, openPlan: null, createdAt: count, updatedAt: count,
      })) },
    },
    states: {
      about: 'Shared solid-dot states in expanded rows and collapsed overflow',
      data: { profiles: profiles.slice(0, 5).map((bot, index) => ({ ...bot,
        lastMessageAt: Date.now() - index * 60_000,
        avatar: 'cindy://avatar/preset/cindy', lastMessagePreview: ['Working', 'Waiting', 'Finished', 'New message', 'Error'][index] })),
        remoteBots: [], route: '/bots/mate-2', unread: { 'mate-3': 1, 'mate-4': 1 },
        activities: ['running', 'needs-interaction', 'completed', 'idle', 'error'].map((phase, index) =>
          [`chat-${index}`, { sessionId: `chat-${index}`, phase, attention: true, workingPhase: 'processing', startedAtMs: null }]),
      },
    },
    ...Object.fromEntries([
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
      ...(merged ? { lastReplyAt: Date.now(), readAt: 0 } : {}),
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
    ...Object.fromEntries([true, false].map(withMentions => [withMentions ? 'collapsed-mention' : 'collapsed-plain', {
      about: withMentions
        ? 'Collapsed strip: orange @ on a running group, blue @ on an idle one, plain dot on an unread group without @'
        : 'Collapsed strip: the same chats and selection plate without any @',
      // Real preset portraits and a selected group, so captures match the shipped strip.
      data: { profiles: profiles.slice(0, 2).map((bot, index) => ({ ...bot, avatar: `cindy://avatar/preset/${['dash', 'lizi'][index]}` })),
        remoteBots: [], route: '/bots/groups/group-0', groups: ['周末出游', '设计评审', '读书会'].map((name, index) => ({
        id: `group-${index}`, name, replyMode: 'all', speakingMode: 'auto',
        members: (index === 1 ? ['cindy', 'dash', 'lizi'] : ['cindy', 'lizi']).map((preset, memberIndex) => ({
          botId: `member-${memberIndex}`, name: preset, avatar: `cindy://avatar/preset/${preset}`, avatarColor: 'violet', status: 'active',
        })),
        speakingBotIds: index === 0 ? ['member-0'] : [], organizerBotId: 'member-0', projectDir: null,
        lastMessage: { authorKind: 'user', authorName: 'Alice', preview: '@me', createdAt: Date.now() - index },
        planningBotId: null, openPlan: null, createdAt: 1, updatedAt: Date.now() - index,
        serverUnread: { count: 2, mentioned: withMentions && index < 2 },
      })) },
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
    if (ui.case === 'group-avatars') {
      await ui.capture('expanded-groups');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      await ui.capture('collapsed-groups');
      return;
    }
    // Read the painted selection, including the wrapper used by local/Cindy rows.
    const selectedRow = page.locator('[data-sidebar-section="teammates"] [aria-current="page"]').first();
    if (await selectedRow.count()) {
      const colors = await selectedRow.evaluate(node => {
        const surface = node.closest('.bg-sidebar-item-active');
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'hsl(var(--surface-hover-hsl))';
        probe.style.color = 'var(--sidebar-nav-text)';
        node.append(probe);
        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(surface);
        const result = { background: actual.backgroundColor, foreground: actual.color,
          expectedBackground: expected.backgroundColor, expectedForeground: expected.color };
        probe.remove(); return result;
      });
      assert.equal(colors.background, colors.expectedBackground, 'selection uses the quiet theme surface');
      assert.equal(colors.foreground, colors.expectedForeground, 'selection keeps normal text contrast');
    }
    if (ui.case === 'states') {
      const expandedAvatar = await selectedRow.locator('[aria-hidden="true"]').first().boundingBox();
      for (const state of ['running', 'awaiting', 'done', 'unread', 'error']) {
        const dot = page.locator(`[data-teammate-status="${state}"]`);
        assert.equal(await dot.count(), 1);
        const size = await dot.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
        assert.equal(size.width, 14); assert.equal(size.height, 14);
      }
      await ui.capture('expanded-states');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      await page.locator('[data-teammate-status="running"]').first().waitFor();
      const selected = page.locator('[data-sidebar-section="teammates"]').first().locator('button[aria-current="page"]').first();
      const dot = selected.locator('[data-teammate-status="awaiting"]');
      assert.equal(await dot.count(), 1, 'selection preserves the pending point');
      // Regression: collapsing enlarged the portrait to meet touch-target sizing.
      // Measure the real rendered portrait and corner dot, independently of its button.
      const portrait = await selected.locator('[aria-hidden="true"]:not([data-teammate-selected])').first().boundingBox();
      const target = await selected.boundingBox();
      const dotBox = await dot.boundingBox();
      assert.ok(portrait && expandedAvatar && portrait.width < expandedAvatar.width, 'collapsed portrait is smaller than the list portrait');
      assert.ok(target.width >= 48 && target.height >= 48, 'smaller portrait preserves its touch target');
      assert.ok(dotBox.x + dotBox.width <= target.x + target.width && dotBox.y + dotBox.height <= target.y + target.height, 'corner dot fits within the reserved target space');
      await ui.capture('collapsed-states');
      return;
    }
    if (ui.case === 'collapsed-plain') {
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const plate = page.locator('button[aria-current="page"] > [data-teammate-selected]');
      await plate.waitFor();
      const box = await plate.boundingBox();
      assert.ok(box && box.width === 56 && box.height === 56, 'the selection plate is 56px around the 48px touch target');
      assert.equal(await page.locator('[data-teammate-mention]').count(), 0);
      await ui.capture('collapsed-plain');
      return;
    }
    if (ui.case === 'collapsed-mention') {
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const badge = page.locator('[data-teammate-mention]');
      await badge.first().waitFor();
      assert.equal(await badge.count(), 2, 'only the groups that mention the user are marked');
      const box = await badge.first().boundingBox();
      assert.ok(box && box.width === 18 && box.height === 18, 'the @ point keeps its 18px ring geometry');
      const colors = await badge.evaluateAll(nodes => nodes.map(node => node.style.backgroundColor));
      assert.deepEqual(colors, ['var(--status-bar-accent)', 'var(--bot-unread-bg)'], 'running stays orange, otherwise unread blue');
      assert.equal(await page.locator('button:has([data-teammate-mention]) [data-teammate-status]').count(), 2, 'one indicator per marked avatar');
      await ui.capture('collapsed-mention');
      return;
    }
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
