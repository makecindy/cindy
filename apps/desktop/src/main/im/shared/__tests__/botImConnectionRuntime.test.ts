/**
 * 伙伴自有 IM 连接运行时: 添加 → 起实例 → 交凭证建连; 连不上整条撤销(记录 + 凭证);
 * 移除 → 归档专线、解绑、清凭证、注销编排器; 停止只放实例不删记录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotImConnectionRecord } from '../../../../shared/botImConnection';

const h = vi.hoisted(() => ({
  root: '',
  ipcHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  secrets: new Map<string, string>(),
  botStatus: 'active' as string | null,
  archived: [] as string[],
  archiveCalls: [] as unknown[],
  sent: [] as Array<{ channel: string; payload: unknown }>,
  ownerKey: 'owner-a',
  drainWechat: vi.fn(async (update: () => void, isCurrent: () => boolean) => { if (isCurrent()) update(); }),
  /** 每次 Telegram setConfig 落盘前调用(测并发添加 / 建连期间切账号)。 */
  beforeTelegramSetConfig: null as (() => Promise<void> | void) | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.root },
  ipcMain: { handle: vi.fn((name: string, handler: (event: unknown, payload: unknown) => unknown) => h.ipcHandlers.set(name, handler)) },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } },
    ],
  },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.ownerKey,
  isAppSessionBoundaryPending: () => false,
}));
// 记录存储(.js 说明符)与凭证存储(无后缀说明符)解析到同一个模块: 一份 mock 同时提供两者。
vi.mock('../../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', 'owner-a', ...parts),
  ownerScopedImSecrets: {
    isAvailable: () => true,
    read: (name: string) => h.secrets.get(name) ?? null,
    readResult: (name: string) =>
      h.secrets.has(name) ? { kind: 'value', value: h.secrets.get(name) } : { kind: 'missing' },
    write: (name: string, value: string) => {
      h.secrets.set(name, value);
      return true;
    },
    remove: (name: string) => {
      h.secrets.delete(name);
    },
  },
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.botStatus === null ? [] : [{ status: h.botStatus }]) }),
        }),
      }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({ botProfiles: { id: 'id', status: 'status' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../../localDb/ipc/bots', () => ({
  archiveBotChannelLanes: vi.fn(async (input: unknown) => {
    h.archiveCalls.push(input);
    return h.archived;
  }),
}));
vi.mock('../../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: vi.fn() }));

import {
  addBotImConnection,
  buildBotImConnectionListPayload,
  configureBotImConnectionRuntime,
  registerBotImConnectionIpc,
  setWechatCompanionBinding,
  getBotFeishuTransport,
  listBotImConnectionGroups,
  removeBotImConnection,
  setBotImConnectionGroupMode,
  removeBotImConnectionsForBot,
  startBotImConnections,
  stopBotImConnections,
  __testing,
} from '../botImConnectionRuntime';
import { addBotImConnectionRecord, listBotImConnections, secretKeyPrefixFor } from '../botImConnectionStore';
import * as connectionStore from '../botImConnectionStore';
import { __testing as laneTesting } from '../botImLaneRuntime';
import { withBotProfileLocks } from '../../../maker-ipc/botProfileLock';
import { readWechatChannelSettings, writeWechatCompanionBinding, writeWechatWorkingDir } from '../../wechat/channelSettings';
import {
  adoptPersonalBot,
  configureBotImPersonalAdoption,
  __testing as adoptionTesting,
  type PersonalBotTransport,
} from '../botImPersonalAdoption';

type StatusHandler = (status: { kind: string; appId?: string }) => void;

function fakeTelegram(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: { kind: string; appId?: string; reason?: string } = { kind: 'idle' };
  const set = (next: typeof status) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  const im = {
    init: vi.fn(async () => {
      if (h.secrets.has(`${prefix}telegram-bot-token`)) set({ kind: 'connected', appId: '777' });
    }),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getConfigState: () => ({ status, ownerUserId: h.secrets.get(`${prefix}telegram-owner-user-id`) ?? null, botUsername: 'mia_bot' }),
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => {
      await h.beforeTelegramSetConfig?.();
      h.secrets.set(`${prefix}telegram-bot-token`, payload.token);
      h.secrets.set(`${prefix}telegram-owner-user-id`, payload.ownerUserId);
      if (!opts.connect) {
        h.secrets.delete(`${prefix}telegram-bot-token`);
        h.secrets.delete(`${prefix}telegram-owner-user-id`);
        set({ kind: 'error', reason: 'Unauthorized', code: 'auth' } as typeof status);
        return { status, ownerUserId: null, botUsername: null, saveErrorStatus: status };
      }
      set({ kind: 'connected', appId: '777' });
      // 原来的网关还在轮询同一个 token: Telegram 在连上之后才回 409。
      if (telegramConflictAfterConnect) setTimeout(() => set({ kind: 'conflict' }), 0);
      return { status, ownerUserId: payload.ownerUserId, botUsername: 'mia_bot' };
    }),
    disconnect: vi.fn(async () => {
      h.secrets.delete(`${prefix}telegram-bot-token`);
      h.secrets.delete(`${prefix}telegram-owner-user-id`);
      set({ kind: 'idle' });
      return { status };
    }),
  };
  return im;
}

type FakeStatus = { kind: string; appId?: string; reason?: string; code?: string };

/** 企业微信: 凭证同步落盘, 建连异步(下一拍才到终态)。 */
function fakeWecom(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}wecom-owner-user-id`) ?? '',
    presetOwnerUserId: vi.fn((ownerUserId: string) => {
      h.secrets.set(`${prefix}wecom-owner-user-id`, ownerUserId);
      return true;
    }),
    setConfig: vi.fn(async (payload: { botId: string; secret: string }) => {
      h.secrets.set(`${prefix}wecom-bot-id`, payload.botId);
      h.secrets.set(`${prefix}wecom-bot-secret`, payload.secret);
      set({ kind: 'connecting' });
      setTimeout(() => {
        if (opts.connect) set({ kind: 'connected', appId: payload.botId });
        else set({ kind: 'error', reason: 'bad secret' });
      }, 0);
      return { status, botId: payload.botId, ownerUserId: null };
    }),
    clearCredentials: vi.fn(async () => {
      h.secrets.delete(`${prefix}wecom-bot-id`);
      h.secrets.delete(`${prefix}wecom-bot-secret`);
      set({ kind: 'idle' });
      return { status, botId: null, ownerUserId: null };
    }),
  };
}

/** 钉钉: 先连通再落盘, 连不上抛错。 */
function fakeDingTalk(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}dingtalk-bot-owner-user-id`) ?? '',
    saveCredentials: vi.fn(async (payload: { appKey: string; appSecret: string }) => {
      if (!opts.connect) {
        set({ kind: 'error', reason: 'stream refused' });
        throw new Error('DINGTALK_CONNECT_FAILED');
      }
      h.secrets.set(`${prefix}dingtalk-bot-app-key`, payload.appKey);
      h.secrets.set(`${prefix}dingtalk-bot-app-secret`, payload.appSecret);
      set({ kind: 'connected', appId: payload.appKey });
      return { status, appKey: payload.appKey, ownerUserId: null };
    }),
    clearCredentials: vi.fn(async () => {
      h.secrets.delete(`${prefix}dingtalk-bot-app-key`);
      h.secrets.delete(`${prefix}dingtalk-bot-app-secret`);
      set({ kind: 'idle' });
    }),
  };
}

/** Discord: status.appId 是展示用的 bot 标签, 路由身份是 botContextId(应用 id)。 */
function fakeDiscord(prefix: string, opts: { connect: boolean }) {
  const handlers = new Set<StatusHandler>();
  let status: FakeStatus = { kind: 'idle' };
  const set = (next: FakeStatus) => {
    status = next;
    for (const handler of handlers) handler(next);
  };
  return {
    init: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    getStatus: () => status,
    get botContextId() {
      return status.kind === 'connected' ? '9001' : '';
    },
    onStatusChange: (handler: StatusHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getOwnerUserId: () => h.secrets.get(`${prefix}discord-owner-user-id`) ?? '',
    setConfig: vi.fn(async (payload: { token: string; ownerUserId: string }) => {
      if (!opts.connect) {
        set({ kind: 'error', reason: 'Invalid token', code: 'auth' });
        return { status, ownerUserId: null, saveErrorStatus: status };
      }
      h.secrets.set(`${prefix}discord-bot-token`, payload.token);
      h.secrets.set(`${prefix}discord-owner-user-id`, payload.ownerUserId);
      set({ kind: 'connected', appId: 'Mia#1234' });
      return { status, ownerUserId: payload.ownerUserId };
    }),
    disconnect: vi.fn(async () => {
      h.secrets.delete(`${prefix}discord-bot-token`);
      h.secrets.delete(`${prefix}discord-owner-user-id`);
      set({ kind: 'idle' });
      return { status };
    }),
  };
}

function fakeOrchestrator() {
  return {
    channel: 'telegram',
    turnRunner: { disposeOneSession: vi.fn(async () => undefined) },
    disposeAllSessions: vi.fn(async () => undefined),
    unregister: vi.fn(),
  };
}

const created: Array<{ record: BotImConnectionRecord; im: ReturnType<typeof fakeTelegram>; orchestrator: ReturnType<typeof fakeOrchestrator> }> = [];
const createdOther: Array<{
  record: BotImConnectionRecord;
  im: ReturnType<typeof fakeWecom> | ReturnType<typeof fakeDingTalk> | ReturnType<typeof fakeDiscord>;
  orchestrator: ReturnType<typeof fakeOrchestrator>;
}> = [];
let connectOutcome = true;
let telegramConflictAfterConnect = false;

describe('bot im connection runtime', () => {
  // Electron IPC 安全规则 §5：新增归档入口不能绕过 sender/payload 校验；旧测试只覆盖连接生命周期。
  // unit：注册真实 handler，以非法 sessionId 作为最小输入，拒绝后无归档写入。
  it('validates archive IPC payload before entering the lane runtime', async () => {
    registerBotImConnectionIpc();
    const handler = h.ipcHandlers.get('botImConnection:archive-lane')!;
    expect(handler).toBeTypeOf('function');
    expect(() => handler({}, { id: 'a1b2c3d4e5f6', sessionId: '../outside' })).toThrow(/INVALID_PARAMS/);
    expect(() => handler({}, { id: 'invalid', sessionId: 'session' })).toThrow(/INVALID_PARAMS/);
    expect(h.archiveCalls).toEqual([]);
  });

  // PR #6959: the real IPC handler must encode storage failures without leaking
  // filesystem paths, while retaining domain/owner errors. Existing coverage
  // only rejects synchronous invalid inputs. Unit: inject failure at archive
  // persistence after real connection/link ownership checks, without Electron.
  it.each([
    { failure: new Error('ARCHIVE_CAPACITY_REACHED'), code: 'PRECONDITION_FAILED', message: 'ARCHIVE_CAPACITY_REACHED' },
    { failure: new Error('OWNER_CHANGED'), code: 'PRECONDITION_FAILED', message: 'OWNER_CHANGED' },
    { failure: new Error("EACCES: permission denied, open '/private/owners/secret/bot-im-connections.json'"), code: 'INTERNAL', message: 'LANE_ARCHIVE_FAILED' },
    { failure: new Error('EPERM: operation not permitted, rename C:\\Users\\private-owner\\bot-im-connections.json'), code: 'INTERNAL', message: 'LANE_ARCHIVE_FAILED' },
  ])('normalizes archive persistence failure to $code ($message)', async ({ failure, code, message }) => {
    const record = await addBotImConnectionRecord({ botId: 'bot-mia', channel: 'telegram' });
    await connectionStore.updateBotImConnectionRecord(record.id, { botContextId: '777' });
    laneTesting.setStore({
      listLinks: async () => [{ sessionId: 'session-1', role: 'canonical', routeKey: null }],
      readActivity: vi.fn(),
      readArchiveActivity: vi.fn(async () => ({ messageId: null, hasNewActivity: false })),
    });
    const archive = vi.spyOn(connectionStore, 'archiveBotImTaskRow').mockRejectedValueOnce(failure);
    registerBotImConnectionIpc();
    const handler = h.ipcHandlers.get('botImConnection:archive-lane')!;
    await expect(handler({}, { id: record.id, sessionId: 'session-1' })).rejects.toMatchObject({
      code, message: `[${code}] ${message}`,
    });
    expect(archive).toHaveBeenCalledOnce();
    expect(listBotImConnections()[0]?.archivedTaskRows).toBeUndefined();
  });

  it('preserves the archive IPC not-found error', async () => {
    registerBotImConnectionIpc();
    const handler = h.ipcHandlers.get('botImConnection:archive-lane')!;
    await expect(handler({}, { id: 'a1b2c3d4e5f6', sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND', message: '[NOT_FOUND] CONNECTION_NOT_FOUND',
    });
  });

  it('preserves the archive IPC owner-change rejection before persistence', async () => {
    const record = await addBotImConnectionRecord({ botId: 'bot-mia', channel: 'telegram' });
    await connectionStore.updateBotImConnectionRecord(record.id, { botContextId: '777' });
    laneTesting.setStore({
      listLinks: async () => {
        h.ownerKey = 'owner-b';
        return [{ sessionId: 'session-1', role: 'canonical', routeKey: null }];
      },
      readActivity: vi.fn(),
      readArchiveActivity: vi.fn(async () => ({ messageId: null, hasNewActivity: false })),
    });
    const archive = vi.spyOn(connectionStore, 'archiveBotImTaskRow');
    registerBotImConnectionIpc();
    const handler = h.ipcHandlers.get('botImConnection:archive-lane')!;
    await expect(handler({}, { id: record.id, sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: '[PRECONDITION_FAILED] OWNER_CHANGED',
    });
    expect(archive).not.toHaveBeenCalled();
    expect(listBotImConnections()[0]?.archivedTaskRows).toBeUndefined();
  });

  beforeEach(() => {
    h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-im-runtime-'));
    h.secrets.clear();
    h.botStatus = 'active';
    h.archived = [];
    h.archiveCalls = [];
    h.sent = [];
    h.ownerKey = 'owner-a';
    h.beforeTelegramSetConfig = null;
    created.length = 0;
    createdOther.length = 0;
    connectOutcome = true;
    telegramConflictAfterConnect = false;
    adoptionTesting.reset();
    h.drainWechat.mockClear();
    configureBotImConnectionRuntime({
      removeWechatCompanionBinding: h.drainWechat,
      create: (record) => {
        const prefix = secretKeyPrefixFor(record.id);
        const orchestrator = fakeOrchestrator();
        if (record.channel === 'telegram') {
          const im = fakeTelegram(prefix, { connect: connectOutcome });
          created.push({ record, im, orchestrator });
          return { kind: 'telegram', im: im as never, orchestrator: orchestrator as never };
        }
        const im =
          record.channel === 'wecom'
            ? fakeWecom(prefix, { connect: connectOutcome })
            : record.channel === 'dingtalk'
              ? fakeDingTalk(prefix, { connect: connectOutcome })
              : fakeDiscord(prefix, { connect: connectOutcome });
        createdOther.push({ record, im, orchestrator });
        return { kind: record.channel, im: im as never, orchestrator: orchestrator as never } as never;
      },
      settingsIdentity: () => ({
        telegramToken: h.secrets.get('telegram-bot-token') ?? null,
        feishuAppId: null,
        wecomBotId: h.secrets.get('wecom-bot-id') ?? null,
        dingtalkAppKey: h.secrets.get('dingtalk-bot-app-key') ?? null,
        discordToken: h.secrets.get('discord-bot-token') ?? null,
      }),
      listKnownGroups: async () => [{ chatId: '-1001', chatName: 'Dev Group' }],
    });
  });

  // #6439: persisted connections can fail init and remain in instances. Exercise
  // the real store/start/select lifecycle (unit) instead of a selector replica.
  it('skips failed and ownerless Feishu connections without changing the resolved recipient', async () => {
    const states = [
      { kind: 'error', owner: 'ou_failed' },
      { kind: 'connected', owner: null },
      { kind: 'connected', owner: 'ou_target' },
      { kind: 'connected', owner: 'ou_other' },
    ];
    const records: BotImConnectionRecord[] = [];
    for (let index = 0; index < states.length; index += 1) {
      records.push(await addBotImConnectionRecord({ botId: 'bot-mia', channel: 'feishu' }, { now: () => index }));
    }
    configureBotImConnectionRuntime({
      removeWechatCompanionBinding: h.drainWechat,
      create: (record) => {
        const state = states[records.findIndex((candidate) => candidate.id === record.id)]!;
        return {
          kind: 'feishu',
          im: {
            init: async () => { if (state.kind === 'error') throw new Error('startup failed'); },
            dispose: async () => undefined,
            onStatusChange: () => () => undefined,
            getStatus: () => ({ kind: state.kind }),
            getOwnerOpenId: () => state.owner,
          } as never,
          orchestrator: fakeOrchestrator() as never,
        };
      },
      settingsIdentity: () => ({ telegramToken: null, feishuAppId: null, wecomBotId: null, dingtalkAppKey: null, discordToken: null }),
      listKnownGroups: async () => [],
    });
    await startBotImConnections();
    expect(getBotFeishuTransport('bot-mia')?.getOwnerOpenId()).toBe('ou_target');
    states[2]!.kind = 'error';
    // A later tool phase must not retry a resolved target through another owner.
    expect(getBotFeishuTransport('bot-mia', 'ou_target')).toBeNull();
    expect(getBotFeishuTransport('unrelated-bot')).toBeNull();
    await stopBotImConnections();
    expect(getBotFeishuTransport('bot-mia')).toBeNull();
  });

  it('lists known groups with their per-connection activation and toggles it live', async () => {
    const added = await addBotImConnection({
      botId: 'bot-mia',
      channel: 'telegram',
      token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
      ownerUserId: '42',
    });
    const id = added.connection.id;
    expect((await listBotImConnectionGroups(id)).groups).toEqual([
      { chatId: '-1001', chatName: 'Dev Group', activation: 'mention' },
    ]);
    const on = await setBotImConnectionGroupMode(id, '-1001', 'always');
    expect(on.groups[0]?.activation).toBe('always');
    // 传输层的行为 getter 读的是记录正本: 这里立刻能看到, 不需要重启实例。
    expect(listBotImConnections()[0]?.groupActivation).toEqual({ '-1001': 'always' });
    expect(__testing.instances.get(id)?.record.groupActivation).toEqual({ '-1001': 'always' });
    const off = await setBotImConnectionGroupMode(id, '-1001', 'mention');
    expect(off.groups[0]?.activation).toBe('mention');
    expect(listBotImConnections()[0]?.groupActivation).toBeUndefined();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    laneTesting.setStore(null);
    await stopBotImConnections();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('adds a Telegram connection, hands the credentials to its own transport and records the platform id', async () => {
    const result = await addBotImConnection({
      botId: 'bot-mia',
      channel: 'telegram',
      token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      ownerUserId: '4242',
    });
    expect(created).toHaveLength(1);
    const prefix = secretKeyPrefixFor(result.connection.id);
    expect(created[0]!.im.setConfig).toHaveBeenCalledWith({ token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    expect(h.secrets.get(`${prefix}telegram-bot-token`)).toBe('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(h.secrets.has('telegram-bot-token')).toBe(false);
    expect(result.connection).toMatchObject({
      botId: 'bot-mia',
      channel: 'telegram',
      botContextId: '777',
      status: { kind: 'connected', appId: '777' },
      identity: { username: 'mia_bot', ownerUserId: '4242' },
    });
    expect(listBotImConnections()[0]?.botContextId).toBe('777');
    expect(h.sent.some((item) => item.channel === 'botImConnection:changed')).toBe(true);
    expect(__testing.instances.size).toBe(1);
  });

  it('rolls the whole connection back when the transport cannot connect', async () => {
    connectOutcome = false;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/CONNECT_FAILED: auth: Unauthorized/);
    expect(listBotImConnections()).toEqual([]);
    expect([...h.secrets.keys()]).toEqual([]);
    expect(created[0]!.im.dispose).toHaveBeenCalled();
    expect(created[0]!.orchestrator.unregister).toHaveBeenCalled();
    expect(__testing.instances.size).toBe(0);
  });

  it('refuses an inactive teammate and a token already used by the settings-page bot', async () => {
    h.botStatus = 'paused';
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/BOT_INACTIVE/);
    h.botStatus = null;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/BOT_NOT_FOUND/);
    h.botStatus = 'active';
    h.secrets.set('telegram-bot-token', '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' }),
    ).rejects.toThrow(/TOKEN_IN_USE/);
    expect(created).toHaveLength(0);
    expect(listBotImConnections()).toEqual([]);
  });

  // 回归(PR #6289 review): 查重读的凭证要到 setConfig 才落盘, 两次并发添加(另一个窗口 / 并发导入)
  // 之前都能通过查重, 给同一个 bot 建出两条连接。
  it('serializes concurrent adds of the same bot: the second one sees the first and is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.beforeTelegramSetConfig = () => gate;
    const input = { botId: 'bot-mia', channel: 'telegram' as const, token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' };
    const first = addBotImConnection(input);
    const second = addBotImConnection(input);
    await vi.waitFor(() => expect(created[0]?.im.setConfig).toHaveBeenCalled(), { interval: 5 });
    release();
    await expect(first).resolves.toMatchObject({ connection: { botId: 'bot-mia', channel: 'telegram' } });
    await expect(second).rejects.toThrow(/TOKEN_IN_USE/);
    expect(created).toHaveLength(1);
    expect(listBotImConnections()).toHaveLength(1);
    // 失败不断链: 之后的添加照常排队执行。
    await expect(addBotImConnection({ ...input, token: '2:ABCDEFGHIJKLMNOPQRSTUVWXYZ' })).resolves.toBeTruthy();
  });

  it('removes a connection: archives its lanes, disconnects, purges credentials and unregisters', async () => {
    const added = await addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    h.archived = ['lane-1', 'lane-2'];
    const removed = await removeBotImConnection(added.connection.id);
    expect(h.archiveCalls).toEqual([{ routeKeyPrefix: 'im:telegram:777:' }]);
    expect(removed.archivedSessionIds).toEqual(['lane-1', 'lane-2']);
    const inst = created[0]!;
    expect(inst.orchestrator.turnRunner.disposeOneSession).toHaveBeenCalledTimes(2);
    expect(inst.im.disconnect).toHaveBeenCalled();
    expect(inst.im.dispose).toHaveBeenCalled();
    expect(inst.orchestrator.unregister).toHaveBeenCalled();
    expect([...h.secrets.keys()]).toEqual([]);
    expect(listBotImConnections()).toEqual([]);
    expect(removed.connections).toEqual([]);
  });

  // #6492 r4318509719, unit: existing cleanup tests miss an initially unbound
  // teammate being deleted during transport drain. Use the real binding/store
  // entry and the same profile lock as botLifecycleService, with controlled gates.
  it('does not resurrect a deleted teammate when its first WeChat binding is draining', async () => {
    let release!: () => void;
    let entered!: () => void;
    const draining = new Promise<void>((resolve) => { entered = resolve; });
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const binding = setWechatCompanionBinding('bot-mia', async (commit) => {
      entered();
      await drained;
      commit();
    });
    await draining;
    const deletion = withBotProfileLocks(['bot-mia'], async () => {
      h.botStatus = 'deleting';
      await removeBotImConnectionsForBot('bot-mia');
      h.botStatus = null;
    });
    // Run until deletion either completes or waits on the binding's profile lock.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([binding, deletion]);
    expect(readWechatChannelSettings().companionBotId).toBeUndefined();
    const apply = vi.fn(async (commit: () => void) => { commit(); });
    await expect(setWechatCompanionBinding('bot-mia', apply)).rejects.toThrow('BOT_INACTIVE');
    expect(apply).not.toHaveBeenCalled();
    // A different active teammate can claim the shared connection afterwards.
    h.botStatus = 'active';
    await setWechatCompanionBinding('bot-other', apply);
    expect(readWechatChannelSettings().companionBotId).toBe('bot-other');
  });

  // Regression #6492: a WeChat-only teammate has no connection-store records.
  // unit tier: real deletion cleanup and settings store; keep shared auth and unrelated owners.
  it('clears only the deleted teammate’s WeChat assignment and broadcasts without removing authorization', async () => {
    writeWechatWorkingDir(h.root);
    writeWechatCompanionBinding('bot-mia');
    h.secrets.set('wechat_credentials_test', 'retained-test-credential');
    h.secrets.set('wechat_data_key_v1', 'retained-test-key');
    const before = readWechatChannelSettings();
    const secrets = new Map(h.secrets);
    await removeBotImConnectionsForBot('bot-other');
    expect(readWechatChannelSettings()).toEqual(before);
    expect(h.sent).toEqual([]);

    h.drainWechat.mockRejectedValueOnce(new Error('DRAIN_FAILED'));
    await expect(removeBotImConnectionsForBot('bot-mia')).rejects.toThrow('DRAIN_FAILED');
    expect(readWechatChannelSettings()).toEqual(before);
    expect(h.sent).toEqual([]);
    await removeBotImConnectionsForBot('bot-mia');
    expect(h.drainWechat).toHaveBeenCalledTimes(2);
    expect(readWechatChannelSettings()).toEqual({ version: 1, workingDir: before.workingDir, workingDirAvailable: true });
    expect(h.secrets).toEqual(secrets);
    expect(h.sent).toEqual([{ channel: 'wechatBot:channel-settings-changed', payload: readWechatChannelSettings() }]);
  });

  // Owner recall must discover only the selected teammate's persisted connections,
  // including disconnected ones, without changing the settings page's all-bot view.
  it('projects only the requested teammate connections after transports stop', async () => {
    const a = await addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    await addBotImConnection({ botId: 'bot-other', channel: 'telegram', token: '2:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    await stopBotImConnections();
    expect(buildBotImConnectionListPayload('bot-mia').connections.map(r => r.id)).toEqual([a.connection.id]);
    expect(buildBotImConnectionListPayload('absent').connections).toEqual([]);
    expect(buildBotImConnectionListPayload().connections).toHaveLength(2);
  });

  it('starts recorded connections on login, keeps records across stop, and drops them with the teammate', async () => {
    const a = await addBotImConnection({ botId: 'bot-mia', channel: 'telegram', token: '1:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '4242' });
    await stopBotImConnections();
    expect(__testing.instances.size).toBe(0);
    expect(listBotImConnections().map((r) => r.id)).toEqual([a.connection.id]);
    expect(h.secrets.has(`${secretKeyPrefixFor(a.connection.id)}telegram-bot-token`)).toBe(true);

    await startBotImConnections();
    expect(__testing.instances.size).toBe(1);
    expect(created.at(-1)!.im.init).toHaveBeenCalled();
    expect(__testing.toView(listBotImConnections()[0]!).status).toEqual({ kind: 'connected', appId: '777' });

    await removeBotImConnectionsForBot('bot-mia');
    expect(listBotImConnections()).toEqual([]);
    expect(__testing.instances.size).toBe(0);
  });

  it('adds WeCom, DingTalk and Discord connections through their own transports and records each routing identity', async () => {
    const wecom = await addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' });
    const dingtalk = await addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'ding-secret' });
    const discord = await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    expect(createdOther.map((item) => item.record.channel)).toEqual(['wecom', 'dingtalk', 'discord']);
    const [wecomIm, dingIm, discordIm] = createdOther.map((item) => item.im) as [
      ReturnType<typeof fakeWecom>,
      ReturnType<typeof fakeDingTalk>,
      ReturnType<typeof fakeDiscord>,
    ];
    expect(wecomIm.setConfig).toHaveBeenCalledWith({ botId: 'wb-1', secret: 's3cret' });
    expect(dingIm.saveCredentials).toHaveBeenCalledWith({ appKey: 'ding-key', appSecret: 'ding-secret' });
    expect(discordIm.setConfig).toHaveBeenCalledWith({ token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    // 凭证只在各自前缀下, 设置页那份键名不受影响。
    expect(h.secrets.get(`${secretKeyPrefixFor(wecom.connection.id)}wecom-bot-id`)).toBe('wb-1');
    expect(h.secrets.has('wecom-bot-id')).toBe(false);
    expect(h.secrets.has('dingtalk-bot-app-key')).toBe(false);
    expect(h.secrets.has('discord-bot-token')).toBe(false);
    // 异步建连的企业微信等到了终态再记身份; Discord 记应用 id 而不是展示用的 bot 标签。
    expect(wecom.connection).toMatchObject({ channel: 'wecom', botContextId: 'wb-1', status: { kind: 'connected' } });
    expect(dingtalk.connection).toMatchObject({ channel: 'dingtalk', botContextId: 'ding-key', status: { kind: 'connected' } });
    expect(discord.connection).toMatchObject({
      channel: 'discord',
      botContextId: '9001',
      status: { kind: 'connected', appId: 'Mia#1234' },
      identity: { username: 'Mia#1234', ownerUserId: '123456789012345678' },
    });
    expect(listBotImConnections().map((r) => r.botContextId)).toEqual(['wb-1', 'ding-key', '9001']);
  });

  it('rolls back WeCom / DingTalk / Discord connections that fail to connect, leaving no record or key', async () => {
    connectOutcome = false;
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' }),
    ).rejects.toThrow(/CONNECT_FAILED: bad secret/);
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'ding-secret' }),
    ).rejects.toThrow(/CONNECT_FAILED: DINGTALK_CONNECT_FAILED/);
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' }),
    ).rejects.toThrow(/CONNECT_FAILED: auth: Invalid token/);
    expect(listBotImConnections()).toEqual([]);
    expect([...h.secrets.keys()]).toEqual([]);
    expect(createdOther).toHaveLength(3);
    for (const item of createdOther) {
      expect(item.im.dispose).toHaveBeenCalled();
      expect(item.orchestrator.unregister).toHaveBeenCalled();
    }
    expect(__testing.instances.size).toBe(0);
  });

  it('refuses a WeCom bot, DingTalk app or Discord token already used by the settings-page bot or another teammate', async () => {
    h.secrets.set('wecom-bot-id', 'wb-1');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' }),
    ).rejects.toThrow(/APP_IN_USE/);
    h.secrets.set('dingtalk-bot-app-key', 'ding-key');
    await expect(
      addBotImConnection({ botId: 'bot-mia', channel: 'dingtalk', appKey: 'ding-key', appSecret: 'x' }),
    ).rejects.toThrow(/APP_IN_USE/);
    await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    await expect(
      addBotImConnection({ botId: 'bot-lizi', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' }),
    ).rejects.toThrow(/TOKEN_IN_USE/);
    expect(listBotImConnections()).toHaveLength(1);
  });

  it('removes Discord via disconnect and WeCom via clearCredentials, purging only their own keys', async () => {
    const wecom = await addBotImConnection({ botId: 'bot-mia', channel: 'wecom', wecomBotId: 'wb-1', secret: 's3cret' });
    const discord = await addBotImConnection({ botId: 'bot-mia', channel: 'discord', token: 'MTAw.discord.token', ownerUserId: '123456789012345678' });
    h.secrets.set(`${secretKeyPrefixFor(wecom.connection.id)}wecom-owner-user-id`, 'zhangsan');
    await removeBotImConnection(discord.connection.id);
    expect(h.archiveCalls.at(-1)).toEqual({ routeKeyPrefix: 'im:discord:9001:' });
    expect((createdOther[1]!.im as ReturnType<typeof fakeDiscord>).disconnect).toHaveBeenCalled();
    expect([...h.secrets.keys()].some((key) => key.includes('discord'))).toBe(false);
    expect(h.secrets.get(`${secretKeyPrefixFor(wecom.connection.id)}wecom-bot-id`)).toBe('wb-1');
    await removeBotImConnection(wecom.connection.id);
    expect(h.archiveCalls.at(-1)).toEqual({ routeKeyPrefix: 'im:wecom:wb-1:' });
    expect((createdOther[0]!.im as ReturnType<typeof fakeWecom>).clearCredentials).toHaveBeenCalled();
    expect([...h.secrets.keys()]).toEqual([]);
    expect(listBotImConnections()).toEqual([]);
  });
  it('rejects a Telegram bot whose token another process starts polling right after connecting', async () => {
    telegramConflictAfterConnect = true;
    await expect(
      addBotImConnection(
        { botId: 'bot-mia', channel: 'telegram', token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '42' },
        { rejectConflictWithinMs: 50 },
      ),
    ).rejects.toThrow(/CONNECT_FAILED: conflict/);
    expect(listBotImConnections()).toEqual([]);
    expect([...h.secrets.keys()]).toEqual([]);
  });

  describe('moving the settings-page bot to a teammate', () => {
    function personalTransports() {
      const make = (): PersonalBotTransport & Record<'stop' | 'start' | 'clear', ReturnType<typeof vi.fn>> => ({
        identity: () => '@mia_bot',
        stop: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      });
      const personal = { telegram: make(), feishu: make(), wecom: make(), dingtalk: make(), discord: make() };
      configureBotImPersonalAdoption({
        isReady: () => true,
        personal,
        telegramGroupActivation: () => ({ '-1001': 'always', '-1002': 'mention' }),
      });
      return personal;
    }

    it('moves Telegram with its owner and group activation, then empties the personal bot', async () => {
      const personal = personalTransports();
      h.secrets.set('telegram-bot-token', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      h.secrets.set('telegram-owner-user-id', '42');
      const result = await adoptPersonalBot({ botId: 'bot-mia', channel: 'telegram' });
      const prefix = secretKeyPrefixFor(result.connection.id);
      expect(personal.telegram.stop.mock.invocationCallOrder[0]).toBeLessThan(created[0]!.im.setConfig.mock.invocationCallOrder[0]!);
      expect(created[0]!.im.setConfig).toHaveBeenCalledWith({ token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', ownerUserId: '42' });
      expect(listBotImConnections()[0]?.groupActivation).toEqual({ '-1001': 'always' });
      expect(h.secrets.has('telegram-bot-token')).toBe(false);
      expect(h.secrets.has('telegram-owner-user-id')).toBe(false);
      expect(h.secrets.get(`${prefix}telegram-bot-token`)).toBe('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      expect(personal.telegram.clear).toHaveBeenCalledOnce();
      expect(personal.telegram.start).not.toHaveBeenCalled();
    });

    it('restores and restarts the personal bot when the teammate connection cannot connect', async () => {
      const personal = personalTransports();
      connectOutcome = false;
      h.secrets.set('telegram-bot-token', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      h.secrets.set('telegram-owner-user-id', '42');
      const before = new Map(h.secrets);
      // Whatever the stop did to the stored keys, a failed move puts them back as they were.
      personal.telegram.stop.mockImplementation(async () => {
        h.secrets.delete('telegram-owner-user-id');
      });
      await expect(adoptPersonalBot({ botId: 'bot-mia', channel: 'telegram' })).rejects.toThrow(/CONNECT_FAILED/);
      expect(new Map(h.secrets)).toEqual(before);
      expect(personal.telegram.start).toHaveBeenCalledOnce();
      expect(personal.telegram.clear).not.toHaveBeenCalled();
      expect(listBotImConnections()).toEqual([]);
    });

    // 回归(PR #6289 review): 安全存储按当前数据主人现取, 建连期间切了账号的话, 成功分支会删掉
    // 新账号的个人 bot 凭证, 失败分支会把旧账号的快照写进新账号。
    it('leaves the personal bot alone when the account changes while the teammate connection is being added', async () => {
      for (const connect of [true, false]) {
        const personal = personalTransports();
        connectOutcome = connect;
        h.secrets.clear();
        h.ownerKey = 'owner-a';
        h.secrets.set('telegram-bot-token', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        h.secrets.set('telegram-owner-user-id', '42');
        personal.telegram.stop.mockImplementation(async () => {
          h.secrets.delete('telegram-owner-user-id');
        });
        h.beforeTelegramSetConfig = () => {
          h.ownerKey = 'owner-b';
        };
        await expect(adoptPersonalBot({ botId: `bot-${String(connect)}`, channel: 'telegram' })).rejects.toThrow(
          connect ? /OWNER_SCOPE_CHANGED/ : /CONNECT_FAILED/,
        );
        // 没删(成功分支)、也没把快照写回(失败分支): 存储保持 stop 之后的样子。
        expect(h.secrets.get('telegram-bot-token')).toBe('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        expect(h.secrets.has('telegram-owner-user-id')).toBe(false);
        expect(personal.telegram.clear).not.toHaveBeenCalled();
        expect(personal.telegram.start).not.toHaveBeenCalled();
        await stopBotImConnections();
      }
    });

    it('keeps the WeCom owner already recognised by the personal bot', async () => {
      personalTransports();
      h.secrets.set('wecom-bot-id', 'wb-1');
      h.secrets.set('wecom-bot-secret', 's3cret');
      h.secrets.set('wecom-owner-user-id', 'zhangsan');
      const result = await adoptPersonalBot({ botId: 'bot-mia', channel: 'wecom' });
      expect(h.secrets.get(`${secretKeyPrefixFor(result.connection.id)}wecom-owner-user-id`)).toBe('zhangsan');
      expect([...h.secrets.keys()].filter((key) => key.startsWith('wecom-'))).toEqual([]);
    });
  });
});
