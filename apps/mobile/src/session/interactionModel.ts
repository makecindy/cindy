import {
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
  buildRemotePluginSetupSummary,
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
  selectActivePendingInteraction,
  selectionFromAnswer,
  sessionScopedPermissionSuggestions,
  sortPendingInteractions,
  type AskQuestion,
  type AskQuestionReviewPresentation,
  type PermissionReviewPresentation,
  type PlanReviewEvidencePresentation,
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
  planViewerState: string;
}): boolean {
  return input.activeKind === 'plan_review'
    && (input.planViewerState === 'expanded' || input.planViewerState === 'edit');
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

/** NOT_CONNECTED(请求未出本机)的自动重试次数与退避基数。 */
const RESOLVE_NOT_CONNECTED_RETRIES = 3;
const RESOLVE_NOT_CONNECTED_BACKOFF_MS = 300;

function isNotConnectedResolveError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === 'NOT_CONNECTED' || message.includes('NOT_CONNECTED');
}

/**
 * 弱网韧性版 resolveInteraction:
 * - NOT_CONNECTED 自动带退避重试。注意 NOT_CONNECTED 不保证未送达(断连时
 *   in-flight invoke 会被批量 reject 成 NOT_CONNECTED),但 resolve 重发是安全的:
 *   交互请求在被控端是一次性的,已解决的 requestId 再收到 resolve 只会被拒,
 *   不会重复执行决定,被拒后走下方权威查证按成功收敛——与 enqueue(追加语义,
 *   盲重会双入队)有本质区别。
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
  for (let attempt = 0; attempt <= RESOLVE_NOT_CONNECTED_RETRIES; attempt++) {
    try {
      await transport.resolveInteraction(requestId, decision);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RESOLVE_NOT_CONNECTED_RETRIES && isNotConnectedResolveError(err)) {
        await sleep(RESOLVE_NOT_CONNECTED_BACKOFF_MS * 2 ** attempt);
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
