/**
 * telegram/index.ts — 个人 Telegram bot 传输层(BYO token, 直连 Bot API)。
 * ---------------------------------------------------------------------------
 * 与官方 Cindy Telegram bot(hook-control, 经 relay server)完全平行的另一套
 * 通道: 用户在 BotFather 建自己的 bot, 桌面端拿 token 直连 getUpdates 长轮询,
 * 消息不经任何服务器中转 — 本地即可调试全链路体验。
 *
 * 会话路由约定(见 codec.ts):
 *   - 私聊: senderId = Telegram 数字 user id(仅 owner 放行, Discord 同款
 *     显式 owner 模型 — Telegram bot 全网可搜, TOFU 抢注风险不可接受);
 *   - 群/topic: senderId = 群 lane id `g/{chatId}[/{threadId}]`, 编排层按
 *     (bot, laneId) 得到「每群每话题一个会话」; 出站按 lane id 解码回群聊。
 *     触发条件 = owner 在群里 @bot 或回复 bot 消息; 其余群消息只进本地
 *     群上下文窗口(onGroupWindowMessage), 不起 turn。
 *
 * 群窗口数据面: transport 把收到的每条群消息(含非触发消息与其他 bot 消息,
 * 取决于 BotFather privacy mode)与自己发出的群回复(回流条目)推给
 * onGroupWindowMessage 订阅者; 窗口存储与上下文拼装在 desktop main
 * (im/telegram/groupWindow.ts), 包内不落盘。
 */

import fs from 'node:fs';
import path from 'node:path';

import { BaseIM } from '../BaseIM.js';
import type { ChannelIM } from '../channelIM.js';
import type {
  IMCardActionEvent,
  IMHost,
  IMMessageEvent,
  IMSecretReadResult,
  IMStatus,
  InteractiveCardSpec,
  SendFileResult,
  StreamingTextHandle,
} from '../types.js';
import {
  createTelegramApiClient,
  TelegramApiError,
  type TelegramApiClient,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './api.js';
import { chunkTelegramSource } from './chunk.js';
import { decodeLaneUserId, decodeMessageId, encodeLaneUserId, encodeMessageId } from './codec.js';
import { buildCardPayload, hasLiveCallbackToken, parseCallbackQuery } from './components.js';
import {
  detectGroupTrigger,
  groupWindowEntryOf,
  laneThreadIdOf,
  normalizeMessage,
  type TelegramGroupWindowEntry,
} from './inbound.js';
import { markdownToTelegramHtml, stripTelegramHtmlTags } from './markdown.js';
import { TELEGRAM_PERSONAL_CAPABILITIES } from './presentationCapabilities.js';
import {
  EXPRESSIVE_DONE_POOL,
  EXPRESSIVE_ERROR_POOL,
  pickExpressiveReaction,
} from './reactionPool.js';
import { startTelegramStreaming } from './streamingText.js';

const TOKEN_SECRET_KEY = 'telegram-bot-token';
const OWNER_USER_ID_SECRET_KEY = 'telegram-owner-user-id';

/** 历史遗留 key(上下线播报机制已移除), disconnect 时顺手清掉。 */
const LEGACY_RUNTIME_ACTIVE_SECRET_KEY = 'telegram-bot-runtime-active';
/**
 * getUpdates 游标持久化(`${botId}:${offset}`)。offset 只有在下一次 getUpdates
 * 送达服务器时才被确认 — 强杀落在"批次处理完 → 下一次请求送达"窗口会导致
 * 重放, 而下游 turn 无 messageId 幂等; 落盘让重启从上次处理完的位置续读。
 */
const UPDATES_OFFSET_SECRET_KEY = 'telegram-updates-offset';
/**
 * 用户主动下线标志('1' = 下线)。与凭证分离是本功能的全部要点: 下线只停轮询,
 * token / owner / offset 一律保留, 重启后仍保持下线(否则换机器时把另一台停掉
 * 的意义就没了 — 它一重启就又来抢 getUpdates)。解绑(disconnect)会连同清除。
 */
const OFFLINE_SECRET_KEY = 'telegram-bot-offline';

const POLL_TIMEOUT_SEC = 50;
/**
 * 相册(media_group)聚合窗: Telegram 把一次多图拆成多条消息, 同组消息通常在
 * 同一批 getUpdates 里到齐; 静默 1s 后合并成单个事件, 不各起一轮 turn。
 */
const ALBUM_SETTLE_MS = 1_000;
/**
 * 超过该时限的消息视为「离线期积压重放」, 不再起 turn。
 *
 * Telegram 会替离线的 bot 保留最长 24h 的 update, 一上线整批推来。官方 bot
 * 服务端为此设了 10 分钟闸(2026-07-27 实踩: 上线后整批历史消息被诈尸回复,
 * 半夜给离线桌面派了过期任务), 个人 bot 此前一道闸都没有 —— 而它跑在桌面端,
 * 天天关机开机, 暴露面比常驻服务端大得多。
 *
 * 阈值比官方宽是**有意的**: 服务端离线 = 故障, 桌面关机 = 预期状态。用户合上
 * 电脑一小时再打开, 那条正等回复的消息仍然该被处理; 但跨夜、跨半天的整批积压
 * 用户早已不在等, 逐条回答只会刷屏并派出过期任务。
 */
const STALE_MESSAGE_MS = 60 * 60 * 1_000;
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
/** 409 = 另一个进程在对同一 token 轮询 — 低频探测等它退出。 */
const POLL_CONFLICT_RETRY_MS = 30_000;
/**
 * 429 没给 `retry_after`(或给了非法值)时的兜底退避。**只用于兜底** —— 合法值
 * 一律按服务端给的全长等, 不设上限: 任何上限都等于在 flood 窗口结束前提前重试,
 * 那次重试必然再 429, 终稿于是又丢一次(bot-wide flood 的 retry_after 可以远超
 * 一分钟)。不设上限是安全的, 因为这个等待绑定了连接生命周期取消源(见
 * outboundAbortSignal), dispose / 下线 / 重连会立刻把它收口。
 */
const RETRY_AFTER_FALLBACK_MS = 3_000;

/** 429 退避时长: 合法 `retry_after` 原样采用, 缺失或非法(NaN / ≤0 / 非有限)走兜底。 */
function retryAfterWaitMs(retryAfterSec: number | undefined): number {
  if (typeof retryAfterSec !== 'number') return RETRY_AFTER_FALLBACK_MS;
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return RETRY_AFTER_FALLBACK_MS;
  return retryAfterSec * 1000;
}
const MAX_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const OWNER_NOTICE_TIMEOUT_MS = 4_500;
/**
 * typing 续命间隔/上限:引用呈现能力契约的**单一出处**(#1855 L1),不再本地
 * 硬编码 —— 与 desktop turnPresenter re-export 的 PERSONAL_DRIVER_CAPABILITIES 同源。
 * (原生 typing 只持续 ~5s,按 keepaliveMs 续命;keepaliveMaxMs 是异常悬挂兜底上限。)
 */
const TYPING_REFRESH_MS = TELEGRAM_PERSONAL_CAPABILITIES.typingKeepaliveMs;
const TYPING_LOOP_MAX_MS = TELEGRAM_PERSONAL_CAPABILITIES.typingKeepaliveMaxMs;
/**
 * link preview 关闭,取自能力契约单一出处(见 `linkPreviewDisabled`)。
 *
 * **覆盖面是答案这条路,不是全部出站**(原注释写的"全档出站/编辑共用"不准确):
 * 正文/过程消息的 `sendMessage`、400 回落的纯文本 `sendMessage`、分段
 * `sendPlainChunked`、`editMessageText` 及其 HTML 解析失败后的纯文本回落 —— 只有
 * 这五处带它。**卡片消息、rich 主路径(`rich_message` payload)、陌生人提示、主人
 * 通知都不带**。新增出站路径时自己决定挂不挂, 不会被这个常量自动覆盖。
 */
const LINK_PREVIEW_OPTIONS = {
  is_disabled: TELEGRAM_PERSONAL_CAPABILITIES.linkPreviewDisabled,
} as const;
const SECRET_WRITE_FAILED_REASON = '无法安全保存凭证(系统安全存储不可用)';
const DEFAULT_EXPIRED_CARD_NOTICE = '卡片已过期';

/** 非 owner 显式召唤(私聊/群 @/reply)的礼貌回应 — per-user 冷却防刷屏。 */
const STRANGER_NOTICE_COOLDOWN_MS = 60_000;
const DEFAULT_STRANGER_NOTICE =
  '👋 我是一位主人的个人 Cindy 助理，只响应主人本人的指令~\nI am a personal Cindy assistant and only respond to my owner.';

// 只保留一次性动作确认(填 token 关联成功 / 手动断开)。生命周期播报(上线/
// 下线/离线致歉)已整体移除 —— bot 随桌面端频繁重启, 每次都播报会刷屏;
// 官方 bot 与业内 Telegram bot 的重启一律静默(2026-07-30 Chris)。
const DEFAULT_OWNER_NOTICES = {
  linked: '✅ All linked. Just send a message when you are ready.',
  disconnected: '🔌 Unlinked. Link again whenever you need me.',
} as const;

type OwnerNoticePhase = keyof typeof DEFAULT_OWNER_NOTICES;
type MessageHandler = (e: IMMessageEvent) => void;
type CardActionHandler = (e: IMCardActionEvent) => void;
type StatusHandler = (s: IMStatus) => void;
type GroupWindowHandler = (entry: TelegramGroupWindowEntry) => void;

/**
 * 回挂目标的请求级凭据: 记住本次出站真正带上的那个目标身份。
 * null = 本次没挂回(无需提交)。提交必须凭它校身份, 不能按 userId 当前槽位盲删。
 */
type ReplyTargetLease = { userId: string; messageId: string } | null;

/**
 * 流式回合的身份快照(建 handle 时拍下)。终稿补送必须绑定它 —— 补送是一次**全新**
 * 的 callSend, 会按"当前"世代重新取 api, 所以旧回合的 429 退避即使正确放弃了,
 * 补送仍可能把旧回合的完整答案发出去。
 */
interface StreamRoundIdentity {
  /** 配置世代(换 token / 换 owner / disconnect / dispose 都会 +1)。 */
  generation: number;
  /** 建 handle 时的 api 客户端身份 —— 重连换了客户端就不是同一回合。 */
  api: TelegramApiClient | null;
  /**
   * 建 handle 时的主人。只换 owner 不换 token 的那条分支不会 stopPolling,
   * **api 对象完全不变**, 只有这个字段(与 generation)能识别出授权已经易主。
   */
  ownerUserId: string;
  /** 本轮回挂目标(此刻还没被任何出站消耗)。 */
  replyTargetId: string | null;
}

type TelegramReplyParams =
  | { reply_parameters: { message_id: number; allow_sending_without_reply: true } }
  | Record<string, never>;

/** 回挂目标 id → 出站请求参数; null/空 = 不挂回。 */
function replyParamsFor(targetId: string | null | undefined): TelegramReplyParams {
  if (!targetId) return {};
  return { reply_parameters: { message_id: Number(targetId), allow_sending_without_reply: true } };
}

/**
 * 队列里是否存在比 current 更新的触发消息 —— Telegram 同一 chat 内 message_id
 * 单调递增, 因此更大的 id 就意味着槽位里那个已经过时。
 * current 解不出数字(不应发生)时不阴拦领取。
 */
function hasNewerTrigger(queue: Array<{ id: string }>, current: string): boolean {
  const currentId = Number(current);
  if (!Number.isFinite(currentId)) return true;
  return queue.some((entry) => Number(entry.id) > currentId);
}

/**
 * 调用方给的「本轮触发消息」编码 id → 同群的原生 message_id(给私聊授权卡拼深链)。
 *
 * 解不开、或解出来属于**别的 chat** 时返回 null(不渲染深链): 链到别的会话比没有链更糟。
 */
function sourceMessageIdIn(chatId: string, encoded: string | undefined): string | null {
  if (encoded === undefined) return null;
  try {
    const decoded = decodeMessageId(encoded);
    return decoded.chatId === chatId ? decoded.messageId : null;
  } catch {
    return null;
  }
}

/** settle 缓冲/处理中的相册(见 albumsInFlight 注释)。 */
interface PendingAlbum {
  messages: TgMessage[];
  /** settle 定时器; null = 尚未挂上(构造与 setTimeout 之间的窗口)。 */
  timer: ReturnType<typeof setTimeout> | null;
  firstUpdateId: number;
  chatId: string;
  /** 处理收口(或被丢弃)时 resolve — 同 chat 后续消息的顺序门在等它。 */
  done: Promise<void>;
  resolveDone: () => void;
  /** settle 定时器已触发, 不再接受追加成员。 */
  settled: boolean;
}

/** 行为配置(设置卡可视化, 实时生效 — host 以 getter 注入, transport 每次使用时读)。 */
export interface TelegramBehaviorConfig {
  /**
   * emoji 回应等级:
   *   off = 完全不放表情(含 👀 ack 与终态);
   *   minimal = 👀 ack → 👍/👎 终态(默认);
   *   expressive = 终态用丰富变体池(👍🎉💯 / 👎😱), ack 保持 👀。
   */
  emojiReactions: 'off' | 'minimal' | 'expressive';
  /** 群回复引用: off=不挂 / first=每次触发首条挂回(默认) / all=每条都挂。 */
  replyQuoteGroup: 'off' | 'first' | 'all';
  /** DM 回复引用: off(默认) / first=首条回复挂回触发消息。 */
  replyQuoteDm: 'off' | 'first';
  /**
   * per-chat 群参与模式(chatId → 模式)。缺省 mention。
   * always = 全响应·自主判断: 每条群消息都进 turn(ambient 标记), 模型用
   * NO_REPLY 哨兵决定插不插话; ambient 消息不放表情回应。
   */
  groupActivation?: Record<string, 'mention' | 'always'>;
}

export const TELEGRAM_DEFAULT_BEHAVIOR: TelegramBehaviorConfig = {
  emojiReactions: 'minimal',
  replyQuoteGroup: 'first',
  replyQuoteDm: 'off',
};

export interface TelegramIMOptions {
  /** cindy-media:// / xdt-image:// → 本地绝对路径(出站图片上传用)。 */
  resolveImageUrl?: (url: string) => string;
  expiredCardNotice?: string;
  ownerNoticeText?:
    | Partial<Record<OwnerNoticePhase, string>>
    | ((phase: OwnerNoticePhase) => string);
  /** 非 owner 显式召唤时的礼貌回应文案(缺省用内置中英双语一句)。 */
  strangerNotice?: string;
  /**
   * owner 的命令菜单(setMyCommands + BotCommandScopeChat 精准只发 owner
   * 私聊; 陌生人/群成员看不到任何命令)。缺省不注册。
   */
  commandMenu?: ReadonlyArray<{ command: string; description: string }>;
  /** 测试注入: 替换真实 Bot API 客户端。 */
  apiFactory?: (token: string) => TelegramApiClient;
  /** 行为配置 getter(缺省 = TELEGRAM_DEFAULT_BEHAVIOR)。 */
  behavior?: () => TelegramBehaviorConfig;
}

export class TelegramIM extends BaseIM implements ChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly cardActionHandlers = new Set<CardActionHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly groupWindowHandlers = new Set<GroupWindowHandler>();

  private status: IMStatus = { kind: 'idle' };
  private api: TelegramApiClient | null = null;
  private botId = 0;
  private botUsername = '';
  private botDisplayName = '';
  private ownerUserId = '';
  private configVersion = 0;
  private pollAbort: AbortController | null = null;
  /**
   * 实例级取消源(dispose 时 abort)。pollAbort 只覆盖"正在轮询"的时段, 而出站也
   * 会发生在连接建立中与下线收尾这类没有轮询的窗口 —— 那时退避等待要靠这个收口。
   *
   * **不可 readonly**: 同一实例支持 dispose → init 复用(退出登录再登录, init 里
   * 就有 `this.disposing = false`)。一次性的控制器 abort 之后永远是 aborted 态,
   * 新世代的每次退避都会当场判定"已停止"而跳过重试 —— 等于把 429 重试永久关掉。
   * 由 resetLifetimeAbort() 在新 init 世代重建。
   */
  private lifetimeAbort = new AbortController();
  private pollLoop: Promise<void> | null = null;
  private disposing = false;
  /** sendRichMessage 方法不可用(404)后的永久 latch(本实例生命周期内)。 */
  private richSendDisabled = false;
  private readonly mediaDir: string;
  /** 相册聚合缓冲 — key `${chatId}:${mediaGroupId}`。 */
  private readonly pendingAlbums = new Map<string, PendingAlbum>();
  /**
   * 缓冲或处理中的相册(settle 定时器一响就从 pendingAlbums 摘键关闭追加,
   * 但要留在这里直到 processInboundMessage 收口): 持久化游标 cap 与同
   * chat 的顺序门都看本集合 — 摘早了, 处理途中到达的批次会把游标推过
   * 未完成的相册(review P1)。
   */
  private readonly albumsInFlight = new Set<PendingAlbum>();
  /** 本连接见过的最大 offset(update_id+1) — 相册 flush 后补写持久化游标用。 */
  private lastSeenOffset = 0;
  /**
   * per-chat 串行处理链(chatKey → 链尾 promise): 轮询循环只做分发不等待 —
   * 同 chat 内保序(相册门只挡自己 chat), 跨 chat 并行, 无队头阻塞
   * (2026-07-30 #1098 review: 全局 await 会让一个 chat 的相册下载拖住全部)。
   */
  private readonly chatQueues = new Map<string, Promise<void>>();
  /**
   * 已分发未收口的 update。key 是每次分发的独立身份而非裸 update_id:
   * offline→online 后 Telegram 会重放未提交的同一 update_id，旧世代任务收尾时
   * 只能删除自己的登记，不能误删新世代的重放任务并让游标越过去。
   */
  private readonly inflightUpdates = new Map<symbol, number>();
  /**
   * 待配对的回挂触发队列(laneUserId → 原生 message_id FIFO): 多条消息在上一
   * 轮还没出话时先后触发同一 lane, 各自的答案必须挂回各自的提问 — 单值会被
   * 后到者覆盖(2026-07-30 review P1)。lane 的 turn 串行执行, 每次流式句柄
   * 创建(= 一轮输出开始)从队头领取本轮目标进 turnReplyTargets。
   */
  private readonly pendingReplyTargets = new Map<string, Array<{ id: string; at: number }>>();
  /** 当前轮的回挂目标(claimTurnReplyTarget 领取; 'first' 用后即耗, 'all' 整轮保留)。 */
  private readonly turnReplyTargets = new Map<string, string>();
  /**
   * 活动流式回合计数(userId → 未收口的 handle 数) —— 回挂目标槽位的**归属权**。
   *
   * 为何必需: A 回合正在流式输出时, B 消息到达会入队并立即发一条排队提示
   * (turnRunner 的 notifyQueuedPosition → sendMarkdownText)。若让那条独立出站按「队列
   * 里有更新的 id」接管槽位, A 剩下的 sendRenderedChunk 会改挂到 B 上 —— 群 'all'
   * 档要求目标整轮不变, 而「队列里有更新的消息」并不证明 A 已被放弃。
   * 所以领取要看归属: 回合活着就由它持有, 收口(finalize/close)后才允许替换。
   */
  private readonly activeStreamRounds = new Map<string, number>();
  /** 非 owner 礼貌回应的 per-user 冷却(userId → 上次回应 ts)。 */
  private readonly strangerNoticeAt = new Map<string, number>();
  /** ambient 触发的原生 messageId(`chatId|msgId`) — 表情回应抑制名单(FIFO 512)。 */
  private readonly ambientTriggerIds = new Set<string>();
  /** 进行中的 typing 续命循环(`chatId:threadId` → 状态)。 */
  private readonly typingLoops = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; startedAt: number }
  >();

  constructor(
    host: IMHost,
    private readonly opts: TelegramIMOptions = {},
  ) {
    super('telegram', host);
    if (!host.paths.telegramMediaDir) {
      throw new Error('IMHost.paths.telegramMediaDir is required to wire the telegram channel');
    }
    this.mediaDir = host.paths.telegramMediaDir;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.disposing = false;
    this.resetLifetimeAbort();
    const tokenResult = this.secretReadResult(TOKEN_SECRET_KEY);
    if (tokenResult.kind === 'error') {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return;
    }
    const token = tokenResult.kind === 'value' ? tokenResult.value.trim() : '';
    this.ownerUserId = this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? '';
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    // 主动下线态必须跨重启保持: 这里一旦 connect 就会重新抢 getUpdates, 把
    // 用户特意让位给另一台设备的轮询又夺回来。零网络请求进 offline。
    const offlineFlagState = this.offlineFlagState();
    if (offlineFlagState === 'unknown') {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return;
    }
    if (offlineFlagState === 'set') {
      // botId 能从 token 前缀解析, 但 username / 显示名只有 getMe 拿得到 —— 而
      // 下线态不发请求。同进程内换账号(A→B)时若不清, get-status 会把 A 的 bot
      // 身份和 B 的离线状态一起报给设置卡。宁可留空, 不可张冠李戴。
      this.botId = botIdFromToken(token);
      this.botUsername = '';
      this.botDisplayName = '';
      this.setStatus({ kind: 'offline', appId: this.botContextId });
      return;
    }
    await this.connect(token);
  }

  /**
   * 主动下线: 停轮询但**保留全部绑定信息**(token / owner / offset / 命令菜单)。
   * 用途是换机器时把这一端让出来 —— 与 disconnect(解绑, 清凭证)是两个动作。
   * 不向 owner 播报(与 dispose 同口径, 见文件头部生命周期静默说明)。
   */
  async goOffline(): Promise<void> {
    // 先判安全存储可用性: 不可用时 read 一律返回 null, 会把"读不到 token"误判成
    // "未配置" → 设 idle 却不停轮询, 变成「UI 显示未配置、bot 还在收消息」。
    // 这条路径远程下线也会走(telegramRemoteControl 不做预检), 必须在这里兜住。
    if (!this.host.secrets.isAvailable()) {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return;
    }
    const tokenResult = this.secretReadResult(TOKEN_SECRET_KEY);
    if (tokenResult.kind === 'error') {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return;
    }
    const token = tokenResult.kind === 'value' ? tokenResult.value.trim() : '';
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    // 标志必须先落盘成功再停轮询: 反过来的话, 写失败时本机已经停了、UI 也显示
    // 已下线, 但重启就会自动上线回来抢另一台的轮询 —— 恰好毁掉下线的全部意义。
    // 宁可停在"没下线成功"的明确错误上, 也不留一个会自己复活的假下线。
    if (!this.host.secrets.write(OFFLINE_SECRET_KEY, '1')) {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return;
    }
    // 换代先行: 在途 poll 循环据 configVersion 自行退出, 不会把下线状态覆盖回去。
    this.configVersion += 1;
    this.clearAllTypingLoops();
    this.pendingReplyTargets.clear();
    this.turnReplyTargets.clear();
    await this.stopPolling();
    if (!this.botId) this.botId = botIdFromToken(token);
    this.setStatus({ kind: 'offline', appId: this.botContextId });
  }

  /** 从下线态恢复: 清标志并按保留的 token 重新建连(offset 续上, 不重放)。 */
  async goOnline(): Promise<boolean> {
    const tokenResult = this.secretReadResult(TOKEN_SECRET_KEY);
    if (tokenResult.kind === 'error') {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return false;
    }
    const token = tokenResult.kind === 'value' ? tokenResult.value.trim() : '';
    this.host.secrets.remove(OFFLINE_SECRET_KEY);
    // remove 返回 void 且吞掉异常(文件锁/权限/磁盘错误), 只能回读确认。标志没删掉
    // 却照常连上, 会让用户看到"已上线"、重启后却又回到 offline —— 与写标志失败
    // 同源的静默失败, 同样宁可停在明确错误上。
    // 只有明确读到"不存在"才算删成功: 'unknown'(存储在 remove→read 窗口里失效)
    // 同样 fail closed, 否则删除失败会被当成成功放过。
    if (this.offlineFlagState() !== 'absent') {
      this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      return false;
    }
    if (!token) {
      this.setStatus({ kind: 'idle' });
      return false;
    }
    this.configVersion += 1;
    await this.stopPolling();
    return this.connect(token);
  }

  /** Read with explicit missing/error semantics; legacy hosts fail closed. */
  private secretReadResult(name: string): IMSecretReadResult {
    return this.host.secrets.readResult?.(name) ?? { kind: 'error' };
  }

  /**
   * 下线标志的三态判定。只有可靠读到 ENOENT 才是 absent；文件存在（无论内容）
   * 都视为 set，I/O／解密失败或旧 host 没实现 readResult 都是 unknown。
   */
  private offlineFlagState(): 'set' | 'absent' | 'unknown' {
    const result = this.secretReadResult(OFFLINE_SECRET_KEY);
    if (result.kind === 'error') return 'unknown';
    return result.kind === 'missing' ? 'absent' : 'set';
  }

  // 生命周期静默: dispose / 重连不向 owner 发任何播报(桌面端频繁重启会刷屏)。
  async dispose(): Promise<void> {
    this.disposing = true;
    // 在途的 429 退避等待就此收口 —— 否则一个最长一分钟的定时器会活过 dispose。
    this.lifetimeAbort.abort();
    this.configVersion += 1;
    this.clearAllTypingLoops();
    // 回挂配对是连接期内存态 — 换代/断开后旧目标一律作废, 不跨代错配。
    this.pendingReplyTargets.clear();
    this.turnReplyTargets.clear();
    await this.stopPolling();
    // bot 身份是上一个账号的连接期产物: 登出/换账号后必须清干净, 否则下一个
    // 账号在 offline 等拿不到 getMe 的状态下会继承旧账号的 bot 名字。
    this.botId = 0;
    this.botUsername = '';
    this.botDisplayName = '';
    this.setStatus({ kind: 'idle' });
  }

  registerIpc(): void {
    const configResult = (saveErrorStatus?: IMStatus) => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      botUsername: this.botUsername || null,
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    });

    this.host.ipc.handle('telegramBot:set-config', async (payload) => {
      const config = isRecord(payload) ? payload : {};
      const token = typeof config.token === 'string' ? config.token.trim() : '';
      const ownerUserId =
        typeof config.ownerUserId === 'string' ? config.ownerUserId.trim() : '';
      if (!this.host.secrets.isAvailable()) {
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
        return configResult();
      }

      // 回滚前必须先可靠读取旧值；把读取失败当成“不存在”会在后续失败时误删旧配置。
      const previousTokenResult = this.secretReadResult(TOKEN_SECRET_KEY);
      const previousOwnerResult = this.secretReadResult(OWNER_USER_ID_SECRET_KEY);
      if (previousTokenResult.kind === 'error' || previousOwnerResult.kind === 'error') {
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
        return configResult();
      }
      const previousToken =
        previousTokenResult.kind === 'value' ? previousTokenResult.value : null;
      const previousOwnerUserId =
        previousOwnerResult.kind === 'value' ? previousOwnerResult.value : null;
      const previousRuntimeOwnerUserId = this.ownerUserId;

      const tokenSaved = token ? this.host.secrets.write(TOKEN_SECRET_KEY, token) : true;
      const ownerSaved = ownerUserId
        ? this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, ownerUserId)
        : true;
      if (!tokenSaved || !ownerSaved) {
        await this.rollbackConfigOrFailClosed(
          previousToken,
          previousOwnerUserId,
          previousRuntimeOwnerUserId,
        );
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
        return configResult();
      }

      const nextOwnerUserId = ownerUserId || this.ownerUserId;
      if (token) {
        this.configVersion += 1;
        await this.stopPolling();
        this.ownerUserId = nextOwnerUserId;
        // 手动填 token 点连接 = 明确要在这台机器上用, 清掉遗留的下线标志,
        // 否则连上了但重启后又被 init 判回 offline。remove 吞异常且无返回值
        // (Windows 文件锁尤甚, 见 engineering-conventions「文件系统差异」), 必须
        // 回读确认 —— 否则用户重填 token 看似恢复、重启后又掉回 offline。
        this.host.secrets.remove(OFFLINE_SECRET_KEY);
        if (this.offlineFlagState() !== 'absent') {
          await this.rollbackConfigOrFailClosed(
            previousToken,
            previousOwnerUserId,
            previousRuntimeOwnerUserId,
          );
          this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
          return configResult();
        }
        const connected = await this.connect(token);
        if (!connected) {
          const failedStatus = this.status;
          const restored = await this.rollbackConfigOrFailClosed(
            previousToken,
            previousOwnerUserId,
            previousRuntimeOwnerUserId,
          );
          if (!restored) return configResult(this.status);
          const previous = previousToken?.trim();
          if (previous) {
            this.configVersion += 1;
            await this.connect(previous);
          }
          return configResult(failedStatus);
        }
        const noticeConfigVersion = this.configVersion;
        await this.sendOwnerNoticeWithTimeout(
          nextOwnerUserId,
          'linked',
          OWNER_NOTICE_TIMEOUT_MS,
          () => this.configVersion === noticeConfigVersion && this.ownerUserId === nextOwnerUserId,
        );
      } else if (nextOwnerUserId !== this.ownerUserId) {
        this.configVersion += 1;
        this.ownerUserId = nextOwnerUserId;
      }
      return configResult();
    });

    this.host.ipc.handle('telegramBot:get-status', () => ({
      status: this.status,
      ownerUserId: this.ownerUserId || null,
      botUsername: this.botUsername || null,
    }));

    /**
     * 上线/下线开关(不碰凭证)。单 channel 双向 —— handler 不依赖 event.sender、
     * 无本机 UI/shell 副作用、语义只在被控端执行才正确, 满足 device-link
     * allowlist 的三条准入判据, 后续做跨设备下线可原样登记。
     */
    this.host.ipc.handle('telegramBot:set-online', async (payload) => {
      if (!isRecord(payload) || typeof payload.online !== 'boolean') {
        this.host.ipc.throwIpcError(
          'INVALID_PARAMS',
          'expected an object payload { online: boolean }',
        );
      }
      const { online } = payload;
      if (!this.host.secrets.isAvailable()) {
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
        return { status: this.status };
      }
      if (online) {
        await this.goOnline();
      } else {
        await this.goOffline();
      }
      return { status: this.status };
    });

    this.host.ipc.handle('telegramBot:disconnect', async () => {
      this.configVersion += 1;
      const disconnectedOwnerUserId = this.ownerUserId;
      // 下线态 this.api 已被 stopPolling 置空,但解绑仍要用它清命令菜单、发解绑
      // 通知 —— 不复活的话「先下线再解绑」会让 /help 等失效命令永久留在 Telegram
      // 里,而 token 随即被删,以后再也没机会清。用保留的 token 临时造一个
      // client(best-effort;末尾 stopPolling 会再次置空)。
      if (!this.api) {
        const retainedToken = this.host.secrets.read(TOKEN_SECRET_KEY)?.trim() ?? '';
        if (retainedToken) {
          this.api = (this.opts.apiFactory ?? createTelegramApiClient)(retainedToken);
        }
      }
      // 顺手清掉 owner scope 的命令菜单(解绑后菜单残留会误导)。
      if (this.api && disconnectedOwnerUserId) {
        void this.api
          .call('deleteMyCommands', {
            scope: { type: 'chat', chat_id: Number(disconnectedOwnerUserId) },
          })
          .catch(() => {});
      }
      this.ownerUserId = '';
      await this.sendOwnerNoticeWithTimeout(
        disconnectedOwnerUserId,
        'disconnected',
        OWNER_NOTICE_TIMEOUT_MS,
        () => !this.ownerUserId,
      );
      this.host.secrets.remove(TOKEN_SECRET_KEY);
      this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
      this.host.secrets.remove(LEGACY_RUNTIME_ACTIVE_SECRET_KEY);
      this.host.secrets.remove(UPDATES_OFFSET_SECRET_KEY);
      // 解绑必须连下线标志一起清: 留着的话重新填 token 会连上、但重启即回
      // offline, 表现为"填了 token 却不工作"。
      this.host.secrets.remove(OFFLINE_SECRET_KEY);
      await this.stopPolling();
      this.setStatus({ kind: 'idle' });
      return { status: this.status };
    });
  }

  // ── inbound subscriptions ──────────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onCardAction(handler: CardActionHandler): () => void {
    this.cardActionHandlers.add(handler);
    return () => this.cardActionHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** 群窗口数据面订阅(desktop main 的 groupWindow 存储挂这里)。 */
  onGroupWindowMessage(handler: GroupWindowHandler): () => void {
    this.groupWindowHandlers.add(handler);
    return () => this.groupWindowHandlers.delete(handler);
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    // 独立输出(命令回复/notice/turn 未及流式即失败的报错): 本轮没有已领取
    // 的回挂目标时从队列领取 — 这类输出就是对触发消息的直接响应。
    this.claimTurnReplyTargetIfIdle(userId);
    return this.sendPlainChunked(userId, text);
  }

  async sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    // 与 sendText/卡片同口径: 独立 markdown 输出(slash 命令回复等)也要
    // 认领回挂目标, 否则命令回复不挂回、队列残留错配到下一轮。
    this.claimTurnReplyTargetIfIdle(userId);
    const chunks = chunkTelegramSource(markdown);
    let firstMessageId = '';
    const allImageUrls: string[] = [];
    for (const chunk of chunks) {
      const { messageId, imageUrls } = await this.sendRenderedChunk(userId, chunk);
      if (!firstMessageId) firstMessageId = messageId;
      allImageUrls.push(...imageUrls);
    }
    if (allImageUrls.length > 0 && firstMessageId) {
      await this.uploadImages(firstMessageId, allImageUrls);
    }
    return { messageId: firstMessageId };
  }

  async sendInteractiveCard(
    userId: string,
    spec: InteractiveCardSpec,
    opts?: {
      threadTs?: string;
      deliverToOwnerDm?: boolean;
      ownerDmNote?: string;
      ownerDmSourceMessageId?: string;
    },
  ): Promise<{ messageId: string }> {
    // **只有授权类卡片**转宿主私聊(调用方用 deliverToOwnerDm 点名): 群里的授权卡消不掉,
    // 且只有 owner 能回答它。命令卡 / 会话选择卡(/ctr 等)不传这个开关 —— 它们的回调必须
    // 落在原群 lane, 否则 exitControl 释放的是宿主私聊那把锁而不是原群锁。
    // owner 未知时(理论上不该发生: 群 lane 的触发条件本身就是 owner @bot / reply)保持原
    // lane 投递, 不吞掉这次交互。
    const groupLane =
      opts?.deliverToOwnerDm === true && this.ownerUserId ? decodeLaneUserId(userId) : null;
    if (groupLane) {
      // 来源深链只认调用方给的那条触发消息 id —— 只有它知道这张卡属于哪一轮业务 turn。
      // 传输层能看到的两个信号都不等于业务轮次: 回挂目标在 'first' 档发出首条回复即被
      // consumeReplyParams 消耗, 而调用方在发卡前会主动收口流式 handle(turnRunner 的
      // finalizeActiveStream), 所以"有活动流式回合"同样为假。宁可不渲染深链, 不猜。
      const link = groupMessageLink(
        groupLane.chatId,
        sourceMessageIdIn(groupLane.chatId, opts?.ownerDmSourceMessageId),
      );
      // 卡片不再发到群里 —— callSend 只停它自己那条 chat 的 typing loop(这里是宿主私聊),
      // 群里那条会继续每 4.5s 打一次 sendChatAction, 于是群里一直显示「正在输入…」。
      // 手动停掉原群的那条(review 指出的回归)。
      this.stopTypingLoopsForChat(groupLane.chatId);
      // 说明文案由调用方给(传输层不造用户可见措辞); 深链是 URL 不是文案, 在这里拼。
      const notice = [opts?.ownerDmNote, link].filter((line) => line).join('\n');
      const { html, replyMarkup } = buildCardPayload({
        ...spec,
        body: notice.length > 0 ? `${notice}\n\n${spec.body}` : spec.body,
      });
      const sent = await this.callSend<TgMessage>('sendMessage', {
        chat_id: this.ownerUserId,
        text: html,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      // 刻意不动群 lane 的回挂目标: 那条触发消息在私聊里不存在, 消耗掉还会让本轮真正的
      // 回答失去引用。回声按**实际落地**的私聊维度记, 否则群窗口会以为 bot 在群里说过这段。
      this.recordOwnEcho(
        this.ownerUserId,
        spec.title ? `[${spec.title}]` : spec.body.slice(0, 100),
        sent,
      );
      return { messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)) };
    }
    this.claimTurnReplyTargetIfIdle(userId);
    const target = this.targetOf(userId);
    const { html, replyMarkup } = buildCardPayload(spec);
    const { params: replyParams, lease } = this.leaseReplyTarget(userId);
    const sent = await this.callSend<TgMessage>('sendMessage', {
      ...target,
      ...replyParams,
      text: html,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    this.commitReplyTarget(lease);
    this.recordOwnEcho(userId, spec.title ? `[${spec.title}]` : spec.body.slice(0, 100), sent);
    return { messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)) };
  }

  async updateInteractiveCard(messageId: string, spec: InteractiveCardSpec): Promise<void> {
    const { chatId, messageId: nativeId } = decodeMessageId(messageId);
    const { html, replyMarkup } = buildCardPayload(spec);
    await this.editHtml(chatId, nativeId, html, replyMarkup);
  }

  async patchMarkdownCard(messageId: string, markdown: string): Promise<void> {
    const { chatId, messageId: nativeId } = decodeMessageId(messageId);
    const { html } = markdownToTelegramHtml(markdown);
    await this.editHtml(chatId, nativeId, html, undefined);
  }

  async startStreamingText(userId: string, initial?: string): Promise<StreamingTextHandle> {
    // DM 与群/topic 共用同一条流式呈现: send + editMessageText 覆盖同一条
    // 消息, 过程区(工具时间线)与正文一起原地刷新, 定稿原地升级为 rich。
    // 私聊曾走 sendMessageDraft 草稿通道 —— 草稿只能承载一行纯文本, 工具调用
    // 在私聊里因此整体不可见, 与群聊形成两套体验(Chris 2026-08 点名);
    // 呈现规则不再按 DM / 群分叉。
    // 一轮输出开始: 从待配对队列领取本轮的回挂目标(见 claimTurnReplyTarget), 并占住
    // 槽位归属直到本回合收口 —— 期间的排队提示等独立出站不得把它改向新消息。
    this.claimTurnReplyTarget(userId);
    this.beginStreamRound(userId);
    return this.startTrackedStreaming(userId, initial);
  }

  private async startTrackedStreaming(
    userId: string,
    initial?: string,
  ): Promise<StreamingTextHandle> {
    try {
      const handle = await this.createStreamingHandle(userId, initial);
      return this.trackStreamRound(userId, handle);
    } catch (err) {
      // 建 handle 就失败 → 本回合没有 finalize/close 可依靠, 当场退归属, 否则槽位
      // 会被一个不存在的回合永久锁住。
      this.endStreamRound(userId);
      throw err;
    }
  }

  private createStreamingHandle(
    userId: string,
    initial?: string,
  ): Promise<StreamingTextHandle> {
    // 建 handle 时拍下本轮身份。回挂目标此刻还没被任何出站消耗
    // (claimTurnReplyTarget 刚领完) —— 'first' 档下过程消息一发就把槽位耗掉了,
    // 补送若重新 lease 会拿到空目标, 那条答案在群里就脱离了提问脉络。
    const round: StreamRoundIdentity = {
      generation: this.configVersion,
      api: this.api,
      ownerUserId: this.ownerUserId,
      replyTargetId: this.turnReplyTargets.get(userId) ?? null,
    };
    return startTelegramStreaming(
      {
        // 本轮**每一个**触达 Telegram 的出站入口都先核验回合身份 —— 一个不漏。
        // 逐个核验不可省成"补送时查一次": 换 owner 可能发生在任意一次 await 之后,
        // 而 owner-only 变更**不换 api 客户端**, 剩下的出站照样能成功。
        // 覆盖面: send / repost(新消息)、edit / editFinal(原位编辑——终稿的主投递
        // 路径, 换主人后编辑成功就等于把答案写进已失权主人的聊天)、deleteMessage
        // (失权后连清理都不该再碰对方的聊天)、uploadImages(内部逐次再核验)。
        // 正常轮次里这些核验恒为空操作。
        send: async (markdown) => {
          this.assertRoundStillLive(round);
          const { messageId } = await this.sendRenderedChunk(userId, markdown);
          return messageId;
        },
        repost: async (markdown) => {
          // 核验必须在发之前: 补送是全新的 callSend, 按当前世代重新取 api —— 换
          // owner 那条分支不 stopPolling、api 对象不变, 于是旧回合的答案会照发给
          // **已失去授权的旧 userId**。核验失败就抛, 由 finalize 抛回原始编辑错误。
          this.assertRoundStillLive(round);
          const { messageId } = await this.sendRenderedChunk(
            userId,
            markdown,
            round.replyTargetId,
          );
          return messageId;
        },
        edit: async (messageId, markdown) => {
          this.assertRoundStillLive(round);
          const { chatId, messageId: nativeId } = decodeMessageId(messageId);
          const { html } = markdownToTelegramHtml(markdown);
          await this.editHtml(chatId, nativeId, html, undefined);
        },
        uploadImages: async (messageId, imageUrls) => {
          // 图片是多次真实出站(分组 sendMediaGroup、整组失败回落逐张 sendPhoto),
          // 每次之间都有 await —— 所以核验要下沉到每次调用前, 只在批次开头查一次
          // 挡不住"第一组传完才换主人"这个窗口。
          this.assertRoundStillLive(round);
          await this.uploadImages(messageId, imageUrls, () =>
            this.assertRoundStillLive(round),
          );
        },
        chunk: chunkTelegramSource,
        extractImageUrls: (markdown) => markdownToTelegramHtml(markdown).imageUrls,
        editFinal: (messageId, markdown) => {
          this.assertRoundStillLive(round);
          return this.richEditFinal(messageId, markdown);
        },
        deleteMessage: async (messageId) => {
          this.assertRoundStillLive(round);
          const { chatId, messageId: nativeId } = decodeMessageId(messageId);
          await this.requireApi().call('deleteMessage', {
            chat_id: chatId,
            message_id: Number(nativeId),
          });
        },
      },
      initial,
    );
  }

  async sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (stat.size === 0) return { ok: false, reason: 'EMPTY' };
    if (stat.size > MAX_OUTBOUND_FILE_BYTES) return { ok: false, reason: 'TOO_LARGE' };
    const api = this.api;
    if (!api) return { ok: false, reason: 'SEND_FAIL' };

    try {
      const target = this.targetOf(userId);
      const form = new FormData();
      form.set('chat_id', target.chat_id);
      if (target.message_thread_id !== undefined) {
        form.set('message_thread_id', String(target.message_thread_id));
      }
      const name = displayName ?? path.basename(absPath);
      form.set('document', new Blob([fs.readFileSync(absPath)]), name);
      const sent = await api.callForm<TgMessage>('sendDocument', form);
      this.recordOwnEcho(userId, '', sent, [name]);
      return { ok: true, messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)) };
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 413) {
        return { ok: false, reason: 'TOO_LARGE' };
      }
      return { ok: false, reason: 'UPLOAD_FAIL' };
    }
  }

  async reactToMessage(messageId: string, emoji: string): Promise<string | null> {
    const api = this.api;
    if (!api) return null;
    try {
      const behavior = this.behaviorOf();
      if (behavior.emojiReactions === 'off') return null;
      if (this.ambientTriggerIds.has(messageId)) return null; // ambient 全静默
      let effective = emoji;
      if (behavior.emojiReactions === 'expressive') {
        // 终态用变体池(生动档); ack(👀)保持稳重不随机。
        if (emoji === '👍') {
          effective = pickExpressiveReaction(EXPRESSIVE_DONE_POOL);
        } else if (emoji === '👎') {
          effective = pickExpressiveReaction(EXPRESSIVE_ERROR_POOL);
        }
      }
      const { chatId, messageId: nativeId } = decodeMessageId(messageId);
      const isBig = emoji === '👍' || emoji === '👎';
      const react = (value: string) =>
        api.call('setMessageReaction', {
          chat_id: chatId,
          message_id: Number(nativeId),
          reaction: [{ type: 'emoji', emoji: value }],
          // 终态表情放大动画; 过程 ack(👀)保持安静。
          ...(isBig ? { is_big: true } : {}),
        });
      try {
        await react(effective);
        return effective;
      } catch (err) {
        // 变体在该群被 available_reactions 限制 → 回落基础款一次。
        if (effective !== emoji && err instanceof TelegramApiError && err.errorCode === 400) {
          await react(emoji);
          return emoji;
        }
        throw err;
      }
    } catch {
      return null;
    }
  }

  async removeMessageReaction(messageId: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const { chatId, messageId: nativeId } = decodeMessageId(messageId);
      await api.call('setMessageReaction', {
        chat_id: chatId,
        message_id: Number(nativeId),
        reaction: [],
      });
    } catch {
      /* cleanup is best-effort */
    }
  }

  getStatus(): IMStatus {
    return this.status;
  }

  /** 当前 bot 的展示名(群窗口回流条目署名用)。 */
  get botName(): string {
    return this.botDisplayName || this.botUsername || 'bot';
  }

  /** 当前 bot 的 contextId(数字 id 字符串; 未连接为 '') — 群窗口按 bot 命名空间查询用。 */
  get botContextId(): string {
    return this.botId ? String(this.botId) : '';
  }

  // ── connect / polling ──────────────────────────────────────────────────────

  private async connect(token: string): Promise<boolean> {
    const api = (this.opts.apiFactory ?? createTelegramApiClient)(token);
    // getMe 是网络请求, 这段窗口里另一台设备可能远程下线、用户可能本地下线或
    // 登出。这些路径都只递增 configVersion + 停当前 poll —— 尚未创建 poll 的
    // 本次 connect 不受影响, 返回后会无条件写 connected 并拉起新一轮轮询,
    // 于是控制端已经收到「已下线」, 目标机却又回来抢同一个 bot。
    // 捕获出发时的世代, 回来后核对: 失效就安静退出, 不写状态、不起轮询。
    const generation = this.configVersion;
    this.setStatus({ kind: 'connecting' });
    let me: TgUser;
    try {
      me = await api.call<TgUser>('getMe');
    } catch (err) {
      if (this.configVersion !== generation || this.disposing) return false;
      this.setStatus(mapConnectErrorToStatus(err));
      return false;
    }
    // 世代变了(被下线/登出/换 token)或已 dispose → 本次连接结果作废。offline
    // 标志再查一次是防守: 远程下线写标志与递增世代之间也有窗口。
    if (this.configVersion !== generation || this.disposing) {
      this.log.info('connect result discarded: superseded by offline/dispose during getMe');
      return false;
    }
    const offlineFlagState = this.offlineFlagState();
    if (offlineFlagState !== 'absent') {
      if (offlineFlagState === 'unknown') {
        this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
      } else {
        this.botId = me.id;
        this.setStatus({ kind: 'offline', appId: String(me.id) });
      }
      this.log.info('connect result discarded: offline flag is set or unreadable after getMe');
      return false;
    }
    this.api = api;
    this.botId = me.id;
    this.botUsername = me.username ?? '';
    this.botDisplayName = me.first_name ?? '';
    this.setStatus({ kind: 'connected', appId: String(me.id) });
    this.startPolling(api);
    this.registerOwnerCommandMenu();
    return true;
  }

  /**
   * 人格名字同步到 Telegram 资料页(setMyName)。空名 = 清除自定义名。
   * 返回是否成功(限流/网络失败返回 false, 由设置卡提示重试)。
   */
  async syncBotProfileName(name: string): Promise<boolean> {
    const api = this.api;
    if (!api) return false;
    try {
      await api.call('setMyName', { name: name.slice(0, 64) });
      // 名字召唤(detectGroupTrigger)按显示名匹配 — 同步成功即更新本地缓存,
      // 不等下次 getMe。
      this.botDisplayName = name.slice(0, 64);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`telegram setMyName failed: ${msg}`);
      return false;
    }
  }

  /**
   * 把命令菜单注册到 owner 私聊 scope(best-effort, 失败静默)。
   * scope 精准到 chat: 只有 owner 的输入框会出现 "/" 菜单。
   */
  private registerOwnerCommandMenu(): void {
    const api = this.api;
    const menu = this.opts.commandMenu;
    if (!api || !menu?.length || !this.ownerUserId) return;
    void api
      .call('setMyCommands', {
        commands: menu,
        scope: { type: 'chat', chat_id: Number(this.ownerUserId) },
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`telegram command menu register failed (non-fatal): ${msg}`);
      });
  }

  private startPolling(api: TelegramApiClient): void {
    const abort = new AbortController();
    this.pollAbort = abort;
    const generation = this.configVersion;
    this.pollLoop = this.runPollLoop(api, abort, generation).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`telegram poll loop exited unexpectedly: ${msg}`);
    });
  }

  private async runPollLoop(
    api: TelegramApiClient,
    abort: AbortController,
    generation: number,
  ): Promise<void> {
    let offset = this.readPersistedOffset();
    this.lastSeenOffset = offset;
    let retryDelay = POLL_RETRY_BASE_MS;
    while (!abort.signal.aborted && this.configVersion === generation) {
      try {
        const updates = await api.call<TgUpdate[]>(
          'getUpdates',
          {
            offset,
            timeout: POLL_TIMEOUT_SEC,
            allowed_updates: ['message', 'callback_query'],
          },
          abort.signal,
        );
        retryDelay = POLL_RETRY_BASE_MS;
        if (this.status.kind !== 'connected') {
          this.setStatus({ kind: 'connected', appId: String(this.botId) });
        }
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          this.lastSeenOffset = offset;
          if (abort.signal.aborted || this.configVersion !== generation) return;
          // 只分发不等待: 处理进 per-chat 串行链, 循环立即消费下一条 —
          // 一个 chat 的相册下载/顺序门不会拖住其它 chat(#1098 review P1/P2)。
          this.dispatchUpdate(update, generation);
        }
        // 持久化游标走低水位: 不越过任何在途(分发未收口)update 与缓冲中
        // 相册 — 各任务收口时在 finally 里自行补写(getUpdates 的内存 offset
        // 照常前进, 本连接内不重复拉取)。
        if (updates.length > 0) this.persistOffsetCapped();
      } catch (err) {
        if (abort.signal.aborted || this.configVersion !== generation) return;
        if (err instanceof TelegramApiError && err.errorCode === 409) {
          this.setStatus({ kind: 'conflict', appId: String(this.botId) });
          await sleep(POLL_CONFLICT_RETRY_MS, abort.signal);
          continue;
        }
        if (err instanceof TelegramApiError && (err.errorCode === 401 || err.errorCode === 404)) {
          this.setStatus({ kind: 'error', reason: 'invalid token', code: 'invalid-token' });
          return;
        }
        // 网络抖动/超时: connecting + 指数退避重试。
        if (this.status.kind === 'connected') this.setStatus({ kind: 'connecting' });
        await sleep(retryDelay, abort.signal);
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS);
      }
    }
  }

  private async stopPolling(): Promise<void> {
    this.clearPendingAlbums();
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.pollLoop) {
      try {
        await this.pollLoop;
      } catch {
        /* swallow */
      }
      this.pollLoop = null;
    }
    this.api = null;
  }

  // ── update handling ────────────────────────────────────────────────────────

  /**
   * 把 update 挂进所属 chat 的串行处理链并登记在途 id。链尾即序: 同 chat
   * 严格按到达顺序处理; 不同 chat 各自成链互不等待。收口(成功/失败/跳过)
   * 时移除在途 id 并补写低水位游标 — 进程在任何点退出, 重启都从"最早未
   * 完成的 update"续读, 不丢消息(at-least-once)。
   */
  private dispatchUpdate(update: TgUpdate, generation: number): void {
    const chatId =
      update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? 'global';
    const key = String(chatId);
    const inflightKey = Symbol();
    this.inflightUpdates.set(inflightKey, update.update_id);
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        if (this.disposing || this.configVersion !== generation) return;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`telegram update handling failed: ${msg}`);
        }
      })
      .finally(() => {
        this.inflightUpdates.delete(inflightKey);
        if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
        if (!this.disposing && this.configVersion === generation) this.persistOffsetCapped();
      });
    this.chatQueues.set(key, next);
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (this.disposing) return;
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const m = update.message;
    if (!m || !m.from) return;
    if (m.from.id === this.botId) return; // 自身消息(某些客户端场景)不处理

    // 相册成员先入群窗口(逐条, 幂等), turn 触发交给聚合器合并处理。
    if (m.media_group_id) {
      if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
        this.emitGroupWindow(groupWindowEntryOf(m), m);
      }
      this.bufferAlbumMessage(m, update.update_id);
      return;
    }

    // 顺序门: 同 chat 有相册在 settle/处理中时, 后续消息等它收口再进 turn —
    // 否则"相册 + 追问"会被倒序回答。本方法跑在该 chat 自己的串行链里
    // (dispatchUpdate), 等待只挡本 chat, 其它 chat 的链照常并行。
    const gates = [...this.albumsInFlight]
      .filter((album) => album.chatId === String(m.chat.id))
      .map((album) => album.done);
    if (gates.length > 0) {
      const generation = this.configVersion;
      await Promise.all(gates);
      if (this.disposing || this.configVersion !== generation) return;
    }

    await this.processInboundMessage(m);
  }

  /** 相册成员缓冲 + 静默窗到期后合并处理。 */
  private bufferAlbumMessage(m: TgMessage, updateId: number): void {
    const key = `${m.chat.id}:${m.media_group_id}`;
    const generation = this.configVersion;
    const existing = this.pendingAlbums.get(key);
    let album: PendingAlbum;
    if (existing && !existing.settled) {
      existing.messages.push(m);
      if (existing.timer) clearTimeout(existing.timer);
      album = existing;
    } else {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      album = {
        messages: [m],
        timer: null,
        firstUpdateId: updateId,
        chatId: String(m.chat.id),
        done,
        resolveDone,
        settled: false,
      };
      this.pendingAlbums.set(key, album);
      this.albumsInFlight.add(album);
    }
    album.timer = setTimeout(() => {
      // 关闭追加(摘 append 键), 但留在 albumsInFlight 直到处理收口 —
      // 游标 cap 与顺序门在处理期间必须仍然生效(review P1)。
      album.settled = true;
      this.pendingAlbums.delete(key);
      const finish = () => {
        this.albumsInFlight.delete(album);
        album.resolveDone();
        if (!this.disposing && this.configVersion === generation) this.persistOffsetCapped();
      };
      if (this.disposing || this.configVersion !== generation) {
        finish();
        return;
      }
      // 有正文/引用的成员当主消息(caption 通常只挂在其中一条上)。
      const primary =
        album.messages.find((x) => (x.text ?? x.caption ?? '') !== '' || x.reply_to_message) ??
        album.messages[0];
      const siblings = album.messages.filter((x) => x !== primary);
      void this.processInboundMessage(primary, siblings, { skipGroupWindow: true })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`telegram album handling failed: ${msg}`);
        })
        .finally(finish);
    }, ALBUM_SETTLE_MS);
  }

  private clearPendingAlbums(): void {
    for (const album of this.albumsInFlight) {
      if (album.timer) clearTimeout(album.timer);
      album.resolveDone(); // 解开顺序门, 不留悬挂 await
    }
    this.pendingAlbums.clear();
    this.albumsInFlight.clear();
  }

  /**
   * 返回消息超龄的毫秒数; 未超龄、或时间戳缺失/不可信时返回 null(按新鲜处理)。
   *
   * 缺时间戳时选择放行而非拦截: 拦错等于吞掉用户当下发的消息, 比多回一条
   * 陈旧消息严重得多。
   */
  private staleMessageAgeMs(m: TgMessage): number | null {
    if (!Number.isFinite(m.date) || m.date <= 0) return null;
    const age = Date.now() - m.date * 1_000;
    return age > STALE_MESSAGE_MS ? age : null;
  }

  /** 只记录时长与 Telegram 侧序号 — 不写用户内容, 也不写 chat / user id。 */
  private logStaleSkip(ageMs: number, chatType: string, messageId: number): void {
    this.log.info(
      `telegram stale message skipped (${Math.round(ageMs / 1_000)}s old ${chatType} message=${messageId})`,
    );
  }

  private async processInboundMessage(
    m: TgMessage,
    siblings: TgMessage[] = [],
    opts: { skipGroupWindow?: boolean } = {},
  ): Promise<void> {
    if (!m.from) return;
    const staleFor = this.staleMessageAgeMs(m);
    if (m.chat.type === 'private') {
      if (staleFor !== null) {
        // 陌生人提示也一并跳过 —— 隔夜再回一句「我不认识你」同样是诈尸。
        this.logStaleSkip(staleFor, 'private', m.message_id);
        return;
      }
      if (String(m.from.id) !== this.ownerUserId) {
        // 非 owner 私聊: 礼貌回应一句(官方 bot unbound 提示的个人版语义),
        // per-user 冷却防刷屏; 不进任何业务链路。
        this.maybeSendStrangerNotice(String(m.from.id), String(m.chat.id), m.message_id);
        return;
      }
      // 附件下载可达数秒 — 快照受理时的配置, 完成后配置已换代就丢弃
      // (与 Discord 的 acceptedContext 模式同口径)。
      const acceptedConfigVersion = this.configVersion;
      const event = await normalizeMessage(m, {
        api: this.requireApi(),
        contextId: String(this.botId),
        mediaDir: this.mediaDir,
        ...(siblings.length > 0 ? { siblings } : {}),
        ...(this.host.media ? { media: this.host.media } : {}),
      });
      if (this.disposing || this.configVersion !== acceptedConfigVersion) return;
      if (this.behaviorOf().replyQuoteDm === 'first') {
        this.queueReplyTarget(String(m.from.id), String(m.message_id));
      }
      // DM 也要 typing: 首条真实消息落地前, 聊天列表/标题栏的「正在输入…」
      // 是唯一反馈, 靠 sendChatAction(Chris 2026-07-30 实测点名缺失)。
      this.startTypingLoop(String(m.chat.id));
      this.emitMessage(event);
      return;
    }

    if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
      // 每条群消息(触发与否)都进本地窗口 — 群上下文的数据面。相册成员在
      // 缓冲入口已逐条入窗, 这里跳过避免重复(入窗本身幂等, 跳过纯省一次写)。
      if (!opts.skipGroupWindow) {
        this.emitGroupWindow(groupWindowEntryOf(m), m);
      }
      // 群消息的历史价值与「该不该现在回答」是两件事: 上面照常入窗(数据面),
      // 这里只拦 turn 触发 —— 隔夜的 @ 不再唤起一轮回答。
      if (staleFor !== null) {
        this.logStaleSkip(staleFor, m.chat.type, m.message_id);
        return;
      }

      let trigger = detectGroupTrigger(m, this.botId, this.botUsername, this.botDisplayName);
      let ambient = false;
      const isOwner = String(m.from.id) === this.ownerUserId;
      if (!trigger && isOwner) {
        // owner 的裸斜杠命令视为显式召唤: 群里主人手打 /project 不该因为没带
        // @username 而石沉大海(2026-07-31 实测反馈)。只认**不带 @ 后缀**的
        // 命令 token — `/cmd@其它bot` 是显式发给别的 bot 的, 不抢答(带
        // @本bot 后缀的由 detectGroupTrigger 的 bot_command 分支处理)。
        // 成员的裸命令不在此列 — 仍走"命令 owner 专属"的静默丢弃。
        const plain = (m.text ?? '').trim();
        const firstToken = plain.split(/\s/, 1)[0] ?? '';
        if (/^\/[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(firstToken)) trigger = { text: plain };
      }
      if (!trigger) {
        // 全响应·自主判断(per-chat 配置): 未被召唤的消息也进 turn, 打 ambient
        // 标记 — 业务层注入安静上下文, 模型可用 NO_REPLY 沉默。
        const activation = this.behaviorOf().groupActivation?.[String(m.chat.id)] ?? 'mention';
        if (activation !== 'always') return;
        const plain = (m.text ?? m.caption ?? '').trim();
        if (!plain) return; // 纯媒体/服务消息不进 ambient turn
        trigger = { text: plain };
        ambient = true;
      }
      {
        const probe = trigger.text.trimStart();
        const isCommand = probe.startsWith('/') || probe.startsWith('!');
        // 命令永远 owner 专属且必须显式召唤: 成员命令静默丢(群里不可被探测,
        // 对标 OpenClaw/Hermes); ambient 路径不消费任何人的命令。
        if (isCommand && (!isOwner || ambient)) return;
      }
      const laneUserId = this.resolveGroupLane(m);
      if (this.behaviorOf().replyQuoteGroup !== 'off') {
        this.queueReplyTarget(laneUserId, String(m.message_id));
      }
      if (ambient) {
        // ambient 全静默: 不 typing、不表情(说不说话都不能打扰群)。
        this.ambientTriggerIds.add(`${m.chat.id}|${m.message_id}`);
        if (this.ambientTriggerIds.size > 512) {
          const oldest = this.ambientTriggerIds.values().next().value;
          if (oldest !== undefined) this.ambientTriggerIds.delete(oldest);
        }
      } else {
        // 被召唤即出 typing 并持续续命到首条输出 — "收到了, 在干活"。
        this.startTypingLoop(
          String(m.chat.id),
          m.is_topic_message === true ? m.message_thread_id : undefined,
        );
      }
      const acceptedConfigVersion = this.configVersion;
      const event = await normalizeMessage(m, {
        api: this.requireApi(),
        contextId: String(this.botId),
        mediaDir: this.mediaDir,
        overrideText: trigger.text,
        laneUserId,
        ...(siblings.length > 0 ? { siblings } : {}),
        ...(this.host.media ? { media: this.host.media } : {}),
      });
      if (this.disposing || this.configVersion !== acceptedConfigVersion) return;
      this.emitMessage({
        ...event,
        speaker: {
          id: String(m.from.id),
          name:
            [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || String(m.from.id),
          ...(m.from.username ? { username: m.from.username } : {}),
          isOwner,
        },
        ...(ambient ? { ambient: true } : {}),
      });
    }
    // channel 消息不支持(bot 作为频道管理员的广播场景不在个人助理语义内)。
  }

  private async handleCallbackQuery(q: import('./api.js').TgCallbackQuery): Promise<void> {
    const api = this.api;
    if (!api) return;
    // 应答只有一次机会: 同一个 callback_query_id 二次 answer 会被 Telegram 拒掉。
    // 先无条件发一次空 answer 消 loading, 会把后面那条「已过期」alert 一起吞掉 ——
    // 分支决定这唯一一次应答带不带提示。
    const answer = (extra?: Record<string, unknown>): void => {
      void api
        .call('answerCallbackQuery', { callback_query_id: q.id, ...extra })
        .catch(() => undefined);
    };
    if (String(q.from.id) !== this.ownerUserId) {
      answer();
      return;
    }
    const event = parseCallbackQuery(q);
    if (!event) {
      // ref 失效(重启丢内存 token / 被淘汰): 提示过期的同时把键盘清掉。
      // 只提示不清键盘, 按钮会一直留在原消息上 —— 看起来还能点, 点了只会再弹一次过期。
      answer({
        text: this.opts.expiredCardNotice ?? DEFAULT_EXPIRED_CARD_NOTICE,
        show_alert: true,
      });
      // 但**只有整张卡都失效**才清键盘: token 是逐个淘汰的, 同卡其它按钮可能还能用,
      // 清掉等于把一次仍能完成的交互从用户手里拿走(pending 那头还在等它)。
      if (q.message && !hasLiveCallbackToken(q.message)) {
        void api
          .call('editMessageReplyMarkup', {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => undefined);
      }
      return;
    }
    answer();
    for (const h of this.cardActionHandlers) {
      try {
        h(event);
      } catch {
        /* swallow */
      }
    }
  }

  private emitMessage(event: IMMessageEvent): void {
    for (const h of this.messageHandlers) {
      try {
        h(event);
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * 群窗口入窗的**唯一出口**, 也是受保护内容的唯一执行点。
   *
   * source 传原始 Telegram 消息(入站)或 send 返回的消息(自回流): 只要它带
   * has_protected_content, 该群开了「禁止保存内容」, 这条就一个字都不落本地池
   * —— 与官方 bot 服务端「has_protected_content 的消息不中继」同一语义。判据放
   * 在这里而不是各调用点, 是为了让将来新增的入窗路径默认受同一条边界约束。
   */
  private emitGroupWindow(
    entry: Omit<TelegramGroupWindowEntry, 'botId'>,
    source?: Pick<TgMessage, 'has_protected_content'>,
  ): void {
    if (source?.has_protected_content === true) return;
    // botId 统一在此注入 — 窗口存储按 bot 命名空间隔离(换绑不串史)。
    const full: TelegramGroupWindowEntry = { ...entry, botId: String(this.botId) };
    for (const h of this.groupWindowHandlers) {
      try {
        h(full);
      } catch {
        /* swallow */
      }
    }
  }

  // ── outbound helpers ───────────────────────────────────────────────────────

  /**
   * 群消息 → lane 归属(OpenClaw 同款会话模型, Chris 2026-07-30 拍板):
   * **一个群一条持久 lane** `g/{chatId}` — 群公共上下文连续, 所有成员(含
   * owner)共享同一条会话, bot 靠发言人标签区分谁在说话。仅论坛型群组真带
   * message_thread_id 的消息按 topic 分流(普通群完全无感)。
   */
  private resolveGroupLane(m: TgMessage): string {
    return encodeLaneUserId(String(m.chat.id), laneThreadIdOf(m));
  }

  /** userId → sendMessage 目标参数(私聊 chat_id = user id; lane 解码回群)。 */
  private targetOf(userId: string): { chat_id: string; message_thread_id?: number } {
    const lane = decodeLaneUserId(userId);
    if (!lane) return { chat_id: userId };
    if (!lane.threadId) return { chat_id: lane.chatId };
    return { chat_id: lane.chatId, message_thread_id: Number(lane.threadId) };
  }

  /** 触发消息入队(等待与它的那一轮输出配对)。 */
  private queueReplyTarget(userId: string, messageId: string): void {
    const queue = this.pendingReplyTargets.get(userId) ?? [];
    queue.push({ id: messageId, at: Date.now() });
    while (queue.length > 32) queue.shift();
    this.pendingReplyTargets.set(userId, queue);
  }

  /**
   * 一轮输出开始(流式句柄创建)时从队头领取本轮回挂目标。lane 的 turn 串行,
   * 触发顺序 = 输出顺序, FIFO 即正确配对。掉队条目(如某轮在产出前失败, 其
   * 目标从未被领取)按 15 分钟时效丢弃, 防止错位配对无限传递。
   */
  private claimTurnReplyTarget(userId: string): void {
    const queue = this.pendingReplyTargets.get(userId);
    const cutoff = Date.now() - 15 * 60_000;
    while (queue && queue.length > 0 && queue[0].at < cutoff) queue.shift();
    const next = queue?.shift();
    if (queue && queue.length === 0) this.pendingReplyTargets.delete(userId);
    if (next) this.turnReplyTargets.set(userId, next.id);
    else this.turnReplyTargets.delete(userId);
  }

  /**
   * 独立输出入口用的领取: 队列有货, 且槽位为空 **或槽位已过时** 时领取。
   *
   * 为何不能拿「槽位非空」当忙: 槽位里的目标可能是上一轮的残留 —— 某轮领取后
   * 出站失败且调用方直接放弃(如 processOne 捕到 unsupportedOnly 后 return), 目标就会
   * 一直占着。旧判据下下一条入站消息领不到自己的新目标, 回复会持续落后一条。
   *
   * 过时判据不靠猜失败原因(传输层无法区分「调用方还会重试」与「已放弃」), 而是用
   * Telegram 的硬事实: 同一 chat 内 message_id 单调递增 —— 队列里出现更大的 id,
   * 就证明有更新的触发消息到达过, 槽位那个已经不是"当前该回的那条"。
   * 这比分类失败路径更嬽: 任何原因造成的残留都会在下一条入站消息处自愈。
   */
  private claimTurnReplyTargetIfIdle(userId: string): void {
    const queue = this.pendingReplyTargets.get(userId);
    if (!queue || queue.length === 0) return;
    const current = this.turnReplyTargets.get(userId);
    if (current !== undefined) {
      // 流式回合持有期间一律不接管: 排队提示这类独立出站不得把正在输出的
      // 回合改向新消息(群 'all' 档会把 A 剩下的答案挂到 B 上)。代价是该提示本身
      // 沿用回合目标或不挂回 —— 但 B 的目标因此留在队列里, B 自己的回合能领到。
      if (this.hasActiveStreamRound(userId)) return;
      // 无活动回合 = 槽位是上一轮残留; 队列里有更新的 id 即证明它过时。
      if (!hasNewerTrigger(queue, current)) return;
    }
    this.claimTurnReplyTarget(userId);
  }

  private hasActiveStreamRound(userId: string): boolean {
    return (this.activeStreamRounds.get(userId) ?? 0) > 0;
  }

  private beginStreamRound(userId: string): void {
    this.activeStreamRounds.set(userId, (this.activeStreamRounds.get(userId) ?? 0) + 1);
  }

  private endStreamRound(userId: string): void {
    const next = (this.activeStreamRounds.get(userId) ?? 0) - 1;
    if (next > 0) this.activeStreamRounds.set(userId, next);
    else this.activeStreamRounds.delete(userId);
  }

  /**
   * 给流式 handle 包上回合归属的生命周期: finalize / close 任一到达即收口(只计
   * 一次)。收口后槽位失去保护, 残留目标可被下一条入站消息覆盖领取(自愈)。
   */
  private trackStreamRound(userId: string, inner: StreamingTextHandle): StreamingTextHandle {
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      this.endStreamRound(userId);
    };
    const wrapped: StreamingTextHandle = {
      get messageId() {
        return inner.messageId;
      },
      append: (delta) => inner.append(delta),
      replace: (fullText) => inner.replace(fullText),
      finalize: async (finalText) => {
        try {
          await inner.finalize(finalText);
        } finally {
          end();
        }
      },
      close: () => {
        try {
          inner.close();
        } finally {
          end();
        }
      },
      // 只在底层真的支持时暴露 —— turnRunner 靠它是否存在判断能不能投图。
      ...(inner.addExtraImageAbsPath
        ? { addExtraImageAbsPath: (absPath: string) => inner.addExtraImageAbsPath?.(absPath) }
        : {}),
    };
    return wrapped;
  }

  /**
   * 租借本次出站的回挂目标: 同时返回 reply_parameters 与**请求级凭据**(lease),
   * **只读不消耗**。allow_sending_without_reply: 触发消息被删时降级为普通消息。
   *
   * 读与消耗分开的原因: 首条出站失败(网络/限流耗尽)时调用方会重试 —— 发前就消耗
   * 会让重试那条丢掉引用('first' 档于是整轮不再挂回)。旧 sendRichFinal 就是这么
   * 做的, DM 改走经典路径后该语义必须留在共用发送入口上。
   */
  private leaseReplyTarget(userId: string): {
    params: TelegramReplyParams;
    lease: ReplyTargetLease;
  } {
    const target = this.turnReplyTargets.get(userId);
    if (!target) return { params: {}, lease: null };
    return { params: replyParamsFor(target), lease: { userId, messageId: target } };
  }

  /**
   * 出站确定成功后才消耗 —— 且只能消耗**本次请求真正带上的那个目标**。
   *
   * 身份校验不可省: 旧轮请求还在途时新一轮可能已 claim 了新目标写进同一个槽位,
   * 此时若按 userId 无条件删除, 旧请求的迟到成功会吃掉新轮的目标 —— 新轮首条
   * 答案于是丢引用(群里就是一条与提问脉络不上的回答)。不匹配 = 本次与当前槽位无关,
   * 什么都不做。
   */
  private commitReplyTarget(lease: ReplyTargetLease): void {
    if (!lease) return;
    if (this.turnReplyTargets.get(lease.userId) !== lease.messageId) return;
    // 群 'all' 档: 目标保留整轮(下一轮 claim 时被替换/清除), 每条出站都挂回。
    const keepForAll =
      decodeLaneUserId(lease.userId) !== null && this.behaviorOf().replyQuoteGroup === 'all';
    if (!keepForAll) this.turnReplyTargets.delete(lease.userId);
  }


  private requireApi(): TelegramApiClient {
    if (!this.api) throw new Error('telegram api is not connected');
    return this.api;
  }

  /**
   * 429 退避一次重试; 'message is not modified' 静默。
   *
   * 退避时长必须尊重 Telegram 给的 `retry_after` **全值, 不设任何上限** —— 早先
   * 这里封在 10s, 于是 `retry_after` 更大的 flood 窗口里重试必然二次失败(实测
   * 2026-08-04: 一个 11 分钟群轮次的终稿撞上 `retry after 26`, 只等 10s 就重试,
   * 再次 429 后整条答案丢失)。任何固定上限都只是把同一个 bug 往后挪: bot-wide
   * flood 的 retry_after 可以是几分钟, 60s 上限照样会提前重试。只有缺失/非法值
   * 才走 RETRY_AFTER_FALLBACK_MS。
   *
   * 退避必须绑定连接生命周期: 等待期可能长达一分钟, 期间实例完全可能被
   * dispose / 下线 / 换配置重连。等待本身用当前世代的 AbortSignal 取消(否则
   * 定时器会活过 dispose), 醒来后再核验一次仍是同一条连接 —— 少了这道核验,
   * 停止后仍会用**旧 api 客户端**补发一次请求, 且这次重试已经脱离调用方
   * (外层如 owner 通知的 4.5s 超时早就返回了), 变成没人收口的后台任务。
   */
  private async callSend<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const api = this.requireApi();
    const generation = this.configVersion;
    const abortSignal = this.outboundAbortSignal();
    // 首条真实消息即将出现 — typing 使命完成(客户端收到消息也会自动清)。
    if (typeof params.chat_id === 'string' || typeof params.chat_id === 'number') {
      this.stopTypingLoopsForChat(String(params.chat_id));
    }
    try {
      return await api.call<T>(method, params);
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 429) {
        // sleep 在 abort 时提前 resolve(不 reject), 所以醒来后必须显式核验。
        await sleep(retryAfterWaitMs(err.retryAfterSec), abortSignal);
        // 已停止 → 放弃重试并抛回原始 429, 不再发出任何请求。
        if (!this.isLiveConnection(api, generation, abortSignal)) throw err;
        return api.call<T>(method, params);
      }
      throw err;
    }
  }

  /**
   * 旧回合还有权发新消息吗。生命周期取消(dispose)、配置换代、重连换客户端、
   * 换主人 —— 任一命中即判这个回合已死, 不得再以它的名义出站。
   *
   * `ownerUserId` 与 `generation` 都查: 换 owner 的分支两者一起变, 但显式写出
   * 主人这条能让"授权易主 → 旧内容不许再发"的意图留在代码里, 也兜住将来某条
   * 路径改了 owner 却忘了升世代。
   */
  private assertRoundStillLive(round: StreamRoundIdentity): void {
    if (this.disposing) throw new Error('telegram round abandoned: instance disposing');
    if (this.configVersion !== round.generation) {
      throw new Error('telegram round abandoned: config generation superseded');
    }
    if (this.api !== round.api) throw new Error('telegram round abandoned: api client replaced');
    if (this.ownerUserId !== round.ownerUserId) {
      throw new Error('telegram round abandoned: owner changed');
    }
    if (this.lifetimeAbort.signal.aborted) {
      throw new Error('telegram round abandoned: lifetime cancelled');
    }
  }

  /**
   * 新 init 世代重建生命周期取消源。只在已 abort 时重建: 未 abort 说明没经历
   * dispose, 此时换掉控制器会让在途退避失去被后续 dispose 取消的能力。
   */
  private resetLifetimeAbort(): void {
    if (!this.lifetimeAbort.signal.aborted) return;
    this.lifetimeAbort = new AbortController();
  }

  /**
   * 出站退避的取消信号: 轮询期用当前世代的 pollAbort(下线/重连即 abort),
   * 并始终叠加实例级 lifetimeAbort(覆盖没有轮询的出站窗口)。
   * 每次调用都重读字段 —— 不得缓存, 否则拿不到新 init 世代的控制器。
   */
  private outboundAbortSignal(): AbortSignal {
    const poll = this.pollAbort?.signal;
    if (poll === undefined) return this.lifetimeAbort.signal;
    return AbortSignal.any([poll, this.lifetimeAbort.signal]);
  }

  /**
   * 退避醒来后的重试前置校验: 仍是同一条连接、同一配置世代、未被取消、未在销毁。
   * `this.api !== api` 覆盖「重连换了客户端」——世代号相同也不能用旧客户端发。
   */
  private isLiveConnection(
    api: TelegramApiClient,
    generation: number,
    abortSignal: AbortSignal,
  ): boolean {
    if (this.disposing) return false;
    if (this.configVersion !== generation) return false;
    if (this.api !== api) return false;
    return !abortSignal.aborted;
  }

  /**
   * Rich 原地定稿(editMessageText + rich_message, Bot API 10.1): 把流式占位
   * 消息一步升级成 rich 渲染(表格/标题/代码块/LaTeX 原生, 32768 上限免分段)。
   * DM 与群共用。404 → 实例级 latch; 400(本条解析不过)只回落本条。
   */
  private async richEditFinal(messageId: string, markdown: string): Promise<boolean> {
    if (this.richSendDisabled || !markdown.trim()) return false;
    const api = this.api;
    if (!api) return false;
    try {
      const { chatId, messageId: nativeId } = decodeMessageId(messageId);
      await api.call('editMessageText', {
        chat_id: chatId,
        message_id: Number(nativeId),
        rich_message: { markdown },
      });
      return true;
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 404) {
        this.richSendDisabled = true;
      }
      return false;
    }
  }

  /**
   * 单段 markdown → HTML 发送; parse 失败回退纯文本(agent 输出偶发怪标记)。
   *
   * `reuseReplyTargetId` 给终稿补送用: 那一轮的回挂目标已经被过程消息消耗掉了
   * ('first' 档用后即耗), 补送是**替换那条消息**而不是新增一条输出, 所以要沿用
   * 同一个目标、且不再走 lease/commit(既不重新领取也不二次消耗)。传 null =
   * 本轮没有目标(如 replyQuote 档位为 off), 按不挂回处理。
   */
  private async sendRenderedChunk(
    userId: string,
    markdownChunk: string,
    reuseReplyTargetId?: string | null,
  ): Promise<{ messageId: string; imageUrls: string[] }> {
    const target = this.targetOf(userId);
    const reusing = reuseReplyTargetId !== undefined;
    const { params: replyParams, lease } = reusing
      ? { params: replyParamsFor(reuseReplyTargetId), lease: null }
      : this.leaseReplyTarget(userId);
    const { html, imageUrls } = markdownToTelegramHtml(markdownChunk);
    let sent: TgMessage;
    try {
      sent = await this.callSend<TgMessage>('sendMessage', {
        ...target,
        ...replyParams,
        text: html || '…',
        parse_mode: 'HTML',
        link_preview_options: LINK_PREVIEW_OPTIONS,
      });
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        sent = await this.callSend<TgMessage>('sendMessage', {
          ...target,
          ...replyParams,
          text: markdownChunk || '…',
          link_preview_options: LINK_PREVIEW_OPTIONS,
        });
      } else {
        throw err;
      }
    }
    this.commitReplyTarget(lease);
    this.recordOwnEcho(userId, markdownChunk, sent);
    return {
      messageId: encodeMessageId(String(sent.chat.id), String(sent.message_id)),
      imageUrls,
    };
  }

  private async sendPlainChunked(userId: string, text: string): Promise<{ messageId: string }> {
    const target = this.targetOf(userId);
    let firstMessageId = '';
    for (const chunk of chunkTelegramSource(text)) {
      // 只首条挂回: 后续分段不租借、也不提交(lease 为 null 时 commit 是 noop)。
      const { params: replyParams, lease } =
        firstMessageId === '' ? this.leaseReplyTarget(userId) : { params: {}, lease: null };
      const sent = await this.callSend<TgMessage>('sendMessage', {
        ...target,
        ...replyParams,
        text: chunk || '…',
        link_preview_options: LINK_PREVIEW_OPTIONS,
      });
      if (!firstMessageId) {
        this.commitReplyTarget(lease);
        firstMessageId = encodeMessageId(String(sent.chat.id), String(sent.message_id));
      }
      this.recordOwnEcho(userId, chunk, sent);
    }
    return { messageId: firstMessageId };
  }

  private async editHtml(
    chatId: string,
    nativeMessageId: string,
    html: string,
    replyMarkup: unknown,
  ): Promise<void> {
    try {
      await this.callSend('editMessageText', {
        chat_id: chatId,
        message_id: Number(nativeMessageId),
        text: html || '…',
        parse_mode: 'HTML',
        link_preview_options: LINK_PREVIEW_OPTIONS,
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      });
    } catch (err) {
      if (err instanceof TelegramApiError && /not modified/i.test(err.message)) return;
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        // HTML parse 失败: 剥标签退回纯文本编辑(宁可丢格式不丢内容)。
        await this.callSend('editMessageText', {
          chat_id: chatId,
          message_id: Number(nativeMessageId),
          text: stripTelegramHtmlTags(html) || '…',
          link_preview_options: LINK_PREVIEW_OPTIONS,
          // 同样要带上 reply_markup: 走到这条 fallback 时若省略, 清空键盘的意图会被丢掉。
          ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
        }).catch((fallbackErr) => {
          if (fallbackErr instanceof TelegramApiError && /not modified/i.test(fallbackErr.message)) {
            return;
          }
          throw fallbackErr;
        });
        return;
      }
      throw err;
    }
  }

  /**
   * 受管图片(cindy-media/xdt-image url 或 `abs:` 前缀绝对路径)出站。
   * 2 张起自动合成原生相册(sendMediaGroup, 每组 ≤10 — Telegram 上限),
   * 客户端渲染为整齐的图集而不是刷屏的一串独立消息; 单张走 sendPhoto;
   * 相册整组失败回落逐张(部分文件缺失/超限时不拖累其余)。
   *
   * `assertLive` 是**每次真实出站前**的回合核验(流式回合传入; 独立出站不传)。
   * 这里的循环会跨多个 await 打出多次 callForm —— >10 张的分组、以及整组失败后
   * 的逐张回落都是。只在进入本方法时查一次挡不住"第一组传完才换主人"的窗口,
   * 剩下的图片会照发到已失权的旧聊天。
   */
  private async uploadImages(
    messageId: string,
    imageRefs: string[],
    assertLive?: () => void,
  ): Promise<void> {
    const api = this.api;
    if (!api || imageRefs.length === 0) return;
    // 图片以 reply 挂回答案锚点消息: 论坛 topic 内自动跟随该 topic(裸发会
    // 落进 General), 视觉上也和答案连成一体; 锚点被删则降级普通发送。
    const { chatId, messageId: anchorNativeId } = decodeMessageId(messageId);
    const anchorReply = {
      reply_parameters: {
        message_id: Number(anchorNativeId),
        allow_sending_without_reply: true as const,
      },
    };
    const seen = new Set<string>();
    const absPaths: string[] = [];
    for (const ref of imageRefs) {
      let absPath: string | null = null;
      if (ref.startsWith('abs:')) {
        absPath = ref.slice(4);
      } else if (this.opts.resolveImageUrl) {
        try {
          absPath = this.opts.resolveImageUrl(ref);
        } catch {
          absPath = null;
        }
      }
      if (!absPath || seen.has(absPath)) continue;
      seen.add(absPath);
      absPaths.push(absPath);
    }
    if (absPaths.length === 1) {
      assertLive?.();
      await this.sendSinglePhoto(chatId, absPaths[0], anchorReply);
      return;
    }
    for (let i = 0; i < absPaths.length; i += 10) {
      const group = absPaths.slice(i, i + 10);
      assertLive?.();
      // 单张不成相册, 直接走单发 —— 这条是正常路径, 不是相册失败。
      const outcome =
        group.length > 1 ? await this.sendPhotoAlbum(chatId, group, anchorReply) : 'rejected';
      if (outcome === 'uncertain') continue; // 可能已经发出去了, 不补发
      if (outcome === 'rejected') {
        for (const absPath of group) {
          assertLive?.();
          await this.sendSinglePhoto(chatId, absPath, anchorReply);
        }
      }
    }
  }

  private behaviorOf(): TelegramBehaviorConfig {
    try {
      return this.opts.behavior?.() ?? TELEGRAM_DEFAULT_BEHAVIOR;
    } catch {
      return TELEGRAM_DEFAULT_BEHAVIOR;
    }
  }

  /**
   * 持续 typing: 立即打一次 sendChatAction 并按 4.5s 续命(原生 typing 只显
   * ~5s), 首条真实消息发出(callSend)即停; 5 分钟兜底上限。聊天列表与标题栏
   * 的「正在输入…」由它保证 — DM 的草稿占位只在会话内部可见, 不能替代。
   */
  private startTypingLoop(chatId: string, messageThreadId?: number): void {
    const key = `${chatId}:${messageThreadId ?? ''}`;
    const existing = this.typingLoops.get(key);
    if (existing) {
      existing.startedAt = Date.now(); // 同 chat 追问: 续租, 不叠循环
      return;
    }
    this.sendTypingAction(chatId, messageThreadId);
    const timer = setInterval(() => {
      const loop = this.typingLoops.get(key);
      if (!loop || Date.now() - loop.startedAt > TYPING_LOOP_MAX_MS || this.disposing) {
        this.stopTypingLoop(key);
        return;
      }
      this.sendTypingAction(chatId, messageThreadId);
    }, TYPING_REFRESH_MS);
    this.typingLoops.set(key, { timer, startedAt: Date.now() });
  }

  private stopTypingLoop(key: string): void {
    const loop = this.typingLoops.get(key);
    if (!loop) return;
    clearInterval(loop.timer);
    this.typingLoops.delete(key);
  }

  /** 该 chat 的所有 typing 循环全停(首条真实消息已到, 客户端会自动清 typing)。 */
  private stopTypingLoopsForChat(chatId: string): void {
    for (const key of [...this.typingLoops.keys()]) {
      if (key.startsWith(`${chatId}:`)) this.stopTypingLoop(key);
    }
  }

  private clearAllTypingLoops(): void {
    for (const key of [...this.typingLoops.keys()]) this.stopTypingLoop(key);
  }

  /** fire-and-forget typing 状态(失败静默 — 纯体验增强, 不参与正确性)。 */
  private sendTypingAction(chatId: string, messageThreadId?: number): void {
    const api = this.api;
    if (!api) return;
    void api
      .call('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {
        /* 无权限/限流一律静默 */
      });
  }

  private async sendSinglePhoto(
    chatId: string,
    absPath: string,
    anchorReply?: { reply_parameters: { message_id: number; allow_sending_without_reply: true } },
  ): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      if (anchorReply) form.set('reply_parameters', JSON.stringify(anchorReply.reply_parameters));
      form.set('photo', new Blob([fs.readFileSync(absPath)]), path.basename(absPath));
      await api.callForm('sendPhoto', form);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`telegram image upload failed: ${msg}`);
    }
  }

  /**
   * 多图原生相册(attach:// 多部分上传)的结果。
   *
   * `rejected` 与 `uncertain` 的区别决定了能不能逐张重发:
   * Telegram 没有发送端幂等键, 一次 sendMediaGroup 只要被服务端接受, 图片就
   * 已经出现在聊天里 —— 哪怕响应在网络上丢了。此时逐张补发会让用户看到**两套**
   * 同样的图, 而且无法分辨哪些是重复。只有 Telegram 明确回 400(确定性拒绝相册
   * 形状, 一张都没接受)时, 逐张回落才是安全的 —— 与官方 bot 服务端同一判据。
   */
  private async sendPhotoAlbum(
    chatId: string,
    absPaths: string[],
    anchorReply?: { reply_parameters: { message_id: number; allow_sending_without_reply: true } },
  ): Promise<'sent' | 'rejected' | 'uncertain'> {
    const api = this.api;
    if (!api) return 'uncertain';

    // 组装(含本地读盘)与发送分开 catch。两者都会抛, 但含义相反: 组装失败时请求
    // 根本没发出, 一张都没进聊天 —— 这跟 Telegram 回 400 是同一类确定性失败,
    // 逐张回落安全, 而且能把同组其余可读的图片救回来。混在一个 catch 里判成
    // uncertain, 一张图丢失就会连累整组静默消失。
    let form: FormData;
    try {
      form = new FormData();
      form.set('chat_id', chatId);
      if (anchorReply) form.set('reply_parameters', JSON.stringify(anchorReply.reply_parameters));
      form.set(
        'media',
        JSON.stringify(absPaths.map((_, i) => ({ type: 'photo', media: `attach://photo${i}` }))),
      );
      absPaths.forEach((absPath, i) => {
        form.set(`photo${i}`, new Blob([fs.readFileSync(absPath)]), path.basename(absPath));
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`telegram album assembly failed before send, fallback to singles: ${msg}`);
      return 'rejected';
    }

    try {
      await api.callForm('sendMediaGroup', form);
      return 'sent';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 400 = Telegram 读懂了请求并拒绝了相册形状(比如某张图不合法), 可以确定
      // 一张都没进聊天; 逐张重发安全。网络错误 / 5xx / 429 都可能是「已被接受,
      // 只是响应没回来」, 重发会造成重复相册 —— 宁可这一组丢失也不重复。
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        this.log.warn(`telegram album rejected (400), fallback to singles: ${msg}`);
        return 'rejected';
      }
      this.log.warn(`telegram album upload outcome unknown, not resending: ${msg}`);
      return 'uncertain';
    }
  }

  /**
   * 自己发进群 lane 的消息回流进群窗口(与官方通道 server 回流 isBot 条目
   * 同语义) — 让下一轮上下文里能看到 bot 自己说过什么。私聊不记录。
   */
  private recordOwnEcho(
    userId: string,
    text: string,
    sent: TgMessage,
    fileNames?: string[],
  ): void {
    const lane = decodeLaneUserId(userId);
    if (!lane) return;
    this.emitGroupWindow({
      chatId: lane.chatId,
      threadId: lane.threadId,
      messageId: String(sent.message_id),
      chatName: sent.chat.title ?? null,
      author: { name: this.botName, isBot: true },
      text,
      ...(fileNames && fileNames.length > 0 ? { fileNames } : {}),
      sentAt: sent.date * 1000,
    }, sent);
  }

  // ── owner notices / secrets ────────────────────────────────────────────────

  /** 恢复一项 secret 并回读确认；调用成功不等于数据真的落盘。 */
  private restoreSecret(key: string, previousValue: string | null): boolean {
    if (previousValue === null) {
      this.host.secrets.remove(key);
      return this.secretReadResult(key).kind === 'missing';
    }
    if (!this.host.secrets.write(key, previousValue)) return false;
    const restored = this.secretReadResult(key);
    return restored.kind === 'value' && restored.value === previousValue;
  }

  /**
   * 配置事务回滚。任一 secret 无法恢复时，运行态立即停轮询并重新落下线闩锁；
   * 即使磁盘留下新 token 或新旧混合配置，重启也不会拿它自动上线。
   */
  private async rollbackConfigOrFailClosed(
    previousToken: string | null,
    previousOwnerUserId: string | null,
    previousRuntimeOwnerUserId: string,
  ): Promise<boolean> {
    // 两项都必须尝试，不能因第一项失败而把另一项也留在新值。
    const tokenRestored = this.restoreSecret(TOKEN_SECRET_KEY, previousToken);
    const ownerRestored = this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
    this.ownerUserId = previousOwnerUserId?.trim() || previousRuntimeOwnerUserId;
    if (tokenRestored && ownerRestored) return true;

    this.configVersion += 1;
    this.clearAllTypingLoops();
    this.pendingReplyTargets.clear();
    this.turnReplyTargets.clear();
    await this.stopPolling();
    const latchWritten = this.host.secrets.write(OFFLINE_SECRET_KEY, '1');
    const latchConfirmed = latchWritten && this.offlineFlagState() === 'set';
    if (!latchConfirmed) {
      // 最后兜底：闩锁无法确认时删除 token 并回读。二者任一可靠落盘，重启都不会
      // 自动上线；若存储整体失效，运行态仍保持停止并显式报错。
      this.host.secrets.remove(TOKEN_SECRET_KEY);
      const tokenRemovalConfirmed = this.secretReadResult(TOKEN_SECRET_KEY).kind === 'missing';
      if (!tokenRemovalConfirmed) {
        this.log.warn(
          'telegram config rollback failed and no durable offline guard could be confirmed',
        );
      }
    }
    this.setStatus({ kind: 'error', reason: SECRET_WRITE_FAILED_REASON, code: 'secret-unavailable' });
    return false;
  }

  /** 持久化游标按 botId 命名空间 — 换 bot(token)后旧 offset 无意义, 归零。 */
  private readPersistedOffset(): number {
    const raw = this.host.secrets.read(UPDATES_OFFSET_SECRET_KEY);
    if (!raw) return 0;
    const separator = raw.indexOf(':');
    if (separator <= 0) return 0;
    if (raw.slice(0, separator) !== String(this.botId)) return 0;
    const n = Number(raw.slice(separator + 1));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private persistOffset(offset: number): void {
    try {
      if (!this.host.secrets.isAvailable()) return;
      this.host.secrets.write(UPDATES_OFFSET_SECRET_KEY, `${this.botId}:${offset}`);
    } catch {
      /* best-effort — 丢失只是退化回 at-least-once 重放 */
    }
  }

  /**
   * 持久化游标, 但不越过仍在 settle 缓冲的相册成员(取各缓冲相册最早
   * update_id 为上限) — settle 窗口内进程退出/换 token 时, 下次连接从该
   * 相册重放而不是永久丢弃。at-least-once 语义: flush 后崩溃且游标未及
   * 补写时相册会重放一次, 比丢图可取。
   */
  private persistOffsetCapped(): void {
    // 低水位 = min(在途 update, 缓冲/处理中相册的首条): 顺序门里等待的追问、
    // 处理中的消息、settle 后仍在下载附件的相册都算未完成 — 游标一律不越过
    // (#1098 review: 只看相册会把门里等待的追问永久跳过)。
    let floor = Number.POSITIVE_INFINITY;
    for (const album of this.albumsInFlight) {
      floor = Math.min(floor, album.firstUpdateId);
    }
    for (const updateId of this.inflightUpdates.values()) {
      floor = Math.min(floor, updateId);
    }
    this.persistOffset(Math.min(this.lastSeenOffset, floor));
  }

  /** 非 owner 显式召唤的礼貌回应(fire-and-forget, per-user 冷却)。 */
  private maybeSendStrangerNotice(
    userId: string,
    chatId: string,
    replyToMessageId: number,
    opts: { messageThreadId?: number } = {},
  ): void {
    const now = Date.now();
    const last = this.strangerNoticeAt.get(userId) ?? 0;
    if (now - last < STRANGER_NOTICE_COOLDOWN_MS) return;
    this.strangerNoticeAt.set(userId, now);
    if (this.strangerNoticeAt.size > 500) {
      const oldest = this.strangerNoticeAt.keys().next().value;
      if (oldest !== undefined) this.strangerNoticeAt.delete(oldest);
    }
    const api = this.api;
    if (!api) return;
    void api
      .call('sendMessage', {
        chat_id: chatId,
        text: this.opts.strangerNotice?.trim() || DEFAULT_STRANGER_NOTICE,
        reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
        ...(opts.messageThreadId !== undefined
          ? { message_thread_id: opts.messageThreadId }
          : {}),
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`stranger notice failed (non-fatal): ${msg}`);
      });
  }


  private async sendOwnerNoticeWithTimeout(
    userId: string,
    phase: OwnerNoticePhase,
    timeoutMs: number,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    if (!userId || !this.api) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (async () => {
          if (isCurrent && !isCurrent()) return false;
          const text = this.resolveOwnerNoticeText(phase);
          await this.callSend('sendMessage', { chat_id: userId, text });
          return true;
        })().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`telegram owner ${phase} notice failed: ${msg}`);
          return false;
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveOwnerNoticeText(phase: OwnerNoticePhase): string {
    const configured = this.opts.ownerNoticeText;
    const text = typeof configured === 'function' ? configured(phase) : configured?.[phase];
    return text?.trim() || DEFAULT_OWNER_NOTICES[phase];
  }

  private setStatus(s: IMStatus): void {
    this.status = s;
    this.host.ipc.broadcast('telegramBot:status-change', {
      status: s,
      botUsername: this.botUsername || null,
    });
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        /* swallow */
      }
    }
  }
}

export function createTelegramIM(host: IMHost, opts?: TelegramIMOptions): TelegramIM {
  return new TelegramIM(host, opts);
}

export type { TelegramGroupWindowEntry } from './inbound.js';

/**
 * reason 保留原文供日志/诊断; code 是给 UI 用的稳定分类 —— 渲染层按 code 取
 * i18n 文案, 不再把这些英文技术串直接怼给用户看。
 */
/**
 * 私有超级群里某条消息的深链(`t.me/c/<internal>/<messageId>`) —— 授权卡改投宿主私聊后,
 * 用它告诉宿主「是哪个群的哪条消息」。
 *
 * 只对 `-100` 前缀的私有超级群成立(公开群要 username, 这一层没有持久化群名/username)。
 * 形状对不上返回 null, 调用方省掉那一行, 不拼一个点不开的链接。
 */
function groupMessageLink(chatId: string, messageId: string | null): string | null {
  if (messageId === null || !chatId.startsWith('-100')) return null;
  const internal = chatId.slice(4);
  if (!/^\d+$/.test(internal) || !/^\d+$/.test(messageId)) return null;
  return `https://t.me/c/${internal}/${messageId}`;
}

function mapConnectErrorToStatus(err: unknown): IMStatus {
  if (err instanceof TelegramApiError) {
    if (err.errorCode === 401 || err.errorCode === 404) {
      return { kind: 'error', reason: 'invalid token', code: 'invalid-token' };
    }
    return { kind: 'error', reason: `telegram api ${err.errorCode}`, code: 'provider-api' };
  }
  return { kind: 'error', reason: 'network unreachable', code: 'network' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 BotFather token(`<botId>:<secret>`)取 botId。下线态不建连也就没有 getMe,
 * 但设置卡仍要显示 bot 标识、群窗口仍按 botId 命名空间查询 — 前缀本身就是
 * botId, 不值得为此发一次网络请求。形态不符返回 0(与"未连接"同值)。
 */
function botIdFromToken(token: string): number {
  const separator = token.indexOf(':');
  if (separator <= 0) return 0;
  const n = Number(token.slice(0, separator));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * 可取消等待。abort 时提前 resolve(不 reject) —— 调用方靠自己的世代/状态核验
 * 决定醒来后做什么。
 *
 * **进来时就已 aborted 必须立刻返回**: `addEventListener('abort')` 对已经发生过
 * 的 abort 不会再触发, 于是定时器会走满全程。这条路径是可达的 —— dispose() 先
 * 同步 abort 生命周期取消源, 再 `await stopPolling()`(那里要等 pollLoop 才把
 * this.api 置空), 落在这个窗口里的出站拿到的就是一个已取消的信号; 少了这行,
 * 一次 429 会在 dispose 之后干等满一整个退避周期。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
