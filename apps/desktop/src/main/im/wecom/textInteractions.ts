import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import {
  escapeWecomMarkdown,
  type IMCardActionEvent,
  type InteractiveCardSpec,
  type WecomIM,
} from '@cindy/im';

import { autoReviewUnavailablePromptLine, permissionOperationPreview, permissionPromptDescription } from '../shared/autoReviewUnavailablePrompt';
import { isStopCommand } from '../shared/controlCommands';
import { imText } from '../shared/imText';
import { localizedReplyWords, matchesReplyWord, type ReplyWords } from '../shared/replyWords';
import type { SharedPermission } from '../../maker-ipc/sharedPermission';
import { interactionChoiceReceivedText, permissionOutcomeText } from '../shared/permissionPresentation';
import { createLogger } from '../../logger';

const log = createLogger('im:wecom-interaction');

interface PendingInteraction {
  request: InteractionRequest;
  words: ReplyWords;
  resolve: (decision: InteractionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 已发出的确认卡(模板卡片); 点击按 messageId 对回本请求。 */
  cardId?: string;
  /** 已经收口(决定/超时/取消/替换): 之后不得再发新卡。 */
  settled: boolean;
  /** 卡片已做过本地失效(幂等标记)。 */
  cardExpired: boolean;
  /**
   * 这次确认是否接入了 SharedPermission。共享决定可能被宿主暂停, 所以收到选择时
   * 只能回"已收到"; 非共享请求当场就有最终结果, 直接发结果即可。
   */
  paused: boolean;
}

/**
 * 传输层的可选卡片能力。用可选字段声明而不是直接调 `WecomIM` 上的方法: 旧测试
 * 替身/旧宿主可能没有这些方法, 少了它们就退回纯文字确认, 不能因此报错。
 */
interface WecomCardApi {
  onCardAction?: (handler: (event: IMCardActionEvent) => void) => () => void;
  sendInteractiveCard?: (
    userId: string,
    spec: InteractiveCardSpec,
    options?: { onRegistered?: (messageId: string) => void },
  ) => Promise<{ messageId: string }>;
  updateInteractiveCard?: (messageId: string, spec: InteractiveCardSpec) => Promise<void>;
  supportsTemplateCards?: boolean;
}

const INTERACTION_TIMEOUT_MS = 10 * 60_000;
/** 这些 reason 表示请求没被真正作答(超时/取消/被替换/发不出去), 而不是用户拒绝。 */
const EXPIRED_INTERACTION_REASON =
  /timeout|cancelled|replaced_by_new_request|send_failed|disconnected|session_disposed|session_aborted|session_closed|interaction_route_released|turn_terminal/;

const K = 'imBot.text.wecom.interaction';

/**
 * 企业微信的文字 + 模板卡片确认。
 *
 * 两条入口解析同一份答案、交给同一个决定:
 *  - 文字回复(旧路径, 也用于任意自由回答);
 *  - **模板卡片按钮**(新增): 按钮 key 是每次呈现随机生成的 token, 点击只提交
 *    选择, 不唤醒模型; 最终结果仍由 SharedPermission 决定(桌面/手机可能先答)。
 */
export class WecomTextInteractions {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly cardApi: WecomCardApi;

  constructor(private readonly im: WecomIM) {
    this.cardApi = im as unknown as WecomCardApi;
    im.onTextMessageIntercept((event) => this.consume(event));
    im.onStatusChange((status) => {
      if (status.kind === 'idle' || status.kind === 'conflict' || status.kind === 'error') {
        this.cancelAll('wecom_interaction_disconnected');
      }
    });
    // 卡片点击只在传输层认定"当前主人 + 未过期活卡片 token"之后才会送到这里。
    this.cardApi.onCardAction?.((event) => this.consumeCard(event));
  }

  async handle(userId: string, request: InteractionRequest, options?: { sharedPermission?: SharedPermission }): Promise<InteractionDecision> {
    const shared = options?.sharedPermission;
    if (shared?.decision) return shared.result;
    const previous = this.pending.get(userId);
    if (previous) {
      // 被新请求替换: 旧请求按"已被替换"收口, 旧卡立即失效(不碰新 entry)。
      this.settleEntry(userId, previous, defaultDecision(previous.request, 'replaced_by_new_request'));
    }

    let resolvePending!: (decision: InteractionDecision) => void;
    const result = new Promise<InteractionDecision>((resolve) => {
      resolvePending = resolve;
    });
    const settle = (decision: InteractionDecision) => shared ? shared.decide(decision) : resolvePending(decision);
    const entry: PendingInteraction = {
      request,
      words: localizedReplyWords(),
      resolve: settle,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
      cardExpired: false,
      paused: Boolean(shared),
    };
    const timer = setTimeout(() => {
      // 超时也走统一的收口: 幂等、只作用这一条 entry, 并让已发出的卡失效。
      this.settleEntry(userId, entry, defaultDecision(request, 'wecom_interaction_timeout'));
    }, INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    entry.timer = timer;
    this.pending.set(userId, entry);
    if (shared) void shared.result.then((decision) => {
      // 桌面/手机先给了最终决定: 无论提示/发卡走到哪一步都要收口与失效。
      this.settleEntry(userId, entry, decision);
      resolvePending(decision);
    });
    if (!shared) {
      // 非共享确认(例如 turnRunner 的计划审批)没有别的入口公布结果: 收口时尽力
      // 发一条最终说明。它不改变已经作出的决定, 发送失败只丢这句提示。
      void result
        .then((decision) => this.notifyFinalDecision(userId, request, decision))
        .catch(() => undefined);
    }

    try {
      await this.present(userId, request, entry);
      if (shared) void shared.result.then((decision) => this.im.sendText(userId,
        permissionOutcomeText(decision, request.kind === 'permission' ? request.toolName : undefined),
      )).catch(() => {});
    } catch {
      this.settleEntry(
        userId,
        entry,
        defaultDecision(request, 'wecom_interaction_send_failed'),
      );
      // Denial reasons are classified by exact/prefix match. Raw Error.message
      // is not a system code and would be presented as a user rejection.
      // A reply may already have settled this entry before the prompt ACK failed.
      // Return that decision; settleEntry supplies the denial only while still live.
      return shared ? shared.result : result;
    }
    return result;
  }

  /** 这条 entry 是否仍是该 lane 当前等待的那一条(未被收口/替换)。 */
  private isLive(userId: string, entry: PendingInteraction): boolean {
    return !entry.settled && this.pending.get(userId) === entry;
  }

  /**
   * 收口一条请求。幂等: 只对**当前仍在等待的这条**生效, 不会误伤后来的请求。
   * 返回是否真的由本次调用收口。
   */
  private settleEntry(
    userId: string,
    entry: PendingInteraction,
    decision: InteractionDecision,
  ): boolean {
    const live = this.isLive(userId, entry);
    if (live) {
      entry.settled = true;
      clearTimeout(entry.timer);
      this.pending.delete(userId);
      entry.resolve(decision);
    }
    // 无论谁先收口, 已经发出去的卡都要失效(幂等)。
    void this.expireCard(entry);
    return live;
  }

  /**
   * 呈现确认。Permission / plan_review 优先用模板卡片(按钮就是两个决定);
   * ask_user_question 仍是文字(自由回答, 卡片按钮表达不了)。
   *
   * **完整提示一定先发**: 卡片的二级文本只有 ~112 字, 只放工具名会让「Bash」这种
   * 短命令的确认卡看不到实际操作 —— 用户在按“允许”之前必须已经看到操作/计划内容、
   * 原因与来源。提示发送失败时直接放弃发卡(fail closed), 不能让用户面对一张看不到
   * 具体内容的可批准卡片。
   */
  private async present(
    userId: string,
    request: InteractionRequest,
    entry: PendingInteraction,
  ): Promise<void> {
    const prompt = formatWecomInteractionPrompt(request, entry.words);
    // 无论长短都先发完整提示。
    await this.im.sendMarkdownText(userId, prompt);
    // 提示发送期间请求可能已经被桌面/手机/超时/stop/新请求收口: 不再发可批准卡。
    if (!this.isLive(userId, entry)) return;
    const wantsCard =
      request.kind !== 'ask_user_question' &&
      this.cardApi.supportsTemplateCards === true &&
      typeof this.cardApi.sendInteractiveCard === 'function';
    if (!wantsCard) return;
    let cardId: string;
    try {
      const sent = await this.cardApi.sendInteractiveCard!(userId, buildWecomConfirmCard(request), {
        // Bind before transport IO: an authenticated click can beat the send ACK.
        // Keep the exact card ID check so replaced requests cannot answer a new one.
        onRegistered: (messageId) => { entry.cardId = messageId; },
      });
      cardId = sent.messageId;
    } catch {
      // 卡片不可用(权限/接口拒绝): 文字提示已经给出完整信息, 确认仍可文字作答。
      log.warn('wecom confirm card unavailable; using text prompt');
      return;
    }
    entry.cardId = cardId;
    // 发卡往返期间请求已经收口(桌面/手机先决定、超时、stop、被新请求替换):
    // 这张迟到卡必须立刻在**本地**失效(移出活卡、撤 token), 此后点击不会再提交
    // 决定。远端按钮可能仍然可见 —— 平台不接受我们手上这类无跳转终态卡的更新,
    // 也不保证它会自行消失。
    if (!this.isLive(userId, entry)) void this.expireCard(entry);
  }

  private cancelAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.resolve(defaultDecision(pending.request, reason));
      void this.expireCard(pending);
    }
    this.pending.clear();
  }

  /** 卡片点击: 只把选择提交给共享决定, 回执不等待模型。 */
  private consumeCard(event: IMCardActionEvent): void {
    const pending = this.pending.get(event.senderId);
    if (!pending) return;
    // 只认本请求那张卡: 旧卡(已被替换/收口的)点击一律忽略。
    if (!pending.cardId || pending.cardId !== event.messageId) return;
    const value = typeof event.payload.value === 'string' ? event.payload.value : '';
    const decision = value ? parseReply(pending.request, value, pending.words) : null;
    if (!decision) return;
    // 只提交一次: 收口后重复/迟到点击不会再调用 decide。
    if (!this.settleEntry(event.senderId, pending, decision)) return;
    if (pending.paused) {
      void this.im
        .sendText(event.senderId, interactionChoiceReceivedText())
        .catch(() => undefined);
    }
  }

  /**
   * 非共享确认的最终结果说明。
   *
   * 共享路径由宿主在 `shared.result` 上统一公布; 非共享确认(例如 turnRunner 里的
   * 计划审批)以前只在收到选择时回一句"已收到", 超时/替换后没有任何结论 —— 这里
   * 补上最终说明。文案复用现有口径: 权限走 `permissionOutcomeText`,
   * 计划用同一套 emoji/措辞(共享函数只懂 permission, 不能拿它把"批准计划"误报成
   * 拒绝)。ask_user_question 不是权限决定, 不发结果。
   *
   * 尽力发送: 渠道离线时这句提示可能发不出去, 不影响已经作出的决定, 也不重试。
   */
  private async notifyFinalDecision(
    userId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
  ): Promise<void> {
    let text: string;
    if (request.kind === 'permission') {
      text = permissionOutcomeText(decision, request.toolName);
    } else if (request.kind === 'plan_review') {
      const behavior = decision.kind === 'plan_review' ? decision.behavior : 'deny';
      const reason = decision.kind === 'plan_review' ? decision.reason : undefined;
      text =
        behavior === 'allow'
          ? '✅ 已批准计划'
          : EXPIRED_INTERACTION_REASON.test(reason ?? '')
            ? '⌛ 本次计划确认已失效'
            : '❌ 已拒绝计划';
    } else {
      return;
    }
    try {
      await this.im.sendText(userId, text);
    } catch {
      // 结果提示是尽力而为: 已经作出的决定不受影响, 也不重试刷屏。
    }
  }

  /**
   * 卡片收口 = **只做本地失效**(经传输层把卡片移出活卡表、撤掉 token)。
   *
   * 平台对 `update_template_card` 的结构要求很严: 空按钮 `button_interaction` 被拒
   * (40016), 无跳转的 `text_notice` 也被拒(42045 `card_action Missing or Invalid`,
   * 官方社区确认该卡型更新只接受跳转 1/2)。我们不编造跳转、不伪造点击帧, 因此
   * **不发远端更新**, 也不声称远端按钮已经消失; 结果由调用方另发文字告知。迟到点击
   * 因卡片已不在活卡表且 pending 已清理而不会再提交决定。
   *
   * 幂等且只作用于这一条 entry: 桌面先决定时卡片可能还没发出去(没有 cardId, 稍后
   * 由 present 在返回时补做)。
   */
  private async expireCard(entry: PendingInteraction): Promise<void> {
    if (!entry.cardId || entry.cardExpired) return;
    entry.cardExpired = true;
    const update = this.cardApi.updateInteractiveCard;
    if (!update) return;
    try {
      // 空 buttons = 传输层的本地失效入口; 不会触发平台更新。
      await update.call(this.cardApi, entry.cardId, {
        body: '这个确认已失效，无需再处理。',
        buttons: [],
      });
    } catch {
      // 远端更新失败不影响已经作出的决定。
    }
  }

  private consume(event: { senderId: string; text: string }): boolean {
    const pending = this.pending.get(event.senderId);
    if (!pending) return false;
    if (isStopCommand(event.text)) {
      this.settleEntry(
        event.senderId,
        pending,
        defaultDecision(pending.request, 'wecom_interaction_cancelled_by_stop'),
      );
      return false;
    }
    const decision = parseReply(pending.request, event.text, pending.words);
    if (!decision) {
      const words = pending.words;
      void this.im.sendText(
        event.senderId,
        imText(`${K}.invalidReply`, { allow: words.allow, deny: words.deny }),
      );
      return true;
    }
    this.settleEntry(event.senderId, pending, decision);
    // 仅共享路径回"已收到"(宿主可能还暂停着); 非共享由最终结果说明覆盖, 不双发。
    if (pending.paused) {
      void this.im
        .sendText(event.senderId, interactionChoiceReceivedText())
        .catch(() => undefined);
    }
    return true;
  }
}

/**
 * 确认卡内容。按钮只带**语义值**, token 由传输层每次随机生成 —— 卡片上的按钮
 * 不是静态的 allow/deny id, 猜中 key 也无法代替主人作答。
 */
export function buildWecomConfirmCard(request: InteractionRequest): InteractiveCardSpec {
  if (request.kind === 'plan_review') {
    return {
      title: '计划待批准',
      body: 'Agent 提交了一份执行计划，需要你决定是否继续。',
      buttons: [
        { id: 'approve', label: '批准计划', type: 'primary', payload: { value: '批准' } },
        { id: 'reject', label: '拒绝计划', type: 'danger', payload: { value: '拒绝' } },
      ],
    };
  }
  const toolName = (request.kind === 'permission' ? request.displayName ?? request.toolName : '').slice(0, 40);
  return {
    title: '需要确认操作',
    body: toolName ? `需要确认工具「${toolName}」的这次操作。` : '需要你确认这次操作。',
    buttons: [
      { id: 'allow', label: '允许本次操作', type: 'primary', payload: { value: '允许' } },
      { id: 'deny', label: '拒绝本次操作', type: 'danger', payload: { value: '拒绝' } },
    ],
  };
}

export function formatWecomInteractionPrompt(request: InteractionRequest, words = localizedReplyWords()): string {
  if (request.kind === 'permission') {
    const toolName = escapeWecomMarkdown(request.displayName ?? request.toolName);
    const unavailable = autoReviewUnavailablePromptLine(request);
    return `${imText(`${K}.permissionTitle`, { toolName })}
${permissionPromptDescription(request) ?? ''}
${unavailable ? `\n${unavailable}\n` : ''}
${permissionOperationPreview(request) ? `${imText(`${K}.operationLabel`)}
\`\`\`
${permissionOperationPreview(request)}
\`\`\`
` : ''}

${imText(`${K}.permissionFooter`, { allow: words.allow, deny: words.deny })}`;
  }
  if (request.kind === 'plan_review') {
    const plan = request.plan.length > 6_000 ? `${request.plan.slice(0, 6_000)}…` : request.plan;
    return `${imText(`${K}.planIntro`)}

${plan}

${imText(`${K}.planFooter`, { approve: words.approve, deny: words.deny })}`;
  }
  const question = request.questions[0];
  if (!question) return imText(`${K}.askNoQuestion`);
  const options = (question.options ?? [])
    .slice(0, 9)
    .map((option, index) => `${index + 1}. ${escapeWecomMarkdown(option.label)}`)
    .join('\n');
  return `${imText(`${K}.askIntro`)}
${escapeWecomMarkdown(question.question)}
${options ? `\n${options}\n` : ''}
${imText(`${K}.askFooter`)}`;
}

function defaultDecision(request: InteractionRequest, reason: string): InteractionDecision {
  if (request.kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {} };
  }
  if (request.kind === 'plan_review') {
    return { kind: 'plan_review', behavior: 'deny', reason };
  }
  return { kind: 'permission', behavior: 'deny', reason };
}

function parseReply(request: InteractionRequest, rawText: string, words: ReplyWords): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  const is = (fixed: string[], localized: string) => matchesReplyWord(normalized, fixed, localized);
  if (request.kind === 'permission') {
    if (is(['允许', '同意', '确认', 'allow', 'yes', 'y'], words.allow)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (is(['拒绝', '不允许', '取消', 'deny', 'no', 'n'], words.deny)) {
      return { kind: 'permission', behavior: 'deny', reason: 'wecom_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (is(['批准', '同意', '确认', '继续', 'approve', 'allow', 'yes', 'y'], words.approve)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (is(['拒绝', '取消', 'deny', 'no', 'n'], words.deny)) {
      return { kind: 'plan_review', behavior: 'deny', reason: 'wecom_user_denied' };
    }
    return null;
  }
  const question = request.questions[0];
  if (!question) return { kind: 'ask_user_question', answers: {} };
  const index = Number.parseInt(text, 10);
  const option = Number.isInteger(index) && index >= 1 ? question.options?.[index - 1] : undefined;
  return {
    kind: 'ask_user_question',
    answers: { [question.question]: option?.label ?? text },
  };
}
