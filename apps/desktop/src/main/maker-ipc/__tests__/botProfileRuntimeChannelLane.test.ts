import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], snapshots: [] as Array<{ resolvedJson: string }> }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: { select: () => {
  const q: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) q[method] = () => q;
  q.limit = async () => state.rows.shift() ?? [];
  return q;
} }, tx: async (_name: string, payload: { snapshot: { resolvedJson: string } }) => { state.snapshots.push(payload.snapshot); } }) }));

import { hydrateBotProfileRuntime } from '../botProfileRuntime';
import { MemoryStorage, memoryScopeDirName, resolveMemoryScopeKey } from '@cindy/maker-core';
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
  // Unit: an owner's group project differs from the teammate workspace. Verify the
  // actual session options consumed by all three adapters (bot-group-chat §7.5).
  // A member's tools lane in the same project folder gets the same context (owner 2026-11-22).
  it.each([
    ['codex', 'group:g1:access:owner:1'], ['pi', 'group:g1:access:owner:1'],
    ['claude-code', 'group:g1:access:owner:1'], ['codex', 'group:g1:access:tools:1:mask:member-1'],
  ] as const)('keeps teammate skills and memory in a group project on %s (%s)', async (agentKind, routeKey) => {
    seed('group', routeKey, { projectMode: true, memory: true });
    const opts = { id: 'lane', agentKind, workingDir: path.resolve('/projects/group'), model: 'm' } as MakerSessionCreateOpts;
    const skill = { name: 'review', description: 'Review rules', path: '/bots/bot/workspace/skills/review' };
    await hydrateBotProfileRuntime(opts, {
      readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }),
      listOwnSkills: async () => ({ pluginRoot: '/projection', skills: [skill] }),
    }, { persistSnapshot: false });
    expect(opts.botRuntimeProfile?.projectContext).toBe(true);
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toEqual([skill]);
    expect(opts.makerMemoryEnabled).toBe(true);
    // Native project memory still resolves from the unchanged group working directory.
    expect(opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(opts.workingDir)).toBe(path.resolve('/projects/group'));
    expect(prompt(opts)).toContain(JSON.stringify(path.resolve('/bots/bot/workspace', '.cindy', 'memory')));
  });

  // Review P2 (#12128): a tools lane without a group project runs in its own dialogue workspace outside
  // Home. That is not a project, so it keeps the teammate's one project memory instead of a private one.
  it('keeps the teammate project memory for a group lane in a dialogue workspace', async () => {
    seed('group', 'group:g1:access:tools:1:mask:member-1', { projectMode: true, memory: true });
    const opts = { id: 'lane', agentKind: 'codex', workingDir: path.resolve('/dialogues/lane-1'), workspaceKind: 'dialogue', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, {
      readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }),
    }, { persistSnapshot: false });
    expect(opts.botRuntimeProfile?.projectContext).toBe(true);
    expect(opts.makerMemoryScopeKey).toBe(await resolveMemoryScopeKey(path.resolve('/bots/bot/workspace')));
  });

  // Integration: rehydrate the same owner group twice with same-named memory records.
  // A replacement of the project scope loses the original record on the first or resumed turn.
  it('preserves separate on-disk group and teammate records across rehydration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'group-memory-'));
    try {
      const group = path.join(root, 'group');
      const home = path.join(root, 'bot');
      const personal = path.join(home, 'workspace', '.cindy', 'memory');
      await mkdir(group);
      await mkdir(personal, { recursive: true });
      const groupKey = await resolveMemoryScopeKey(group);
      const groupStore = new MemoryStorage(path.join(root, 'maker-memory', memoryScopeDirName(groupKey)));
      await groupStore.init(groupKey);
      const record = { type: 'project' as const, name: 'rule', title: 'rule', description: 'group rule', body: 'group first' };
      await groupStore.write(record);
      const personalFile = path.join(personal, 'project_rule.md');
      await writeFile(personalFile, 'teammate first');
      for (const turn of [1, 2]) {
        seed('group', 'group:g1:access:owner:1', { projectMode: true, memory: true });
        const opts = { id: 'lane', agentKind: 'codex', workingDir: group, model: 'm' } as MakerSessionCreateOpts;
        await hydrateBotProfileRuntime(opts, {
          readProfileFolder: async () => ({ homeDir: home, systemPromptOverride: '', contentWritableDirs: [path.join(home, 'workspace')] }),
        }, { persistSnapshot: false });
        const key = opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(opts.workingDir);
        const store = new MemoryStorage(path.join(root, 'maker-memory', memoryScopeDirName(key)));
        await store.init(key);
        expect(await readFile(path.join(store.dir, 'project_rule.md'), 'utf8')).toContain(turn === 1 ? 'group first' : 'group second');
        expect(prompt(opts)).toContain(JSON.stringify(personal));
        expect(opts.writableDirs).toContain(path.join(home, 'workspace'));
        expect(await readFile(personalFile, 'utf8')).toBe(turn === 1 ? 'teammate first' : 'teammate second');
        if (turn === 1) {
          await store.write({ ...record, mode: 'update', body: 'group second' });
          await writeFile(personalFile, 'teammate second');
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Unit: a failed skill directory read used to be reported as a fully applied profile.
  it('marks a channel runtime degraded when its teammate skills cannot be enumerated', async () => {
    seed('channel', 'im:telegram:777:dm:555');
    const opts = { id: 'lane', agentKind: 'codex', workingDir: '/projects/group', model: 'm' } as MakerSessionCreateOpts;
    const snapshot = await hydrateBotProfileRuntime(opts, {
      listOwnSkills: async () => { throw new Error('unreadable skill directory'); },
    }, { persistSnapshot: false });
    expect(snapshot?.resolutionStatus).toBe('degraded');
  });

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

  // PR #12070 review: the Bot snapshot is frozen for the session and taken before the Agent launch
  // prepares; startup only warms the shared Skill preparation, so hydration must join it first.
  it('joins shared Skill preparation before listing the Bot skill catalog', async () => {
    seed('channel', 'im:telegram:777:dm:555', { skillMode: 'allowlist', skills: ['personal'] });
    const opts = { id: 'lane', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    const order: string[] = [];
    await hydrateBotProfileRuntime(opts, {
      prepareSharedSkills: async () => { order.push('prepare'); },
      listSkills: async () => {
        order.push('list');
        return [{ name: 'personal', path: '/personal/SKILL.md' }];
      },
      fingerprintSkillSource: async () => 'a'.repeat(64),
    }, { persistSnapshot: false });
    expect(order).toEqual(['prepare', 'list']);
    expect(opts.botRuntimeProfile?.skillPolicy.configured).toEqual(['personal']);
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

  // Tier 1: a scheduler opened the group session without imessageChatId after restart.
  // Later family input then had a valid per-turn scope but no archive tool in its harness.
  it('mounts iMessage tools for a saved dedicated lane on scheduler-first startup', async () => {
    seed('channel', 'im:imessage:imessage-abcd:g:any;+;group');
    const opts = { id: 'lane', agentKind: 'codex', workingDir: '/bots/bot/workspace', model: 'm',
      vendorOptions: { source: 'scheduler' } } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false });
    expect(opts.vendorOptions).toEqual({ source: 'scheduler', [BOT_IM_CHANNELS_VENDOR_KEY]: ['imessage'] });
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
    // Its conversation with its owner saves through cindy_memory (2026-11-21 teammate review).
    expect(main.makerMemorySaveWithTool).toBe(true);
    expect(deps.readMemoryIndex).not.toHaveBeenCalled();
    expect(snapshot?.disabledToolsets).toEqual([]);
    expect(main.extraDirs).toEqual(['/code/app']);
    expect(main.botProfileContextPrompt).toContain('/bots/bot/workspace');
    // It works like an ordinary task: no teammate how-to guidance on top.
    expect(main.botProfileContextPrompt).not.toContain('# 你会做什么');
    expect(main.botProfileContextPrompt).not.toContain('teammate-guide');

    // 分工 elsewhere is an ordinary task in that folder too, still on the teammate's one project memory.
    seed('canonical', null, { ...narrow, projectMode: true });
    const elsewhere = { id: 'plan', agentKind: 'pi', workingDir: '/code/app', model: 'm' } as MakerSessionCreateOpts;
    const planSnapshot = await hydrateBotProfileRuntime(elsewhere, deps, { persistSnapshot: false });
    expect(elsewhere.botRuntimeProfile?.projectContext).toBe(true);
    expect(planSnapshot?.disabledToolsets).toEqual([]);
    expect(elsewhere.makerMemoryScopeKey).toBe(await resolveMemoryScopeKey(path.resolve('/bots/bot/workspace')));

    // Regression (owner 2026-11-22, iMessage · Niny lane had no plugin roster, host prompt or project
    // Skills): no session of a V2 teammate is an "isolated lane". Other people's IM chats and group lanes,
    // whoever spoke, run as the same ordinary project task; permissions stay with the permission tier.
    for (const [role, routeKey] of [
      ['group', 'group:g1'],
      ['group', 'group:g1:access:tools:2:mask:member-1'],
      ['channel', 'im:telegram:777:g:-100123'],
      ['channel', 'im:imessage:imessage-1:dm:any;-;+8613000000000'],
    ] as const) {
      seed(role, routeKey, { ...narrow, projectMode: true });
      const lane = { id: 'lane', agentKind: 'pi', workingDir: path.resolve('/bots/bot/workspace'), model: 'm' } as MakerSessionCreateOpts;
      const laneSnapshot = await hydrateBotProfileRuntime(lane, deps, { persistSnapshot: false });
      expect(lane.botRuntimeProfile?.projectContext, routeKey).toBe(true);
      expect(laneSnapshot?.disabledToolsets, routeKey).toEqual([]);
      expect(lane.botRuntimeProfile?.toolsetPolicy.configured, routeKey).toEqual(['browser', 'docs']);
      // The teammate's one project memory, loaded natively from its workspace.
      expect(lane.makerMemoryEnabled, routeKey).toBe(true);
      expect(lane.makerMemoryScopeKey ?? await resolveMemoryScopeKey(lane.workingDir), routeKey)
        .toBe(await resolveMemoryScopeKey(path.resolve('/bots/bot/workspace')));
      expect(deps.readMemoryIndex).not.toHaveBeenCalled();
      // Only the owner's own conversations save through cindy_memory; these lanes keep the file route.
      expect(lane.makerMemorySaveWithTool, routeKey).toBeUndefined();
    }

    // A chat-only group still gets no tools.
    seed('group', 'group:g1:access:chat:1', { ...narrow, projectMode: true });
    const chatOnly = { id: 'chat', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(chatOnly, deps, { persistSnapshot: false });
    expect(chatOnly.botRuntimeProfile?.toolsetPolicy.configured).toEqual([]);
    expect(chatOnly.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(chatOnly.makerMemorySaveWithTool).toBeUndefined();

    seed('canonical', null, narrow);
    const classic = { id: 'main', agentKind: 'pi', workingDir: '/bots/bot/workspace', model: 'm' } as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(classic, deps, { persistSnapshot: false });
    expect(classic.botRuntimeProfile?.projectContext).toBeUndefined();
    expect(classic.makerMemoryScopeKey).toBe('bot:bot');
    expect(classic.extraDirs).toBeUndefined();
    expect(classic.makerMemorySaveWithTool).toBeUndefined();
  });

  // A V2 session mounts the ordinary task's MCP and plugins, so its own catalogs only shape the snapshot:
  // an unreadable catalog must not keep the teammate from answering. A classic teammate still fails closed.
  it('starts a V2 teammate when its capability catalogs cannot be read, classic teammates still refuse', async () => {
    const deps = {
      readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }),
      listMcpServers: async () => { throw new Error('catalog offline'); },
      listToolsets: async () => { throw new Error('registry offline'); },
    };
    seed('canonical', null, { memory: false, projectMode: true });
    const v2 = { id: 'main', agentKind: 'codex', workingDir: path.resolve('/bots/bot/workspace'), model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(v2, deps, { persistSnapshot: false })).resolves.not.toBeNull();
    expect(v2.botRuntimeProfile?.projectContext).toBe(true);
    seed('canonical', null, { memory: false });
    const classic = { id: 'main', agentKind: 'codex', workingDir: path.resolve('/bots/bot/workspace'), model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(classic, deps, { persistSnapshot: false })).rejects.toThrow('MCP 能力目录');
  });

  // Review (#12145): an unreadable catalog must not look like a change. Otherwise a working V2 session is
  // rebuilt at the next send, and again once the catalog recovers. Last known resources are kept.
  it('keeps the runtime epoch of a V2 teammate across an unreadable catalog and its recovery', async () => {
    const healthy = {
      readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }),
      listMcpServers: async () => [{ name: 'cindy_helper', available: true, generation: 'g1' }],
      listToolsets: async () => [{ id: 'docs', name: 'Docs', available: true, version: '1' }],
    };
    const broken = { ...healthy,
      listMcpServers: async () => { throw new Error('catalog offline'); },
      listToolsets: async () => { throw new Error('registry offline'); } };
    const run = async (deps: typeof healthy, previous?: string) => {
      seed('canonical', null, { memory: false, projectMode: true });
      state.rows.push(previous ? [{ profileVersion: 3, resolvedJson: previous }] : []);
      const opts = { id: 'main', agentKind: 'codex', workingDir: path.resolve('/bots/bot/workspace'), model: 'm' } as MakerSessionCreateOpts;
      const snapshot = await hydrateBotProfileRuntime(opts, deps as never);
      return { changed: snapshot?.runtimeEpochChanged, resolvedJson: state.snapshots.at(-1)!.resolvedJson };
    };
    const first = await run(healthy);
    const failed = await run(broken, first.resolvedJson);
    expect(failed.changed).toBe(false);
    const failedAgain = await run(broken, failed.resolvedJson);
    expect(failedAgain.changed).toBe(false);
    expect((await run(healthy, failedAgain.resolvedJson)).changed).toBe(false);
  });

  // Review (#12145): the toolset branch on its own still fails closed for a classic teammate.
  it('refuses a classic teammate whose toolset catalog alone cannot be read', async () => {
    seed('canonical', null, { memory: false });
    const classic = { id: 'main', agentKind: 'codex', workingDir: path.resolve('/bots/bot/workspace'), model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(classic, {
      readProfileFolder: async () => ({ homeDir: '/bots/bot', systemPromptOverride: '' }),
      listMcpServers: async () => [],
      listToolsets: async () => { throw new Error('registry offline'); },
    }, { persistSnapshot: false })).rejects.toThrow('工具能力目录');
  });

  it('still refuses read-only history links', async () => {
    seed('history', null);
    const opts = { id: 'old', agentKind: 'claude-code', workingDir: '/x', model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false })).resolves.toBeNull();
  });
});
