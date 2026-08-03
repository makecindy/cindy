import {
  interactionKind as sharedInteractionKind,
  normalizeAskQuestions as sharedNormalizeAskQuestions,
  permissionToolName as sharedPermissionToolName,
  planReviewFilePath as sharedPlanReviewFilePath,
  planReviewPlan as sharedPlanReviewPlan,
  readRequestId as sharedReadRequestId,
  remoteInteractionHandling as sharedRemoteInteractionHandling,
  selectActivePendingInteraction as sharedSelectActivePendingInteraction,
  type PendingInteractionLike,
  type PermissionReviewPresentation,
} from '@cindy/maker-shared/interaction';
import { i18n } from '@/i18n';
import { readAskUserDraft } from '@/session/interactionDraftStore';

export {
  answerKey,
  buildAskQuestionProgressSummary,
  buildAskQuestionReviewPresentation,
  buildAskUserQuestionDecision,
  buildInteractionResolveActionPresentation,
  buildPendingInteractionQueuePresentation,
  buildPermissionDecision,
  buildPermissionDecisionSummary,
  buildPermissionReviewPresentation,
  buildPlanReviewDecision,
  buildPlanReviewDecisionSummary,
  buildPlanReviewEvidencePresentation,
  buildPluginSetupCancelDecision,
  buildRemotePluginSetupPresentation,
  canStartInteractionResolve,
  encodeMultiSelectAnswer,
  extractPlanOutline,
  formatPermissionInput,
  interactionBlocksRemoteComposer,
  interactionKind,
  normalizeAskQuestions,
  pendingInteractionsBlockRemoteComposer,
  permissionRiskSummary,
  permissionTitle,
  planReviewFilePath,
  planReviewPlan,
  readRequestId,
  remoteInteractionHandling,
  REMOTE_PLUGIN_SETUP_ACTION_KINDS,
  REMOTE_PLUGIN_SETUP_ERROR_CODES,
  REMOTE_PLUGIN_SETUP_PHASES,
  selectActivePendingInteraction,
  selectionFromAnswer,
  sessionScopedPermissionSuggestions,
  sortPendingInteractions,
  type AskQuestion,
  type AskQuestionReviewPresentation,
  type PermissionReviewPresentation,
  type PlanReviewEvidencePresentation,
  type RemotePluginSetupGroup,
  type RemotePluginSetupPhase,
  type RemotePluginSetupPresentation,
  type RemotePluginSetupStep,
} from '@cindy/maker-shared/interaction';

export type MobilePermissionDecisionAction = 'allow-once' | 'always-allow';

export function buildMobilePermissionCardState(input: {
  armedDecision: MobilePermissionDecisionAction | null;
  presentation: Pick<PermissionReviewPresentation, 'canAlwaysAllow' | 'riskSummary' | 'title'>;
}): {
  canShowAlwaysAllow: boolean;
  isHighRisk: boolean;
  riskWarningText: string | null;
  title: string;
} {
  const isHighRisk = !!input.presentation.riskSummary;
  const armed = input.armedDecision !== null;
  return {
    canShowAlwaysAllow: input.presentation.canAlwaysAllow && !isHighRisk,
    isHighRisk,
    riskWarningText: input.presentation.riskSummary
      ? (armed ? i18n.t('interaction.permission.armedRiskWarning') : input.presentation.riskSummary)
      : null,
    title: isHighRisk && armed ? i18n.t('interaction.permission.armedHighRiskTitle') : input.presentation.title,
  };
}

export function selectPendingInteractionByRequestId<T extends PendingInteractionLike>(
  interactions: readonly T[],
  requestId: string | null | undefined,
): T | null {
  const fallback = sharedSelectActivePendingInteraction(interactions) as T | null;
  if (!requestId) return fallback;
  return interactions.find((item) => sharedReadRequestId(item) === requestId) ?? fallback;
}

export function shouldUseFullHeightPendingInteractionSurface(input: {
  activeKind: string | null;
  collapsed?: boolean;
  planViewerState: string;
}): boolean {
  // 收起时不能再吃固定高度:那正是「收起后仍然霸屏」的成因,收起的全部意义就是把
  // 屏幕还给消息流。
  if (input.collapsed) return false;
  return input.activeKind === 'plan_review'
    && (input.planViewerState === 'expanded' || input.planViewerState === 'edit');
}

// ─── 待处理卡收起态 ──────────────────────────────────────────────────────────

/**
 * 收起态按 requestId 记录、且必须由**会话页**持有。
 *
 * 曾经它是 AskUserQuestionCard 内部的 useState:卡片 key 变化(队列刷新 / 切卡)、
 * 页面重挂载都会把状态冲掉,用户刚收起来看输出、下一帧卡又弹回来占满屏。状态提到
 * 页面级后,收起是「这条请求我先不答」的稳定意图,只有该请求被终结才失效。
 */
export function isPendingInteractionCollapsed(
  collapsedRequestIds: readonly string[],
  requestId: string | null | undefined,
): boolean {
  if (!requestId) return false;
  return collapsedRequestIds.includes(requestId);
}

export function togglePendingInteractionCollapsed(
  collapsedRequestIds: readonly string[],
  requestId: string,
): string[] {
  if (collapsedRequestIds.includes(requestId)) {
    return collapsedRequestIds.filter((id) => id !== requestId);
  }
  return [...collapsedRequestIds, requestId];
}

/** 收起记录的保留上限:非权威窗口里不清时靠它保持有界(见下方 prune 注释)。 */
const COLLAPSED_REQUEST_ID_LIMIT = 8;

/**
 * 丢掉已经不在 pending 集合里的 requestId(卡被回答 / 被撤)。
 *
 * **清理的前提是这份 pending 列表权威**(`authoritative`,来自被控端的一次全量快照,
 * 见 remoteSessionStore 的 pendingInteractionsAuthoritative)。空列表有两种来源:
 * - 权威的空 = 被控端确认全都处理完了 → **要清**,否则最后一条收起记录永远留着;
 * - 非权威的空 = `markDeviceOffline` 按设计清掉了这份投影(它依赖实时连接),切网 /
 *   进地铁都会让 pending 瞬时归零 → **不能清**,否则重连后被控端把同一张卡灌回来,
 *   它又以展开态占满屏,正是本 PR 要治的病换条路径复发(#1493 review)。
 *
 * 判据只能是这个显式状态,不能退化成看全局 relay status:目标设备 offline 时 relay
 * 仍可能 online。
 *
 * 非权威窗口里不清,集合靠 COLLAPSED_REQUEST_ID_LIMIT 截断最旧的保持有界;权威快照
 * 一到就会收敛掉真正已终结的条目。
 *
 * 无变化时**返回原数组**:调用方在 effect 里按 pending 变化 prune,返回新数组会
 * 让 setState 每帧都换引用 → 依赖它的 effect 无限重入。
 */
export function prunePendingInteractionCollapsed<T extends PendingInteractionLike>(
  collapsedRequestIds: readonly string[],
  pending: readonly T[],
  options: { authoritative: boolean },
): readonly string[] {
  if (collapsedRequestIds.length === 0) return collapsedRequestIds;
  const alive = new Set(
    pending.map((item) => sharedReadRequestId(item)).filter((id): id is string => !!id),
  );
  // 非权威时**一律不清**,连非空列表也不清:重连后可能先到一条 push 增量
  //(applyInteractionRequest)、全量快照还没来,那份列表只含增量那张卡,按它过滤会把
  // 其它仍在等待的请求的收起记录误清 —— 与离线空列表是同一类误判。
  const next = options.authoritative
    ? collapsedRequestIds.filter((id) => alive.has(id))
    : collapsedRequestIds;
  const bounded = next.length > COLLAPSED_REQUEST_ID_LIMIT
    ? next.slice(next.length - COLLAPSED_REQUEST_ID_LIMIT)
    : next;
  return bounded.length === collapsedRequestIds.length ? collapsedRequestIds : bounded;
}

/**
 * 收起条上那行「具体在等什么」。语言无关(用户内容 / 工具名),不引入共享层中文直出。
 *
 * `questionIndex` 是多问提问卡当前翻到第几问(来自 askUserDraft)。缺省 0;传当前进度
 * 才不会出现「收起条写第一问、展开后停在第三问」的错位(#1493 review)。
 */
export function pendingInteractionSummaryText(
  item: PendingInteractionLike,
  questionIndex = 0,
): string | null {
  const kind = sharedInteractionKind(item);
  if (kind === 'ask_user_question') {
    const questions = sharedNormalizeAskQuestions(item.request.questions);
    if (questions.length === 0) return null;
    const index = Number.isInteger(questionIndex)
      ? Math.min(Math.max(questionIndex, 0), questions.length - 1)
      : 0;
    return firstLinePreview(questions[index]?.question);
  }
  if (kind === 'permission') {
    return firstLinePreview(sharedPermissionToolName(item.request));
  }
  if (kind === 'plan_review') {
    return firstLinePreview(sharedPlanReviewPlan(item.request))
      ?? firstLinePreview(sharedPlanReviewFilePath(item.request));
  }
  return null;
}

/**
 * 收起条的呈现(摘要 + 读屏标签)。
 *
 * 做成一个纯函数是为了让读屏行为可被直接断言:标签必须跟随用户翻到的那一问,而
 * 「进入第二问后 label 用第二问」这件事光看渲染代码断言不出来(#1493 review)。
 * 进度从 askUserDraft 现取(卡内翻页时同步保存),所以传 requestId 即可。
 */
export function buildCollapsedPendingInteractionPresentation(input: {
  item: PendingInteractionLike;
  queueTitle: string;
  requestId: string | null | undefined;
}): { accessibilityLabel: string; summaryText: string | null } {
  const questionIndex = input.requestId
    ? readAskUserDraft(input.requestId)?.currentIndex ?? 0
    : 0;
  const summaryText = pendingInteractionSummaryText(input.item, questionIndex);
  return {
    accessibilityLabel: i18n.t('interaction.panel.expandPendingCard', {
      title: summaryText ?? input.queueTitle,
    }),
    summaryText,
  };
}

/**
 * 这张卡能不能给收起入口。
 *
 * 只有本端能终结的卡才可以:队列里混着 plugin_setup / issue_confirm 时,用户能从队列头
 * 切过去,那类卡在手机上答不了(只能取消或回电脑端)。给它挂上「点开回答」的收起条,
 * 既是错的语义,也绕过了「贴输入框上方那种放置点不给收起」的保护(#1493 review)。
 */
export function canCollapsePendingInteraction(item: PendingInteractionLike | null | undefined): boolean {
  return !!item && sharedRemoteInteractionHandling(item) === 'resolvable';
}

const SUMMARY_PREVIEW_MAX_LENGTH = 80;

function firstLinePreview(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const line = value
    .split('\n')
    .map((entry) => entry.replace(/^\s*#{1,6}\s*/, '').trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  return line.length > SUMMARY_PREVIEW_MAX_LENGTH
    ? `${line.slice(0, SUMMARY_PREVIEW_MAX_LENGTH - 1)}…`
    : line;
}

export function isPlanReviewResolveBusy(input: { busy: boolean }): boolean {
  return input.busy;
}

// ─── 弱网韧性提交 ────────────────────────────────────────────────────────────

/** resolveInteraction 依赖的最小 transport 面(便于单测注入 fake)。 */
export interface InteractionResolveTransport {
  resolveInteraction(requestId: string, decision: Record<string, unknown>): Promise<void>;
  getPendingInteractions(sessionId: string): Promise<readonly PendingInteractionLike[]>;
}

/** resolve 瞬时传输失败的自动重试次数与退避基数。 */
const RESOLVE_TRANSIENT_SEND_RETRIES = 3;
const RESOLVE_TRANSIENT_SEND_BACKOFF_MS = 300;

function isRetryableResolveTransportError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'NOT_CONNECTED' ||
    code === 'BACKPRESSURE' ||
    message.includes('NOT_CONNECTED') ||
    message.includes('BACKPRESSURE')
  );
}

/**
 * 弱网韧性版 resolveInteraction:
 * - NOT_CONNECTED / BACKPRESSURE 自动带退避重试。注意 NOT_CONNECTED 不保证未送达(断连时
 *   in-flight invoke 会被批量 reject 成 NOT_CONNECTED),但 resolve 重发是安全的:
 *   交互请求在被控端是一次性的,已解决的 requestId 再收到 resolve 只会被拒,
 *   不会重复执行决定,被拒后走下方权威查证按成功收敛——与 enqueue(追加语义,
 *   盲重会双入队)有本质区别。BACKPRESSURE 要么在本地发送前拒绝,要么由被控端
 *   admission 明确拒绝执行,同样可安全重试。
 * - 其余失败(超时 / ack 丢失 / 对已解决请求的重复提交被拒)以被控端 pending
 *   列表为权威分辨:该 requestId 已不在列表 → 决定已生效,按成功收敛(面板正常
 *   关闭,而不是留给用户一个会诱发二次提交的错误态);仍在列表或查询失败 →
 *   抛原始错误,面板保持可重试。
 */
export async function resolveInteractionResilient(
  transport: InteractionResolveTransport,
  sessionId: string,
  requestId: string,
  decision: Record<string, unknown>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RESOLVE_TRANSIENT_SEND_RETRIES; attempt++) {
    try {
      await transport.resolveInteraction(requestId, decision);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RESOLVE_TRANSIENT_SEND_RETRIES && isRetryableResolveTransportError(err)) {
        await sleep(RESOLVE_TRANSIENT_SEND_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  try {
    const pending = await transport.getPendingInteractions(sessionId);
    if (!pending.some((item) => sharedReadRequestId(item) === requestId)) return;
  } catch {
    // 权威查询也失败:无法分辨,按原始错误上抛
  }
  throw lastErr;
}
