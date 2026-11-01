/**
 * main/im/shared/botImConnectionRuntime.ts
 * ---------------------------------------------------------------------------
 * 伙伴自有 IM 机器人连接的运行时: 每条记录一份传输层实例 + 一个编排器实例。
 *
 *   - 账号 IM 连接启动时(initializeImConnection)按记录逐条起实例并 init;
 *     停止时逐条 dispose 并注销编排器, 记录保留, 下次登录再起。
 *   - 伙伴页「添加平台」: 建记录 → 起实例 → 把凭证交给传输层建连; 连不上就整条撤销,
 *     不留半配置的记录。
 *   - 「移除」/ 伙伴被删: 归档这条连接的隐藏专线、释放运行时、清凭证、删记录。
 *   - 把 设置 → IM 机器人 那份个人 bot 移给伙伴走 botImPersonalAdoption.ts, 最后一步仍是
 *     这里的 addBotImConnection(带上原主人与群参与模式)。
 *
 * 传输层与编排器的具体装配由 im/index.ts 注入(configureBotImConnectionRuntime),
 * 这里不 import host.ts, 避免把 IM 子系统拽进单测收集期。
 */

import { BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import type { DingTalkIM, DiscordIM, FeishuIM, IMStatus, TelegramIM, WecomIM } from '@cindy/im';

import { createLogger } from '../../logger';
import { getDbClient } from '../../localDb/client/current';
import { archiveBotChannelLanes } from '../../localDb/ipc/bots';
import { botProfiles } from '../../localDb/schema';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { isIpcError } from '../../../shared/ipc-errors';
import { ownerScopedImSecrets } from '../ownerScopedStorage';
import { readWechatChannelSettings, writeWechatCompanionBinding } from '../wechat/channelSettings';
import {
  BOT_IM_CONNECTION_CHANGED_EVENT,
  type BotImChannel,
  type BotImConnectionAddInput,
  type BotImConnectionAddResult,
  type BotImConnectionGroupsPayload,
  type BotImConnectionListPayload,
  type BotImConnectionRecord,
  type BotImConnectionRemoveResult,
  type BotImConnectionView,
  type BotImFeishuService,
  type BotImGuestAccessUpdate,
} from '../../../shared/botImConnection';
import {
  addBotImConnectionRecord,
  isBotImChannel,
  isBotImConnectionId,
  listBotImConnections,
  listBotImConnectionsForBot,
  readBotImConnection,
  removeBotImConnectionRecord,
  secretKeyPrefixFor,
  setBotImConnectionGroupActivation,
  setBotImConnectionGuestAccess,
  isBotImGuestId,
  updateBotImConnectionRecord,
} from './botImConnectionStore';
import { linkedProjectDirectoryKey, readBotLinkedProjects } from '../../maker-ipc/botWorkbenchService';
import { ownerScopedUserDataPath } from '../../appSessionState';
import { companionConnectionRouteKeyPrefix } from './imBotBindingRoute';
import { archiveBotImConnectionLane, listBotImConnectionLanes, resetBotImConnectionLane } from './botImLaneRuntime';
import type { ImOrchestrator } from './orchestrator';

const log = createLogger('im:bot-connections');

export type BotImTransportInstance =
  | { kind: 'telegram'; im: TelegramIM; orchestrator: ImOrchestrator }
  | { kind: 'feishu'; im: FeishuIM; orchestrator: ImOrchestrator }
  | { kind: 'wecom'; im: WecomIM; orchestrator: ImOrchestrator }
  | { kind: 'dingtalk'; im: DingTalkIM; orchestrator: ImOrchestrator }
  | { kind: 'discord'; im: DiscordIM; orchestrator: ImOrchestrator };

/** 设置页那份个人 bot 当前用的各平台身份(用于拒绝同一个 bot 两处同时用); 没配为 null。 */
export interface BotImSettingsIdentity {
  telegramToken: string | null;
  feishuAppId: string | null;
  wecomBotId: string | null;
  dingtalkAppKey: string | null;
  discordToken: string | null;
}

export interface BotImConnectionRuntimeDeps {
  /** Drain the shared WeChat transport and cancel queued work before clearing its owner. */
  removeWechatCompanionBinding(update: () => void, isCurrent: () => boolean): Promise<void>;
  /** 为一条记录装配传输层 + 编排器(不 init)。渠道尚未支持时抛错。 */
  create(record: BotImConnectionRecord): BotImTransportInstance;
  /** 设置页那份个人 bot 当前用的平台身份(用于拒绝同一个 bot 两处同时用)。 */
  settingsIdentity(): BotImSettingsIdentity;
  /** 这个机器人进过的群(群窗口表里出现过的 chat); 没有群参与模式的渠道返回空。 */
  listKnownGroups(record: BotImConnectionRecord): Promise<Array<{ chatId: string; chatName: string | null }>>;
}

interface LiveInstance {
  record: BotImConnectionRecord;
  transport: BotImTransportInstance;
  offStatus: () => void;
}

/** 传输层按前缀写进安全存储的全部键名(移除连接时一并清掉)。 */
const TELEGRAM_SECRET_KEYS = [
  'telegram-bot-token',
  'telegram-owner-user-id',
  'telegram-bot-runtime-active',
  'telegram-updates-offset',
  'telegram-bot-offline',
] as const;
const FEISHU_SECRET_KEYS = [
  'feishu_bot_app_id',
  'feishu_bot_app_secret',
  'feishu_bot_service',
  'feishu_bot_owner_open_id',
  'feishu_bot_lifecycle_announcement',
] as const;
const WECOM_SECRET_KEYS = ['wecom-bot-id', 'wecom-bot-secret', 'wecom-owner-user-id'] as const;
const DINGTALK_SECRET_KEYS = [
  'dingtalk-bot-app-key',
  'dingtalk-bot-app-secret',
  'dingtalk-bot-owner-user-id',
] as const;
const DISCORD_SECRET_KEYS = [
  'discord-bot-token',
  'discord-owner-user-id',
  'discord-bot-runtime-active',
  'discord-bot-lifecycle-announcement',
] as const;
export const SECRET_KEYS_BY_CHANNEL: Record<BotImChannel, readonly string[]> = {
  telegram: TELEGRAM_SECRET_KEYS,
  feishu: FEISHU_SECRET_KEYS,
  wecom: WECOM_SECRET_KEYS,
  dingtalk: DINGTALK_SECRET_KEYS,
  discord: DISCORD_SECRET_KEYS,
};

/**
 * 各渠道「同一个 bot 已在别处连着」的判据: 设置页那份身份字段 + 本机其它连接按前缀存的
 * 同名键。凭证身份只比相等, 不读出来展示。
 */
export const IDENTITY_SECRET_KEY: Record<BotImChannel, string> = {
  telegram: 'telegram-bot-token',
  feishu: 'feishu_bot_app_id',
  wecom: 'wecom-bot-id',
  dingtalk: 'dingtalk-bot-app-key',
  discord: 'discord-bot-token',
};
const IDENTITY_IN_USE_CODE: Record<BotImChannel, string> = {
  telegram: 'TOKEN_IN_USE: this Telegram bot is already connected on this computer',
  feishu: 'APP_IN_USE: this Feishu app is already connected on this computer',
  wecom: 'APP_IN_USE: this WeCom bot is already connected on this computer',
  dingtalk: 'APP_IN_USE: this DingTalk app is already connected on this computer',
  discord: 'TOKEN_IN_USE: this Discord bot is already connected on this computer',
};

/** 企业微信建连是异步的: 交完凭证后最多等这么久看终态, 还在连就当 pending 保留连接。 */
const ASYNC_CONNECT_SETTLE_MS = 15_000;

let deps: BotImConnectionRuntimeDeps | null = null;
const instances = new Map<string, LiveInstance>();
let ipcRegistered = false;

export function configureBotImConnectionRuntime(next: BotImConnectionRuntimeDeps): void {
  deps = next;
}

function requireDeps(): BotImConnectionRuntimeDeps {
  if (!deps) throw new Error('bot im connection runtime is not configured');
  return deps;
}

function purgeSecrets(record: Pick<BotImConnectionRecord, 'id' | 'channel'>): void {
  const prefix = secretKeyPrefixFor(record.id);
  for (const key of SECRET_KEYS_BY_CHANNEL[record.channel]) ownerScopedImSecrets.remove(`${prefix}${key}`);
}

function statusOf(transport: BotImTransportInstance | undefined): IMStatus {
  return transport?.im.getStatus() ?? { kind: 'idle' };
}

/**
 * 专线 route key 用的平台身份。多数渠道就是 connected 状态里的 appId(Telegram bot id /
 * 飞书 app id / 企业微信 bot id / 钉钉 AppKey); Discord 的 status.appId 是展示用的 bot 标签,
 * 路由身份是网关拿到的应用 id(与入站 event.contextId 同源)。
 */
function routingIdentityOf(transport: BotImTransportInstance, status: IMStatus): string | null {
  if (status.kind !== 'connected') return null;
  if (transport.kind === 'discord') return transport.im.botContextId || null;
  return status.appId || null;
}

function identityOf(transport: BotImTransportInstance | undefined): BotImConnectionView['identity'] {
  if (!transport) return { username: null, ownerUserId: null };
  switch (transport.kind) {
    case 'telegram': {
      const state = transport.im.getConfigState();
      return { username: state.botUsername ?? null, ownerUserId: state.ownerUserId ?? null };
    }
    case 'feishu':
      return { username: null, ownerUserId: transport.im.getOwnerOpenId() };
    case 'wecom':
    case 'dingtalk':
      return { username: null, ownerUserId: transport.im.getOwnerUserId() || null };
    case 'discord': {
      const status = transport.im.getStatus();
      return {
        username: status.kind === 'connected' ? status.appId || null : null,
        ownerUserId: transport.im.getOwnerUserId() || null,
      };
    }
  }
}

function toView(record: BotImConnectionRecord): BotImConnectionView {
  const transport = instances.get(record.id)?.transport;
  return { ...record, status: statusOf(transport), identity: identityOf(transport) };
}

export function buildBotImConnectionListPayload(botId?: string): BotImConnectionListPayload {
  const records = botId === undefined ? listBotImConnections() : listBotImConnectionsForBot(botId);
  return { connections: records.map(toView) };
}

function broadcastChanged(): void {
  const payload = buildBotImConnectionListPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(BOT_IM_CONNECTION_CHANGED_EVENT, payload);
    } catch {
      // Best-effort UI refresh only.
    }
  }
}

function instantiate(record: BotImConnectionRecord): LiveInstance {
  const transport = requireDeps().create(record);
  const offStatus = transport.im.onStatusChange((status) => {
    // 连上后记下平台身份: 专线 route key 与移除时的归档范围都按它。
    const routingIdentity = routingIdentityOf(transport, status);
    if (routingIdentity && live.record.botContextId !== routingIdentity) {
      void updateBotImConnectionRecord(record.id, { botContextId: routingIdentity })
        .then((next) => {
          if (next) live.record = next;
        })
        .catch((err) => {
          log.warn(`bot im connection ${record.id}: persist botContextId failed: ${String(err)}`);
        });
    }
    broadcastChanged();
  });
  const live: LiveInstance = { record, transport, offStatus };
  instances.set(record.id, live);
  return live;
}

async function releaseInstance(live: LiveInstance): Promise<void> {
  live.offStatus();
  try {
    await live.transport.im.dispose();
  } catch (err) {
    log.warn(`bot im connection ${live.record.id}: dispose failed: ${String(err)}`);
  }
  live.transport.orchestrator.unregister();
  instances.delete(live.record.id);
}

/** 账号 IM 连接启动: 按记录起全部伙伴连接(各自失败只记日志, 不挡其它)。 */
export async function startBotImConnections(): Promise<void> {
  if (!deps) return;
  for (const record of listBotImConnections()) {
    if (instances.has(record.id)) continue;
    try {
      const live = instantiate(record);
      await live.transport.im.init();
    } catch (err) {
      log.error(`bot im connection ${record.id} (${record.channel}) start failed: ${String(err)}`);
    }
  }
}

/** 账号 IM 连接停止: 释放全部实例, 记录保留。 */
export async function stopBotImConnections(): Promise<void> {
  for (const live of [...instances.values()]) await releaseInstance(live);
}

export function getBotImConnectionOrchestrator(id: string): ImOrchestrator | undefined {
  return instances.get(id)?.transport.orchestrator;
}

/**
 * 某位伙伴当前在线的飞书连接(伙伴主任务出站用)。
 *
 * 伙伴主任务(role='canonical')与桌面共用、不带专线的 `feishuChatId`, 所以非飞书入站轮次
 * (后台任务回执 / 心跳 / scheduler)拿不到逐轮作用域。这些轮次必须仍走伙伴自己的连接,
 * 不能回落到设置页那份可能已被清空的个人 bot —— 否则 `getOwnerOpenId()` 为 null 时
 * `send_message_to_user` / `send_file_to_user` 会误报 NO_CHAT_CONTEXT。
 */
export function getBotFeishuTransport(botId: string, ownerOpenId?: string): FeishuIM | null {
  for (const record of listBotImConnectionsForBot(botId)) {
    if (record.channel !== 'feishu') continue;
    const live = instances.get(record.id);
    if (live?.transport.kind !== 'feishu' || live.record.botId !== botId) continue;
    const im = live.transport.im;
    const owner = im.getOwnerOpenId();
    if (im.getStatus().kind !== 'connected' || !owner) continue;
    // open_id belongs to this app. Never send a previously resolved recipient
    // through a different owner's connection after a disconnect/reconfiguration.
    if (ownerOpenId && owner !== ownerOpenId) continue;
    return im;
  }
  return null;
}

async function readBotProfileStatus(botId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ status: botProfiles.status })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  return row?.status ?? null;
}

function identityValueOf(input: BotImConnectionAddInput): string {
  switch (input.channel) {
    case 'telegram':
      return input.token;
    case 'feishu':
      return input.appId;
    case 'wecom':
      return input.wecomBotId;
    case 'dingtalk':
      return input.appKey;
    case 'discord':
      return input.token;
  }
}

function settingsIdentityValueOf(settings: BotImSettingsIdentity, channel: BotImChannel): string | null {
  switch (channel) {
    case 'telegram':
      return settings.telegramToken;
    case 'feishu':
      return settings.feishuAppId;
    case 'wecom':
      return settings.wecomBotId;
    case 'dingtalk':
      return settings.dingtalkAppKey;
    case 'discord':
      return settings.discordToken;
  }
}

/** 本机已有的伙伴连接里, 用着同一个平台身份(token / app id / bot id / AppKey)的那条; 没有为 null。 */
export function findBotImConnectionByIdentity(
  channel: BotImChannel,
  identityValue: string,
): BotImConnectionRecord | null {
  const key = IDENTITY_SECRET_KEY[channel];
  return (
    listBotImConnections().find(
      (record) =>
        record.channel === channel &&
        ownerScopedImSecrets.read(`${secretKeyPrefixFor(record.id)}${key}`) === identityValue,
    ) ?? null
  );
}

function assertNoDuplicateIdentity(input: BotImConnectionAddInput, ignoreSettings: boolean): void {
  const value = identityValueOf(input);
  const fromSettings = ignoreSettings ? null : settingsIdentityValueOf(requireDeps().settingsIdentity(), input.channel);
  const sameAsSettings = fromSettings !== null && fromSettings === value;
  const sameAsOther = findBotImConnectionByIdentity(input.channel, value) !== null;
  if (sameAsSettings || sameAsOther) {
    throwIpcError('PRECONDITION_FAILED', IDENTITY_IN_USE_CODE[input.channel]);
  }
}

export interface BotImConnectionAddOptions {
  /**
   * 把 设置 → IM 机器人 那份个人 bot 移过来: 调用方已先停掉个人 bot, 所以不按
   * 「设置页已在用」拒绝(仍拒绝已被另一位伙伴用着的)。
   */
  adoptingSettingsBot?: boolean;
  /**
   * 沿用已认定的主人: 企业微信 / 钉钉 / 飞书写进本连接, 不再等首个私聊者(TOFU)。
   * Telegram / Discord 的主人本来就在 input 里。
   */
  ownerUserId?: string;
  /** Telegram 群参与模式(chatId → always), 建连前写进记录。 */
  groupActivation?: Record<string, 'always'>;
  /**
   * 连上后这么久内转成 conflict(同一个 token 另有进程在轮询, 例如原来的网关还开着)
   * 就当没连上, 整条撤销。缺省不等。
   */
  rejectConflictWithinMs?: number;
}

/** 添加前的检查(伙伴在、可用, 平台身份没被别处用着); 移交个人 bot 前先跑一遍, 免得白停一次。 */
export async function assertBotImConnectionAddable(
  input: BotImConnectionAddInput,
  options: Pick<BotImConnectionAddOptions, 'adoptingSettingsBot'> = {},
): Promise<void> {
  const status = await readBotProfileStatus(input.botId);
  if (status === null) throwIpcError('NOT_FOUND', 'BOT_NOT_FOUND');
  if (status !== 'active') throwIpcError('PRECONDITION_FAILED', `BOT_INACTIVE: ${status}`);
  assertNoDuplicateIdentity(input, options.adoptingSettingsBot === true);
}

/**
 * 等传输层把异步建连跑到终态(connected / error / conflict / offline); 超时仍在
 * connecting 则按「还在连」返回当前状态, 由调用方决定保留。
 */
function awaitSettledStatus(
  im: Pick<BotImTransportInstance['im'], 'getStatus' | 'onStatusChange'>,
  timeoutMs: number,
): Promise<IMStatus> {
  const settled = (status: IMStatus) => status.kind !== 'connecting' && status.kind !== 'idle';
  const current = im.getStatus();
  if (settled(current)) return Promise.resolve(current);
  return new Promise<IMStatus>((resolve) => {
    let done = false;
    const finish = (status: IMStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(status);
    };
    const off = im.onStatusChange((status) => {
      if (settled(status)) finish(status);
    });
    const timer = setTimeout(() => finish(im.getStatus()), timeoutMs);
    // 订阅前已经到终态(极短窗口)。
    const now = im.getStatus();
    if (settled(now)) finish(now);
  });
}

/** 在 timeoutMs 内是否转成了 conflict(另一个进程在用同一个 token 轮询)。 */
function awaitConflict(
  im: Pick<BotImTransportInstance['im'], 'getStatus' | 'onStatusChange'>,
  timeoutMs: number,
): Promise<boolean> {
  if (im.getStatus().kind === 'conflict') return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const off = im.onStatusChange((status) => {
      if (status.kind === 'conflict') finish(true);
    });
    const timer = setTimeout(() => finish(im.getStatus().kind === 'conflict'), timeoutMs);
  });
}

function describeStatusFailure(status: IMStatus): string {
  if (status.kind === 'error') return status.code ? `${status.code}: ${status.reason}` : status.reason;
  if (status.kind === 'conflict') return 'conflict';
  return status.kind;
}

/**
 * 添加串行化: 身份查重读的是已落盘的凭证, 而凭证要等记录建好、传输层 setConfig 之后才写;
 * 两次并发添加(另一个窗口、并发导入)会都通过查重, 给同一个 bot 建出两条连接。整段(含前置
 * 检查)排进这条链, 失败不断链。只有 addBotImConnection 自己入队, 调用方先单独跑
 * assertBotImConnectionAddable 不占队列, 不会自锁。
 */
let addQueue: Promise<unknown> = Promise.resolve();

export function addBotImConnection(
  input: BotImConnectionAddInput,
  options: BotImConnectionAddOptions = {},
): Promise<BotImConnectionAddResult> {
  const run = addQueue.then(() => addBotImConnectionNow(input, options));
  addQueue = run.catch(() => undefined);
  return run;
}

async function addBotImConnectionNow(
  input: BotImConnectionAddInput,
  options: BotImConnectionAddOptions,
): Promise<BotImConnectionAddResult> {
  await assertBotImConnectionAddable(input, options);

  let record = await addBotImConnectionRecord({
    botId: input.botId,
    channel: input.channel,
    ...(input.channel === 'feishu' ? { service: input.service } : {}),
  });
  const groupActivation = input.channel === 'telegram' ? options.groupActivation : undefined;
  if (groupActivation && Object.keys(groupActivation).length > 0) {
    // 传输层的行为 getter 每次现读记录, 建连前写好, 第一条群消息就按原来的参与模式走。
    record = (await updateBotImConnectionRecord(record.id, { groupActivation })) ?? record;
  }
  let live: LiveInstance;
  try {
    live = instantiate(record);
  } catch (err) {
    await removeBotImConnectionRecord(record.id);
    throw err;
  }
  const carriedOwner = options.ownerUserId?.trim() || '';

  const rollback = async (reason: string): Promise<never> => {
    await releaseInstance(live);
    purgeSecrets(record);
    await removeBotImConnectionRecord(record.id);
    broadcastChanged();
    return throwIpcError('PRECONDITION_FAILED', `CONNECT_FAILED: ${reason}`);
  };

  const transport = live.transport;
  if (transport.kind !== input.channel) return rollback('channel mismatch');
  try {
    switch (transport.kind) {
      case 'telegram': {
        if (input.channel !== 'telegram') return rollback('channel mismatch');
        const state = await transport.im.setConfig({ token: input.token, ownerUserId: input.ownerUserId });
        const failed = state.saveErrorStatus ?? (state.status.kind === 'connected' ? null : state.status);
        if (failed) return rollback(describeStatusFailure(failed));
        break;
      }
      case 'feishu': {
        if (input.channel !== 'feishu') return rollback('channel mismatch');
        const { verdict } = await transport.im.saveCredentials({
          appId: input.appId,
          appSecret: input.appSecret,
          service: input.service as BotImFeishuService,
          ...(carriedOwner ? { ownerOpenId: carriedOwner } : {}),
        });
        if (verdict !== 'connected' && verdict !== 'pending') return rollback(verdict);
        break;
      }
      case 'wecom': {
        if (input.channel !== 'wecom') return rollback('channel mismatch');
        // 凭证落盘同步, 建连异步: 等一会儿看终态, 还在连就当 pending 保留(与飞书同口径)。
        const state = await transport.im.setConfig({ botId: input.wecomBotId, secret: input.secret });
        if (state.saveErrorStatus) return rollback(describeStatusFailure(state.saveErrorStatus));
        const settled = await awaitSettledStatus(transport.im, ASYNC_CONNECT_SETTLE_MS);
        if (settled.kind === 'error' || settled.kind === 'conflict') return rollback(describeStatusFailure(settled));
        if (carriedOwner && !transport.im.presetOwnerUserId(carriedOwner)) return rollback('secret-unavailable');
        break;
      }
      case 'dingtalk': {
        if (input.channel !== 'dingtalk') return rollback('channel mismatch');
        // 先连通再落盘, 连不上直接抛错(凭证已回滚)。
        await transport.im.saveCredentials({ appKey: input.appKey, appSecret: input.appSecret });
        const status = transport.im.getStatus();
        if (status.kind === 'error' || status.kind === 'conflict') return rollback(describeStatusFailure(status));
        // 换 AppKey 时 saveCredentials 会清主人, 所以沿用的主人在它之后写。
        if (carriedOwner && !transport.im.presetOwnerUserId(carriedOwner)) return rollback('secret-unavailable');
        break;
      }
      case 'discord': {
        if (input.channel !== 'discord') return rollback('channel mismatch');
        const state = await transport.im.setConfig({ token: input.token, ownerUserId: input.ownerUserId });
        const failed = state.saveErrorStatus ?? (state.status.kind === 'connected' ? null : state.status);
        if (failed) return rollback(describeStatusFailure(failed));
        break;
      }
    }
  } catch (err) {
    return rollback(err instanceof Error ? err.message : String(err));
  }
  if (
    options.rejectConflictWithinMs &&
    options.rejectConflictWithinMs > 0 &&
    (await awaitConflict(live.transport.im, options.rejectConflictWithinMs))
  ) {
    return rollback('conflict');
  }

  const connected = live.transport.im.getStatus();
  const routingIdentity = routingIdentityOf(live.transport, connected);
  if (routingIdentity && live.record.botContextId !== routingIdentity) {
    const next = await updateBotImConnectionRecord(record.id, { botContextId: routingIdentity });
    if (next) live.record = next;
  }
  log.info(
    `bot im connection ${record.id} (${record.channel}) added for bot=...${record.botId.slice(-8)} status=${connected.kind}`,
  );
  broadcastChanged();
  const list = buildBotImConnectionListPayload();
  const view = list.connections.find((item) => item.id === record.id) ?? toView(live.record);
  return { ...list, connection: view };
}

/** 伙伴页「群聊」小节: 已知群 + 每群参与模式(仅 @ / 全响应)。 */
export async function listBotImConnectionGroups(id: string): Promise<BotImConnectionGroupsPayload> {
  const record = readBotImConnection(id);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const groups = record.botContextId ? await requireDeps().listKnownGroups(record) : [];
  const activation = record.groupActivation ?? {};
  return {
    connectionId: id,
    groups: groups.map((group) => ({
      chatId: group.chatId,
      chatName: group.chatName,
      activation: activation[group.chatId] === 'always' ? 'always' : 'mention',
    })),
  };
}

export async function setBotImConnectionGroupMode(
  id: string,
  chatId: string,
  mode: 'mention' | 'always',
): Promise<BotImConnectionGroupsPayload> {
  const updated = await setBotImConnectionGroupActivation(id, chatId, mode);
  if (!updated) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const live = instances.get(id);
  if (live) live.record = updated;
  log.info(`bot im connection ${id}: group ${chatId.slice(-6)} activation=${mode}`);
  return listBotImConnectionGroups(id);
}

/**
 * Owner-only (#8359): bind a guest to one of the teammate's linked local
 * projects, unbind it, or choose what unbound guests get. The project must be
 * linked at the moment of binding; runtime re-checks it on every start.
 */
export async function setBotImConnectionGuestAccessForSettings(
  update: BotImGuestAccessUpdate,
): Promise<BotImConnectionListPayload> {
  const record = readBotImConnection(update.connectionId);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const projectPath = update.binding?.projectPath;
  if (projectPath) {
    const linked = (await readBotLinkedProjects(ownerScopedUserDataPath(), record.botId))
      .filter((project) => !project.deviceId)
      .find((project) => linkedProjectDirectoryKey(project.path) === linkedProjectDirectoryKey(projectPath));
    if (!linked) throwIpcError('PRECONDITION_FAILED', 'PROJECT_NOT_LINKED');
  }
  let updated: BotImConnectionRecord | null;
  try {
    updated = await setBotImConnectionGuestAccess(record.id, {
      ...(update.unbound ? { unbound: update.unbound } : {}),
      ...(update.binding ? { binding: update.binding } : {}),
    });
  } catch (error) {
    throwIpcError('INVALID_PARAMS', error instanceof Error ? error.message : 'INVALID_GUEST_ACCESS');
  }
  if (!updated) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const live = instances.get(record.id);
  if (live) live.record = updated;
  log.info(`bot im connection ${record.id}: guest access updated (bindings=${Object.keys(updated.guestAccess?.bindings ?? {}).length}, unbound=${updated.guestAccess?.unbound ?? 'shared'})`);
  broadcastChanged();
  return buildBotImConnectionListPayload();
}

export function parseBotImGuestAccessUpdate(payload: unknown): BotImGuestAccessUpdate {
  const p = (payload ?? {}) as { connectionId?: unknown; unbound?: unknown; binding?: unknown };
  if (!isBotImConnectionId(p.connectionId)) throwIpcError('INVALID_PARAMS', 'connectionId is invalid');
  const out: BotImGuestAccessUpdate = { connectionId: p.connectionId };
  if (p.unbound !== undefined) {
    if (p.unbound !== 'shared' && p.unbound !== 'refuse') throwIpcError('INVALID_PARAMS', 'unbound is invalid');
    out.unbound = p.unbound;
  }
  if (p.binding !== undefined) {
    const b = (p.binding ?? {}) as { guestId?: unknown; projectPath?: unknown };
    if (!isBotImGuestId(b.guestId)) throwIpcError('INVALID_PARAMS', 'guestId is invalid');
    if (b.projectPath !== null && typeof b.projectPath !== 'string') throwIpcError('INVALID_PARAMS', 'projectPath is invalid');
    out.binding = { guestId: b.guestId, projectPath: b.projectPath };
  }
  if (!out.unbound && !out.binding) throwIpcError('INVALID_PARAMS', 'nothing to change');
  return out;
}

export async function removeBotImConnection(id: string): Promise<BotImConnectionRemoveResult> {
  const record = readBotImConnection(id);
  if (!record) throwIpcError('NOT_FOUND', 'CONNECTION_NOT_FOUND');
  const live = instances.get(id);
  // 先归档这条连接的全部隐藏专线, 再放掉它们的运行时。
  let archivedSessionIds: string[] = [];
  if (record.botContextId) {
    try {
      archivedSessionIds = await archiveBotChannelLanes({
        routeKeyPrefix: companionConnectionRouteKeyPrefix(record.channel, record.botContextId),
      });
    } catch (err) {
      log.warn(`bot im connection ${id}: archive lanes failed: ${String(err)}`);
    }
  }
  if (live) {
    for (const sessionId of archivedSessionIds) {
      try {
        await live.transport.orchestrator.turnRunner.disposeOneSession(sessionId);
      } catch (err) {
        log.warn(`bot im connection ${id}: dispose lane ${sessionId} failed: ${String(err)}`);
      }
    }
    try {
      await live.transport.orchestrator.disposeAllSessions();
    } catch (err) {
      log.warn(`bot im connection ${id}: disposeAllSessions failed: ${String(err)}`);
    }
    try {
      // 解绑: 清命令菜单、通知主人、删凭证(传输层自己的那份)。
      const transport = live.transport;
      if (transport.kind === 'telegram' || transport.kind === 'discord') await transport.im.disconnect();
      else await transport.im.clearCredentials();
    } catch (err) {
      log.warn(`bot im connection ${id}: disconnect failed: ${String(err)}`);
    }
    await releaseInstance(live);
  }
  purgeSecrets(record);
  await removeBotImConnectionRecord(id);
  log.info(`bot im connection ${id} (${record.channel}) removed archivedLanes=${archivedSessionIds.length}`);
  broadcastChanged();
  return { ...buildBotImConnectionListPayload(), archivedSessionIds };
}

/** Keep profile validation and deferred WeChat persistence in one lifecycle operation. */
export async function setWechatCompanionBinding(
  botId: string | null,
  apply: (commit: () => void) => Promise<void>,
): Promise<void> {
  const run = async () => {
    if (botId) {
      if (await readBotProfileStatus(botId) !== 'active') throw new Error('BOT_INACTIVE');
      const current = readWechatChannelSettings().companionBotId;
      if (current && current !== botId) throw new Error('WECHAT_COMPANION_IN_USE');
    }
    await apply(() => { writeWechatCompanionBinding(botId); });
  };
  // Match deletion lock order: profile first, then the WeChat transport lifecycle.
  await withBotProfileLocks(botId ? [botId] : [], run);
}

/** 伙伴被删除 / 归档时带走它的全部连接。 */
export async function removeBotImConnectionsForBot(botId: string): Promise<void> {
  // WeChat shares the personal transport: remove only the teammate assignment,
  // even when there are no dedicated connections. Keep its authorization intact.
  if (readWechatChannelSettings().companionBotId === botId) {
    await requireDeps().removeWechatCompanionBinding(() => {
      if (readWechatChannelSettings().companionBotId !== botId) return;
      const settings = writeWechatCompanionBinding(null);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('wechatBot:channel-settings-changed', settings);
      }
    }, () => readWechatChannelSettings().companionBotId === botId);
  }
  for (const record of listBotImConnectionsForBot(botId)) {
    try {
      await removeBotImConnection(record.id);
    } catch (err) {
      log.warn(`remove bot im connection ${record.id} for bot=...${botId.slice(-8)} failed: ${String(err)}`);
    }
  }
}

/** 校验「添加平台」的入参(IPC 与导入共用); 不合法抛 INVALID_PARAMS。 */
export function parseBotImConnectionAddInput(payload: unknown): BotImConnectionAddInput {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (typeof p.botId !== 'string' || !p.botId.trim()) throwIpcError('INVALID_PARAMS', 'botId is required');
  if (!isBotImChannel(p.channel)) throwIpcError('INVALID_PARAMS', 'channel is invalid');
  const botId = p.botId.trim();
  if (p.channel === 'telegram') {
    const token = typeof p.token === 'string' ? p.token.trim() : '';
    const ownerUserId = typeof p.ownerUserId === 'string' ? p.ownerUserId.trim() : '';
    if (!/^\d{6,20}:[A-Za-z0-9_-]{20,}$/.test(token)) throwIpcError('INVALID_PARAMS', 'token is invalid');
    if (!/^\d{1,20}$/.test(ownerUserId)) throwIpcError('INVALID_PARAMS', 'ownerUserId is invalid');
    return { botId, channel: 'telegram', token, ownerUserId };
  }
  if (p.channel === 'feishu') {
    const appId = typeof p.appId === 'string' ? p.appId.trim() : '';
    const appSecret = typeof p.appSecret === 'string' ? p.appSecret.trim() : '';
    const service: BotImFeishuService = p.service === 'lark' ? 'lark' : 'feishu';
    if (!appId || appId.length > 128) throwIpcError('INVALID_PARAMS', 'appId is invalid');
    if (!appSecret || appSecret.length > 512) throwIpcError('INVALID_PARAMS', 'appSecret is invalid');
    return { botId, channel: 'feishu', appId, appSecret, service };
  }
  if (p.channel === 'wecom') {
    const wecomBotId = typeof p.wecomBotId === 'string' ? p.wecomBotId.trim() : '';
    const secret = typeof p.secret === 'string' ? p.secret.trim() : '';
    if (!wecomBotId || wecomBotId.length > 128) throwIpcError('INVALID_PARAMS', 'wecomBotId is invalid');
    if (!secret || secret.length > 512) throwIpcError('INVALID_PARAMS', 'secret is invalid');
    return { botId, channel: 'wecom', wecomBotId, secret };
  }
  if (p.channel === 'dingtalk') {
    const appKey = typeof p.appKey === 'string' ? p.appKey.trim() : '';
    const appSecret = typeof p.appSecret === 'string' ? p.appSecret.trim() : '';
    if (!appKey || appKey.length > 256) throwIpcError('INVALID_PARAMS', 'appKey is invalid');
    if (!appSecret || appSecret.length > 512) throwIpcError('INVALID_PARAMS', 'appSecret is invalid');
    return { botId, channel: 'dingtalk', appKey, appSecret };
  }
  const token = typeof p.token === 'string' ? p.token.trim() : '';
  const ownerUserId = typeof p.ownerUserId === 'string' ? p.ownerUserId.trim() : '';
  if (!token || token.length > 256 || /\s/.test(token)) throwIpcError('INVALID_PARAMS', 'token is invalid');
  if (!/^\d{1,20}$/.test(ownerUserId)) throwIpcError('INVALID_PARAMS', 'ownerUserId is invalid');
  return { botId, channel: 'discord', token, ownerUserId };
}

/** 隐藏任务小节(本机设置页与远程桌面的设置页共用): 群名沿用「群聊」小节同一份已知群。 */
const laneOptions = () => ({ knownGroups: (record: BotImConnectionRecord) => requireDeps().listKnownGroups(record) });
export const listBotImConnectionLanesForSettings = (id: string) => listBotImConnectionLanes(id, laneOptions());
export const resetBotImConnectionLaneForSettings = (id: string, sessionId: string) =>
  resetBotImConnectionLane(id, sessionId, laneOptions());

export function registerBotImConnectionIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('botImConnection:list', (e) => {
    assertTrustedAppRendererEvent(e);
    return buildBotImConnectionListPayload();
  });
  ipcMain.handle('botImConnection:add', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    return addBotImConnection(parseBotImConnectionAddInput(payload));
  });
  ipcMain.handle('botImConnection:remove', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isBotImConnectionId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    return removeBotImConnection(id);
  });
  ipcMain.handle('botImConnection:list-groups', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isBotImConnectionId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    return listBotImConnectionGroups(id);
  });
  ipcMain.handle('botImConnection:set-group-activation', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { id?: unknown; chatId?: unknown; mode?: unknown };
    if (!isBotImConnectionId(p.id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    if (typeof p.chatId !== 'string' || !/^-?\d{1,32}$/.test(p.chatId)) {
      throwIpcError('INVALID_PARAMS', 'chatId is invalid');
    }
    const mode = p.mode === 'always' ? 'always' : 'mention';
    return setBotImConnectionGroupMode(p.id, p.chatId, mode);
  });
  // 隐藏任务小节: 群名沿用「群聊」小节同一份已知群(deps.listKnownGroups)。
  ipcMain.handle('botImConnection:set-guest-access', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    return setBotImConnectionGuestAccessForSettings(parseBotImGuestAccessUpdate(payload));
  });
  ipcMain.handle('botImConnection:list-lanes', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const id = (payload as { id?: unknown } | null)?.id;
    if (!isBotImConnectionId(id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    return listBotImConnectionLanesForSettings(id);
  });
  ipcMain.handle('botImConnection:reset-lane', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { id?: unknown; sessionId?: unknown };
    if (!isBotImConnectionId(p.id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    if (typeof p.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(p.sessionId)) {
      throwIpcError('INVALID_PARAMS', 'sessionId is invalid');
    }
    return resetBotImConnectionLaneForSettings(p.id, p.sessionId);
  });
  ipcMain.handle('botImConnection:archive-lane', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { id?: unknown; sessionId?: unknown };
    if (!isBotImConnectionId(p.id)) throwIpcError('INVALID_PARAMS', 'id is invalid');
    if (typeof p.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(p.sessionId)) {
      throwIpcError('INVALID_PARAMS', 'sessionId is invalid');
    }
    return archiveBotImConnectionLane(p.id, p.sessionId, laneOptions()).catch((error: unknown) => {
      if (isIpcError(error)) throw error;
      if (error instanceof Error && (error.message === 'ARCHIVE_CAPACITY_REACHED' || error.message === 'OWNER_CHANGED')) {
        throwIpcError('PRECONDITION_FAILED', error.message);
      }
      // Storage errors can include owner-specific absolute paths; keep them in main.
      throwIpcError('INTERNAL', 'LANE_ARCHIVE_FAILED');
    });
  });
}

export const __testing = { instances, purgeSecrets, toView };
