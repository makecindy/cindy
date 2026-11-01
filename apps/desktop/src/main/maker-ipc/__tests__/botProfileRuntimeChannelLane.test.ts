import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: { select: () => {
  const q: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) q[method] = () => q;
  q.limit = async () => state.rows.shift() ?? [];
  return q;
} } }) }));

import { hydrateBotProfileRuntime } from '../botProfileRuntime';
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
    // An unbound guest under the default 'shared' policy (#8359).
    const snapshot = await hydrateBotProfileRuntime(opts, { resolveGuestAccess: async () => ({ kind: 'shared' }) }, { persistSnapshot: false });
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

  it('still refuses read-only history links', async () => {
    seed('history', null);
    const opts = { id: 'old', agentKind: 'claude-code', workingDir: '/x', model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false })).resolves.toBeNull();
  });
});

// #8359: the owner bound this guest to a project. Its lane must not see the
// teammate's memory, Home or the owner's USER.md; a refused guest never starts.
describe('guest-DM lanes bound to a project', () => {
  const bound = {
    kind: 'bound' as const,
    route: { channel: 'telegram', botContextId: '777', guestId: '555' },
    projectPath: '/work/client-a',
    memoryScopeKey: 'bot:bot:guest:telegram:555',
  };

  it('isolates memory, file surface and owner profile', async () => {
    seed('channel', 'im:telegram:777:dm:555', { memory: true, userContextSource: 'Owner: Takeshi', mcpMode: 'inherit', toolsetMode: 'inherit' });
    const readMemoryIndex = vi.fn(async () => '- guest note');
    const opts = {
      id: 'lane', agentKind: 'claude-code', workingDir: '/work/client-a', model: 'm',
      extraDirs: ['/owner/secret'], writableDirs: ['/owner/secret'],
    } as unknown as MakerSessionCreateOpts;
    await hydrateBotProfileRuntime(opts, {
      resolveGuestAccess: async () => bound,
      readMemoryIndex,
      readProfileFolder: async () => ({ homeDir: '/bots/bot', contentWritableDirs: ['/bots/bot/workspace'], systemPromptOverride: '' }),
    }, { persistSnapshot: false });
    expect(opts.makerMemoryScopeKey).toBe('bot:bot:guest:telegram:555');
    expect(readMemoryIndex).toHaveBeenCalledWith('bot:bot:guest:telegram:555');
    expect(readMemoryIndex).not.toHaveBeenCalledWith('bot:bot');
    expect(opts.workingDir).toBe('/work/client-a');
    // The harness sandbox enforces the project boundary (#8359).
    expect(opts.workspaceConfinement).toBe('project');
    expect(opts.extraDirs ?? []).toEqual([]);
    expect(opts.writableDirs ?? []).toEqual([]);
    expect(prompt(opts)).not.toContain('/bots/bot');
    expect(opts.botUserProfilePrompt ?? '').not.toContain('Takeshi');
  });

  it('refuses a guest the owner has not let in', async () => {
    seed('channel', 'im:telegram:777:dm:556');
    const opts = { id: 'lane', agentKind: 'claude-code', workingDir: '/x', model: 'm' } as MakerSessionCreateOpts;
    await expect(hydrateBotProfileRuntime(opts, {
      resolveGuestAccess: async () => ({ kind: 'refused', route: bound.route, reason: 'unbound' }),
    }, { persistSnapshot: false })).rejects.toMatchObject({ code: 'BOT_GUEST_ACCESS_REFUSED' });
  });
});
