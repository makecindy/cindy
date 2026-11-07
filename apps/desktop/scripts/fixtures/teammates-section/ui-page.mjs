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
    'remote-running-snapshot': {
      about: 'Standalone remote running snapshot keeps the processing subtitle without an expanded orange dot',
      data: { profiles: [], route: '/bots/remote/studio/writer', remoteBots: [{
        id: 'writer', name: 'Writer', deviceId: 'studio', deviceName: 'Studio',
        avatar: 'cindy://avatar/preset/dash', avatarColor: 'violet', online: true,
        preview: 'Previous reply', activityAt: 1, sessionId: 'remote-session',
        teammateActivity: { phase: 'running' },
      }] },
    },
    'selected-remote-running-snapshot': {
      about: 'Selected remote Cindy retains its processing subtitle when only the running snapshot remains',
      data: { profiles: [], route: '/bots/remote/studio/cindy-default', remoteBots: [{
        id: 'cindy-default', name: 'Cindy', deviceId: 'studio', deviceName: 'Studio',
        avatar: 'cindy://avatar/preset/cindy', avatarColor: 'violet', online: true,
        preview: 'Previous reply', activityAt: 1, sessionId: 'remote-session',
        teammateActivity: { phase: 'running' },
      }] },
    },
    'running-preview-parity': {
      about: 'Local, remote and merged Cindy progress match the group breathing icon and orange text',
      data: {
        profiles: [{ ...profiles[0], id: 'cindy-default', templateId: 'cindy', avatar: 'cindy://avatar/preset/cindy', sessions: [{ id: 'cindy-chat', kind: 'chat', role: 'canonical' }] }, { ...profiles[1], avatar: 'cindy://avatar/preset/dash' }],
        activities: [['cindy-chat', { phase: 'running', sessionId: 'cindy-chat' }], ['chat-1', { phase: 'running', sessionId: 'chat-1' }]],
        remoteBots: [{ id: 'remote-writer', name: 'Remote Writer', deviceId: 'studio', deviceName: 'Studio', avatar: 'cindy://avatar/preset/lizi', avatarColor: 'violet', online: true, activityAt: 1, teammateActivity: { phase: 'running' } }],
        route: '/bots/cindy-default',
        groups: [{ id: 'running-group', name: '正在协作的群', replyMode: 'all', speakingMode: 'auto', members: [{ botId: 'dash', name: 'Dash', avatar: 'cindy://avatar/preset/dash', avatarColor: 'violet', status: 'active' }], organizerBotId: 'dash', projectDir: null, speakingBotIds: ['dash'], planningBotId: null, openPlan: null, teammateActivity: { phase: 'running' }, createdAt: 1, updatedAt: 1 }],
      },
    },
    'completed-group-unread': {
      about: 'Completed unread uses only green points; ordinary unread uses an expanded gray count and collapsed blue point',
      data: { profiles: [], remoteBots: [], route: '/bots', groups: ['完成未读', '普通未读'].map((name, index) => ({
        id: `completed-${index}`, name, replyMode: 'all', speakingMode: 'auto',
        members: ['dash', 'lizi'].map(preset => ({ botId: preset, name: preset, avatar: `cindy://avatar/preset/${preset}`, avatarColor: 'violet', status: 'active' })),
        organizerBotId: 'dash', projectDir: null, speakingBotIds: [], planningBotId: null, openPlan: null,
        teammateActivity: { phase: index === 0 ? 'completed' : 'idle' },
        lastMessage: { authorKind: index === 0 ? 'bot' : 'user', isSelf: false, authorName: index === 0 ? 'Dash' : 'Alex', preview: index === 0 ? '报告已整理好，等你查看' : '今天的讨论有新消息', createdAt: Date.now() - (index + 1) * 60000 },
        serverUnread: { count: index === 0 ? 3 : 12, mentioned: false }, createdAt: 1, updatedAt: Date.now() - (index + 1) * 60000,
      })) },
    },
    'message-kinds': {
      about: 'Bot result green, ordinary group unread count, group mention blue count; execution states retain priority',
      data: {
        profiles: [{ ...profiles[0], name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', lastMessageAt: Date.now(), lastMessageRole: 'assistant', lastMessagePreview: '报告已整理好，等你查看' }],
        unread: { 'mate-1': 1 }, remoteBots: [], route: '/bots/groups/attention-1',
        groups: ['普通群消息', '有人提到我', '群里正在处理', '群里执行失败'].map((name, index) => ({
          id: `attention-${index}`, name, replyMode: 'all', speakingMode: 'auto',
          members: ['dash', 'lizi'].map(preset => ({ botId: preset, name: preset, avatar: `cindy://avatar/preset/${preset}`, avatarColor: 'violet', status: 'active' })),
          speakingBotIds: index === 2 ? ['dash'] : [], organizerBotId: 'dash', projectDir: null,
          lastMessage: { authorKind: 'user', isSelf: false, authorName: 'Alex', preview: ['今天的讨论有新消息', '请你看一下这份方案', '正在整理讨论内容', '这一步需要重新检查'][index], createdAt: Date.now() - (index + 1) * 60000 },
          planningBotId: null, openPlan: null, createdAt: 1, updatedAt: Date.now() - (index + 1) * 60000,
          ...(index === 3 ? { teammateActivity: { phase: 'error' } } : {}),
          serverUnread: { count: index === 0 ? 12 : 2, mentioned: index !== 0 },
        })),
      },
    },
    ...Object.fromEntries(['other-computer-running', 'other-computer-running-mirror', 'local-working-remote-selected'].map(name => {
      const localWorking = name === 'local-working-remote-selected';
      return [name, {
        about: 'Merged Cindy keeps background-computer work visible without a duplicate running dot or route change',
        data: {
          profiles: [{ ...profiles[0], id: 'cindy-default', templateId: 'cindy', avatar: 'cindy://avatar/preset/cindy', lastMessagePreview: '本机上一条消息' }],
          remoteBots: [{ id: 'cindy-default', name: 'Cindy', deviceId: 'studio', deviceName: 'Studio',
            avatar: 'cindy://avatar/preset/cindy', avatarColor: 'violet', online: true, sessionId: 'studio-chat', activityAt: 1,
            preview: '远程上一条消息', ...(localWorking ? {} : name.endsWith('-mirror')
              ? { teammateActivity: { phase: 'running' } }
              : { generation: { phase: 'processing', startedAt: null } }),
          }],
          route: localWorking ? '/bots/remote/studio/cindy-default' : '/bots/cindy-default',
          activities: localWorking ? [['chat-0', { sessionId: 'chat-0', phase: 'running', workingPhase: 'processing', startedAtMs: null }]] : [],
        },
      }];
    })),
    'group-types': {
      about: 'Group and private rows retain their original avatars without type markers; running/unread status semantics remain',
      data: {
        profiles: profiles.slice(0, 2).map((bot, index) => ({ ...bot, lastMessageAt: Date.now() - (index + 5) * 60000, lastMessagePreview: ['设计稿已更新', '收到，继续整理'][index], avatar: `cindy://avatar/preset/${['cindy', 'dash'][index]}` })),
        remoteBots: [], route: '/bots/groups/type-1',
        groups: [1, 2].map((count, index) => ({
          id: `type-${count}`, name: ['单伙伴群', '周末出游'][index],
          replyMode: 'all', speakingMode: 'auto',
          members: ['cindy', 'dash', 'lizi'].slice(0, count).map((preset, memberIndex) => ({
            botId: `member-${memberIndex}`, name: ['Cindy', 'Writer', 'Researcher'][memberIndex],
            avatar: `cindy://avatar/preset/${preset}`, avatarColor: 'violet', status: 'active',
          })),
          speakingBotIds: index === 0 ? ['member-0'] : [], organizerBotId: 'member-0', projectDir: null,
          lastMessage: { authorKind: 'user', authorName: 'Alice', preview: ['看看这个设计', '周六一起出发', '分享一本好书'][index], createdAt: Date.now() - index },
          planningBotId: null, openPlan: null, createdAt: 1, updatedAt: Date.now() - index,
          serverUnread: { count: 2, mentioned: index < 2 },
        })),
      },
    },
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
      data: { profiles: profiles.slice(0, 5).map((bot, index) => ({ ...bot, needsAttention: index === 1,
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
        ? 'Collapsed strip: running stays orange, group mentions blue, ordinary group unread blue'
        : 'Collapsed strip: ordinary group unread stays blue and selection uses an outline',
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
    // Time and status coexist in the existing trailing column, without overlap.
    for (const time of await page.locator('[data-teammate-timestamp]:visible').all()) {
      assert.equal(await time.evaluate(node => getComputedStyle(node).visibility), 'visible');
      const row = time.locator('xpath=ancestor::*[@data-testid="cindy-device-row" or self::button][1]');
      const status = row.locator('[data-teammate-row-status]');
      if (await status.count()) {
        const t = await time.boundingBox();
        const s = await status.boundingBox();
        assert.ok(t && s && t.y + t.height <= s.y, 'timestamp stays above the status mark');
      }
    }
    if (['remote-running-snapshot', 'selected-remote-running-snapshot'].includes(ui.case)) {
      const row = page.locator('[data-sidebar-section="teammates"] button[aria-current="page"]');
      assert.equal(await row.getByText(await ui.t('ccAgent.agentStatus.processing'), { exact: true }).count(), 1);
      assert.equal(await row.getByText('Previous reply', { exact: true }).count(), 0);
      assert.equal(await row.locator('[data-teammate-status="running"]').count(), 0);
      await ui.capture('expanded-remote-running-snapshot');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      assert.equal(await page.locator('[data-teammate-status="running"]:visible').count(), 1);
      await ui.capture('collapsed-remote-running-snapshot');
      return;
    }
    if (ui.case === 'running-preview-parity') {
      const expand = page.getByRole('button', { name: /Show all|显示全部|查看全部/ });
      if (await expand.count()) await expand.click();
      const previews = page.locator('[data-teammate-running-preview]');
      assert.equal(await previews.count(), 3);
      // The screenshot runner defaults to reduced motion. Verify both modes explicitly.
      for (const preview of await previews.all()) {
        assert.equal(await preview.locator('.session-status-breathing').evaluate(node => getComputedStyle(node).animationName), 'none');
      }
      await page.emulateMedia({ colorScheme: ui.theme, reducedMotion: 'no-preference' });
      const groupAnimation = await page.locator('[data-testid="bot-group-running"] .session-status-breathing').evaluate(node => getComputedStyle(node).animationName);
      assert.notEqual(groupAnimation, 'none');
      const groupColor = await page.locator('[data-testid="bot-group-running"]').evaluate(node => getComputedStyle(node).color);
      for (const preview of await previews.all()) {
        assert.equal(await preview.evaluate(node => getComputedStyle(node).color), groupColor);
        const icon = preview.locator('.session-status-breathing');
        assert.equal(await icon.evaluate(node => getComputedStyle(node).animationName), groupAnimation);
        assert.equal(await icon.locator('svg').getAttribute('width'), '11');
      }
      assert.equal(await page.locator('[data-teammate-row-status] [data-teammate-status="running"]').count(), 0);
      const icon = previews.first().locator('.session-status-breathing');
      const before = await icon.evaluate(node => getComputedStyle(node).opacity);
      await page.waitForTimeout(250);
      assert.notEqual(await icon.evaluate(node => getComputedStyle(node).opacity), before, 'the running icon must actually breathe');
      await page.emulateMedia({ colorScheme: ui.theme, reducedMotion: 'reduce' });
      await ui.capture('expanded-running-parity');
      return;
    }
    const statusAlignment = await page.locator('[data-teammate-row-status]').evaluateAll(nodes => nodes.map(node => {
      let container = node.parentElement;
      while (container && !container.querySelector('.text-12.leading-4')) container = container.parentElement;
      const subtitle = container?.querySelector('.text-12.leading-4');
      if (!subtitle) return null;
      const mark = node.getBoundingClientRect(); const text = subtitle.getBoundingClientRect();
      return { offset: mark.y + mark.height / 2 - text.y - text.height / 2, rowHeight: node.parentElement.getBoundingClientRect().height };
    }).filter(Boolean));
    assert.ok(statusAlignment.every(item => Math.abs(item.offset) <= 0.5), `Status alignment: ${JSON.stringify(statusAlignment)}`);
    if (ui.case === 'completed-group-unread') {
      const done = page.locator('[data-bot-group-id="completed-0"]');
      assert.equal(await done.locator('[data-teammate-unread-count]').count(), 0);
      const point = done.locator('[data-teammate-row-status] [data-teammate-status="done"] > span');
      assert.equal(await point.evaluate(node => node.style.backgroundColor), 'var(--card-status-done)');
      assert.equal(await done.locator('[data-teammate-status]').count(), 1);
      const plain = page.locator('[data-bot-group-id="completed-1"]');
      assert.equal(await plain.locator('[data-teammate-unread-count]').innerText(), '12');
      assert.equal(await plain.locator('[data-teammate-status]').count(), 0);
      await ui.capture('expanded-completed-and-ordinary');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const avatar = page.getByRole('button', { name: /^完成未读 ·/ });
      assert.equal(await avatar.locator('[data-teammate-status="done"] > span').evaluate(node => node.style.backgroundColor), 'var(--card-status-done)');
      assert.equal(await page.getByRole('button', { name: /^普通未读 ·/ }).locator('[data-teammate-status] > span').evaluate(node => node.style.backgroundColor), 'var(--bot-unread-bg)');
      await ui.capture('collapsed-completed-and-ordinary');
      return;
    }
    if (ui.case === 'message-kinds') {
      const expand = page.getByRole('button', { name: /Show all|显示全部|查看全部/ });
      if (await expand.count()) await expand.click();
      const plain = page.locator('[data-bot-group-id="attention-0"]');
      assert.equal(await plain.locator('[data-teammate-unread-count]').innerText(), '12');
      const mention = page.locator('[data-bot-group-id="attention-1"] [data-teammate-unread-count] > span');
      assert.equal(await mention.innerText(), '2');
      assert.equal(await mention.evaluate(node => getComputedStyle(node).backgroundColor), await mention.evaluate(node => { const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--bot-unread-bg)'; node.appendChild(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; }));
      assert.equal(await page.locator('[data-bot-group-id="attention-1"] [data-teammate-status]').count(), 0);
      assert.equal(await page.locator('[data-bot-group-id="attention-2"] [data-teammate-status]').count(), 0);
      assert.equal(await page.locator('[data-bot-group-id="attention-2"] [data-teammate-unread-count]').innerText(), '2');
      assert.equal(await page.locator('[data-bot-group-id="attention-3"] [data-teammate-status="error"]').count(), 1);
      await ui.capture('expanded-message-kinds');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const ordinary = page.getByRole('button', { name: /^普通群消息 ·/ });
      assert.equal(await ordinary.locator('[data-teammate-status] > span').evaluate(node => node.style.backgroundColor), 'var(--bot-unread-bg)');
      assert.equal(await page.locator('[data-teammate-mention]:visible').count(), 3);
      await ui.capture('collapsed-message-kinds');
      return;
    }
    if (['other-computer-running', 'other-computer-running-mirror', 'local-working-remote-selected'].includes(ui.case)) {
      const localWorking = ui.case === 'local-working-remote-selected';
      const row = page.getByTestId('cindy-device-row');
      const workingDevice = localWorking ? await ui.t('bots.devicePicker.local') : 'Studio';
      assert.ok((await row.innerText()).includes(`${workingDevice} · `));
      assert.equal(await row.getByText(await ui.t('ccAgent.agentStatus.processing'), { exact: true }).count(), 1);
      assert.equal(await row.locator('[data-teammate-status="running"]').count(), 0);
      const selectedDevice = localWorking ? 'Studio' : await ui.t('bots.devicePicker.local');
      assert.equal(await row.getByRole('button', { name: `Cindy · ${selectedDevice}`, exact: true }).getAttribute('aria-current'), 'page');
      await ui.capture('other-computer-working');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      await row.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-teammate-status="running"]:visible').count(), 1);
      await ui.capture('collapsed-working');
      return;
    }
    if (ui.case === 'group-types') {
      const section = page.locator('[data-sidebar-section="teammates"]');
      assert.equal(await section.locator('[data-bot-group-id]').count(), 2);
      assert.equal(await section.getByText('Cindy', { exact: true }).count(), 1);
      assert.equal(await section.getByText('Writer', { exact: true }).count(), 1);
      assert.equal(await section.getByText('单伙伴群', { exact: true }).count(), 1);
      const expandedTypeMarks = await section.locator('[data-bot-group-id] svg.lucide-users').count();
      await ui.capture('expanded-group-private');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      await section.locator('[data-bot-group-id]').first().waitFor({ state: 'hidden' });
      assert.equal(await section.locator('[data-teammate-mention]:visible').count(), 2);
      await ui.capture('collapsed-group-private');
      assert.equal(expandedTypeMarks, 0, 'expanded groups keep main without extra type icons');
      assert.equal(await section.locator('button:has(svg.lucide-users):visible').count(), 0, 'collapsed avatars have no extra type badge');
      return;
    }
    if (ui.case === 'group-avatars') {
      await ui.capture('expanded-groups');
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      await ui.capture('collapsed-groups');
      for (const count of [1, 2, 3, 4, 5]) {
        const button = page.getByRole('button', { name: new RegExp(`^Group ${count}(?: ·|$)`) });
        await button.click();
        await button.locator('[data-teammate-selected]').waitFor();
        assert.equal(await button.getAttribute('aria-current'), 'page');
        assert.equal(await page.locator('[data-teammate-selected]').count(), 1);
        const ring = button.locator('[data-teammate-selected]');
        const geometry = await ring.evaluate(node => ({ width: node.getBoundingClientRect().width, offset: getComputedStyle(node).getPropertyValue('--tw-ring-offset-width').trim() }));
        assert.equal(geometry.width, 36);
        assert.equal(geometry.offset, '2px');
        await ui.capture(`selected-${count}`);
      }
      return;
    }
    // Read the painted selection, including the wrapper used by local/Cindy rows.
    const selectedRow = page.locator('[data-sidebar-section="teammates"] [aria-current="page"]').first();
    if (await selectedRow.count()) {
      const colors = await selectedRow.evaluate(node => {
        const surface = node.closest('.bg-sidebar-item-active');
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'hsl(var(--sidebar-item-active))';
        probe.style.color = 'var(--sidebar-item-active-foreground)';
        node.append(probe);
        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(surface);
        const result = { background: actual.backgroundColor, foreground: actual.color, shadow: actual.boxShadow,
          expectedBackground: expected.backgroundColor, expectedForeground: expected.color };
        probe.remove(); return result;
      });
      // 2026-11-06: same selected pill as list-mode task rows (fill, text and 1px inset outline).
      assert.equal(colors.background, colors.expectedBackground, 'selection uses the task row fill');
      assert.equal(colors.foreground, colors.expectedForeground, 'selection uses the task row text color');
      assert.match(colors.shadow, /inset/, 'selection draws the task row inset outline');
    }
    if (ui.case === 'states') {
      const expandedAvatar = await selectedRow.locator('[aria-hidden="true"]').first().boundingBox();
      assert.equal(await page.locator('[data-teammate-status="running"]').count(), 0, 'expanded running uses the subtitle only');
      for (const state of ['awaiting', 'done', 'unread', 'error']) {
        const dot = page.locator(`[data-teammate-status="${state}"]`);
        assert.equal(await dot.count(), 1);
        const size = await dot.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
        assert.equal(size.width, 16); assert.equal(size.height, 16);
        assert.equal((await dot.locator('span').boundingBox()).width, 8, 'expanded core matches Session');
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
      assert.ok(portrait && expandedAvatar && portrait.width === 36 && expandedAvatar.width === 44, 'collapsed and expanded portrait geometry');
      assert.ok(target.width === 40 && target.height === 40, 'collapsed strip uses the approved compact target');
      assert.ok(dotBox.x + dotBox.width <= target.x + target.width && dotBox.y + dotBox.height <= target.y + target.height, 'corner dot fits within the reserved target space');
      assert.equal(dotBox.width, 14, 'collapsed dot retains its 2px rim');
      assert.equal((await dot.locator('span').boundingBox()).width, 10, 'collapsed core remains 10px');
      await ui.capture('collapsed-states');
      return;
    }
    if (ui.case === 'collapsed-plain') {
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const plate = page.locator('button[aria-current="page"] > [data-teammate-selected]');
      await plate.waitFor();
      const box = await plate.boundingBox();
      assert.ok(box && box.width === 36 && box.height === 36, 'selection ring follows the 36px portrait');
      assert.equal(await page.locator('[data-teammate-mention]:visible').count(), 0);
      await ui.capture('collapsed-plain');
      return;
    }
    if (ui.case === 'collapsed-mention') {
      await page.getByRole('button', { name: await ui.t('bots.title'), exact: true }).click();
      const badge = page.locator('[data-teammate-mention]:visible');
      await badge.first().waitFor();
      assert.equal(await badge.count(), 2, 'only the groups that mention the user are marked');
      const box = await badge.first().boundingBox();
      assert.ok(box && box.width === 14 && box.height === 14, 'mentions use the same compact status point');
      const colors = await badge.evaluateAll(nodes => nodes.map(node => node.firstElementChild.style.backgroundColor));
      assert.deepEqual(colors, ['var(--warning-accent)', 'var(--bot-unread-bg)'], 'running stays orange, group attention is blue');
      assert.equal(await page.locator('button:visible:has([data-teammate-mention]) [data-teammate-status]:visible').count(), 2, 'one indicator per marked avatar');
      await ui.capture('collapsed-mention');
      return;
    }
    if (ui.case.startsWith('long-speakers-')) {
      const running = page.getByTestId('bot-group-running');
      const label = running.locator('[title]');
      const badge = page.locator('[data-teammate-status="running"]');
      const metrics = await label.evaluate(node => ({
        width: node.clientWidth, fullWidth: node.scrollWidth,
        right: node.getBoundingClientRect().right, overflow: getComputedStyle(node).overflow,
        textOverflow: getComputedStyle(node).textOverflow,
      }));
      assert.ok(metrics.width > 0 && metrics.fullWidth > metrics.width, 'long names reach the text boundary');
      assert.equal(metrics.overflow, 'hidden');
      assert.equal(metrics.textOverflow, 'ellipsis');
      assert.equal(await badge.count(), 0, 'expanded running has no duplicate orange point');
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
    const overflow = page.getByRole('button', { name: new RegExp(`^${await ui.t('bots.list.sectionExpand')} · \\+`) });
    if (await overflow.count()) {
      const circle = await overflow.locator('span').first().boundingBox();
      assert.equal(circle.width, 36, '+N circle matches portrait size');
      assert.equal(circle.height, 36);
      await overflow.focus();
      await page.keyboard.press('Enter');
      assert.equal(await rows.count(), 6, '+N opens the full roster');
      await header.click();
      await rows.first().waitFor({ state: 'detached' });
    }
    await header.click();
    assert.equal(await rows.count(), 5, 'reopening the section restores its compact preview');
  },
};
