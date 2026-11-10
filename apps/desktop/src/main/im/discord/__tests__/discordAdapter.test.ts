/**
 * Discord adapter characterization test — pins the host-side contract used by
 * the shared IM orchestrator.
 */
import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const scopeMocks = vi.hoisted(() => ({
  owner: 'local-v1',
  root: '',
  join: null as unknown as (...parts: string[]) => string,
  claimLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'xdt-discord-adapter-test')),
  },
}));

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    scopeMocks.join(scopeMocks.root, 'owners', scopeMocks.owner, ...parts),
  claimLegacyImPath: scopeMocks.claimLegacy,
}));

import { DiscordIM, type DiscordIMOptions, type IMHost, type IMMessageEvent } from '@cindy/im';
import { buildDiscordAdapter } from '../adapter';

const fakeIm = { getOwnerUserId: () => '1', captureTools: () => ({ assertCurrent() {}, history: async () => ({ messages: [], incomplete: false }) }) } as unknown as DiscordIM;
const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};

// unit: a delivered text receipt must also protect best-effort media across an awaited
// channel fetch. Existing transport tests did not exercise the adapter's terminal media loop.
describe('discord terminal media lease', () => {
  it.each(['remove-member-access', 'revoke-and-regrant'] as const)('does not upload after %s during channel fetch', async change => {
    type Factory = NonNullable<DiscordIMOptions['gatewayFactory']>;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-discord-final-media-'));
    const file = path.join(root, 'answer.txt'); fs.writeFileSync(file, 'fixture');
    const secrets = new Map([['discord-bot-token', 'fake-not-a-token'], ['discord-owner-user-id', '1'], ['discord-bot-lifecycle-announcement', 'false']]);
    let contents: string | null = null;
    let allowMembers = true;
    let revision = 'grant-1';
    let events!: Parameters<Factory>[0];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const post = vi.fn(async () => ({ id: '90' }));
    const channel = { id: '30', guildId: '10', parentId: '20', type: 11,
      isTextBased: () => true, isSendable: () => true, messages: {},
      permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({ id: '91' })) };
    const sdk = { user: { id: '2' }, rest: { post }, channels: { fetch: async () => {
      if (post.mock.calls.length) { entered.resolve(); await release.promise; }
      return channel;
    } } };
    const host: IMHost = {
      secrets: { read: key => secrets.get(key) ?? null, write: () => true, remove() {}, isAvailable: () => true },
      ipc: { handle() {}, broadcast() {}, throwIpcError() { throw new Error('invalid'); } },
      paths: { feishuMediaDir: root }, httpPostForm: async () => ({ status: 200, body: {} }),
    };
    const im = new DiscordIM(host, {
      finalTextStorage: () => ({ key: 'test-owner', read: () => contents, write: value => { contents = value; }, assertCurrent() {}, authorizationStamp: () => revision }),
      channelAccess: { read: () => ({ channels: [{ guildId: '10', channelId: '20', allowMembers }] }) },
      gatewayFactory: ev => {
        events = ev;
        return { appId: '2', botTag: 'fake', client: sdk, connect: async () => ev.onStatus({ kind: 'connected', appId: 'fake' }), destroy: async () => {} } as unknown as ReturnType<Factory>;
      },
    });
    try {
      await im.init();
      const received = new Promise<void>(resolve => im.onMessage(() => resolve()));
      events.onGuildMessage({ id: '8', guildId: '10', channelId: '30', channel, author: { id: '3', username: 'Member' }, content: '<@2> question', mentions: { has: () => true } } as never);
      await received;
      const output = buildDiscordAdapter(im, CONFIG, { companionBotId: 'test-companion' }).output;
      if (output.kind !== 'rich-card' || !output.commitFinal) throw new Error('missing terminal sink');
      const completion = output.commitFinal({ inputMessageId: '30|8', userId: 'g/10/20/30', text: 'answer', terminal: 'done', mediaAbsPaths: [file] });
      await entered.promise;
      expect(post).toHaveBeenCalledTimes(1);
      allowMembers = false;
      if (change === 'revoke-and-regrant') { revision = 'grant-2'; allowMembers = true; }
      release.resolve();
      await expect(completion).rejects.toMatchObject({ code: 'DISCORD_REPLY_ANCHOR_CHANGED' });
      expect(channel.send).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await im.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('discord ImChannelAdapter characterization', () => {
  const adapter = buildDiscordAdapter(fakeIm, CONFIG);
  scopeMocks.root = path.join(os.tmpdir(), 'xdt-discord-adapter-test');
  scopeMocks.join = path.join;

  it('channel / source are discord and the adapter is not thread scoped', () => {
    expect(adapter.channel).toBe('discord');
    expect(adapter.sessions.source).toBe('discord');
    expect(adapter.sessions.workspaceKind).toBe('dialogue');
    expect(adapter.threadScoped).toBeUndefined();
  });

  it('session id is discord_{appId}_{userId}', () => {
    expect(adapter.sessions.sessionIdFor('app_123', '9876543210')).toBe(
      'discord_app_123_9876543210',
    );
  });

  it('uses shared IM insert columns', () => {
    expect(adapter.sessions.extraInsertColumns('app_123', '9876543210')).toEqual({
      imBotContextId: 'app_123',
      imUserId: '9876543210',
    });
  });

  it('reads the current routing identity rather than the status display tag', () => {
    let appId = 'application-1';
    const im = {
      get botContextId() { return appId; },
      getStatus: () => ({ kind: 'connected', appId: 'display#0000' }),
    } as unknown as DiscordIM;
    const current = buildDiscordAdapter(im, CONFIG);
    expect(current.getBotContextId?.()).toBe('application-1');
    appId = 'application-2';
    expect(current.getBotContextId?.()).toBe('application-2');
  });

  it('vendorOptions inject discordChatId + source=discord', () => {
    expect(adapter.buildVendorOptions('9876543210')).toEqual({
      discordChatId: '9876543210',
      source: 'discord',
    });
  });

  it('title, generated title prefix, and processing emoji match Discord contract', () => {
    expect(adapter.sessions.defaultTitle('9876543210')).toBe('Discord · 543210');
    expect(adapter.sessions.generatedTitlePrefix).toBe('Discord · ');
    expect(adapter.processingEmoji).toBe('👩🏻‍💻');
    expect(adapter.queuedEmoji).toBe('👀');
  });

  it('workingDir = userData/im-working-dir/discord-{appId}', () => {
    const dir = adapter.sessions.ensureWorkingDir('app_123');
    expect(dir).toBe(
      path.join(
        os.tmpdir(),
        'xdt-discord-adapter-test',
        'owners',
        'local-v1',
        'im-working-dir',
        'discord-app_123',
      ),
    );
    expect(scopeMocks.claimLegacy).toHaveBeenCalledWith(
      path.join(os.tmpdir(), 'xdt-discord-adapter-test', 'im-working-dir', 'discord-app_123'),
      dir,
    );
  });
});

describe('discord teammate-owned connection', () => {
  it('maps only the configured owner to the teammate main task', () => {
    const im = { getOwnerUserId: () => '123456789012345678', botContextId: '9001' } as unknown as DiscordIM;
    const adapter = buildDiscordAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    expect(adapter.companionLane?.('123456789012345678')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('42')).toEqual({ kind: 'guest-dm', userId: '42' });
    const unset = buildDiscordAdapter({ getOwnerUserId: () => '' } as unknown as DiscordIM, CONFIG, { companionBotId: 'bot-mia' });
    expect(unset.companionLane?.('123456789012345678')).toEqual({ kind: 'guest-dm', userId: '123456789012345678' });
  });
});

describe('discord server channel lanes', () => {
  const LANE = 'g/200000000000000001/300000000000000001';
  const THREAD_LANE = `${LANE}/400000000000000001`;
  const adapter = buildDiscordAdapter(fakeIm, CONFIG);
  const event = (senderId: string, isOwner = true): IMMessageEvent =>
    ({
      senderId,
      messageId: `${senderId}|m1`,
      contextId: 'app_123',
      chatId: '300000000000000001',
      text: 'hi',
      attachments: [], unsupported: [],
      speaker: { id: '1', name: 'Owner', isOwner },
    }) as unknown as IMMessageEvent;

  it('keeps DM session ids and gives each lane / thread its own session and managed directory', () => {
    expect(adapter.sessions.sessionIdFor('app_123', LANE)).toBe(
      'discord_app_123_g-200000000000000001-300000000000000001',
    );
    expect(adapter.sessions.sessionIdFor('app_123', THREAD_LANE)).not.toBe(
      adapter.sessions.sessionIdFor('app_123', LANE),
    );
    const root = path.join(os.tmpdir(), 'xdt-discord-adapter-test', 'owners', 'local-v1', 'im-working-dir');
    const dm = adapter.sessions.ensureWorkingDir('app_123');
    const channel = adapter.sessions.ensureWorkingDir('app_123', LANE);
    const thread = adapter.sessions.ensureWorkingDir('app_123', THREAD_LANE);
    const otherBot = adapter.sessions.ensureWorkingDir('app_999', LANE);
    expect(channel).toBe(path.join(root, 'discord-app_123-g-200000000000000001-300000000000000001'));
    expect(thread).toBe(`${channel}-400000000000000001`);
    expect(new Set([dm, channel, thread, otherBot]).size).toBe(4);
    // 目录是并列的，不是私聊目录的子目录；DM 目录不受 userId 参数影响。
    expect(channel.startsWith(`${dm}${path.sep}`)).toBe(false);
    expect(adapter.sessions.ensureWorkingDir('app_123', '9876543210')).toBe(dm);
  });

  it('routes a lane to a teammate group lane, never to the owner DM main task', () => {
    const im = { getOwnerUserId: () => '123456789012345678' } as unknown as DiscordIM;
    const teammate = buildDiscordAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    expect(teammate.companionLane?.(LANE)).toEqual({
      kind: 'group',
      chatId: '300000000000000001',
      threadId: '',
    });
    expect(teammate.companionLane?.(THREAD_LANE)).toEqual({
      kind: 'group',
      chatId: '300000000000000001',
      threadId: '400000000000000001',
    });
  });

  it('blocks desktop-task takeover and project switching only for lanes', () => {
    expect(adapter.blocksLocalTaskAccess?.(LANE)).toBe(true);
    expect(adapter.blocksLocalTaskAccess?.(THREAD_LANE)).toBe(true);
    expect(adapter.blocksLocalTaskAccess?.('9876543210')).toBe(false);
  });

  it('attaches a confirmation policy to lane turns but not DMs, and only the owner turn may skip it under Full Access', () => {
    const owner = adapter.turnPermissionPolicyFor!(event(LANE))!;
    const member = adapter.turnPermissionPolicyFor!(event(LANE, false))!;
    expect(owner).toMatchObject({ origin: { kind: 'im', channel: 'discord' }, confirmationSurface: 'channel' });
    expect(owner.autoReviewContext).toMatchObject({ requesterAuthority: 'owner' });
    expect(member.autoReviewContext).toMatchObject({ requesterAuthority: 'guest' });
    expect(adapter.turnPermissionPolicyFor?.({ ...event('9876543210'), speaker: undefined })).toBeUndefined();
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', owner)).toBe(true);
    expect(adapter.turnPolicyOptionalForMode?.('bypassPermissions', member)).toBe(false);
    expect(adapter.turnPolicyOptionalForMode?.('auto', owner)).toBe(false);
  });

  it('limits history retrieval to the lane (no cross-lane or DM access)', () => {
    const lane = adapter.groupHistoryAccessFor?.(event(LANE));
    expect(lane).toMatchObject({
      access: 'lane',
      provider: 'discord-personal:app_123',
      lane: { chatId: '300000000000000001', threadId: '' },
    });
    expect(adapter.groupHistoryAccessFor?.(event(THREAD_LANE))?.lane).toMatchObject({
      chatId: '300000000000000001',
      threadId: '400000000000000001',
    });
    expect(adapter.groupHistoryAccessFor?.(event('9876543210'))).toBeUndefined();
  });

  it('labels the speaker for lane turns and leaves DM text untouched', async () => {
    const turn = await adapter.prepareAgentTurnText?.(event(LANE));
    expect(turn?.agentText).toContain('[发言人] Owner · id:1 · 主人\nhi');
    expect(await adapter.prepareAgentTurnText?.({ ...event('9876543210'), speaker: undefined })).toBeNull();
  });

  it('teammate connection follows the teammate permission mode: owner turns carry no policy, member turns only confirm destructive actions', () => {
    const im = { getOwnerUserId: () => '1' } as unknown as DiscordIM;
    const teammate = buildDiscordAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    expect(teammate.turnPermissionPolicyFor?.(event(LANE))).toBeUndefined();
    const member = teammate.turnPermissionPolicyFor!(event(LANE, false))!;
    expect(member.autoReviewContext).toMatchObject({ requesterAuthority: 'guest' });
    // 完全访问是主人对伙伴的明确授权: 成员轮次同样取缔策略而不是拒跑。
    expect(teammate.turnPolicyOptionalForMode?.('bypassPermissions', member)).toBe(true);
    expect(teammate.turnPolicyOptionalForMode?.('auto', member)).toBe(false);
  });
});
