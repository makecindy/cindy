import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: { select: () => {
  const q: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) q[method] = () => q;
  q.limit = async () => state.rows.shift() ?? [];
  return q;
} } }) }));

import { hydrateBotProfileRuntime } from '../botProfileRuntime';
import { resolveMemoryScopeKey } from '@cindy/maker-core';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { BOT_IM_CHANNELS_VENDOR_KEY, type BotImChannel } from '../../../shared/botImConnection';

const SOUL = '我是小满，主人的老搭档。\n\n说话简短直接，群里少说话。\n';

function seed(
  role: string,
  routeKey: string | null,
  capabilities: Record<string, unknown> = { memory: false, mcpMode: 'inherit', toolsetMode: 'inherit' },
): void {
  state.rows = [
    [{ botId: 'bot', role, routeKey, profileVersion: 3 }],
    [{ displayName: '小满', description: '老搭档' }],
    [{ identitySource: SOUL, capabilitiesJson: JSON.stringify(capabilities) }],
  ];
}

function prompt(opts: MakerSessionCreateOpts): string {
  return [opts.botProfilePrompt, opts.botProfileContextPrompt].join('\n');
}

describe('IM channel lanes hydrate the full Bot profile', () => {
  // PR #10294: project AGENTS remains enabled when the memory setting is off. Hydrate the
  // production options for each harness: runtime denial must override the native file route.
  it.each(['claude-code', 'codex', 'pi'] as const)('overrides project memory instructions when disabled on %s', async agentKind => {
    const deps = { readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }) };
    seed('canonical', null, { projectMode: true, memory: false });
    const opts = { id: 'off', agentKind, workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, deps, { persistSnapshot: false });
    expect(opts.makerMemoryEnabled).toBe(false);
    expect(prompt(opts)).toContain('Memory is disabled for this Cindy task');
    expect(prompt(opts)).toContain('Do not read, search, save or maintain memories');
    expect(prompt(opts)).toContain('overrides the project');
    seed('canonical', null, { projectMode: true, memory: true });
    await hydrateBotProfileRuntime(opts, deps, { persistSnapshot: false });
    expect(opts.makerMemoryEnabled).toBe(true);
    expect(prompt(opts)).not.toContain('Memory is disabled for this Cindy task');
  });
  // Unit: account names reach private chats without relabeling visitors or changing stored profiles.
  it.each(['canonical', 'thread', 'routine', 'channel'])('supplies the account name only to its own chat (%s)', async role => {
    seed(role, role === 'channel' ? 'im:telegram:777:dm:555' : null);
    const opts = { id: 'chat', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, { getUserName: () => '  Alex  ' }, { persistSnapshot: false });
    expect(opts.botUserProfilePrompt).toBe(role === 'channel' ? '' : 'User: "Alex"');
    expect(opts.botProfilePrompt).toBe(SOUL.trim());
    seed(role, null);
    await hydrateBotProfileRuntime(opts, { getUserName: () => '' }, { persistSnapshot: false });
    expect(opts.botUserProfilePrompt).toBe('');
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('inherits only enabled official skills on %s', async agentKind => {
    seed('channel', 'im:telegram:777:dm:555', { skillMode: 'allowlist', skills: ['personal'] });
    const opts = { id: 'lane', agentKind, workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const catalog = [
      { name: 'cindy:learn', path: '/official/learn/SKILL.md', cindyOfficial: true },
      { name: 'cindy-plugin-github:pr', path: '/official/pr/SKILL.md', cindyOfficial: true },
      { name: 'off', path: '/official/off/SKILL.md', cindyOfficial: true, enabled: false },
      { name: 'personal', path: '/personal/SKILL.md' },
      { name: 'harness', path: '/harness/SKILL.md' },
      { name: 'cindy-plugin-github:pr', path: '/personal/pr/SKILL.md' },
    ];
    await hydrateBotProfileRuntime(opts, { listSkills: async () => catalog,
      fingerprintSkillSource: async () => 'a'.repeat(64) }, { persistSnapshot: false });
    expect(opts.botRuntimeProfile?.skillPolicy.configured).toEqual(['personal', 'cindy:learn', 'cindy-plugin-github:pr']);
    expect(opts.botRuntimeProfile?.skillPolicy.catalog.find(item => item.path === '/personal/pr/SKILL.md')).toMatchObject({ enabled: false });
    expect(opts.botRuntimeProfile?.skillPolicy.catalog.find(item => item.path === '/official/pr/SKILL.md')).toMatchObject({ contentSha256: 'a'.repeat(64) });
  });

  it('resumes a frozen delegation task with the official set it already ran with', async () => {
    const resource = (name: string, path: string) => ({ name, path, sha256: 'a'.repeat(64) });
    const run = async (skillResources: unknown[], skills = ['personal']) => {
      seed('delegation', null, { skillMode: 'allowlist', skills });
      state.rows.push([{ profileVersion: 3, resolvedJson: JSON.stringify({ skillResources }) }]);
      const opts = { id: 'child', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
      await hydrateBotProfileRuntime(opts, { listSkills: async () => [
        { name: 'pr', path: '/official/pr/SKILL.md', cindyOfficial: true },
        { name: 'learn', path: '/official/learn/SKILL.md', cindyOfficial: true },
        { name: 'personal', path: '/personal/SKILL.md' },
        { name: 'pr', path: '/personal/pr/SKILL.md' },
      ], fingerprintSkillSource: async () => 'a'.repeat(64) }, { persistSnapshot: false });
      return opts.botRuntimeProfile?.skillPolicy.configured;
    };
    const personal = resource('personal', '/personal/SKILL.md');
    expect(await run([personal])).toEqual(['personal']);
    expect(await run([personal, resource('pr', '/official/pr/SKILL.md')])).toEqual(['personal', 'pr']);
    // Frozen with its own same-name personal file: the namesake official file must not replace it.
    expect(await run([resource('pr', '/personal/pr/SKILL.md')], ['pr'])).toEqual(['pr']);
  });

  it('keeps official inheritance under legacy defaults and fails closed on unreadable sources', async () => {
    seed('canonical', null);
    const opts = { id: 'main', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [
        { name: 'pr', path: '/official/pr/SKILL.md', cindyOfficial: true },
        { name: 'personal', path: '/personal/SKILL.md' },
      ],
      fingerprintSkillSource: async () => { throw new Error('unreadable'); },
    }, { persistSnapshot: false });
    expect(opts.botRuntimeProfile?.skillPolicy.configured).toEqual(['pr']);
    expect(opts.botRuntimeProfile?.skillPolicy.catalog.find(item => item.name === 'pr')).toMatchObject({ enabled: false, runtimeStatus: 'failed' });
  });

  it('treats a channel group lane as a full-profile lane with the whole SOUL', async () => {
    seed('channel', 'im:telegram:777:g:-100123');
    const opts = { id: 'lane', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.botId).toBe('bot');
    expect(opts.botRuntimeProfile?.botId).toBe('bot');
    const text = prompt(opts);
    expect(text).toContain('我是小满，主人的老搭档。');
    expect(text).toContain('说话简短直接，群里少说话。');
  });

  it('treats a guest-DM channel lane the same way', async () => {
    seed('channel', 'im:telegram:777:dm:555');
    const opts = { id: 'lane', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false });
    expect(snapshot?.botId).toBe('bot');
    expect(prompt(opts)).toContain('说话简短直接，群里少说话。');
  });

  it('keeps the Feishu outbound channel tool mounted on a Feishu channel lane even under an explicit allowlist', async () => {
    const narrow = {
      toolCapabilityVersion: 1, memory: false,
      mcpMode: 'allowlist', mcpServers: [], toolsetMode: 'allowlist', toolsets: [],
    };
    const deps = {
      listMcpServers: vi.fn(async () => [
        { name: 'cindy_feishu_bot', source: 'builtin' as const, available: true },
        { name: 'cindy_browser', source: 'builtin' as const, available: true },
      ]),
      listToolsets: vi.fn(async () => [
        { id: 'feishu_bot', name: 'Feishu bot', available: true },
        { id: 'browser', name: 'Browser', available: true },
      ]),
    };
    seed('channel', 'im:feishu:cli_app:g:oc_chat', narrow);
    const lane = {
      id: 'lane', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm',
      vendorOptions: { feishuChatId: 'g/oc_chat', source: 'feishu' },
    } as unknown as MakerSessionCreateOpts;
    const laneSnapshot = await hydrateBotProfileRuntime(lane, deps, { persistSnapshot: false });
    expect(lane.botRuntimeProfile?.mcpPolicy.configured).toContain('cindy_feishu_bot');
    expect(lane.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_browser');
    expect(lane.botRuntimeProfile?.toolsetPolicy.configured).toEqual(['feishu_bot']);
    expect(laneSnapshot?.disabledToolsets).toEqual(['browser']);

    // The canonical chat (shared with Desktop, no channel vendor options) keeps the explicit choice.
    seed('canonical', null, narrow);
    const main = { id: 'main', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const mainSnapshot = await hydrateBotProfileRuntime(main, deps, { persistSnapshot: false });
    expect(main.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_feishu_bot');
    expect(mainSnapshot?.disabledToolsets).toEqual(expect.arrayContaining(['feishu_bot', 'browser']));
  });

  it('mounts the Telegram Bot API tool on a Telegram channel lane even under an explicit allowlist', async () => {
    const narrow = {
      toolCapabilityVersion: 1, memory: false,
      mcpMode: 'allowlist', mcpServers: [], toolsetMode: 'allowlist', toolsets: [],
    };
    const deps = {
      listMcpServers: vi.fn(async () => [
        { name: 'cindy_telegram_bot', source: 'builtin' as const, available: true },
        { name: 'cindy_feishu_bot', source: 'builtin' as const, available: true },
        { name: 'cindy_browser', source: 'builtin' as const, available: true },
      ]),
      listToolsets: vi.fn(async () => [
        { id: 'feishu_bot', name: 'Feishu bot', available: true },
        { id: 'browser', name: 'Browser', available: true },
      ]),
    };
    seed('channel', 'im:telegram:777:g:-100123', narrow);
    const lane = {
      id: 'lane', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm',
      vendorOptions: { telegramChatId: 'g/-100123', source: 'telegram' },
    } as unknown as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(lane, deps, { persistSnapshot: false });
    expect(lane.botRuntimeProfile?.mcpPolicy.configured).toContain('cindy_telegram_bot');
    // Only the lane's own channel tool is force-mounted; the Feishu one stays an explicit choice.
    expect(lane.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_feishu_bot');
    expect(lane.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_browser');

    // The canonical chat of a Bot without any bound IM bot does not get it either.
    seed('canonical', null, narrow);
    const main = { id: 'main', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(main, deps, { persistSnapshot: false });
    expect(main.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_telegram_bot');
    expect(main.vendorOptions?.[BOT_IM_CHANNELS_VENDOR_KEY]).toBeUndefined();
  });

  it('mounts the bound channel tools on the canonical chat (owner DM lands there) and marks the bound channels', async () => {
    const narrow = {
      toolCapabilityVersion: 1, memory: false,
      mcpMode: 'allowlist', mcpServers: [], toolsetMode: 'allowlist', toolsets: [],
    };
    const deps = {
      listMcpServers: vi.fn(async () => [
        { name: 'cindy_telegram_bot', source: 'builtin' as const, available: true },
        { name: 'cindy_feishu_bot', source: 'builtin' as const, available: true },
        { name: 'cindy_browser', source: 'builtin' as const, available: true },
      ]),
      listToolsets: vi.fn(async () => [
        { id: 'feishu_bot', name: 'Feishu bot', available: true },
        { id: 'browser', name: 'Browser', available: true },
      ]),
      listBotImChannels: vi.fn<() => BotImChannel[]>(() => ['telegram']),
    };
    seed('canonical', null, narrow);
    const main = {
      id: 'main', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm',
      vendorOptions: { existing: 'kept' },
    } as unknown as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(main, deps, { persistSnapshot: false });
    expect(deps.listBotImChannels).toHaveBeenCalledWith({ botId: 'bot' });
    expect(main.botRuntimeProfile?.mcpPolicy.configured).toContain('cindy_telegram_bot');
    // Only the channels this Bot actually bound; Feishu stays an explicit choice here.
    expect(main.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_feishu_bot');
    expect(main.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_browser');
    expect(snapshot?.disabledToolsets).toEqual(expect.arrayContaining(['feishu_bot', 'browser']));
    // The marker is what the per-harness MCP gates read; other vendor options survive.
    expect(main.vendorOptions).toEqual({ existing: 'kept', [BOT_IM_CHANNELS_VENDOR_KEY]: ['telegram'] });

    // A Bot with a bound Feishu bot gets the Feishu tool and its toolset on the canonical chat too.
    deps.listBotImChannels.mockReturnValue(['feishu']);
    seed('canonical', null, narrow);
    const feishuMain = { id: 'main', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const feishuSnapshot = await hydrateBotProfileRuntime(feishuMain, deps, { persistSnapshot: false });
    expect(feishuMain.botRuntimeProfile?.mcpPolicy.configured).toContain('cindy_feishu_bot');
    expect(feishuMain.botRuntimeProfile?.mcpPolicy.configured).not.toContain('cindy_telegram_bot');
    expect(feishuMain.botRuntimeProfile?.toolsetPolicy.configured).toEqual(['feishu_bot']);
    expect(feishuSnapshot?.disabledToolsets).toEqual(['browser']);

    // Group / channel lanes keep their own chat-based mount; the bound-channel list is not consulted.
    deps.listBotImChannels.mockClear();
    seed('channel', 'im:telegram:777:g:-100123', narrow);
    const lane = {
      id: 'lane', agentKind: 'claude-code', workingDir: '/bots/bot/workspace', model: 'm',
      vendorOptions: { telegramChatId: 'g/-100123', source: 'telegram' },
    } as unknown as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(lane, deps, { persistSnapshot: false });
    expect(deps.listBotImChannels).not.toHaveBeenCalled();
    expect(lane.vendorOptions?.[BOT_IM_CHANNELS_VENDOR_KEY]).toBeUndefined();
  });

  // 伙伴 V2:在自己 workspace 里干活时就是普通项目任务——不用伙伴记忆,只叠加身份;本机关联项目只读挂载。
  // 能力选择不收窄任何一个 session(主人 2026-11-10:群聊、私聊都是 session,要么都支持要么都不支持),
  // 只聊天的群照旧没有工具。依据:主人 2026-11-06 / 2026-11-10;第三轮审查 #1。unit,mock DB。
  it('runs a V2 teammate in its workspace as an ordinary project task', async () => {
    const deps = {
      readProfileFolder: vi.fn(async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' })),
      readMemoryIndex: vi.fn(async () => 'BOT MEMORY'),
      listToolsets: vi.fn(async () => [
        { id: 'browser', name: 'Browser', available: true },
        { id: 'docs', name: 'Docs', available: true },
      ]),
      listLinkedProjectDirs: vi.fn(async () => ['/code/app']),
    };
    const narrow = { toolCapabilityVersion: 1, memory: true, mcpMode: 'allowlist', mcpServers: [], toolsetMode: 'allowlist', toolsets: [] };
    seed('canonical', null, { ...narrow, projectMode: true });
    const main = { id: 'main', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(main, deps, { persistSnapshot: false });
    expect(main.botRuntimeProfile?.projectContext).toBe(true);
    expect(main.makerMemoryScopeKey).toBeUndefined();
    // Project memory, switched by the teammate's own memory setting, not the global one.
    expect(main.makerMemoryEnabled).toBe(true);
    expect(main.makerMemorySwitchOwned).toBe(true);
    expect(deps.readMemoryIndex).not.toHaveBeenCalled();
    expect(snapshot?.disabledToolsets).toEqual([]);
    expect(main.extraDirs).toEqual(['/code/app']);
    expect(main.botProfileContextPrompt).toContain('/bots/bot/workspace');
    // It works like an ordinary task: no teammate how-to guidance on top.
    expect(main.botProfileContextPrompt).not.toContain('# 你会做什么');
    expect(main.botProfileContextPrompt).not.toContain('teammate-guide');

    seed('canonical', null, { ...narrow, projectMode: true });
    const elsewhere = { id: 'plan', agentKind: 'pi', workingDir: '/code/app', model: 'm' } as MakerSessionCreateOpts;
    const planSnapshot = await hydrateBotProfileRuntime(elsewhere, deps, { persistSnapshot: false });
    expect(elsewhere.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(planSnapshot?.disabledToolsets).toEqual([]);

    // A group lane has the same tools; whether the group may use them is the group's authorization.
    seed('group', 'group:g1', { ...narrow, projectMode: true });
    const group = { id: 'group', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const groupSnapshot = await hydrateBotProfileRuntime(group, deps, { persistSnapshot: false });
    expect(group.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(groupSnapshot?.disabledToolsets).toEqual([]);
    expect(group.botRuntimeProfile?.toolsetPolicy.configured).toEqual(['browser', 'docs']);
    // ...but shares the teammate's one project memory, not the old teammate store.
    expect(group.makerMemoryEnabled).toBe(true);
    expect(group.makerMemoryScopeKey).toBe(await resolveMemoryScopeKey(path.resolve('/bots/bot/workspace')));
    expect(deps.readMemoryIndex).not.toHaveBeenCalled();

    // An IM lane (other people) keeps the channel isolation: never the owner's ordinary-task
    // context (personal instructions, settings, Skills), only the teammate's project memory.
    seed('channel', 'im:telegram:777:g:-100123', { ...narrow, projectMode: true });
    const lane = { id: 'lane', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const laneSnapshot = await hydrateBotProfileRuntime(lane, deps, { persistSnapshot: false });
    expect(lane.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(laneSnapshot?.disabledToolsets).toEqual([]);
    expect(lane.makerMemoryScopeKey).toBe(await resolveMemoryScopeKey(path.resolve('/bots/bot/workspace')));

    // A chat-only group still gets no tools.
    seed('group', 'group:g1:access:chat:1', { ...narrow, projectMode: true });
    const chatOnly = { id: 'chat', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(chatOnly, deps, { persistSnapshot: false });
    expect(chatOnly.botRuntimeProfile?.toolsetPolicy.configured).toEqual([]);

    seed('canonical', null, narrow);
    const classic = { id: 'main', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(classic, deps, { persistSnapshot: false });
    expect(classic.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(classic.makerMemoryScopeKey).toBe('bot:bot');
    expect(classic.extraDirs).toBeUndefined();
  });

  it('still refuses read-only history links', async () => {
    seed('history', null);
    const opts = { id: 'old', agentKind: 'claude-code', workingDir: '/x', model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false })).resolves.toBeNull();
  });
});
