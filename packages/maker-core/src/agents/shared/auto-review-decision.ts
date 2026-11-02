import { evaluateApprovalRules, ruleScopeMatches } from './approval-rules/evaluate.js';
import type { UnifiedRule, RuleScope, AutoAskException, RuleOrigin, RuleHarness } from './approval-rules/types.js';
import { createAutoReviewIntentProjection, type AutoReviewUserIntent } from '@cindy/maker-shared/auto-review-intent';
import type { AgentKind, UserMessage } from '../../types/common.js';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, type SendOptions } from '../base-agent.js';

import {
  MAX_AUTO_REVIEW_ACTION_TEXT_CHARS,
  MAX_AUTO_REVIEW_STATIC_TEXT_CHARS,
  reviewAction,
  type ReviewableAction,
  type ReviewVerdict,
} from './auto-review.js';

/** Auto 对用户可见行为的最终三态；只有 `ask` 才允许弹用户确认。 */
export type AutoReviewDecision = {
  verdict: 'allow' | 'block' | 'ask';
  reason?: string;
  /**
   * `true` = 这个 `ask` 来自**审阅器没跑起来**（delegate 缺失 / 超时 / 抛错 / 返回非法），
   * 不是模型判定动作危险。
   *
   * 两件事以前被压成同一个 `block`（issue #1574），于是「模型让我换个安全做法」和
   * 「基础设施故障，Auto 档整个不工作了」在上层完全无法区分 —— 后者是用户有权知道并接管的，
   * 却和前者一样对 UI 静默。区分之后：
   * - 模型判定的 `block` 继续静默，只把 reason 喂给模型（Auto 档的本意就是不打扰）；
   * - `unavailable` 降级成 `ask`，弹确认卡让用户接管；另外发一条会话级一次性提示
   *   （见 createAutoReviewUnavailableNotice）。
   *
   * 注意：证据不足（缺路径 / 命令、动作文本超限）**不算** unavailable。那时审阅器是好的，
   * 是这次请求没法审，属于正常判定。
   */
  unavailable?: boolean;
};

/**
 * 「自动审核不可用」的会话级提示错误码。走既有的 `[CODE] fallback text` 约定：
 * harness emit 非终止 error 事件，renderer 的 decodeRemoteErrorMessage 翻成 i18n 文案
 * （见 apps/desktop 的 chat.remoteError.*），不新增协议、不新增事件类型。
 */
export const AUTO_REVIEW_UNAVAILABLE_CODE = 'AUTO_REVIEW_UNAVAILABLE';

/**
 * 未落地 i18n 的宿主看到的兜底英文。三条 Harness 共用这一句。少打断只能指向
 * Full access：默认权限在 Pi 上问得更多，在 Claude / Codex 上也不会少问联网和提权。
 * 完全访问风险更高，文案必须点明。
 *
 * IM 渠道（Slack / Telegram / 飞书）**不**读它 —— 渠道文案硬编码中文、不进 renderer
 * 的 locale（见 docs/dev-rules/engineering-conventions.md §5），映射在
 * apps/desktop/src/main/im/shared/turnRetryNotice.ts。
 */
const AUTO_REVIEW_UNAVAILABLE_FALLBACK_TEXT =
  'Auto-review could not reach a decision, so actions that need review now need your '
  + 'confirmation. Switch this task to Full access if you would rather not be interrupted. '
  + 'That mode is higher risk.';

/**
 * 判定一条 AgentEvent 的 error message 是否就是「自动审批不可用」提示。
 *
 * 消费方有三处、判据必须单点:desktop 需要把它**额外落库**成持久的 error 行(非终止
 * error 默认只进 ErrorBanner,会被下一条事件清掉);IM 渠道需要把它翻成渠道文案;
 * renderer 需要把它翻成 i18n。谁都不该自己去拼 `[CODE]` 前缀。
 */
export function isAutoReviewUnavailableNotice(message: unknown): boolean {
  return typeof message === 'string'
    && message.startsWith(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`);
}

/**
 * 会话级**一次性**提示的去重器 —— 逐条提示会把 Auto 档退化成比 Ask 更烦的东西，
 * 而完全不提示就是 issue #1574 报的「静默永久拒绝」。所以一个会话只说一次。
 *
 * `reset()` 用在换模型 / 换路由 / 用户主动改权限档之后：那些动作可能已经修好了问题，
 * 若之后**又**不可用，值得再提醒一次。
 */
export function createAutoReviewUnavailableNotice(
  emit: (message: string) => void,
): { notify(): void; reset(): void } {
  let sent = false;
  return {
    notify(): void {
      if (sent) return;
      sent = true;
      emit(`[${AUTO_REVIEW_UNAVAILABLE_CODE}] ${AUTO_REVIEW_UNAVAILABLE_FALLBACK_TEXT}`);
    },
    reset(): void {
      sent = false;
    },
  };
}

/**
 * 确认卡上的兜底英文：审阅器故障后改由用户点这一次。
 * Desktop renderer 见到 metadata 标记后会换成 i18n；IM / 无 locale 的宿主直接显示它。
 */
export const AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT =
  'Automatic review could not finish, so this action needs your confirmation.';

/** InteractionRequest.metadata 标记：这张确认卡是 Auto-review 故障降级，不是普通 Ask。 */
export const AUTO_REVIEW_UNAVAILABLE_METADATA_KEY = 'autoReviewUnavailable';

/**
 * 确认卡没送到 / 没被点 / 超时后的错误码。Codex vendor 会把所有 decline 打成
 * `rejected by user`，这条提示用来纠正归因：不是用户点了拒绝。
 */
export const AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE = 'AUTO_REVIEW_CONFIRM_UNDELIVERED';

const AUTO_REVIEW_CONFIRM_UNDELIVERED_FALLBACK_TEXT =
  'Automatic review was unavailable, and the confirmation request was not completed. '
  + 'This is not a user rejection — do not retry the same action as if the user declined.';

export function isAutoReviewConfirmUndeliveredNotice(message: unknown): boolean {
  return typeof message === 'string'
    && message.startsWith(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`);
}

export function createAutoReviewConfirmUndeliveredNotice(
  emit: (message: string) => void,
): { notify(): void; reset(): void } {
  let sent = false;
  return {
    notify(): void {
      if (sent) return;
      sent = true;
      emit(
        `[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}] ${AUTO_REVIEW_CONFIRM_UNDELIVERED_FALLBACK_TEXT}`,
      );
    },
    reset(): void {
      sent = false;
    },
  };
}

/**
 * Desktop / IM / router 在确认失败时写下的系统 reason。
 * 这些不是用户点击「拒绝」，不能当成 `user-denied`。
 *
 * 必须覆盖所有会走到 permission deny 的系统码：漏一个，Codex 就会把这次系统拒绝
 * 显示成用户点了拒绝。Hook 超时、路由释放、turn 收口、卡片没发出去都属于这一类。
 */
export const SYSTEM_PERMISSION_DENIAL_REASONS: ReadonlySet<string> = new Set([
  'no_interaction_resolver',
  'no_resolver_attached',
  'no_interaction_route',
  'no_listener_attached',
  'interaction_resolver_error',
  'resolver_threw',
  'approval_timeout',
  'interaction_handler_failed',
  'interaction_timeout',
  'hook_interaction_timeout',
  'timeout',
  'stale_turn',
  'stale_route',
  'duplicate_request_id',
  'session_closed',
  'session_aborted',
  'session_cleanup',
  'session_disposed',
  'session disposed',
  'interaction_route_released',
  'hook_turn_terminal',
  'turn_terminal',
  'not_renderable',
  'headless_interaction_unavailable',
  'no_card',
  'rich_output_not_supported',
  'replaced_by_new_request',
  'wecom_interaction_disconnected',
  'wecom_interaction_timeout',
  'wecom_interaction_send_failed',
  'wecom_interaction_cancelled_by_stop',
  'wechat_interaction_timeout',
  'wechat_interaction_send_failed',
  'wechat_binding_stopped',
  'wechat_user_stopped',
  'turn_idle_reconcile',
  'orca_disable',
  'session_running_race',
  'turn_not_dispatched',
]);

/**
 * IM turnRunner 会把投递失败写成 `prefix: ${msg}`，不能靠精确集合命中。
 * 只认确认卡没送到 / 没登记完这类前缀；用户拒绝和 destructiveGuard 不在这里。
 */
export const SYSTEM_PERMISSION_DENIAL_PREFIXES: readonly string[] = Object.freeze([
  'card send failed:',
  'pending failed:',
  'text interaction failed:',
  'register failed:',
  'permission_mode_changed_to_',
  'plan_mode_',
  'wecom_interaction_',
  'wechat_interaction_',
]);

export function isSystemPermissionDenialReason(reason: unknown): boolean {
  if (typeof reason !== 'string' || reason.length === 0) return false;
  if (SYSTEM_PERMISSION_DENIAL_REASONS.has(reason)) return true;
  return SYSTEM_PERMISSION_DENIAL_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Denial provenance for tool results and Codex's same-turn host feedback. */
export function formatPermissionDenial(source: 'auto' | 'user' | 'system', reason?: string): string {
  const label = source === 'auto' ? 'Cindy Auto-review denied this tool call'
    : source === 'user' ? 'User denied this tool call via Cindy'
      : 'Cindy could not approve this tool call';
  const detail = reason?.trim().slice(0, 240);
  return detail ? `${label}: ${detail}` : `${label}.`;
}

export function isAutoReviewUnavailableMetadata(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[AUTO_REVIEW_UNAVAILABLE_METADATA_KEY] === true;
}

/** 给确认卡打上「自动审批失败，请你确认这一次」的说明，不重新跑审阅器。 */
export function annotatePermissionRequestForUnavailableReview<
  T extends {
    kind: 'permission';
    description?: string;
    metadata?: Record<string, unknown>;
  },
>(req: T): T {
  return {
    ...req,
    description: AUTO_REVIEW_UNAVAILABLE_PROMPT_TEXT,
    metadata: {
      ...req.metadata,
      [AUTO_REVIEW_UNAVAILABLE_METADATA_KEY]: true,
    },
  };
}

/** InteractionRequest.metadata：审阅器判定「需要用户决定」时写给用户的原因（已脱敏、限长）。 */
export const AUTO_REVIEW_REASON_METADATA_KEY = 'autoReviewReason';

export function autoReviewReasonFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const reason = metadata?.[AUTO_REVIEW_REASON_METADATA_KEY];
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}

/**
 * 确认卡说明「为什么问你」：故障降级用固定文案；审阅器的 ask 原因挂在 metadata 上，
 * 不覆盖 Agent／SDK 自带的 description。其余确认（Ask 档、逐次确认策略）原样返回。
 */
export function annotatePermissionRequestForAutoReview<
  T extends {
    kind: 'permission';
    description?: string;
    metadata?: Record<string, unknown>;
  },
>(req: T, review: { unavailable?: boolean; reason?: string } | undefined): T {
  if (review?.unavailable) return annotatePermissionRequestForUnavailableReview(req);
  const reason = review?.reason?.trim().slice(0, MAX_AUTO_REVIEW_REASON_CHARS);
  if (!reason) return req;
  return { ...req, metadata: { ...req.metadata, [AUTO_REVIEW_REASON_METADATA_KEY]: reason } };
}

/**
 * 有界用户原话与宿主动作事实；不含助手历史、工具结果、Skill 或 Memory。
 * `userIntent.currentUserReferences` 是宿主盖章的「用户本条明确指向的内容」（被回复／引用的消息、
 * 附件数），只作低信任证据，审阅器单独呈现，不算用户原话、不构成授权。
 */
/** Same accepted CC Query/turn only; never a persisted execution qualification. */
export type PersonalRequirements = { fingerprint: string; scope: RuleScope; groups: readonly UnifiedRule[] };
export type PersonalTurnObservation = PersonalRequirements & {
  revalidate(): Promise<boolean>;
  /** Main/store only. Never a CLI control read or persisted native qualification. */
  readManaged?(): Promise<PersonalRequirements | { kind: 'unavailable'; reason: string } | undefined>;
};
export function evaluatePersonalRequirements(requirements: PersonalRequirements, command: string, harness: RuleHarness = 'claude-code') {
  const exceptions = harness === 'claude-code' ? requirements.groups.filter(group => group.origin.harness === 'cindy'
    && group.origin.decisionDomain === 'personal-approval'
    && ruleScopeMatches(group.scope, requirements.scope, 'claude-code')).flatMap(group =>
    group.clauses.filter(clause => clause.decision === 'allow' && clause.tool?.name === 'Bash'
      && clause.matcher?.kind === 'cc-command' && clause.matcher.mode === 'exact'
      && clause.matcher.pattern === command).flatMap(clause => clause.autoAskExceptions ?? [])) : [];
  const groups = requirements.groups.map(group => ({ ...group, clauses: group.clauses.filter(clause =>
    clause.decision !== 'ask' || !exceptions.some(exception => sameRuleScope(exception.scope, requirements.scope)
      && exception.sourceGroupId === group.id && sameRuleScope(exception.sourceScope, group.scope)
      && sameRuleOrigin(exception.sourceOrigin, group.origin)
      && exception.clauseId === clause.id && exception.original === clause.original)) }));
  return evaluateApprovalRules({ schemaVersion: 1, revision: 0, groups, tombstones: [] },
    requirements.scope, command, harness);
}
const sameRuleScope = (left: RuleScope, right: RuleScope) => left.ownerId === right.ownerId
  && left.executionHostId === right.executionHostId && left.projectId === right.projectId
  && JSON.stringify([...(left.harnesses ?? [])].sort()) === JSON.stringify([...(right.harnesses ?? [])].sort());
const sameRuleOrigin = (left: RuleOrigin, right: RuleOrigin) => left.harness === right.harness
  && left.sourceId === right.sourceId && left.locator === right.locator && left.layer === right.layer
  && left.dialectVersion === right.dialectVersion && left.decisionDomain === right.decisionDomain;
/** Only matched asks observed in this real CC execution become rememberable exceptions. */
export function matchedPersonalAutoAsks(requirements: PersonalRequirements, command: string): AutoAskException[] {
  return requirements.groups.filter(group => group.origin.harness === 'claude-code'
    && group.origin.decisionDomain === 'personal-approval').flatMap(group => group.clauses.flatMap(clause => {
      if (clause.decision !== 'ask' || !clause.matcher) return [];
      const match = evaluateApprovalRules({ schemaVersion: 1, revision: 0, groups: [{ ...group, clauses: [clause] }], tombstones: [] },
        requirements.scope, command, 'claude-code');
      return match.status === 'matched' && match.decision === 'ask' ? [{ scope: structuredClone(requirements.scope),
        sourceGroupId: group.id, sourceScope: structuredClone(group.scope), sourceOrigin: { ...group.origin },
        clauseId: clause.id, original: clause.original }] : [];
    }));
}

export interface AutoReviewRequest {
  /** Host-verified personal restrictions, not a user message or authorization grant. */
  personalRequirements?: PersonalRequirements;
  /** Original root Pi tool or Codex command-approval envelope, before normalization.
   * Host still verifies the active instance; this is not an authorization grant. */
  managedToolExecution?: { sessionInstanceId: string; toolName: string; input: Record<string, unknown>;
    /** Minted only by the actual qualified root Pi RPC dispatcher. */
    piExecution?: { rpcId: string; input: Readonly<Record<string, unknown>>; isCurrent(): boolean; isAuto(): boolean };
    codexApproval?: { threadId: string; turnId: string; itemId: string; approvalId?: string;
      hostGeneration: number; inputGeneration: number; directoryGeneration: number;
      /** Actual root handler lease, independent of rule revision and FullAccess. */
      isCurrent(): boolean; isAuto?(): boolean } };
  sessionId?: string;
  agentKind: AgentKind;
  providerId?: string | null;
  model: string;
  userIntent: AutoReviewUserIntent;
  /** Actual blocked calls preceding the latest user input; reference evidence, never consent. */
  precedingBlockedActions?: readonly ReviewableAction[];
  /** Host-verified requester authority, separate from model-visible/quoted text. */
  authorizationContext?: {
    requesterAuthority: 'owner' | 'guest' | 'unknown';
    source: 'group' | 'direct';
  };
  /** Host-resolved plugin delegation, distinct from user-authored intent. */
  delegatedTask?: {
    source: 'approved-plugin';
    pluginId: string;
    role: 'coordinator' | 'worker';
    task: string;
    workingDir: string;
    authorizationRevision: string;
  };
  /** A recognized delegation whose current authority could not be established. */
  authorizationError?: string;
  action: ReviewableAction;
  /** 全部可读根；首项必须是主工作目录，供相对路径解析。 */
  workspaceRoots: string[];
  /**
   * 显式可写根。旧请求缺省时仍仅 workspaceRoots[0] 可写，保证跨版本 fail-closed。
   */
  writableRoots?: string[];
  platform: NodeJS.Platform;
}

export type ManagedAutoReviewLease = {
  contextKey: string; isCurrent(): boolean; isExecutionCurrent?(): boolean;
};
export type ManagedAutoReviewCheck =
  | { kind: 'unavailable'; reason: string;
      /** Pi only: unavailable storage is distinct from an unverified execution. */
      pi?: { state: 'unverified' | 'inapplicable' } | { state: 'storage-unavailable'; lease: ManagedAutoReviewLease };
      /** Actual Codex command approval only; never Guardian or native shortcut execution. */
      codex?: { state: 'unverified' | 'inapplicable' } | { state: 'storage-unavailable'; lease: ManagedAutoReviewLease } }
  | ({ kind: 'clear'; revision?: number; personalRequirements?: PersonalRequirements }
      | { kind: 'deny' | 'ask'; revision: number; ruleId: string; reason: string }) & {
      contextKey: string; isCurrent(): boolean;
      /** Execution lease alone; publication can legitimately change during review. */
      isExecutionCurrent?(): boolean };

export type AutoReviewDelegate = ((request: AutoReviewRequest) => Promise<AutoReviewDecision | null>) & {
  /** Explicit managed personal rules. Independent of delegation and model caches. */
  precheckManagedAction?: (request: AutoReviewRequest) => Promise<ManagedAutoReviewCheck>;
  /** Re-resolve live Host authority before cache lookup and after any awaited decision. */
  prepareRequest?: (request: AutoReviewRequest) => Promise<AutoReviewRequest>;
};

/** Re-read personal policy after a human wait without re-running the reviewer. */
export type ManagedAutoReviewFence = ((options?: { confirmed: boolean }) => Promise<AutoReviewDecision>) & {
  /** Captured Host identity only; withdrawing Auto must never revive an old owner. */
  isExecutionCurrent?: () => boolean;
  /** Synchronous last-await publication/input seal for the qualified root call. */
  isCurrent?: () => boolean;
  canConfirmAgain?: () => boolean;
};

/** Builtin proof is independent of owner/execution authority and publication. */
export type ManagedAutoReviewEligibility = {
  isCurrent(): boolean;
  captureFallback(fallback: ManagedAutoReviewFence): void;
};

export async function withAutoReviewContext(
  request: AutoReviewRequest,
  delegate: AutoReviewDelegate | undefined,
  evaluate: (prepared: AutoReviewRequest) => Promise<AutoReviewDecision>,
  finalize: (decision: AutoReviewDecision, contribution?: 'managed') => AutoReviewDecision = decision => decision,
  captureManagedFence?: (fence: ManagedAutoReviewFence) => void,
  eligibility?: ManagedAutoReviewEligibility,
): Promise<AutoReviewDecision> {
  const piExecution = request.agentKind === 'pi' ? request.managedToolExecution?.piExecution : undefined;
  const codexApproval = request.agentKind === 'codex' ? request.managedToolExecution?.codexApproval : undefined;
  const execution = piExecution ?? codexApproval;
  const codexCandidate = !!codexApproval && !!delegate?.precheckManagedAction;
  const qualified = (): boolean => eligibility?.isCurrent() !== false;
  // The first Host await can outlive Auto. Keep this RPC's independent guard
  // even when preparation fails or Main has not yet verified an execution lease.
  let initialLease: ManagedAutoReviewLease | undefined;
  let inapplicable = false;
  let executionUnverified = false;
  const piCandidate = !!piExecution && !!delegate?.precheckManagedAction && qualified();
  if (piCandidate || codexCandidate) {
    const current = () => !executionUnverified && execution!.isCurrent() && initialLease?.isExecutionCurrent?.() !== false
      && (inapplicable || !!initialLease);
    const guard: ManagedAutoReviewFence = async () => current() ? { verdict: 'allow' }
      : { verdict: 'block', reason: 'Personal rule execution identity changed; send a new request.' };
    guard.isExecutionCurrent = current;
    guard.isCurrent = current;
    captureManagedFence?.(guard);
  }
  const checkManaged = async (): Promise<ManagedAutoReviewCheck | undefined> => {
    try {
      // Qualification retirement withdraws policy, never the identity check
      // for this already accepted RPC. Main's existing withdrawn-Auto branch
      // verifies the same execution without reading personal policy.
      const managedRequest = piCandidate ? { ...request, managedToolExecution: {
        ...request.managedToolExecution!, piExecution: { ...piExecution!,
          isAuto: () => qualified() && piExecution!.isAuto() },
      } } : request;
      return await delegate?.precheckManagedAction?.(managedRequest);
    }
    catch { return { kind: 'unavailable', reason: 'managed-policy-unavailable' }; }
  };
  // Capture Main's owner synchronously before preparation can switch it.
  const initialManaged = piCandidate || codexCandidate ? checkManaged() : undefined;
  try {
    const prepared = delegate?.prepareRequest ? await delegate.prepareRequest(request) : request;
    if (prepared.authorizationError) return { verdict: 'block', reason: prepared.authorizationError };
    const staleManaged = (): AutoReviewDecision => (pi || codexCandidate) ? invalidExecution() : ({ verdict: 'ask', unavailable: true,
      reason: 'Personal rule execution context changed; retry against the current task.' });
    const managed = initialManaged ? await initialManaged : qualified() ? await checkManaged() : undefined;
    const pi = request.agentKind === 'pi' && !!request.managedToolExecution;
    const bounded = pi || codexCandidate;
    const managedActive = () => qualified() && execution?.isAuto?.() !== false;
    const status = (check: ManagedAutoReviewCheck | undefined) => check?.kind === 'unavailable'
      ? codexCandidate ? check.codex : check.pi : undefined;
    const checkLease = (check: ManagedAutoReviewCheck | undefined): ManagedAutoReviewLease | undefined => {
      if (check && check.kind !== 'unavailable') return check;
      const evidence = status(check);
      return bounded && evidence?.state === 'storage-unavailable' ? evidence.lease : undefined;
    };
    const lease = checkLease(managed);
    initialLease = lease;
    inapplicable = status(managed)?.state === 'inapplicable';
    executionUnverified = managed?.kind === 'unavailable' && (status(managed)?.state === 'unverified'
      || (codexCandidate && !status(managed)));
    const invalidManaged = (check: ManagedAutoReviewCheck | undefined) => bounded
      && check?.kind === 'unavailable' && (status(check)?.state === 'unverified' || (codexCandidate && !status(check)));
    let executionValid = true;
    const invalidExecution = (): AutoReviewDecision => { executionValid = false; return { verdict: 'block', reason: 'Personal rule execution identity changed; send a new request.' }; };
    if (bounded && (execution?.isCurrent() === false || invalidManaged(managed))) return invalidExecution();
    let latestSeal = lease?.isCurrent;
    let reviewedKey: string | undefined;
    let confirmationCount = 0;
    let changedInFence = false;
    const fingerprint = JSON.stringify(prepared);
    // Authorization preparation stays independent of managed review data. The
    // latter changes cache identity, never delegation or execution identity.
    const ordinary = new Map<string, Promise<AutoReviewDecision>>();
    let retainedBlock: AutoReviewDecision | undefined;
    const currentAuthorization = async (): Promise<boolean> => {
      if (!delegate?.prepareRequest) return true;
      const current = await delegate.prepareRequest(request);
      return !current.authorizationError && JSON.stringify(current) === fingerprint;
    };
    const liveManaged = (latest: ManagedAutoReviewCheck | undefined): boolean => {
      if (!lease) return true;
      if (lease.isExecutionCurrent?.() === false || (bounded && execution?.isCurrent() === false)) return false;
      if (bounded && !managedActive()) {
        const current = checkLease(latest);
        return !current || (execution?.isAuto?.() === false
          ? current.isExecutionCurrent?.() !== false : current.contextKey === lease.contextKey);
      }
      const current = checkLease(latest);
      if (current) latestSeal = current.isCurrent;
      return !!current && current.contextKey === lease.contextKey && current.isCurrent();
    };
    const reviewData = (includeManaged: boolean, latest: ManagedAutoReviewCheck | undefined): AutoReviewRequest =>
      includeManaged && qualified() && (!bounded || managedActive()) && latest?.kind === 'clear' && latest.personalRequirements
        ? { ...prepared, personalRequirements: latest.personalRequirements } : prepared;
    const dataKey = (data: AutoReviewRequest) => JSON.stringify(data.personalRequirements ?? null);
    const policyKey = (latest: ManagedAutoReviewCheck | undefined) => JSON.stringify(codexCandidate
      ? [status(latest)?.state === 'storage-unavailable' ? 'storage' : 'policy',
          latest?.kind === 'clear' ? latest.personalRequirements ?? null : null]
      : [latest?.kind, latest && latest.kind !== 'unavailable' ? latest : null]);
    const rememberDecision = (latest: ManagedAutoReviewCheck | undefined) => {
      if (bounded) reviewedKey = policyKey(latest);
    };
    const storageMissing = (latest: ManagedAutoReviewCheck | undefined) => bounded && managedActive() && status(latest)?.state === 'storage-unavailable';
    const storageAsk = (): AutoReviewDecision => ({ verdict: 'ask', unavailable: true,
      reason: 'Personal rules could not be read; confirm only this current tool input.' });
    const captureFence = () => {
      if (!lease) return;
      const fence: ManagedAutoReviewFence = async options => {
        try {
          if (!await currentAuthorization()) return { verdict: 'block', reason: 'Delegated authorization changed; retry against the current scope.' };
          const current = await checkManaged();
          if (bounded && (execution?.isCurrent() === false || lease.isExecutionCurrent?.() === false || invalidManaged(current)))
            return finalize(invalidExecution(), 'managed');
          if (!liveManaged(current)) return finalize(staleManaged(), 'managed');
          if (bounded) {
            if (!managedActive()) return finalize({ verdict: 'allow' }, 'managed');
            if (current?.kind === 'deny') return finalize({ verdict: 'block', reason: current.reason }, 'managed');
            if (options?.confirmed === true) confirmationCount++;
            if ((codexCandidate || options?.confirmed === true) && policyKey(current) !== reviewedKey) {
              if (changedInFence || confirmationCount >= 2 || ordinary.size >= 2)
                return finalize({ verdict: 'block', reason: 'Personal rules changed again; send a new request.' }, 'managed');
              changedInFence = true;
              return await finishReview(true);
            }
            if (options?.confirmed !== true) return finalize(codexCandidate && storageMissing(current) ? storageAsk()
              : current?.kind === 'ask' && options?.confirmed === false ? { verdict: 'ask', reason: current.reason } : { verdict: 'allow' }, 'managed');
            return finalize({ verdict: 'allow' }, 'managed');
          }
          // An explicit answer approves this exact ask, never a newly active deny.
          return finalize(qualified() && current?.kind === 'deny'
            ? { verdict: 'block', reason: current.reason }
            : qualified() && current?.kind === 'ask' && options?.confirmed === false
              ? { verdict: 'ask', reason: current.reason } : { verdict: 'allow' }, 'managed');
        } catch {
          if (bounded && !managedActive() && execution?.isCurrent() !== false && lease.isExecutionCurrent?.() !== false
            && !prepared.delegatedTask && !prepared.authorizationError) return finalize({ verdict: 'allow' }, 'managed');
          return finalize(staleManaged(), 'managed');
        }
      };
      fence.isExecutionCurrent = () => lease.isExecutionCurrent?.() !== false && (!bounded || (executionValid && execution?.isCurrent() !== false));
      if (bounded) fence.canConfirmAgain = () => changedInFence;
      if (bounded) fence.isCurrent = () => fence.isExecutionCurrent!() && (!managedActive() || latestSeal?.() !== false);
      captureManagedFence?.(fence);
    };
    const finishReview = async (includeManaged: boolean): Promise<AutoReviewDecision> => {
      if (bounded && (execution?.isCurrent() === false || lease?.isExecutionCurrent?.() === false)) return finalize(invalidExecution(), 'managed');
      if (lease?.isExecutionCurrent?.() === false) return finalize(staleManaged(), 'managed');
      let latest = lease ? await checkManaged() : undefined;
      if (invalidManaged(latest)) return finalize(invalidExecution(), 'managed');
      if (!liveManaged(latest)) return finalize(staleManaged(), 'managed');
      // One changed review-data version may be re-reviewed. No tool is replayed,
      // and repeated mutation cannot create an unbounded model-review loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!await currentAuthorization())
          return { verdict: 'block', reason: 'Delegated authorization changed; retry against the current scope.' };
        if (retainedBlock) return finalize(retainedBlock);
        if (bounded && storageMissing(latest)) {
          rememberDecision(latest); captureFence(); return finalize(storageAsk(), 'managed');
        }
        if (includeManaged && qualified() && (!bounded || managedActive()) && latest && latest.kind !== 'unavailable' && latest.kind !== 'clear') {
          rememberDecision(latest); captureFence();
          return finalize({ verdict: latest.kind === 'deny' ? 'block' : 'ask', reason: latest.reason }, 'managed');
        }
        const data = reviewData(includeManaged, latest);
        const key = dataKey(data);
        let pending = ordinary.get(key);
        if (!pending) {
          if (ordinary.size >= 2) return finalize({ verdict: 'block',
            reason: 'Personal rules changed repeatedly; retry against the current rules.' }, 'managed');
          pending = evaluate(data); ordinary.set(key, pending);
        }
        const decision = await pending;
        if (decision.verdict === 'block') retainedBlock = decision;
        if (!await currentAuthorization())
          return { verdict: 'block', reason: 'Delegated authorization changed; retry against the current scope.' };
        latest = lease ? await checkManaged() : undefined;
        if (invalidManaged(latest)) return finalize(invalidExecution(), 'managed');
        if (!liveManaged(latest)) return finalize(staleManaged(), 'managed');
        // A real reviewer block survives withdrawal of the managed contribution.
        if (retainedBlock) return finalize(retainedBlock);
        if (bounded && storageMissing(latest)) { rememberDecision(latest); captureFence(); return finalize(storageAsk(), 'managed'); }
        if (includeManaged && qualified() && (!bounded || managedActive()) && latest && latest.kind !== 'unavailable' && latest.kind !== 'clear') {
          rememberDecision(latest); captureFence();
          return finalize({ verdict: latest.kind === 'deny' ? 'block' : 'ask', reason: latest.reason }, 'managed');
        }
        if (dataKey(reviewData(includeManaged, latest)) !== key) continue;
        rememberDecision(latest); captureFence();
        return finalize(decision);
      }
      return finalize({ verdict: 'block', reason: 'Personal rules changed repeatedly; retry against the current rules.' }, 'managed');
    };
    if (lease) {
      eligibility?.captureFallback(async () => {
        try { return await finishReview(false); }
        catch { return finalize(staleManaged(), 'managed'); }
      });
      if (!lease.isCurrent() || lease.isExecutionCurrent?.() === false)
        return finalize(staleManaged(), 'managed');
      // Capture the raw Host lease before any reviewer await, including paths
      // that later become stale and therefore never return a review verdict.
      captureFence();
      // Main verified the independent execution after Auto was withdrawn. The
      // final send still consumes this fence, without consuming personal rules.
      if (bounded && execution?.isAuto?.() === false) return finalize({ verdict: 'allow' }, 'managed');
      if (qualified() && managed && (managed.kind === 'deny' || managed.kind === 'ask')) {
        rememberDecision(managed); captureFence();
        return finalize({ verdict: managed.kind === 'deny' ? 'block' : 'ask', reason: managed.reason }, 'managed');
      }
    }
    return await finishReview(true);
  } catch {
    return { verdict: 'ask', unavailable: true, reason: 'Host could not verify the current authorization; this action needs your confirmation.' };
  }
}

/** Preserve the actual tool identity and arguments across progressive/Host approval entrypoints. */
export function toolAutoReviewAction(
  toolName: string,
  input: unknown,
  context?: string,
  executionEvidence?: unknown,
): ReviewableAction {
  // Structured file writes are reviewed by destination/canonical scope. Do not
  // reintroduce file bodies when a channel policy or resumed child wraps them.
  const evidence = executionEvidence && typeof executionEvidence === 'object'
    ? executionEvidence as Record<string, unknown> : undefined;
  const action = evidence?.action && typeof evidence.action === 'object'
    ? evidence.action as Record<string, unknown> : evidence;
  if (action?.kind === 'file-write') {
    input = undefined;
  }
  return { kind: 'other', description: JSON.stringify({ toolName, input, context, executionEvidence }) };
}

export { MAX_AUTO_REVIEW_ACTION_TEXT_CHARS } from './auto-review.js';
const MAX_AUTO_REVIEW_REASON_CHARS = 240;
/**
 * Auto-review is deliberately bounded: a reviewer outage must still resolve the
 * gray action instead of hanging the tool callback. Keep the host request
 * deadline below the core guard so a valid answer at the request deadline can
 * return before the outer guard fires.
 *
 * **两个数必须一起改。** delegate 侧现在会做重试(见 desktop 的
 * createAutoPermissionReviewer),而重试全部发生在 `delegateTimeoutMs` 之内 ——
 * 外层守卫若先触发,重试就完全失去意义(白等、白花钱,结果照样是不可用)。
 * 上限取「宿主侧最慢的一档 × 重试次数 + 退避」再留余量。
 */
export interface AutoReviewTimeoutPolicy {
  requestTimeoutMs: number;
  delegateTimeoutMs: number;
}

/**
 * 紧凑档(能关思考的模型)的默认策略。宿主侧每次尝试都用完整的
 * `requestTimeoutMs`(不按次数切分 —— 切分会把本来能成功的慢响应也判成超时),
 * 总耗时由 AUTO_REVIEW_DELEGATE_HARD_CEILING_MS 兜住。
 */
export const DEFAULT_AUTO_REVIEW_TIMEOUT_POLICY: Readonly<AutoReviewTimeoutPolicy> = Object.freeze({
  requestTimeoutMs: 12_000,
  delegateTimeoutMs: 13_000,
});

/** 宿主侧的重试次数与退避。核心侧据此推总预算,两边必须同源,否则守卫会截断重试。 */
export const AUTO_REVIEW_RETRY_ATTEMPTS = 3;
export const AUTO_REVIEW_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([100, 200]);

/** 宿主侧单次请求的最宽一档(强制思考模型),核心侧守卫按它推上界。 */
export const AUTO_REVIEW_MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 调度余量:prompt 构造、`setTimeout` 抖动、事件循环排队都计入总耗时但不属于任何
 * 一次请求。宿主的时间兜底与核心守卫都要加上它 —— 不留余量等于要求这些开销恰好
 * 为零,真机上必然差那么几毫秒,于是最后一次重试恒定被自己的护栏挡掉
 * (PR #2474 review 两轮都指向这一点)。
 */
export const AUTO_REVIEW_RETRY_SCHEDULING_SLACK_MS = 2_000;

/**
 * 一轮审阅(含全部重试与退避)的总预算。
 *
 * 宿主用它决定"还够不够再跑一次",核心用它推外层守卫的上界 —— **必须同一个算法**,
 * 否则守卫会在重试跑完前触发,宽裕额度形同虚设(PR #2474 review:固定 35s 盖不住
 * 30s 档的三次尝试,第二次约 5s 就被丢弃且请求未取消、继续消耗额度)。
 */
export function autoReviewRetryBudgetMs(
  requestTimeoutMs: number,
  attempts: number = AUTO_REVIEW_RETRY_ATTEMPTS,
): number {
  const backoffTotal = AUTO_REVIEW_RETRY_BACKOFF_MS
    .slice(0, Math.max(0, attempts - 1))
    .reduce((sum, ms) => sum + ms, 0);
  return requestTimeoutMs * attempts + backoffTotal;
}

/**
 * 核心侧守卫的绝对上界:按最宽一档 + 全部重试与退避推出,再加**两份**调度余量 ——
 * 一份对应宿主时间兜底自己放宽的那份,另一份留给守卫与兜底之间的竞态。
 * 守卫必须严格晚于宿主的兜底触发,否则宿主刚放宽的余量会被守卫吃掉。
 *
 * 这是**兜底**不是常态:绝大多数请求 2s 内返回(实测 p95 ≈ 2.5s)。
 */
const AUTO_REVIEW_DELEGATE_HARD_CEILING_MS =
  autoReviewRetryBudgetMs(AUTO_REVIEW_MAX_REQUEST_TIMEOUT_MS)
  + AUTO_REVIEW_RETRY_SCHEDULING_SLACK_MS * 2;

/** 暴露给测试:守卫必须容得下最宽一档的全部重试,常量漂移时要红。 */
export function getAutoReviewDelegateHardCeilingMs(): number {
  return AUTO_REVIEW_DELEGATE_HARD_CEILING_MS;
}
const AUTO_REVIEW_TIMEOUT = Symbol('auto-review-timeout');

export function getAutoReviewActionTextLength(action: ReviewableAction): number {
  switch (action.kind) {
    case 'exec':
      return action.command.length + (action.cwd?.length ?? 0);
    case 'read':
      return action.path?.length ?? 0;
    case 'file-write':
      return (action.path?.length ?? 0) + (action.resolvedPath?.length ?? 0)
        + (action.resolvedWritableRoots?.reduce((total, root) => total + root.length, 0) ?? 0);
    case 'network':
      return (action.target?.length ?? 0) + (action.operation?.length ?? 0);
    case 'other':
      return action.description?.length ?? 0;
    default:
      return 0;
  }
}

/**
 * `prompt` 是旧 core 给 UI adapter 用的名字；在新的 Auto reviewer 流程里它只代表
 * “确定性规则无法独立裁决”，不是“现在弹用户”。显式映射成独立 tier，避免两层语义混用。
 */
export type LocalAutoReviewTier = Exclude<ReviewVerdict, 'prompt'> | 'needs-review';

export function classifyLocalAutoReviewTier(
  request: AutoReviewRequest,
): LocalAutoReviewTier {
  // Large payloads bypass synchronous parsing, not permission review.
  if (getAutoReviewActionTextLength(request.action) > MAX_AUTO_REVIEW_STATIC_TEXT_CHARS) return 'needs-review';
  const verdict = reviewAction(
    request.action,
    request.workspaceRoots,
    { platform: request.platform, writableRoots: request.writableRoots },
  );
  return verdict === 'prompt' ? 'needs-review' : verdict;
}

function missingReviewEvidence(action: ReviewableAction): string | null {
  switch (action.kind) {
    case 'file-write':
      return action.path?.trim()
        ? null
        : 'File-write review needs a concrete destination path.';
    case 'exec':
      return action.command.trim()
        ? null
        : 'Command review needs concrete command text.';
    case 'network':
      return action.target?.trim()
        ? null
        : 'Network review needs a concrete destination or query.';
    case 'other':
      if (!action.description?.trim()) return 'Unknown actions cannot be reviewed without concrete action details.';
      return fileChangeWithoutPaths(action.description)
        ? 'File-change review needs concrete paths.'
        : null;
    default:
      return null;
  }
}

/** A risk-first reviewer would wave a pathless patch through as "low risk"; never approve unseen writes. */
function fileChangeWithoutPaths(description: string): boolean {
  let envelope: unknown;
  try { envelope = JSON.parse(description); } catch { return false; }
  if (!envelope || typeof envelope !== 'object') return false;
  const { toolName, input } = envelope as { toolName?: unknown; input?: unknown };
  if (toolName !== 'file_change') return false;
  const changes = input && typeof input === 'object' ? (input as { changes?: unknown }).changes : undefined;
  const paths = Array.isArray(changes)
    ? changes.map((change) => (change && typeof change === 'object' ? (change as { path?: unknown }).path : undefined))
    : changes && typeof changes === 'object' ? Object.keys(changes) : [];
  return !paths.some((path) => typeof path === 'string' && path.trim().length > 0);
}

function oversizedReviewEvidence(action: ReviewableAction): string | null {
  return getAutoReviewActionTextLength(action) > MAX_AUTO_REVIEW_ACTION_TEXT_CHARS
    ? 'This action is too large for automatic review in full, so it needs your confirmation.'
    : null;
}

/**
 * Auto 的统一裁决入口：本地规则只可免审明显安全的动作；其余风险等级均交给
 * 审阅器结合用户授权判断。风险分类不等于用户尚未授权，不能直接转换成人工确认。
 *
 * **审阅器故障时降级为 `ask`，不再静默 `block`。** 宿主侧已先做过重试
 * （见 desktop 的 createAutoPermissionReviewer），走到这里意味着重试也没救回来。
 * 此时静默拒绝是最差的选择：用户既看不到发生了什么，一批本来完全正常的灰区操作
 * 又被连续否掉，Auto 档表现得像坏了。降级成 `ask` 把决定权交回用户 ——
 * 安全边界不降低（未经用户点头仍然不会执行），但用户至少知道该点头还是拒绝。
 *
 * 与「模型判定危险」的 `block` 仍然严格区分：那个继续静默，因为 Auto 的本意
 * 就是不打扰；模型 ask、完整证据超出预算与 unavailable 才交用户。
 */
export async function resolveAutoReviewDecision(
  request: AutoReviewRequest,
  delegate: AutoReviewDelegate | undefined,
  hostAutoApprove = false,
  hostShortcutOnly = false,
): Promise<AutoReviewDecision> {
  const personal = (request.agentKind === 'claude-code' || (request.agentKind === 'pi' && !!request.managedToolExecution)
    || (request.agentKind === 'codex' && !!request.managedToolExecution?.codexApproval))
    && request.action.kind === 'exec' && request.personalRequirements
    ? evaluatePersonalRequirements(request.personalRequirements, request.action.command, request.agentKind === 'pi' ? 'pi' : request.agentKind === 'codex' ? 'codex' : 'claude-code') : undefined;
  if (personal?.status === 'matched' && personal.decision === 'deny')
    return { verdict: 'block', reason: 'Blocked by a current personal rule.' };
  const personalAsk = personal?.status === 'matched' && personal.decision === 'ask';
  const unresolvedPersonal = personal?.status === 'uncovered' || !!personal?.uncoveredRuleIds?.length;
  if (personalAsk && !unresolvedPersonal)
    return { verdict: 'ask', reason: 'A current personal rule requires confirmation.' };
  // Host trust skips model review only after live context preparation has
  // established that this is not a delegated task with a narrower scope.
  if (hostAutoApprove && !request.delegatedTask && !unresolvedPersonal) return { verdict: 'allow' };
  // Outside Auto, only establish whether Host trust can skip confirmation.
  // A delegated request must use the existing human approval path, never AI.
  if (hostShortcutOnly) return { verdict: 'ask' };
  // Never review a truncated action or deny routine work merely for its length.
  // Beyond the complete model-review budget, retain the existing confirmation path.
  const oversizedEvidenceReason = oversizedReviewEvidence(request.action);
  if (oversizedEvidenceReason) {
    return { verdict: 'ask', reason: oversizedEvidenceReason };
  }
  const localTier = classifyLocalAutoReviewTier(request);
  // The registered task can constrain reads as well as writes. No delegated
  // action bypasses scope review merely because the workspace tier is safe.
  if (localTier === 'auto-approve' && !request.delegatedTask && !unresolvedPersonal) return { verdict: 'allow' };
  // Never ask the model to approve an action whose material target/text is absent.
  // It has no evidence to distinguish routine work from an unsafe side effect.
  const missingEvidenceReason = missingReviewEvidence(request.action);
  if (missingEvidenceReason) {
    return {
      verdict: 'block',
      reason: missingEvidenceReason,
    };
  }
  if (!delegate) {
    return {
      verdict: 'ask',
      reason: 'Automatic review is unavailable, so this action needs your confirmation.',
      unavailable: true,
    };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = await Promise.race([
      delegate(request),
      new Promise<typeof AUTO_REVIEW_TIMEOUT>((resolve) => {
        // 用硬上界而非紧凑档的 delegateTimeoutMs:宿主侧对强制思考的模型会放宽
        // 单次超时并叠加重试,守卫必须容得下最慢的那一档,否则重试与放宽额度
        // 都会被这里提前切断。
        timeout = setTimeout(
          () => resolve(AUTO_REVIEW_TIMEOUT),
          AUTO_REVIEW_DELEGATE_HARD_CEILING_MS,
        );
      }),
    ]);
    if (
      decision !== AUTO_REVIEW_TIMEOUT
      && (
        decision?.verdict === 'allow'
        || decision?.verdict === 'block'
        || decision?.verdict === 'ask'
      )
    ) {
      // Delegate 是运行期边界：即便当前 host 实现已做解析，未来实现也不能把
      // 非字符串或无上限 reason 原样塞进日志、UI 或下一轮模型上下文。
      const reason = typeof decision.reason === 'string'
        ? decision.reason.trim().slice(0, MAX_AUTO_REVIEW_REASON_CHARS)
        : '';
      // Unknown siblings still reach the original reviewer. Its allow cannot
      // erase the deterministic ask; its block remains a block.
      if (personalAsk && decision.verdict === 'allow')
        return { verdict: 'ask', reason: 'A current personal rule requires confirmation.' };
      return {
        verdict: decision.verdict,
        ...(reason ? { reason } : {}),
      };
    }
  } catch {
    // 审阅器故障不得吊住 tool callback;下面统一降级收口。
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  // 走到这里 = delegate 存在但没给出可用结果(重试后仍超时 / 抛错 / 返回非法)。
  // 与「模型判定危险」不同,这是审阅器本身没跑起来 —— 交给用户确认,而不是替他拒绝。
  return {
    verdict: 'ask',
    reason: 'Automatic review could not complete, so this action needs your confirmation.',
    unavailable: true,
  };
}

export type { AutoReviewUserIntent, AutoReviewUserReferences } from '@cindy/maker-shared/auto-review-intent';
const intentProjection = createAutoReviewIntentProjection();
const compactCurrentUserIntent = intentProjection.compact;
function userIntentText(content: UserMessage['content']): string {
  return (typeof content === 'string'
    ? content
    : content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')).trim();
}

/** Authorization text is atomic: never sample away a restriction within a message. */
export function extractAutoReviewUserIntent(content: UserMessage['content']): string {
  return compactCurrentUserIntent(userIntentText(content));
}

/** Enforce the budget without interpreting strings as Host-generated structure. */
export const normalizeAutoReviewUserIntent = intentProjection.normalize;

/** Preserve chronological user messages; scope is assessed, never assumed permanent. */
export function appendAutoReviewUserIntent(previous: AutoReviewUserIntent | undefined, content: UserMessage['content'], sendOpts?: SendOptions): AutoReviewUserIntent {
  // A continuation is not a new human input. A live empty reset is authoritative too.
  if (sendOpts?.[AUTO_REVIEW_DELEGATED_CONTINUATION] && previous !== undefined) return normalizeAutoReviewUserIntent(previous);
  // The authenticated Host snapshot already includes this input; never append it twice.
  if (sendOpts?.[AUTO_REVIEW_USER_INTENT] !== undefined) {
    return normalizeAutoReviewUserIntent(sendOpts[AUTO_REVIEW_USER_INTENT]);
  }
  const sourceContent = sendOpts?.[AUTO_REVIEW_SOURCE_CONTENT] ?? content;
  // Only Main's Symbol carries authenticated channel text, never decorated assistant replies.
  const latest = userIntentText(sendOpts?.[MAIN_OWNED_SEND_CONTEXT]?.rawChannelText ?? sourceContent);
  // A new attachment changes what "send this" refers to; it cannot renew an earlier grant.
  const hasAttachments = Array.isArray(sourceContent) && sourceContent.some((block) => block.type !== 'text');
  // References belong to this message only and travel with Main's Symbol, never a wire field.
  return intentProjection.withReferences(
    intentProjection.append(hasAttachments ? '' : previous, latest),
    sendOpts?.[MAIN_OWNED_SEND_CONTEXT]?.autoReviewReferences,
  );
}

/** Keep actual denied actions across one user follow-up, without assistant explanations or grants. */
export function createAutoReviewActionContext() {
  let blocked: ReviewableAction[] = [];
  let preceding: readonly ReviewableAction[] = [];
  return {
    advance(sameAuthority: boolean): void {
      preceding = sameAuthority ? blocked : [];
      blocked = [];
    },
    record(action: ReviewableAction, decision: AutoReviewDecision): void {
      if (decision.verdict !== 'block' || getAutoReviewActionTextLength(action) > MAX_AUTO_REVIEW_STATIC_TEXT_CHARS) return;
      const snapshot = JSON.parse(JSON.stringify(action)) as ReviewableAction;
      const key = JSON.stringify(snapshot);
      blocked = [...blocked.filter((item) => JSON.stringify(item) !== key), snapshot].slice(-3);
      while (blocked.length && JSON.stringify(blocked).length > MAX_AUTO_REVIEW_STATIC_TEXT_CHARS) blocked.shift();
    },
    get precedingBlockedActions(): readonly ReviewableAction[] { return preceding; },
  };
}

/**
 * Plan approval changes the authority for the implementation turn. Keep the
 * original request together with the approved plan without expanding the
 * lightweight reviewer beyond its existing intent budget.
 */
export function composeAutoReviewIntentWithApprovedPlan(
  currentUserIntent: AutoReviewUserIntent,
  approvedPlan: string,
): AutoReviewUserIntent {
  const plan = approvedPlan.trim();
  if (!plan) return normalizeAutoReviewUserIntent(currentUserIntent);
  return appendAutoReviewUserIntent(currentUserIntent, `Approved plan:\n${plan}`);
}

/**
 * 澄清问答同样改变本轮的授权范围:用户把范围从 `src/` 收窄到 `build/` 后,后续 `rm -rf src` 必须按
 * **澄清后**的意图裁决,而不是仍按原先那句含糊请求(否则可能被静默 allow)。答案与获批计划同理并入
 * 有界 intent,不扩大轻量 reviewer 的输入预算。
 */
export function composeAutoReviewIntentWithClarification(
  currentUserIntent: AutoReviewUserIntent,
  clarifications: readonly { question?: string; answer?: string }[],
): AutoReviewUserIntent {
  const lines = clarifications
    .map(({ question, answer }) => {
      const q = (question ?? '').trim();
      const a = (answer ?? '').trim();
      if (!a) return '';
      return q ? `- ${q} → ${a}` : `- ${a}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return normalizeAutoReviewUserIntent(currentUserIntent);
  return appendAutoReviewUserIntent(currentUserIntent, `Clarifications:\n${lines.join('\n')}`);
}
