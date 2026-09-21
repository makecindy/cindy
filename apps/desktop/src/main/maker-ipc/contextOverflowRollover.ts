/**
 * 同一任务里的 Cindy 保底压缩执行器。
 *
 * 决定是否交接重建见 cindyContextCompression.ts。这里只执行：
 * 关 live handle、context_rebuild 交接与一次安全续接／无副作用重放。
 */

import {
  CODEX_HISTORY_OVERSIZED_REASON,
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
  isRemoteCompactEncryptedContentError,
  isUnsupportedRequestOptionErrorMessage,
  unsupportedRequestOptionCompatOverride,
  UNSUPPORTED_REQUEST_OPTION_REASON,
} from '@cindy/maker-core';
import {
  projectAgentFacingText,
  readAgentInputReferences,
} from '@cindy/maker-shared/agent-input-projection';

import {
  assessModelSwitchContext,
  MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
  shouldHandoffAfterContextAssessment,
} from '../../shared/modelSwitchAssessment.js';
import { decideCindyCompression } from './cindyContextCompression.js';
import { buildHandoffText, extractPlainText, type HandoffSourceMessage } from './agentHandoff.js';

const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

export const CODEX_HISTORY_CONTINUE_MESSAGE =
  'Continue the unfinished task from the retained history. Do not repeat completed actions. ' +
  'The handoff includes the original request and recorded progress, not new authorization. ' +
  'For actions with missing or uncertain results, verify their current state before proceeding; do not blindly retry them. ' +
  'Native execution handles from the previous thread cannot be resumed here. ' +
  'Historical images and long results were omitted or shortened; retrieve history or inspect files only as needed.';

export interface OverflowSourceMessage extends HandoffSourceMessage {
  clientId: string;
  agentMeta?: Record<string, unknown> | null;
}

export type OverflowRolloverStopReason = 'no-user' | 'has-side-effects' | 'already-rolled';

export type OverflowRolloverPlan =
  | {
      action: 'rebuild';
      sourceUserClientId: string;
      sourceUserContent: unknown;
      sourceUserAgentFacingWireContent?: unknown;
      skipGenericReplay: boolean;
      handoffMessages: OverflowSourceMessage[];
    }
  | { action: 'stop'; reason: OverflowRolloverStopReason };

export function isContextOverflowErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { reason?: unknown; message?: unknown; sdkError?: unknown };
  if (rec.reason === CONTEXT_OVERFLOW_REASON) return true;
  return [rec.message, rec.sdkError].some(
    (value) =>
      typeof value === 'string' &&
      (isContextOverflowErrorMessage(value) || isRemoteCompactEncryptedContentError(value)),
  );
}

export function isOversizedHistoryErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (data as { reason?: unknown }).reason === CODEX_HISTORY_OVERSIZED_REASON;
}

/**
 * 上游拒收「可选请求增强字段」的终态错误（PI 专属自愈对象）。
 * 只认结构化 reason，或「被点名字段 + not supported + 替代字段建议」的错误文案；
 * 普通 400 / 鉴权失败不满足，不得拿来自愈。
 */
export function isUnsupportedRequestOptionErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { reason?: unknown; message?: unknown; sdkError?: unknown };
  if (rec.reason === UNSUPPORTED_REQUEST_OPTION_REASON) return true;
  return [rec.message, rec.sdkError].some(
    (value) => typeof value === 'string' && isUnsupportedRequestOptionErrorMessage(value),
  );
}

function unsupportedRequestOptionErrorText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as { message?: unknown; sdkError?: unknown };
  return [rec.message, rec.sdkError].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ) ?? '';
}

export interface NativeSessionRecoveryTarget {
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

const PI_PROMPT_RPC_TIMEOUT_RE = /pi rpc timeout after \d+ms: prompt\b/i;

export function isPiPromptRpcTimeoutError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as { message?: unknown; sdkError?: unknown };
  return [rec.message, rec.sdkError].some(
    (value) => typeof value === 'string' && PI_PROMPT_RPC_TIMEOUT_RE.test(value),
  );
}

/** PI 原生会话已经无法继续：超限，或 prompt RPC 超时（巨大 jsonl resume 卡死）。 */
export function shouldRebuildPiNativeSession(data: unknown): boolean {
  return isContextOverflowErrorData(data) || isPiPromptRpcTimeoutError(data);
}

const GROK_4_CONTEXT_CAP = 500_000;

export function effectiveContextWindow(
  model: string | null | undefined,
  reportedWindow: number,
  verifiedWindow?: number | null,
): number {
  if (typeof verifiedWindow === 'number' && verifiedWindow > 0) return verifiedWindow;
  const reported = Number.isFinite(reportedWindow) && reportedWindow > 0 ? reportedWindow : 0;
  if (typeof model === 'string' && /grok-4/i.test(model)) {
    return reported > 0 ? Math.min(reported, GROK_4_CONTEXT_CAP) : GROK_4_CONTEXT_CAP;
  }
  return reported;
}

/** @deprecated Kept for callers/tests that still use the old PI-specific name. */
export const effectivePiContextWindow = effectiveContextWindow;

export function lookupVerifiedContextWindow(
  resolve:
    ((agentKind: string, modelId: string, providerId: string | null) => number | null) | undefined,
  model: string | null | undefined,
  providerId?: string | null,
  agentKind?: string,
): number | null {
  if (!resolve || !model) return null;
  const ids = [model];
  const slash = model.lastIndexOf('/');
  if (slash >= 0) ids.push(model.slice(slash + 1));
  if (model.startsWith('x-ai/')) ids.push(`xai/${model.slice(5)}`);
  // A missing provider is an unresolved route, not permission to borrow the
  // xAI catalog entry. The Grok model-level cap below remains the only generic
  // fallback; directory lookup must stay scoped to this session's provider.
  const providerIds = [providerId ?? null];
  for (const id of [...new Set(ids)]) {
    const callResolve = (pid: string | null): number | null => resolve(agentKind ?? 'pi', id, pid);
    const hit = providerIds
      .map(callResolve)
      .find((value) => typeof value === 'number' && value > 0);
    if (typeof hit === 'number' && hit > 0) return hit;
  }
  return null;
}

/** 同模型发送前只认满窗。切小窗口的 danger 仍走 assessModelSwitchContext，不走这里。 */
export function shouldRebuildForContextPressure(
  tokens: number,
  window: number,
  _autoCompactThresholdPct?: number,
): boolean {
  if (!Number.isFinite(tokens) || tokens <= 0) return false;
  if (!Number.isFinite(window) || window <= 0) return false;
  return tokens >= window;
}

function isSyntheticUser(message: OverflowSourceMessage): boolean {
  if (message.role !== 'user') return false;
  return extractPlainText(message.content).startsWith(SYNTHETIC_TRIGGER_PREFIX);
}

function hasTurnSideEffects(messagesAfterUser: OverflowSourceMessage[]): boolean {
  return messagesAfterUser.some((message) => message.role !== 'error');
}

export type OverflowReplayWireMessage =
  string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

function isOverflowReplayWireMessage(value: unknown): value is OverflowReplayWireMessage {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'user' && (typeof record.content === 'string' || Array.isArray(record.content))
  );
}

export function persistedUserContentToWireMessage(content: unknown): OverflowReplayWireMessage {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return persistedUserContentToWireMessage(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return { type: 'user', content: content as Array<{ type: string; [k: string]: unknown }> };
  }
  if (!content || typeof content !== 'object') return '';
  const rec = content as Record<string, unknown>;
  if (isOverflowReplayWireMessage(rec.agentFacingWireContent)) {
    return rec.agentFacingWireContent;
  }
  if (rec.type === 'user') {
    if (typeof rec.content === 'string' || Array.isArray(rec.content)) {
      return rec as OverflowReplayWireMessage;
    }
  }
  const text = typeof rec.text === 'string' ? rec.text : '';
  const agentReferences = readAgentInputReferences(rec.agentReferences, text);
  const projectedText = projectAgentFacingText({
    text,
    quotesEncoded: rec.quotesEncoded === true,
    agentReferences,
  });
  const images = Array.isArray(rec.images) ? rec.images : [];
  const files = Array.isArray(rec.files) ? rec.files : [];
  if (images.length === 0 && files.length === 0) return projectedText;
  const blocks: Array<{ type: string; [k: string]: unknown }> = [];
  if (projectedText) blocks.push({ type: 'text', text: projectedText });
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const item = image as Record<string, unknown>;
    const path =
      typeof item.url === 'string' ? item.url : typeof item.path === 'string' ? item.path : '';
    if (path) blocks.push({ type: 'image', path });
  }
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const item = file as Record<string, unknown>;
    const path = typeof item.path === 'string' ? item.path : '';
    if (path) blocks.push({ type: 'file', path });
  }
  return { type: 'user', content: blocks.length > 0 ? blocks : projectedText };
}

export function planContextOverflowRollover(
  messages: OverflowSourceMessage[],
  alreadyRolledUserClientId?: string | null,
  continueFromHistory = false,
): OverflowRolloverPlan {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user' && !isSyntheticUser(message)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return { action: 'stop', reason: 'no-user' };
  const sourceUser = messages[lastUserIndex]!;
  if (alreadyRolledUserClientId && alreadyRolledUserClientId === sourceUser.clientId) {
    return { action: 'stop', reason: 'already-rolled' };
  }
  if (!continueFromHistory && hasTurnSideEffects(messages.slice(lastUserIndex + 1))) {
    return { action: 'stop', reason: 'has-side-effects' };
  }
  return {
    action: 'rebuild',
    sourceUserClientId: sourceUser.clientId,
    sourceUserContent: sourceUser.content,
    ...(sourceUser.agentMeta?.agentFacingWireContent !== undefined
      ? { sourceUserAgentFacingWireContent: sourceUser.agentMeta.agentFacingWireContent }
      : {}),
    skipGenericReplay: isExternalDispatchOwner(sourceUser.agentMeta),
    handoffMessages: continueFromHistory
      ? messages.filter((message) => message.role !== 'error')
      : messages.slice(0, lastUserIndex),
  };
}

function isExternalDispatchOwner(agentMeta: Record<string, unknown> | null | undefined): boolean {
  if (!agentMeta) return false;
  if (agentMeta.hookSource) return true;
  const origin = agentMeta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
  const kind = (origin as { kind?: unknown }).kind;
  // 有 origin.kind 就是外部派单方（scheduler / IM / goal / orca / …）。
  // 不要再列白名单：漏一个 kind 就会走 generic replay 冒充 Cindy 对话。
  return typeof kind === 'string' && kind.length > 0;
}

function normalizeOverflowDbAgentKind(value: string): 'cc' | 'codex' | 'pi' {
  if (value === 'codex' || value === 'pi') return value;
  return 'cc';
}

export function engineLabelForOverflow(agentKind: string): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude Code';
}

export function errorContentToData(content: unknown): unknown {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return { message: content };
      }
    }
    return { message: content };
  }
  return content;
}

/** 最近一条终态若是超限，或（PI 专属）prompt 超时，则原生会话已死，发送前不要再 resume。 */
export function findLatestRebuildableError(
  messages: OverflowSourceMessage[],
  allowPiPromptTimeout = true,
): unknown | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'error') {
      const data = errorContentToData(message.content);
      if (isContextOverflowErrorData(data)) return data;
      if (allowPiPromptTimeout && isPiPromptRpcTimeoutError(data)) return data;
      if (isOversizedHistoryErrorData(data)) return data;
      return null;
    }
    if (message.role === 'assistant' && extractPlainText(message.content).trim().length > 0) {
      return null;
    }
  }
  return null;
}

export interface ContextOverflowRolloverDeps {
  getSessionRow(sessionId: string): Promise<{
    status: string;
    source?: string | null;
    agentKind: string;
    remoteHostId: string | null;
    clearedAt: number | null;
    sdkSessionId?: string | null;
    contextTokens?: number | null;
    contextWindow?: number | null;
    model?: string | null;
    providerId?: string | null;
    workingDir?: string | null;
  } | null>;
  /** 发送前只读复核：旧错误不能把已经恢复健康的新线程再次重建。 */
  classifyCodexHistory?(threadId: string): Promise<'oversized' | 'healthy' | 'unknown'>;
  resolveVerifiedWindow?(
    agentKind: string,
    modelId: string,
    providerId: string | null,
  ): number | null;
  getAutoCompactThresholdPct?(): number | undefined;
  listMessages(sessionId: string): Promise<OverflowSourceMessage[]>;
  /** 不受 handoff 窗口限制的最近 user，避免工具密集 turn 把身份扫丢。 */
  findLatestUser?(sessionId: string): Promise<OverflowSourceMessage | null>;
  findLatestRebuildMeta(
    sessionId: string,
  ): Promise<{ reason?: string; sourceUserClientId?: string | null } | null>;
  getLiveSession(sessionId: string): {
    isTurnRunning(): boolean;
    getUsageSnapshot?(): { contextTokens: number; contextWindow: number; needsRollover?: boolean };
  } | null | undefined;
  rehydrateColdPiRuntimeForWindowVerification?(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  drainPersistQueue(): Promise<void>;
  commitRebuild(
    sessionId: string,
    handoff: string,
    meta: {
      reason: 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout' | 'native-session-recovery';
      sourceUserClientId: string | null;
      sourceAgentKind?: 'cc' | 'codex' | 'pi';
      sourceModel?: string | null;
      sourceProviderId?: string | null;
      expectedClearedAt?: number | null;
      replacementRoute?: NativeSessionRecoveryTarget & { expectedSdkSessionId: string };
    },
    signal?: AbortSignal,
  ): Promise<void>;
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  readPendingHandoffGeneration?(sessionId: string): number;
  replayUserMessage(
    sessionId: string,
    content: unknown,
    agentFacingWireContent?: unknown,
    recovery?: { signal?: AbortSignal; continueFromHistory?: false } | {
      signal?: AbortSignal;
      continueFromHistory: true;
      sourceUserContent: unknown;
      sourceUserClientId: string;
      sourceCapabilitySelectionText: string;
    },
  ): Promise<{ accepted: boolean }>;
  getRecoveryAbortSignal?(sessionId: string): AbortSignal;
  /**
   * PI provider compat 自愈：读取已学到的 per-model compat 修正。
   * 已存在 = 这台机器已经学过这个 provider/model 的拒收，不再自动重试（避免循环）。
   */
  readPiNativeCompatOverride?(
    providerId: string,
    modelId: string,
  ): Record<string, unknown> | undefined;
  /** PI provider compat 自愈：把本次学习到的 compat 修正落盘，供重建的 models.json 合并。
   *  返回 true 仅当条目确实落盘；false 时调用方不得重放（否则闩锁永远是假、无限重试）。 */
  recordPiNativeCompatOverride?(
    providerId: string,
    modelId: string,
    compat: Record<string, unknown>,
  ): Promise<boolean> | boolean;
  /** Synchronous: external dispatch may release its turn marker on this same terminal event. */
  hasExternalRecoveryOwner?(sessionId: string): boolean;
  onRebuilt?(sessionId: string): void;
  withSessionLock?<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  withCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export type OverflowClaimResult = 'claimed' | 'in-flight' | 'idle';

export type ModelWindowSwitchPreparationResult =
  | 'not-needed'
  | 'confirmation-required'
  | 'rebuilt'
  | 'busy'
  | 'remote-unsupported'
  | 'unknown-context'
  | 'in-flight';

export function hasModelWindowContextToProtect(
  contextTokensKnown: boolean,
  contextTokens: number,
): boolean {
  return !contextTokensKnown || contextTokens !== 0;
}

export function shouldRebuildForModelWindowSwitch(input: {
  contextTokens: number;
  currentContextWindow: number;
  targetContextWindow: number;
}): boolean {
  if (
    !Number.isFinite(input.currentContextWindow) ||
    input.currentContextWindow <= 0 ||
    !Number.isFinite(input.targetContextWindow) ||
    input.targetContextWindow <= 0 ||
    input.targetContextWindow >= input.currentContextWindow
  ) {
    return false;
  }
  return shouldHandoffAfterContextAssessment(
    assessModelSwitchContext({
      contextTokens: input.contextTokens,
      targetContextWindow: input.targetContextWindow,
      autoCompactThresholdPct: MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
    }),
  );
}

export function createContextOverflowRollover(deps: ContextOverflowRolloverDeps): {
  claim(sessionId: string): OverflowClaimResult;
  cancelRecovery(sessionId: string): void;
  tryRecover(
    sessionId: string,
    errorData: unknown,
    /** 产生该终态错误的 turn 身份：区分「同一轮的重复投递」与「重放后的新一轮失败」。 */
    turnIdentity?: { instanceId?: string; generation?: number },
  ): Promise<boolean>;
  prepareUnhealthySession(sessionId: string): Promise<boolean>;
  prepareNativeSessionRecovery(
    sessionId: string,
    // null is an explicit Bot restart: keep its route, including before the first native handle.
    target: NativeSessionRecoveryTarget | null,
    assertCanCommit: () => void,
    signal?: AbortSignal,
  ): Promise<void>;
  prepareModelWindowSwitch(
    sessionId: string,
    target: {
      contextWindow: number;
      recheckTargetPressure?: boolean;
      confirmedTargetPressure?: boolean;
      onConfirmationRequired?: (contextTokens: number) => void;
      assertCanCommit?: () => void;
      beforeClose?: () => void;
    },
  ): Promise<ModelWindowSwitchPreparationResult>;
} {
  const inFlight = new Map<string, AbortController | undefined>();
  // One automatic continuation per source input, not one per replacement thread.
  const continuedInputs = new Map<string, string>();
  // 自愈成功时那一轮的 turn 身份：同身份再次到达 = 同一轮的重复终态投递（丢弃）；
  // 新身份 = 重放后的新一轮失败（必须 surface，不能静默吞掉）。
  const healedCompatTurns = new Map<string, { instanceId?: string; generation?: number }>();

  const runRecover = async (
    sessionId: string,
    errorData: unknown,
    signal?: AbortSignal,
    turnIdentity?: { instanceId?: string; generation?: number },
  ): Promise<boolean> => {
    if (signal?.aborted) return true;
    const oversized = isOversizedHistoryErrorData(errorData);
    const unsupportedOption = isUnsupportedRequestOptionErrorData(errorData);
    if (!isContextOverflowErrorData(errorData) && !oversized && !unsupportedOption) return false;
    await deps.drainPersistQueue();
    const sessionRow = await deps.getSessionRow(sessionId);
    signal?.throwIfAborted();
    if (!sessionRow || sessionRow.status === 'deleted') return false;
    // SSH only. device-link 会话落在被控桌面本地库,没有 remoteHostId,必须继续换窗。
    if (sessionRow.remoteHostId) return false;
    if (oversized && (sessionRow.source !== 'desktop' || sessionRow.agentKind !== 'codex')) return false;
    // compat 自愈同样只服务本机桌面会话（与 replayUserMessage 的 continueFromHistory 一致）。
    if (unsupportedOption && sessionRow.source !== 'desktop') return false;

    return deps.withCloseSuppressed(sessionId, async () => {
      const live = deps.getLiveSession(sessionId);
      if (live?.isTurnRunning()) {
        deps.log.warn('context overflow rollover skipped: turn still running', { sessionId });
        return false;
      }
      const tokens: 'violated' | 'unknown' = isContextOverflowErrorData(errorData)
        ? 'violated'
        : 'unknown';
      // ── PI provider compat 自愈：上游拒收可选请求字段（如 prompt_cache_retention）──
      // 失败轮零产出，学习该 provider/model 的 compat 修正后关会话重建（新 models.json
      // 不再带该字段），并重放同一轮用户消息。只做一次：已学过的 (provider, model)
      // 再失败就交给常规错误面，绝不循环重试。
      if (unsupportedOption) {
        const compat = unsupportedRequestOptionCompatOverride(
          unsupportedRequestOptionErrorText(errorData),
        );
        const providerId = sessionRow.providerId ?? null;
        const modelId = sessionRow.model ?? null;
        // providerId 为 null（老会话/远端控制端未持久化）时无法确定学习键，不自愈。
        if (!compat || !providerId || !modelId || !deps.recordPiNativeCompatOverride) {
          return false;
        }
        const source = await deps.listMessages(sessionId);
        signal?.throwIfAborted();
        const plan = planContextOverflowRollover(source, null);
        // 同一轮重复终态 error：上一次自愈已经重放并续跑过，这次直接丢弃（不重放、
        // 不落错误行）。必须用「实例 + 轮次」身份区分：重放失败是新一轮（新 instanceId /
        // 新 generation），必须照常 surface，否则真实的重试失败会被静默吞掉。
        const sourceUser =
          plan.action === 'rebuild'
            ? { clientId: plan.sourceUserClientId }
            : [...source].reverse().find((message) => message.role === 'user' && !isSyntheticUser(message));
        const healedTurn = healedCompatTurns.get(sessionId);
        if (
          sourceUser &&
          healedTurn?.generation !== undefined &&
          healedTurn.generation === turnIdentity?.generation &&
          healedTurn.instanceId === turnIdentity?.instanceId &&
          continuedInputs.get(sessionId) === sourceUser.clientId
        ) {
          return true;
        }
        // 已学过（包括用户在别处已修好）→ 不再自动重试，交常规错误面。
        if (deps.readPiNativeCompatOverride?.(providerId, modelId)) {
          return false;
        }
        // 外部派单方（Orca / scheduler / IM / ghost setup）拥有自己的重试语义：不能代它
        // 重放用户消息 —— 派单正文经 wire 投影可能退化为空，重复发送还可能让两方各跑一次。
        const externalOwner =
          plan.action !== 'stop' &&
          (plan.skipGenericReplay || (deps.hasExternalRecoveryOwner?.(sessionId) ?? false));
        // 先关掉旧 runtime，再置学习闩锁：闩锁置了而 runtime 没换掉的话，后续同 pair 的
        // 请求会命中闩锁直接放弃，永久停在旧 models.json 上反复 400。
        if (live) await deps.closeSession(sessionId);
        signal?.throwIfAborted();
        const learned = await deps.recordPiNativeCompatOverride(providerId, modelId, compat);
        signal?.throwIfAborted();
        if (!learned) {
          // 没学到就不重放：否则闩锁永远为假，同一个 400 会被无上限重放。
          deps.log.warn('pi provider compat was not persisted; leaving the error to surface', {
            sessionId,
            providerId,
            modelId,
          });
          return false;
        }
        // 零产出守卫判定不能重放（无用户消息/已有副作用）或外部 owner：只学不重放，
        // 让下一次发送用修好的 models.json 重建。
        if (plan.action === 'stop' || externalOwner) {
          deps.log.info('pi provider compat learned without replay', {
            sessionId,
            providerId,
            modelId,
            compat,
            ...(plan.action === 'stop' ? { stopReason: plan.reason } : { externalOwner: true }),
          });
          return false;
        }
        const sourceWire = persistedUserContentToWireMessage(
          plan.sourceUserAgentFacingWireContent ?? plan.sourceUserContent,
        );
        const sourceText = typeof sourceWire === 'string' ? sourceWire : sourceWire.content;
        const replay = await deps.replayUserMessage(
          sessionId,
          plan.sourceUserContent,
          plan.sourceUserAgentFacingWireContent,
          {
            signal,
            // 保留同一 Pi 会话历史：失败轮的 error assistant 会被 pi-ai 序列化时
            // 跳过，模型看到的仍是同一条用户请求，重放即重试。
            continueFromHistory: true,
            sourceUserContent: plan.sourceUserContent,
            sourceUserClientId: plan.sourceUserClientId,
            sourceCapabilitySelectionText:
              typeof sourceText === 'string' ? sourceText : extractPlainText(sourceText),
          },
        );
        signal?.throwIfAborted();
        if (!replay.accepted) {
          deps.log.warn('pi provider compat replay was not accepted', {
            sessionId,
            providerId,
            modelId,
          });
          return false;
        }
        deps.onRebuilt?.(sessionId);
        continuedInputs.set(sessionId, plan.sourceUserClientId);
        if (turnIdentity?.generation !== undefined) {
          healedCompatTurns.set(sessionId, turnIdentity);
        }
        deps.log.info('pi provider compat learned; replayed the user message', {
          sessionId,
          providerId,
          modelId,
          compat,
        });
        return true;
      }
      const action = decideCindyCompression({
        local: true,
        bytes: oversized ? 'violated' : 'unknown',
        tokens,
      });
      if (action !== 'rebuild') return false;
      const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
      const [source, rebuildMeta] = await Promise.all([
        deps.listMessages(sessionId),
        deps.findLatestRebuildMeta(sessionId),
      ]);
      signal?.throwIfAborted();
      const alreadyRolled =
        rebuildMeta?.reason === 'context-overflow' ? rebuildMeta.sourceUserClientId : null;
      // Tool-heavy turns may have pushed the user out of the bounded history window.
      // Keep the original input identity and intent without replaying it as a new request.
      let recoverySource = source;
      if (oversized && !source.some((message) => message.role === 'user' && !isSyntheticUser(message))) {
        const sourceUser = await deps.findLatestUser?.(sessionId);
        signal?.throwIfAborted();
        if (sourceUser && !isSyntheticUser(sourceUser)) recoverySource = [sourceUser, ...source];
      }
      const plan = planContextOverflowRollover(recoverySource, alreadyRolled, oversized);
      if (plan.action === 'stop') {
        deps.log.info('context overflow rollover stopped', {
          sessionId,
          reason: plan.reason,
        });
        return false;
      }

      if (oversized) {
        if (plan.skipGenericReplay || deps.hasExternalRecoveryOwner?.(sessionId)) return false;
        if (continuedInputs.get(sessionId) === plan.sourceUserClientId) return false;
        // Claim the input before any destructive recovery step, even if commit/send fails.
        continuedInputs.set(sessionId, plan.sourceUserClientId);
      }

      if (live) await deps.closeSession(sessionId);
      signal?.throwIfAborted();
      if (oversized && deps.hasExternalRecoveryOwner?.(sessionId)) return false;
      const label = engineLabelForOverflow(sessionRow.agentKind);
      const handoff = buildHandoffText(plan.handoffMessages, {
        fromLabel: label,
        toLabel: label,
        sessionId,
        reason: oversized ? 'native-session-recovery' : 'context-overflow',
        includeToolResults: oversized,
      });
      await deps.commitRebuild(sessionId, handoff, {
        reason: 'context-overflow',
        sourceUserClientId: plan.sourceUserClientId,
        sourceAgentKind: normalizeOverflowDbAgentKind(sessionRow.agentKind),
        sourceModel: sessionRow.model ?? null,
        sourceProviderId: sessionRow.providerId ?? null,
        expectedClearedAt: sessionRow.clearedAt,
      }, signal);
      signal?.throwIfAborted();
      deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
      if (plan.skipGenericReplay) {
        deps.log.info('overflow rebuilt; external owner must retry send', {
          sessionId,
          sourceUserClientId: plan.sourceUserClientId,
        });
        return true;
      }
      if (oversized && deps.hasExternalRecoveryOwner?.(sessionId)) return false;
      const sourceWire = persistedUserContentToWireMessage(
        plan.sourceUserAgentFacingWireContent ?? plan.sourceUserContent,
      );
      const sourceText = typeof sourceWire === 'string' ? sourceWire : sourceWire.content;
      const replay = await deps.replayUserMessage(
        sessionId,
        oversized ? CODEX_HISTORY_CONTINUE_MESSAGE : plan.sourceUserContent,
        oversized ? undefined : plan.sourceUserAgentFacingWireContent,
        oversized ? {
          signal,
          continueFromHistory: true,
          sourceUserContent: plan.sourceUserContent,
          sourceUserClientId: plan.sourceUserClientId,
          sourceCapabilitySelectionText: typeof sourceText === 'string' ? sourceText : extractPlainText(sourceText),
        } : { signal },
      );
      signal?.throwIfAborted();
      if (!replay.accepted) {
        deps.log.warn('context overflow rollover replay was not accepted', {
          sessionId,
          sourceUserClientId: plan.sourceUserClientId,
        });
        return false;
      }
      // 重放被接受后再清 recovery：失败时要保留 Retry，不能先 clearError。
      deps.onRebuilt?.(sessionId);
      deps.log.info(oversized ? 'codex image history rebuilt and continued' : 'context overflow rollover replayed user message', {
        sessionId,
        sourceUserClientId: plan.sourceUserClientId,
      });
      return true;
    });
  };

  const runPrepareModelWindowSwitch = async (
    sessionId: string,
    target: {
      contextWindow: number;
      recheckTargetPressure?: boolean;
      confirmedTargetPressure?: boolean;
      onConfirmationRequired?: (contextTokens: number) => void;
      assertCanCommit?: () => void;
      beforeClose?: () => void;
    },
  ): Promise<ModelWindowSwitchPreparationResult> => {
    await deps.drainPersistQueue();
    const sessionRow = await deps.getSessionRow(sessionId);
    if (!sessionRow || sessionRow.status === 'deleted' || !sessionRow.sdkSessionId) {
      return 'not-needed';
    }
    const persistedContextTokens =
      typeof sessionRow.contextTokens === 'number' &&
      Number.isFinite(sessionRow.contextTokens) &&
      sessionRow.contextTokens >= 0
        ? sessionRow.contextTokens
        : 0;
    let live = deps.getLiveSession(sessionId);
    let rehydratedColdPi = false;
    if (sessionRow.agentKind === 'pi' && !live) {
      if (sessionRow.remoteHostId) {
        // A cold SSH runtime cannot be rehydrated locally. Persisted usage is still
        // sufficient to allow an empty/low-pressure switch or reject a required rebuild.
        const requiresRemoteRebuild = shouldHandoffAfterContextAssessment(
          assessModelSwitchContext({
            contextTokens: persistedContextTokens,
            targetContextWindow: target.contextWindow,
            autoCompactThresholdPct: MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
          }),
        );
        return requiresRemoteRebuild ? 'remote-unsupported' : 'not-needed';
      }
      if (!deps.rehydrateColdPiRuntimeForWindowVerification) return 'unknown-context';
      try {
        await deps.rehydrateColdPiRuntimeForWindowVerification(sessionId);
      } catch (error) {
        deps.log.warn('cold Pi runtime window verification failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'unknown-context';
      }
      live = deps.getLiveSession(sessionId);
      rehydratedColdPi = true;
    }
    const liveUsage = live?.getUsageSnapshot?.();
    if (
      rehydratedColdPi &&
      (!liveUsage || !Number.isFinite(liveUsage.contextWindow) || liveUsage.contextWindow <= 0)
    ) {
      return 'unknown-context';
    }
    const liveContextTokens =
      liveUsage && Number.isFinite(liveUsage.contextTokens) && liveUsage.contextTokens >= 0
        ? liveUsage.contextTokens
        : null;
    // A freshly/lazily attached runtime reports the placeholder 0 before any usage.
    // Only persisted 0 confirms that zero is authoritative; a positive live value is authoritative itself.
    const contextTokens =
      liveContextTokens !== null && (liveContextTokens > 0 || persistedContextTokens === 0)
        ? liveContextTokens
        : persistedContextTokens;
    const reportedCurrentWindow =
      liveUsage && Number.isFinite(liveUsage.contextWindow) && liveUsage.contextWindow > 0
        ? liveUsage.contextWindow
        : (sessionRow.contextWindow ?? 0);
    const verifiedCurrentWindow = lookupVerifiedContextWindow(
      deps.resolveVerifiedWindow,
      sessionRow.model,
      sessionRow.providerId,
      sessionRow.agentKind,
    );
    // Cold Pi rows may contain either a catalog value or a runtime-verified value in
    // the same legacy column. Rehydration above makes get_state the cold-path source.
    const piRuntimeWindow =
      liveUsage && Number.isFinite(liveUsage.contextWindow) && liveUsage.contextWindow > 0
        ? liveUsage.contextWindow
        : (sessionRow.contextWindow ?? 0);
    const currentContextWindow =
      sessionRow.agentKind === 'pi'
        ? piRuntimeWindow
        : effectiveContextWindow(
            sessionRow.model,
            reportedCurrentWindow,
            verifiedCurrentWindow,
          );
    if (contextTokens > 0 && currentContextWindow <= 0) return 'unknown-context';
    const targetPressureRequiresRebuild =
      target.recheckTargetPressure === true &&
      shouldHandoffAfterContextAssessment(
        assessModelSwitchContext({
          contextTokens,
          targetContextWindow: target.contextWindow,
          autoCompactThresholdPct: MODEL_WINDOW_SWITCH_FORCE_REBUILD_PCT,
        }),
      );
    if (
      !targetPressureRequiresRebuild &&
      !shouldRebuildForModelWindowSwitch({
        contextTokens,
        currentContextWindow,
        targetContextWindow: target.contextWindow,
      })
    ) {
      return 'not-needed';
    }
    if (sessionRow.remoteHostId) return 'remote-unsupported';
    if (live?.isTurnRunning()) return 'busy';
    if (targetPressureRequiresRebuild && target.confirmedTargetPressure !== true) {
      target.onConfirmationRequired?.(contextTokens);
      return 'confirmation-required';
    }

    const source = (await deps.listMessages(sessionId)).filter(
      (message) => message.role !== 'error',
    );
    const latestUser =
      [...source].reverse().find((message) => message.role === 'user' && !isSyntheticUser(message)) ??
      (await deps.findLatestUser?.(sessionId)) ??
      null;
    const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
    target.assertCanCommit?.();
    target.beforeClose?.();
    if (live) await deps.closeSession(sessionId);
    target.assertCanCommit?.();
    const label = engineLabelForOverflow(sessionRow.agentKind);
    const handoff = buildHandoffText(source, {
      fromLabel: label,
      toLabel: label,
      sessionId,
      reason: 'model-window-switch',
    });
    await deps.commitRebuild(sessionId, handoff, {
      reason: 'model-window-switch',
      sourceUserClientId: latestUser?.clientId ?? null,
      sourceAgentKind: normalizeOverflowDbAgentKind(sessionRow.agentKind),
      sourceModel: sessionRow.model ?? null,
      sourceProviderId: sessionRow.providerId ?? null,
      expectedClearedAt: sessionRow.clearedAt,
    });
    deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
    deps.onRebuilt?.(sessionId);
    deps.log.info('model window shrink rebuilt native context before runtime switch', {
      sessionId,
      agentKind: sessionRow.agentKind,
      contextTokens,
      currentContextWindow,
      targetContextWindow: target.contextWindow,
    });
    return 'rebuilt';
  };

  const runPrepare = async (sessionId: string): Promise<boolean> => {
    await deps.drainPersistQueue();
    const sessionRow = await deps.getSessionRow(sessionId);
    if (!sessionRow || sessionRow.status === 'deleted') return false;
    // SSH only; device-link 会话在被控桌面是本地 session,继续换窗。
    if (sessionRow.remoteHostId) return false;
    if (!sessionRow.sdkSessionId) return false;
    const live = deps.getLiveSession(sessionId);
    if (live?.isTurnRunning()) return false;
    const source = await deps.listMessages(sessionId);
    const lastError = findLatestRebuildableError(source, sessionRow.agentKind === 'pi');
    const liveUsage = live?.getUsageSnapshot?.();
    const hasLiveTokens =
      liveUsage !== undefined &&
      Number.isFinite(liveUsage.contextTokens) &&
      liveUsage.contextTokens >= 0;
    const usedTokens = hasLiveTokens
      ? liveUsage.contextTokens
      : typeof sessionRow.contextTokens === 'number'
        ? sessionRow.contextTokens
        : 0;
    const reportedWindow =
      hasLiveTokens && liveUsage.contextWindow > 0
        ? liveUsage.contextWindow
        : typeof sessionRow.contextWindow === 'number'
          ? sessionRow.contextWindow
          : 0;
    const verified = lookupVerifiedContextWindow(
      deps.resolveVerifiedWindow,
      sessionRow.model,
      sessionRow.providerId,
      sessionRow.agentKind,
    );
    const window = effectiveContextWindow(sessionRow.model, reportedWindow, verified);
    const pressure = shouldRebuildForContextPressure(usedTokens, window);
    const compactFailed = liveUsage?.needsRollover === true;
    const tokenViolated =
      isContextOverflowErrorData(lastError) ||
      isPiPromptRpcTimeoutError(lastError) ||
      pressure ||
      compactFailed;
    const oversized = isOversizedHistoryErrorData(lastError);
    const historyHealth = oversized && sessionRow.agentKind === 'codex'
      ? await deps.classifyCodexHistory?.(sessionRow.sdkSessionId)
      : undefined;
    const action = decideCindyCompression({
      local: true,
      bytes: oversized && historyHealth !== 'healthy' ? 'violated' : 'unknown',
      tokens: tokenViolated ? 'violated' : 'unknown',
    });
    if (action !== 'rebuild') return false;
    let lastUser: OverflowSourceMessage | undefined;
    let lastUserIndex = -1;
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const message = source[i];
      if (message && message.role === 'user' && !isSyntheticUser(message)) {
        lastUser = message;
        lastUserIndex = i;
        break;
      }
    }
    if (!lastUser) {
      lastUser = (await deps.findLatestUser?.(sessionId)) ?? undefined;
      lastUserIndex = -1;
    }
    if (!lastUser) return false;
    const rebuildReason = isPiPromptRpcTimeoutError(lastError)
      ? 'pi-prompt-timeout'
      : 'context-overflow';
    // 待发出/失败的 user 还会由本次 send 或 Retry 再 wire 一次，交接里不能带。
    // 已完成的最后一轮（后面有非 error）要留在交接里。
    // lastUser 若不在 handoff 窗口里（index < 0），窗口全是其后的 tool/assistant，算已完成。
    const pendingOutbound =
      lastUserIndex >= 0 &&
      source.slice(lastUserIndex + 1).every((message) => message.role === 'error');
    const handoffMessages = (
      pendingOutbound && lastUserIndex >= 0 ? source.slice(0, lastUserIndex) : source
    ).filter((message) => message.role !== 'error');
    const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
    // 关掉当前 live handle。调用方必须在解析发送目标之前调用 prepare,
    // 再 getSession / createSession;peek 之后对旧对象 send 会打到已关闭实例。
    if (live) await deps.closeSession(sessionId);
    const label = engineLabelForOverflow(sessionRow.agentKind);
    const handoff = buildHandoffText(handoffMessages, {
      fromLabel: label,
      toLabel: label,
      sessionId,
      reason: isOversizedHistoryErrorData(lastError) ? 'native-session-recovery' : rebuildReason,
      includeToolResults: isOversizedHistoryErrorData(lastError),
    });
    await deps.commitRebuild(sessionId, handoff, {
      reason: rebuildReason,
      sourceUserClientId: lastUser.clientId,
      sourceAgentKind: normalizeOverflowDbAgentKind(sessionRow.agentKind),
      sourceModel: sessionRow.model ?? null,
      sourceProviderId: sessionRow.providerId ?? null,
      expectedClearedAt: sessionRow.clearedAt,
    });
    deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
    deps.onRebuilt?.(sessionId);
    deps.log.info('unhealthy native session rebuilt before send; skip compact/resume', {
      sessionId,
      sourceUserClientId: lastUser.clientId,
    });
    return true;
  };

  return {
    async prepareNativeSessionRecovery(sessionId, target, assertCanCommit, signal) {
      if (inFlight.has(sessionId)) throw new Error('Native session recovery is already in progress');
      inFlight.set(sessionId, undefined);
      try {
        await deps.withCloseSuppressed(sessionId, async () => {
          await deps.drainPersistQueue();
          const row = await deps.getSessionRow(sessionId);
          if (!row || row.status === 'deleted' ||
              (target ? (!row.sdkSessionId || row.remoteHostId) : (row.source !== 'bot' || row.status !== 'active'))) {
            throw new Error('Native session recovery source is unavailable');
          }
          const generation = deps.readPendingHandoffGeneration?.(sessionId);
          let source = (await deps.listMessages(sessionId)).filter((message) => message.role !== 'error');
          if (source.length === 0 && row.contextTokens !== 0) {
            throw new Error('Cindy history is unavailable for native session recovery');
          }
          assertCanCommit();
          const live = deps.getLiveSession(sessionId);
          if (target && live?.isTurnRunning()) {
            throw new Error('Native session recovery cannot interrupt a running turn');
          }
          // Manual restart closes the broken runtime without asking it to compact.
          if (live) await deps.closeSession(sessionId);
          assertCanCommit();
          if (!target) {
            // Include any last output persisted while the old runtime was stopping.
            await deps.drainPersistQueue();
            assertCanCommit();
            source = (await deps.listMessages(sessionId)).filter((message) => message.role !== 'error');
            assertCanCommit();
          }
          const handoff = buildHandoffText(source, {
            fromLabel: engineLabelForOverflow(row.agentKind),
            toLabel: engineLabelForOverflow(row.agentKind),
            sessionId,
            reason: 'native-session-recovery',
          });
          // Durable handoff, SDK reset and complete target route succeed or fail together.
          // No user turn or tool call is replayed by this control-plane operation.
          const commitArgs: Parameters<ContextOverflowRolloverDeps['commitRebuild']> = [sessionId, handoff, {
            reason: 'native-session-recovery',
            sourceUserClientId: [...source].reverse().find((message) => message.role === 'user')?.clientId ?? null,
            sourceAgentKind: normalizeOverflowDbAgentKind(row.agentKind),
            sourceModel: row.model ?? null,
            sourceProviderId: row.providerId ?? null,
            expectedClearedAt: row.clearedAt,
            ...(target ? { replacementRoute: { ...target, expectedSdkSessionId: row.sdkSessionId! } } : {}),
          }];
          if (signal) commitArgs[3] = signal;
          await deps.commitRebuild(...commitArgs);
          deps.setPendingHandoff(sessionId, handoff, generation);
          deps.onRebuilt?.(sessionId);
        });
      } finally {
        inFlight.delete(sessionId);
      }
    },

    claim(sessionId: string): OverflowClaimResult {
      if (inFlight.has(sessionId)) return 'in-flight';
      inFlight.set(sessionId, new AbortController());
      return 'claimed';
    },

    cancelRecovery(sessionId: string): void {
      // Keep the claim until its async work unwinds; only the hidden send is
      // cancelled, never the newer input or the session's normal generation.
      inFlight.get(sessionId)?.abort();
    },

    async tryRecover(
      sessionId: string,
      errorData: unknown,
      turnIdentity?: { instanceId?: string; generation?: number },
    ): Promise<boolean> {
      let signal: AbortSignal | undefined;
      try {
        // IM may not persist this input (protected content), and an attached IM
        // turn can outlive its binding. Check live ownership before any await.
        if (isOversizedHistoryErrorData(errorData) && deps.hasExternalRecoveryOwner?.(sessionId)) return false;
        const claim = inFlight.get(sessionId) ?? new AbortController();
        inFlight.set(sessionId, claim);
        const inputSignal = deps.getRecoveryAbortSignal?.(sessionId);
        signal = inputSignal ? AbortSignal.any([claim.signal, inputSignal]) : claim.signal;
        if (deps.withSessionLock) {
          return await deps.withSessionLock(sessionId, () =>
            runRecover(sessionId, errorData, signal, turnIdentity),
          );
        }
        return await runRecover(sessionId, errorData, signal, turnIdentity);
      } catch (error) {
        if (signal?.aborted) return true;
        deps.log.warn('context overflow rollover failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        inFlight.delete(sessionId);
      }
    },

    async prepareUnhealthySession(sessionId: string): Promise<boolean> {
      if (inFlight.has(sessionId)) return false;
      inFlight.set(sessionId, undefined);
      try {
        return await deps.withCloseSuppressed(sessionId, () => runPrepare(sessionId));
      } catch (error) {
        deps.log.warn('unhealthy native session prepare failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        // A failed pre-send rebuild must not fall through to the caller's
        // stale resume/fork/thread options. Let the send boundary fail closed.
        throw error;
      } finally {
        inFlight.delete(sessionId);
      }
    },

    async prepareModelWindowSwitch(sessionId, target) {
      if (inFlight.has(sessionId)) return 'in-flight';
      inFlight.set(sessionId, undefined);
      try {
        return await deps.withCloseSuppressed(sessionId, () =>
          runPrepareModelWindowSwitch(sessionId, target),
        );
      } catch (error) {
        deps.log.warn('model window switch preparation failed', {
          sessionId,
          targetContextWindow: target.contextWindow,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        inFlight.delete(sessionId);
      }
    },
  };
}
