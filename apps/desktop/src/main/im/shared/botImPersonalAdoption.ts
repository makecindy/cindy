/**
 * main/im/shared/botImPersonalAdoption.ts
 * ---------------------------------------------------------------------------
 * 把 设置 → IM 机器人 里那份个人 bot 一次性移给伙伴(伙伴设置「消息平台」→ 添加平台 →
 * 「使用已在 Cindy 设置的机器人」)。凭证只在 main 里搬, 不经过 renderer。
 *
 * 顺序(同一个 Telegram token 只能被一个进程长轮询, Discord 网关 / 钉钉 Stream / 飞书长连接同理):
 *   1. 先按添加平台的口径检查一遍(伙伴可用、没被另一位伙伴用着), 不合格直接拒绝, 个人 bot 不动;
 *   2. 记下个人 bot 在安全存储里的全部键值;
 *   3. 静默停掉个人 bot 的传输层(凭证保留, 不给主人发「已断开」);
 *   4. 走 addBotImConnection(同一份添加入参, 带上原主人与 Telegram 群参与模式);
 *   5. 成功: 清空个人 bot(只清凭证 / 主人 / 运行期游标, 保留生命周期播报等偏好), 设置页随
 *      各渠道既有的状态广播显示「未配置」;
 *      失败: 把第 2 步的键值原样写回, 重新起个人 bot, 原错误照抛。
 *   6. 第 5 步前复核账号: 安全存储按「当前」数据主人现取, 等建连期间切了账号的话, 删键 / 写回
 *      会落到新账号头上 —— 这时不碰凭证与个人 bot, 只记日志(成功分支报 OWNER_SCOPE_CHANGED)。
 *
 * 不共用: 移过去之后个人 bot 是空的, 想再要个人 bot 需要另配一个。
 * 传输层装配由 im/index.ts 注入(configureBotImPersonalAdoption), 这里不 import host.ts。
 */

import { ipcMain } from 'electron';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { createLogger } from '../../logger';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { ownerScopedImSecrets } from '../ownerScopedStorage';
import {
  BOT_IM_CHANNELS,
  type BotImAdoptablePersonalBotsPayload,
  type BotImAdoptPersonalBotInput,
  type BotImChannel,
  type BotImConnectionAddInput,
  type BotImConnectionAddResult,
  type BotImFeishuService,
} from '../../../shared/botImConnection';
import { isBotImChannel } from './botImConnectionStore';
import {
  SECRET_KEYS_BY_CHANNEL,
  addBotImConnection,
  assertBotImConnectionAddable,
  findBotImConnectionByIdentity,
} from './botImConnectionRuntime';

const log = createLogger('im:bot-adopt');

/** 设置页那份个人 bot 的传输层(无前缀实例)在移交里要用到的几个动作。 */
export interface PersonalBotTransport {
  /** 给人看的身份(Telegram @用户名 / Discord bot 标签等); 读不到为 null。不含凭证。 */
  identity(): string | null;
  /** 静默停掉: 让出轮询 / 长连接, 凭证保留, 不通知主人。 */
  stop(): Promise<void>;
  /** 按安全存储里现有的凭证重新起(回滚时恢复原样)。 */
  start(): Promise<void>;
  /**
   * 移交成功、安全存储里的凭证已删之后调用: 让传输层回到未配置, 设置页随各渠道既有的
   * 状态广播看到「未配置」。不能给主人发「已断开」、不能删平台侧命令菜单 —— 同一个 bot
   * 已经由伙伴接着用。
   */
  clear(): Promise<void>;
}

export interface BotImPersonalAdoptionDeps {
  /** 账号 IM 连接已起(登录后); 没起时不列也不移。 */
  isReady(): boolean;
  personal: Record<BotImChannel, PersonalBotTransport>;
  /** 个人 Telegram bot 的群参与模式(设置卡「群聊」小节)。 */
  telegramGroupActivation(): Record<string, 'mention' | 'always'> | undefined;
}

/** 个人 bot 用的安全存储键名(无前缀), 与 lizi-im 各传输层同源。 */
const PERSONAL_KEYS = {
  telegram: { token: 'telegram-bot-token', owner: 'telegram-owner-user-id' },
  feishu: {
    appId: 'feishu_bot_app_id',
    appSecret: 'feishu_bot_app_secret',
    service: 'feishu_bot_service',
    owner: 'feishu_bot_owner_open_id',
  },
  wecom: { botId: 'wecom-bot-id', secret: 'wecom-bot-secret', owner: 'wecom-owner-user-id' },
  dingtalk: {
    appKey: 'dingtalk-bot-app-key',
    appSecret: 'dingtalk-bot-app-secret',
    owner: 'dingtalk-bot-owner-user-id',
  },
  discord: { token: 'discord-bot-token', owner: 'discord-owner-user-id' },
} as const;

/** 清空个人 bot 时保留的偏好键(不是凭证, 用户以后再配个人 bot 时沿用)。 */
const KEPT_PREFERENCE_KEYS = new Set(['feishu_bot_lifecycle_announcement', 'discord-bot-lifecycle-announcement']);

let deps: BotImPersonalAdoptionDeps | null = null;
let inFlight = false;
let ipcRegistered = false;

export function configureBotImPersonalAdoption(next: BotImPersonalAdoptionDeps): void {
  deps = next;
}

function read(key: string): string {
  return ownerScopedImSecrets.read(key)?.trim() ?? '';
}

interface PersonalCredentials {
  input: BotImConnectionAddInput;
  /** 企业微信 / 钉钉 / 飞书已认定的主人(Telegram / Discord 在 input 里)。 */
  carriedOwner: string;
  identityValue: string;
  service?: BotImFeishuService;
}

/** 读个人 bot 的凭证, 拼成添加平台的同一份入参; 没配齐为 null。 */
function readPersonalCredentials(channel: BotImChannel, botId: string): PersonalCredentials | null {
  switch (channel) {
    case 'telegram': {
      const token = read(PERSONAL_KEYS.telegram.token);
      const ownerUserId = read(PERSONAL_KEYS.telegram.owner);
      if (!token || !ownerUserId) return null;
      return { input: { botId, channel, token, ownerUserId }, carriedOwner: '', identityValue: token };
    }
    case 'feishu': {
      const appId = read(PERSONAL_KEYS.feishu.appId);
      const appSecret = read(PERSONAL_KEYS.feishu.appSecret);
      if (!appId || !appSecret) return null;
      const service: BotImFeishuService = read(PERSONAL_KEYS.feishu.service) === 'lark' ? 'lark' : 'feishu';
      return {
        input: { botId, channel, appId, appSecret, service },
        carriedOwner: read(PERSONAL_KEYS.feishu.owner),
        identityValue: appId,
        service,
      };
    }
    case 'wecom': {
      const wecomBotId = read(PERSONAL_KEYS.wecom.botId);
      const secret = read(PERSONAL_KEYS.wecom.secret);
      if (!wecomBotId || !secret) return null;
      return {
        input: { botId, channel, wecomBotId, secret },
        carriedOwner: read(PERSONAL_KEYS.wecom.owner),
        identityValue: wecomBotId,
      };
    }
    case 'dingtalk': {
      const appKey = read(PERSONAL_KEYS.dingtalk.appKey);
      const appSecret = read(PERSONAL_KEYS.dingtalk.appSecret);
      if (!appKey || !appSecret) return null;
      return {
        input: { botId, channel, appKey, appSecret },
        carriedOwner: read(PERSONAL_KEYS.dingtalk.owner),
        identityValue: appKey,
      };
    }
    case 'discord': {
      const token = read(PERSONAL_KEYS.discord.token);
      const ownerUserId = read(PERSONAL_KEYS.discord.owner);
      if (!token || !ownerUserId) return null;
      return { input: { botId, channel, token, ownerUserId }, carriedOwner: '', identityValue: token };
    }
  }
}

/** 「消息平台」添加弹窗: 每个渠道的个人 bot 是否配好、可以移过来(只给身份)。 */
export function listAdoptablePersonalBots(): BotImAdoptablePersonalBotsPayload {
  if (!deps?.isReady() || !ownerScopedImSecrets.isAvailable()) return { bots: [] };
  const bots: BotImAdoptablePersonalBotsPayload['bots'] = [];
  for (const channel of BOT_IM_CHANNELS) {
    const credentials = readPersonalCredentials(channel, '');
    if (!credentials) continue;
    // 同一个 bot 已被某位伙伴用着(异常状态)时不提供移交, 免得点了才报冲突。
    if (findBotImConnectionByIdentity(channel, credentials.identityValue)) continue;
    let identity: string | null = null;
    try {
      identity = deps.personal[channel].identity();
    } catch {
      identity = null;
    }
    bots.push({ channel, identity, ...(credentials.service ? { service: credentials.service } : {}) });
  }
  return { bots };
}

function snapshotPersonalSecrets(channel: BotImChannel): Map<string, string | null> {
  return new Map(SECRET_KEYS_BY_CHANNEL[channel].map((key) => [key, ownerScopedImSecrets.read(key)]));
}

function restorePersonalSecrets(snapshot: Map<string, string | null>): void {
  for (const [key, value] of snapshot) {
    if (value === null) ownerScopedImSecrets.remove(key);
    else if (!ownerScopedImSecrets.write(key, value)) log.warn(`restore personal bot key ${key} failed`);
  }
}

function purgePersonalSecrets(channel: BotImChannel): void {
  for (const key of SECRET_KEYS_BY_CHANNEL[channel]) {
    if (!KEPT_PREFERENCE_KEYS.has(key)) ownerScopedImSecrets.remove(key);
  }
}

function carriedGroupActivation(channel: BotImChannel): Record<string, 'always'> | undefined {
  if (channel !== 'telegram') return undefined;
  const raw = deps?.telegramGroupActivation() ?? {};
  const always = Object.fromEntries(
    Object.entries(raw).filter(([chatId, mode]) => mode === 'always' && /^-?\d{1,32}$/.test(chatId)),
  ) as Record<string, 'always'>;
  return Object.keys(always).length > 0 ? always : undefined;
}

/** 把个人 bot 移给伙伴: 先停个人 bot, 再按添加平台建连; 失败把个人 bot 恢复原样。 */
export async function adoptPersonalBot(input: BotImAdoptPersonalBotInput): Promise<BotImConnectionAddResult> {
  const current = deps;
  if (!current?.isReady()) throwIpcError('PRECONDITION_FAILED', 'IM_NOT_READY');
  if (!ownerScopedImSecrets.isAvailable()) throwIpcError('PRECONDITION_FAILED', 'SECRET_STORAGE_UNAVAILABLE');
  if (inFlight) throwIpcError('PRECONDITION_FAILED', 'ADOPT_IN_PROGRESS');
  const credentials = readPersonalCredentials(input.channel, input.botId);
  if (!credentials) throwIpcError('PRECONDITION_FAILED', 'PERSONAL_BOT_NOT_CONFIGURED');
  inFlight = true;
  // 安全存储每次读写都按当前数据主人解析; 后面每次动个人 bot 的凭证 / 传输层前复核仍是同一个账号。
  const ownerKey = activeOwnerScopeKey();
  const sameOwner = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerKey;
  try {
    // 不合格的(伙伴不可用、已被另一位伙伴用着)在停个人 bot 之前就拒绝。
    await assertBotImConnectionAddable(credentials.input, { adoptingSettingsBot: true });
    const snapshot = snapshotPersonalSecrets(input.channel);
    const personal = current.personal[input.channel];
    await personal.stop();
    let result: BotImConnectionAddResult;
    try {
      result = await addBotImConnection(credentials.input, {
        adoptingSettingsBot: true,
        ...(credentials.carriedOwner ? { ownerUserId: credentials.carriedOwner } : {}),
        ...(carriedGroupActivation(input.channel) ? { groupActivation: carriedGroupActivation(input.channel) } : {}),
      });
    } catch (err) {
      if (!sameOwner()) {
        log.warn(`personal ${input.channel} bot adoption failed after the account changed; personal bot left untouched`);
        throw err;
      }
      restorePersonalSecrets(snapshot);
      try {
        await personal.start();
      } catch (restartErr) {
        log.warn(`personal ${input.channel} bot restart after failed adoption failed: ${String(restartErr)}`);
      }
      log.info(`personal ${input.channel} bot adoption failed, personal bot restored`);
      throw err;
    }
    if (!sameOwner()) {
      log.warn(
        `personal ${input.channel} bot moved to connection ${result.connection.id} but the account changed; personal bot left untouched`,
      );
      throwIpcError('PRECONDITION_FAILED', 'OWNER_SCOPE_CHANGED');
    }
    // 先删键再让传输层归位: 凭证不能留在个人 bot 上(否则下次启动两处抢同一个 bot)。
    purgePersonalSecrets(input.channel);
    try {
      await personal.clear();
    } catch (err) {
      log.warn(`personal ${input.channel} bot clear after adoption failed: ${String(err)}`);
    }
    log.info(
      `personal ${input.channel} bot moved to connection ${result.connection.id} for bot=...${input.botId.slice(-8)}`,
    );
    return result;
  } finally {
    inFlight = false;
  }
}

function readAdoptInput(payload: unknown): BotImAdoptPersonalBotInput {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (typeof p.botId !== 'string' || !p.botId.trim() || p.botId.length > 200) {
    throwIpcError('INVALID_PARAMS', 'botId is required');
  }
  if (!isBotImChannel(p.channel)) throwIpcError('INVALID_PARAMS', 'channel is invalid');
  return { botId: p.botId.trim(), channel: p.channel };
}

export function registerBotImPersonalAdoptionIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('botImConnection:list-adoptable', (e) => {
    assertTrustedAppRendererEvent(e);
    return listAdoptablePersonalBots();
  });
  ipcMain.handle('botImConnection:adopt', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    return adoptPersonalBot(readAdoptInput(payload));
  });
}

export const __testing = {
  reset(): void {
    deps = null;
    inFlight = false;
  },
};
