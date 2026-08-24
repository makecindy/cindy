/**
 * 会话尾部收尾提示(error-tail / interrupted)的纯判定模型 —— 对齐桌面
 * CCAgentSessionView 的 errorTailMsg / interruptedFromSession 两套 banner 语义,
 * 手机端渲染由 SessionTailBanner 组件承担,本模块只做可单测的状态推导。
 *
 * 两种语义(互斥,error-tail 优先):
 *  - error-tail:会话尾部停在未忽略的 role='error' 持久化行(桌面进程重启后
 *    live 报错只剩这条历史行)。reason=app-exit-interrupted(旧版补写的中断
 *    标记行)→「继续任务」;普通失败行 →「重试」。
 *  - interrupted:session 双时间戳驱动的「疑似中断」(activeTurnStartedAt >
 *    max(lastTurnEndedAt, clearedAt),桌面 sessionActiveTurn.ts 同款判定)。
 *
 * 抑制条件对齐桌面(漏一条就会出现双红条 / 对同一错误重复续跑):
 *  - live 错误(projection.error)在场 → InlineQueueSection 的错误框独家承载;
 *  - 凭证切换等待(credentialSwitchWait)→ 等待横幅优先;
 *  - 会话跑起来(isSessionStreaming)→ 任务已推进;
 *  - 续跑指令已在 pendingQueue(精确匹配两条共享常量,不用前缀——其它 UI
 *    trigger 并不推进失败 turn,前缀匹配会误抑制,桌面 review P2)→ 已点过。
 */
import {
  APP_EXIT_INTERRUPTED_REASON,
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '@cindy/maker-shared/synthetic-trigger';
import {
  messageContentToPreview,
  sortMessagesByCreatedAt,
} from '@cindy/maker-shared/message-normalize';
import { describeAgentAuthError } from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';
import type { InputProjection, QueuedRemoteMessage, RemoteMessage, RemoteSession } from '@/session/types';

export interface SessionTailErrorBanner {
  kind: 'error-tail';
  /** 错误行 clientId:忽略(dismiss)与本地隐藏态都按它归属。 */
  clientId: string;
  /** 展示文案(agent 未鉴权错误已换成中文引导,其余保持原文)。 */
  text: string;
  /** 主按钮语义:中断标记行 →「继续任务」;普通失败行 →「重试」。 */
  continueKind: 'interrupted' | 'error';
  /**
   * false = 不显示主按钮(agent 未鉴权类错误:凭证在被控电脑上,手机端重试
   * 必撞同一失败;对齐桌面 ErrorBanner 的 401 hide-Retry 门控的核心语义)。
   */
  retryable: boolean;
}

export interface SessionTailInterruptedBanner {
  kind: 'interrupted';
}

export type SessionTailBannerState = SessionTailErrorBanner | SessionTailInterruptedBanner | null;

export interface ResolveSessionTailBannerInput {
  messages: readonly RemoteMessage[];
  session: Pick<RemoteSession, 'activeTurnStartedAt' | 'lastTurnEndedAt' | 'clearedAt'> | null;
  projection: Pick<InputProjection, 'error' | 'credentialSwitchWait'>;
  isSessionStreaming: boolean;
  /**
   * 在途续跑(pendingQueue **加** settling 窗口里存在续跑指令项)——由调用方用
   * isContinuationQueueItem 对两个集合统一计算后传入。**单点判定**:调用方释放
   * 「重试」本地隐藏的信号必须与本抑制条件是同一个值,两处各算一遍曾让
   * settling-only 状态下 hidden 已释放而抑制不生效,banner 重现可重复续跑
   * (review P1 第五轮收敛,model 不再自己扫队列)。
   */
  continuationInFlight: boolean;
  /** interrupted 已被本视图操作过(继续/忽略)或本窗口内会话跑起来过 → 熄灭。 */
  interruptAcked: boolean;
  /**
   * 本视图内已点过「忽略」的错误行(乐观隐藏,持久化 dismiss 由调用方发起;调用方
   * 同时让这些行的错误卡回流消息流)。「重试」不进此集合——点击窗口由 busy 态挡住,
   * enqueue 成功后在途续跑接管抑制,取消续跑时 banner 自动恢复。
   */
  hiddenErrorClientIds: ReadonlySet<string>;
}

/**
 * 队列 / settling 项是否是续跑指令(精确匹配两条共享常量,不用前缀——其它 UI
 * trigger 并不推进失败 turn,前缀匹配会误抑制)。调用方对 pendingQueue 与
 * settlingQueueItems 的并集计算 continuationInFlight 用。
 */
export function isContinuationQueueItem(item: Pick<QueuedRemoteMessage, 'text'>): boolean {
  return item.text === CONTINUE_AFTER_APP_EXIT_PROMPT || item.text === CONTINUE_AFTER_ERROR_PROMPT;
}

export function resolveSessionTailBanner(input: ResolveSessionTailBannerInput): SessionTailBannerState {
  const { projection } = input;
  if (projection.error) return null;
  if (projection.credentialSwitchWait) return null;
  if (input.isSessionStreaming) return null;
  if (input.continuationInFlight) return null;

  const tail = findErrorTailMessage(input.messages);
  if (tail && !input.hiddenErrorClientIds.has(tail.clientId)) {
    const guidance = describeNonRetryableTailError(tail.text);
    return {
      kind: 'error-tail',
      clientId: tail.clientId,
      text: guidance ?? tail.text,
      continueKind: tail.reason === APP_EXIT_INTERRUPTED_REASON ? 'interrupted' : 'error',
      retryable: guidance === null,
    };
  }
  // 历史中断行优先;无 error-tail 才轮到 session 双时间戳判定(对齐桌面互斥渲染)。
  if (tail) return null;

  if (input.interruptAcked || !input.session) return null;
  const started = input.session.activeTurnStartedAt ?? null;
  if (!started) return null;
  const ended = input.session.lastTurnEndedAt ?? 0;
  const cleared = input.session.clearedAt ? Date.parse(input.session.clearedAt) : 0;
  if (started > ended && started > cleared) return { kind: 'interrupted' };
  return null;
}

/**
 * 不可重试的持久化尾行错误 → 引导文案(null = 可重试,展示原文)。对齐桌面
 * ErrorBanner hide-Retry 门控的核心子集——这些错误重试只会撞同一个失败循环:
 *  - agent 未鉴权(describeAgentAuthError 模板):凭证在被控电脑上,手机改不了;
 *  - codex thread not found:进程重启 / 鉴权模式切换后旧 thread 已随旧进程销毁;
 *  - invalid_encrypted_content:换供应商后协议加密内容不可用,需回桌面处理
 *    (fork 剥离入口仅桌面本地 codex 会话有)。
 * 桌面还有依赖本地上下文的更细分支(codex 401 区分 oauth-bearer / 网关 key、
 * session-expired 的登录引导等),手机端拿不到对应信号,不搬——这些场景重试
 * 失败后错误会重新浮现,不破坏数据。
 */
function describeNonRetryableTailError(text: string): string | null {
  const authGuidance = describeAgentAuthError(text);
  if (authGuidance) return authGuidance;
  if (/thread not found/i.test(text)) {
    return i18n.t('session.tail.codexThreadLost');
  }
  if (/invalid_encrypted_content/i.test(text)) {
    return i18n.t('session.tail.encryptedContentInvalid');
  }
  return null;
}

interface ErrorTailMessage {
  clientId: string;
  text: string;
  reason: string | null;
}

/**
 * 消息流去重用:尾部未忽略 error 行的 clientId。命中时该行由 SessionTailBanner
 * 独家承载,render items 里滤掉对应错误卡(对齐桌面 MessageStream 对尾部未忽略
 * error 行返回 null);dismissed / 有后续消息时判定不命中,错误卡自然回流消息流。
 * 与 banner 的可见性抑制(streaming / 续跑已排队等)无关——桌面同款语义。
 */
export function findErrorTailClientId(messages: readonly RemoteMessage[]): string | null {
  return findErrorTailMessage(messages)?.clientId ?? null;
}

/**
 * 会话尾部未忽略的 role='error' 行。跳过手机本地追加的 system 卡(/pwd、/context
 * 等 `mobile-system-` 前缀行):它们挂在错误行之后不代表任务被推进;其余任何角色
 * 的更新消息都算推进,判定不命中(与桌面「最后一条」语义一致)。
 */
function findErrorTailMessage(messages: readonly RemoteMessage[]): ErrorTailMessage | null {
  const sorted = sortMessagesByCreatedAt(messages);
  for (let index = sorted.length - 1; index >= 0; index--) {
    const message = sorted[index];
    if (message.clientId?.startsWith('mobile-system-')) continue;
    if (message.role !== 'error') return null;
    const content = parseRecord(message.content);
    if (content?.dismissed === true) return null;
    const rawText = typeof content?.message === 'string'
      ? content.message
      : messageContentToPreview(message.content);
    return {
      clientId: message.clientId,
      text: rawText,
      reason: typeof content?.reason === 'string' ? content.reason : null,
    };
  }
  return null;
}

function parseRecord(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 非 JSON 原文,按无结构处理 */
    }
  }
  return null;
}
