import {
  interactionKind as sharedInteractionKind,
  normalizeAskQuestions as sharedNormalizeAskQuestions,
  permissionToolName as sharedPermissionToolName,
  planReviewFilePath as sharedPlanReviewFilePath,
  planReviewPlan as sharedPlanReviewPlan,
  readRequestId as sharedReadRequestId,
  selectActivePendingInteraction as sharedSelectActivePendingInteraction,
  type PendingInteractionLike,
  type PermissionReviewPresentation,
} from '@cindy/maker-shared/interaction';
import { i18n } from '@/i18n';

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

/**
 * 丢掉已经不在 pending 集合里的 requestId(卡被回答 / 被撤)。
 *
 * 无变化时**返回原数组**:调用方在 effect 里按 pending 变化 prune,返回新数组会
 * 让 setState 每帧都换引用 → 依赖它的 effect 无限重入。
 */
export function prunePendingInteractionCollapsed<T extends PendingInteractionLike>(
  collapsedRequestIds: readonly string[],
  pending: readonly T[],
): readonly string[] {
  if (collapsedRequestIds.length === 0) return collapsedRequestIds;
  const alive = new Set(
    pending.map((item) => sharedReadRequestId(item)).filter((id): id is string => !!id),
  );
  const next = collapsedRequestIds.filter((id) => alive.has(id));
  return next.length === collapsedRequestIds.length ? collapsedRequestIds : next;
}

/** 收起条上那行「具体在等什么」。语言无关(用户内容 / 工具名),不引入共享层中文直出。 */
export function pendingInteractionSummaryText(item: PendingInteractionLike): string | null {
  const kind = sharedInteractionKind(item);
  if (kind === 'ask_user_question') {
    const questions = sharedNormalizeAskQuestions(item.request.questions);
    return firstLinePreview(questions[0]?.question);
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
