/**
 * 同一任务里的 Cindy 保底压缩执行器。
 *
 * 决定「剥图还是交接重建」见 cindyContextCompression.ts。这里只执行：
 * 关 live handle、剥图 relink、或 context_rebuild 交接 + 必要时 replay。
 */

import {
  CODEX_HISTORY_OVERSIZED_REASON,
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
  isRemoteCompactEncryptedContentError,
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
import { afterStripAttempt, decideCindyCompression } from './cindyContextCompression.js';
import { buildHandoffText, extractPlainText, type HandoffSourceMessage } from './agentHandoff.js';

const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

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

export type CodexStripRelinkResult = 'recovered' | 'not-needed' | 'failed' | 'busy' | 'stale';

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
  if (hasTurnSideEffects(messages.slice(lastUserIndex + 1))) {
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
    handoffMessages: messages.slice(0, lastUserIndex),
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
  /**
   * Codex 字节病第一档：同任务剥图并 relink native thread。
   * recovered = 已换干净 thread；not-needed = 当前 thread 已可发送；failed = 落到换窗。
   */
  tryStripOversizedCodexHistory?(args: {
    sessionId: string;
    threadId: string;
    model: string | null;
    providerId: string | null;
    workingDir: string | null;
  }): Promise<CodexStripRelinkResult>;
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
      reason: 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout';
      sourceUserClientId: string | null;
      sourceAgentKind?: 'cc' | 'codex' | 'pi';
      sourceModel?: string | null;
      sourceProviderId?: string | null;
      expectedClearedAt?: number | null;
    },
  ): Promise<void>;
  setPendingHandoff(sessionId: string, handoff: string, expectedGeneration?: number): void;
  readPendingHandoffGeneration?(sessionId: string): number;
  replayUserMessage(
    sessionId: string,
    content: unknown,
    agentFacingWireContent?: unknown,
  ): Promise<{ accepted: boolean }>;
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
  tryRecover(sessionId: string, errorData: unknown): Promise<boolean>;
  prepareUnhealthySession(sessionId: string): Promise<boolean>;
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
  const inFlight = new Set<string>();

  const runStripRelink = async (
    sessionId: string,
    sessionRow: {
      agentKind: string;
      sdkSessionId?: string | null;
      model?: string | null;
      providerId?: string | null;
      workingDir?: string | null;
    },
  ): Promise<CodexStripRelinkResult> => {
    if (
      sessionRow.agentKind !== 'codex' ||
      !sessionRow.sdkSessionId ||
      !deps.tryStripOversizedCodexHistory
    ) {
      return 'failed';
    }
    return deps.tryStripOversizedCodexHistory({
      sessionId,
      threadId: sessionRow.sdkSessionId,
      model: sessionRow.model ?? null,
      providerId: sessionRow.providerId ?? null,
      workingDir: sessionRow.workingDir ?? null,
    });
  };

  const runRecover = async (sessionId: string, errorData: unknown): Promise<boolean> => {
    const oversized = isOversizedHistoryErrorData(errorData);
    if (!isContextOverflowErrorData(errorData) && !oversized) return false;
    await deps.drainPersistQueue();
    const sessionRow = await deps.getSessionRow(sessionId);
    if (!sessionRow || sessionRow.status === 'deleted') return false;
    // SSH only. device-link 会话落在被控桌面本地库,没有 remoteHostId,必须继续换窗。
    if (sessionRow.remoteHostId) return false;

    return deps.withCloseSuppressed(sessionId, async () => {
      const live = deps.getLiveSession(sessionId);
      if (live?.isTurnRunning()) {
        deps.log.warn('context overflow rollover skipped: turn still running', { sessionId });
        return false;
      }
      const tokens: 'violated' | 'unknown' = isContextOverflowErrorData(errorData)
        ? 'violated'
        : 'unknown';
      let action = decideCindyCompression({
        local: true,
        bytes: oversized ? 'violated' : 'unknown',
        tokens,
      });
      if (action === 'strip') {
        const strip = await runStripRelink(sessionId, sessionRow);
        const next = afterStripAttempt(strip, { local: true, tokens });
        if (next === 'done') {
          deps.onRebuilt?.(sessionId);
          deps.log.info('codex oversized history strip settled', { sessionId, strip, next });
          return true;
        }
        if (next === 'none') {
          if (strip === 'not-needed') deps.onRebuilt?.(sessionId);
          return strip === 'not-needed';
        }
        action = next;
        deps.log.warn('codex oversized strip did not finish; rebuilding', { sessionId, strip });
      }
      if (action !== 'rebuild') return false;
      const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
      const [source, rebuildMeta] = await Promise.all([
        deps.listMessages(sessionId),
        deps.findLatestRebuildMeta(sessionId),
      ]);
      const alreadyRolled =
        rebuildMeta?.reason === 'context-overflow' ? rebuildMeta.sourceUserClientId : null;
      const plan = planContextOverflowRollover(source, alreadyRolled);
      if (plan.action === 'stop') {
        deps.log.info('context overflow rollover stopped', {
          sessionId,
          reason: plan.reason,
        });
        return false;
      }

      if (live) await deps.closeSession(sessionId);
      const label = engineLabelForOverflow(sessionRow.agentKind);
      const handoff = buildHandoffText(plan.handoffMessages, {
        fromLabel: label,
        toLabel: label,
        sessionId,
        reason: 'context-overflow',
      });
      await deps.commitRebuild(sessionId, handoff, {
        reason: 'context-overflow',
        sourceUserClientId: plan.sourceUserClientId,
        sourceAgentKind: normalizeOverflowDbAgentKind(sessionRow.agentKind),
        sourceModel: sessionRow.model ?? null,
        sourceProviderId: sessionRow.providerId ?? null,
        expectedClearedAt: sessionRow.clearedAt,
      });
      deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
      if (plan.skipGenericReplay) {
        deps.log.info('overflow rebuilt; external owner must retry send', {
          sessionId,
          sourceUserClientId: plan.sourceUserClientId,
        });
        return true;
      }
      const replay =
        plan.sourceUserAgentFacingWireContent !== undefined
          ? await deps.replayUserMessage(
              sessionId,
              plan.sourceUserContent,
              plan.sourceUserAgentFacingWireContent,
            )
          : await deps.replayUserMessage(sessionId, plan.sourceUserContent);
      if (!replay.accepted) {
        deps.log.warn('context overflow rollover replay was not accepted', {
          sessionId,
          sourceUserClientId: plan.sourceUserClientId,
        });
        return false;
      }
      // 重放被接受后再清 recovery：失败时要保留 Retry，不能先 clearError。
      deps.onRebuilt?.(sessionId);
      deps.log.info('context overflow rollover replayed user message', {
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
    let action = decideCindyCompression({
      local: true,
      bytes: isOversizedHistoryErrorData(lastError) ? 'violated' : 'unknown',
      tokens: tokenViolated ? 'violated' : 'unknown',
    });
    if (action === 'none') return false;
    if (action === 'strip') {
      const strip = await runStripRelink(sessionId, sessionRow);
      const next = afterStripAttempt(strip, {
        local: true,
        tokens: tokenViolated ? 'violated' : 'unknown',
      });
      if (next === 'done') {
        deps.onRebuilt?.(sessionId);
        deps.log.info('codex oversized history stripped before send', { sessionId });
        return true;
      }
      if (next === 'none') return false;
      action = next;
      deps.log.warn('codex oversized strip did not finish before send; rebuilding', {
        sessionId,
        strip,
      });
    }
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
      reason: rebuildReason,
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
    claim(sessionId: string): OverflowClaimResult {
      if (inFlight.has(sessionId)) return 'in-flight';
      inFlight.add(sessionId);
      return 'claimed';
    },

    async tryRecover(sessionId: string, errorData: unknown): Promise<boolean> {
      try {
        if (deps.withSessionLock) {
          return await deps.withSessionLock(sessionId, () => runRecover(sessionId, errorData));
        }
        return await runRecover(sessionId, errorData);
      } catch (error) {
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
      inFlight.add(sessionId);
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
      inFlight.add(sessionId);
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
