/**
 * registerMakerTitleIpc — maker:generate-title / maker:regenerate-title
 *
 * 给会话起一个 ≤ 40 字符标题。自动起名与 Magic 重命名都走辅助模型链
 * (`generateTitleWithAuxiliaryModel`)，不再按当前任务供应商目录捡最便宜的
 * `titleModel`。起不出来(链上模型都不可用 / 凭证缺失 / HTTP 失败 / 超时)
 * → 返回 null,renderer 回落「消息前 40 字」启发式。fire-and-forget,
 * 不阻塞主流程,也不向用户暴露失败。
 *
 * regenerate-title:重命名输入框的 Magic 按钮入口——素材来自 main 直读 DB 的
 * 「对话开场 + 最近几轮消息」(与 sessionTaskSummary 同一套 /clear、rewind
 * 可见性口径):开场锚定会话主题,最近窗口反映当前进展,避免只看最后一轮时
 * 被"继续""好的"这类短追问带偏。预期失败用 IPC 错误码区分,由 renderer 场景化提示。
 */

import { ipcMain } from 'electron';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { eq } from 'drizzle-orm';

import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import { getResolvedMainLocale } from '../i18n.desktop.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import {
  generateTitleWithAuxiliaryModel,
  generateTitleWithAuxiliaryModelResult,
} from '../maker-host/auxiliary-title-one-shot.js';
import { regenerateTitleMaterial } from '../localDb/latestMessageText.js';
import { createLogger } from '../logger.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.desktop.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { buildAutoTitlePrompt } from './title-prompt.js';
import {
  AUTO_TITLE_MESSAGE_SLICE,
  TITLE_AGENT_KINDS,
  parseAutoTitleRequest,
  parseGenerateTitleRequest,
  parseRegenerateTitleRequest,
  readSessionAgentKindFromDb,
  regenerateMakerSessionTitleCore,
  type RegenerateTitleDeps,
} from './titleCore.js';

import { MAKER_INVOKE } from './channels.js';
import {
  runSessionAutoTitle,
  type SessionAutoTitleRequest,
  type SessionAutoTitleResult,
} from './sessionAutoTitle.js';
import { generatePromptPrediction } from './promptPrediction.js';
import {
  notePromptPredictionSessionCancelled,
  wasPromptPredictionSessionCancelled,
  wasPromptPredictionSessionStopped,
} from './promptPredictionStopLedger.js';

const log = createLogger('maker-ipc/title');

/**
 * Magic 重命名的 prompt:素材是「对话开场(第一条用户消息)+ 最近几轮 transcript」,
 * 标题语言跟随界面设置。开场只在最近窗口没覆盖到会话开头时单独给出(短会话不重复);
 * transcript 按时间正序,模型能自然看出最后一条是否只是"继续"式短追问,另用一句
 * 指令兜底,避免标题被短追问带偏。
 */
/** 从 DB 读 sessions.provider_id(race-free 显式来源)。失败/空串 → null。 */
async function readSessionProviderIdFromDb(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const [row] = await getDbClient()
      .drizzle.select({ providerId: sessions.providerId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row?.providerId ?? null;
  } catch {
    return null;
  }
}

/** 某 agent 下已连接的供应商视图列表(实时连接态)。失败 → []。 */
async function listConnectedProvidersForAgent(agentKind: AgentKind): Promise<ProviderView[]> {
  try {
    const all = await getDesktopProviderService().listProviders({ allowSideEffects: true });
    return connectedProvidersForAgent(all, agentKind);
  } catch {
    return [];
  }
}

/**
 * 给某会话起标题。`sessionId` 用于读 DB 显式来源(race-free);空串 = 走 WYSIWYG 默认。
 * 失败统一返回 null(调用方回落启发式),不抛。
 */
export async function generateMakerSessionTitle(
  message: string,
  /** null = plugin-engine task: auxiliary model only. */
  agentKind: AgentKind | null,
  sessionId?: string,
): Promise<string | null> {
  // 空消息(如仅图片/附件的首条输入)不发标题请求:LLM 收到空素材会把
  // "请提供用户消息内容"式回复当标题返回。直接放弃,调用方保留默认名。
  const trimmed = message.trim();
  if (!trimmed) return null;
  return generateTitleWithAuxiliaryModel(
    {
      sessionId: sessionId ?? '',
      agentKind,
      prompt: buildAutoTitlePrompt(
        trimmed.slice(0, AUTO_TITLE_MESSAGE_SLICE),
        getResolvedMainLocale(),
      ),
    },
    {
      readSessionProviderId: readSessionProviderIdFromDb,
      listConnectedProviders: listConnectedProvidersForAgent,
    },
  );
}

export type { RegenerateTitleDeps };

const defaultRegenerateDeps: RegenerateTitleDeps = {
  readSessionAgentKind: readSessionAgentKindFromDb,
  collectMaterial: (sessionId, recentLimit, latestTurnIsInFlight) =>
    regenerateTitleMaterial(sessionId, recentLimit, latestTurnIsInFlight, {
      preferHookUserText: true,
    }),
  generateTitle: (sessionId, agentKind, prompt) =>
    generateTitleWithAuxiliaryModelResult(
      { sessionId, agentKind, prompt },
      {
        readSessionProviderId: readSessionProviderIdFromDb,
        listConnectedProviders: listConnectedProvidersForAgent,
      },
    ),
};

export function regenerateMakerSessionTitle(
  sessionId: string,
  deps: RegenerateTitleDeps = defaultRegenerateDeps,
  latestTurnIsInFlight: boolean | (() => boolean) = false,
): Promise<string> {
  return regenerateMakerSessionTitleCore(sessionId, deps, latestTurnIsInFlight, getResolvedMainLocale);
}

const SESSION_ID_MAX = 128;

function parseSessionId(raw: unknown, optional = false): string | undefined {
  if (optional && raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw || raw.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid sessionId');
  }
  return raw;
}

function assertTitleIpcCaller(event: Electron.IpcMainInvokeEvent): void {
  if (!isDeviceLinkInvoke()) {
    assertTrustedAppRendererEvent(event);
  }
}

/** 预测素材窗口:从 DB 读最近几条 user/assistant 消息(与 promptPrediction 的最近 3 轮配对对齐)。 */
const PREDICTION_RECENT_MESSAGE_LIMIT = 6;

/** 预测请求:素材(messages / workingDir)一律由 main 从 DB 读取，不信任 renderer 上报内容。
 * completionRevision 来自本次运行期真实收到的 lastTurnEndedAt push，main 再与 DB 权威值
 * 复核并作为跨窗口幂等键；turnGen 仅保留 renderer 侧请求代次。 */
/** 'acp' = 插件引擎任务：推荐与标题一样只用辅助模型链，不经任何引擎。 */
type PredictionAgentKind = AgentKind | 'acp';
const predictionAgentKindOf = (dbKind: typeof sessions.agentKind._.data): PredictionAgentKind =>
  dbKind === 'acp' ? 'acp' : dbToMakerAgentKind(dbKind);

interface PredictPromptRequest {
  sessionId: string;
  agentKind: PredictionAgentKind;
  turnGen: number;
  completionRevision: number;
  cacheOnly?: boolean;
  cancel?: false;
}
type CancelPromptRequest = { sessionId: string; completionRevision: number; cancel: true };

interface PromptPredictionCacheEntry {
  revision: number;
  ownerScope: ReturnType<typeof activeOwnerScopeKey>;
  agentKind: PredictionAgentKind;
  workingDir: string | null;
  promise: Promise<string | null>;
}

/** 每个 session 只保留最新完成轮的一笔 Promise/结果，进程重启自然清空。 */
const _promptPredictionCache = new Map<string, PromptPredictionCacheEntry>();

function parsePredictPromptRequest(raw: unknown): PredictPromptRequest | CancelPromptRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'predict-prompt request must be a non-null object');
  }
  const { sessionId, agentKind, turnGen, completionRevision, cacheOnly, cancel } = raw as Record<string, unknown>;
  if (cacheOnly !== undefined && typeof cacheOnly !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'cacheOnly must be a boolean');
  }
  if (cancel !== undefined && typeof cancel !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'cancel must be a boolean');
  }
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid or missing sessionId for predict-prompt');
  }
  if (cancel === true) {
    if (typeof completionRevision !== 'number' || !Number.isSafeInteger(completionRevision) || completionRevision <= 0) {
      throwIpcError('INVALID_PARAMS', 'invalid completionRevision for cancellation');
    }
    return { sessionId, completionRevision, cancel: true };
  }
  if (agentKind !== 'acp' && !TITLE_AGENT_KINDS.includes(agentKind as AgentKind)) {
    throwIpcError('INVALID_PARAMS', `invalid agentKind for predict-prompt: ${String(agentKind)}`);
  }
  if (typeof turnGen !== 'number' || !Number.isFinite(turnGen) || turnGen < 0) {
    throwIpcError(
      'INVALID_PARAMS',
      `invalid or missing turnGen for predict-prompt: ${String(turnGen)}`,
    );
  }
  if (
    typeof completionRevision !== 'number' ||
    !Number.isFinite(completionRevision) ||
    !Number.isInteger(completionRevision) ||
    completionRevision <= 0
  ) {
    throwIpcError(
      'INVALID_PARAMS',
      `invalid or missing completionRevision for predict-prompt: ${String(completionRevision)}`,
    );
  }
  return {
    sessionId,
    agentKind: agentKind as PredictionAgentKind,
    turnGen,
    completionRevision,
    cacheOnly,
    cancel: false,
  };
}

/** Test-only reset: settled Promise 会跨 register 调用保留，单测需显式清理。 */
export function _resetPromptPredictionCacheForTests(): void {
  _promptPredictionCache.clear();
}

export interface RegisterMakerTitleIpcOptions {
  /** True from turn dispatch until terminal delivery, including status:false → done. */
  isSessionTurnPendingCompletion?: (sessionId: string) => boolean;
}

/** A status:false patch can precede terminal delivery; this is not an empty prediction. */
class PromptPredictionPendingError extends Error {}

async function readPromptPredictionSession(sessionId: string) {
  const [row] = await getDbClient()
    .drizzle.select({
      remoteHostId: sessions.remoteHostId,
      source: sessions.source,
      agentKind: sessions.agentKind,
      workingDir: sessions.workingDir,
      status: sessions.status,
      updatedAt: sessions.updatedAt,
      activeTurnStartedAt: sessions.activeTurnStartedAt,
      lastTurnEndedAt: sessions.lastTurnEndedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row;
}

async function predictPromptForCompletedRevision(
  request: PredictPromptRequest,
  options: RegisterMakerTitleIpcOptions,
): Promise<string | null> {
  const { sessionId, agentKind, completionRevision } = request;
  const ownerScope = activeOwnerScopeKey();
  if (wasPromptPredictionSessionCancelled(sessionId, completionRevision, ownerScope)) return null;
  // 防御纵深：身份、来源、完成轮次都以 DB 为准。activeTurnStartedAt 不早于完成
  // revision 表示下一轮已经启动（含同毫秒），即使命中缓存也不能返回上一轮推荐。
  const sessionRow = await readPromptPredictionSession(sessionId);
  if (
    !sessionRow ||
    sessionRow.remoteHostId ||
    sessionRow.source === 'review' ||
    sessionRow.status === 'deleted' ||
    sessionRow.lastTurnEndedAt !== completionRevision ||
    (sessionRow.activeTurnStartedAt != null &&
      sessionRow.activeTurnStartedAt >= completionRevision) ||
    wasPromptPredictionSessionStopped(sessionId) ||
    activeOwnerScopeKey() !== ownerScope
  ) {
    return null;
  }
  if (options.isSessionTurnPendingCompletion?.(sessionId)) throw new PromptPredictionPendingError();

  const dbAgentKind = predictionAgentKindOf(sessionRow.agentKind);
  if (dbAgentKind !== agentKind) {
    log.warn('predict-prompt agentKind mismatch — rejecting', {
      sessionId,
      rendererAgentKind: agentKind,
      dbAgentKind,
    });
    return null;
  }

  const cached = _promptPredictionCache.get(sessionId);
  if (wasPromptPredictionSessionCancelled(sessionId, completionRevision, ownerScope)) return null;

  // Generation and retries can wait across a new turn. Only B's current state
  // can authorize returning the result, including callers joining an old Promise.
  const validateResult = async (promise: Promise<string | null>): Promise<string | null> => {
    const prompt = await promise;
    if (!prompt || activeOwnerScopeKey() !== ownerScope) return null;
    const latest = await readPromptPredictionSession(sessionId);
    if (!latest || activeOwnerScopeKey() !== ownerScope || latest.remoteHostId ||
        latest.source === 'review' || latest.status === 'deleted' ||
        latest.lastTurnEndedAt !== completionRevision ||
        (latest.activeTurnStartedAt != null && latest.activeTurnStartedAt >= completionRevision) ||
        predictionAgentKindOf(latest.agentKind) !== agentKind ||
        (latest.workingDir ?? null) !== (sessionRow.workingDir ?? null) ||
        wasPromptPredictionSessionStopped(sessionId) ||
        wasPromptPredictionSessionCancelled(sessionId, completionRevision, ownerScope)) return null;
    if (options.isSessionTurnPendingCompletion?.(sessionId)) throw new PromptPredictionPendingError();
    return prompt;
  };
  if (cached?.revision === completionRevision && cached.ownerScope === ownerScope) {
    // workingDir 会进入模型 prompt；同轮改过目录后不能复用旧目录上下文的结果。
    if (cached.workingDir !== (sessionRow.workingDir ?? null) || cached.agentKind !== agentKind) return null;
    return validateResult(cached.promise);
  }
  // Opening a completed remote task may reuse a live host prediction, but must
  // not turn historical navigation into a new paid model request.
  if (request.cacheOnly) return null;
  if (cached?.ownerScope === ownerScope && cached.revision > completionRevision) {
    return null;
  }
  if (cached) {
    log.debug('predict-prompt replacing cached older completion', {
      sessionId,
      oldRevision: cached.revision,
      newRevision: completionRevision,
    });
  }

  const predictionPromise = (async () => {
    // 先排空落盘队列，确保完成轮的终末 Assistant 已 durable；等待两侧都复查
    // pending completion，避免下一轮已启动却把上一轮缓存成当前推荐。
    const pendingCompletionBeforeDrain =
      options.isSessionTurnPendingCompletion?.(sessionId) === true;
    await drainPersistQueue();
    let pendingCompletionObserved = pendingCompletionBeforeDrain;
    const latestTurnIsPendingCompletion = (): boolean => {
      if (!pendingCompletionObserved) {
        pendingCompletionObserved = options.isSessionTurnPendingCompletion?.(sessionId) === true;
      }
      return pendingCompletionObserved;
    };
    if (activeOwnerScopeKey() !== ownerScope) return null;
    if (latestTurnIsPendingCompletion()) throw new PromptPredictionPendingError();

    const latestSessionRow = await readPromptPredictionSession(sessionId);
    if (
      !latestSessionRow ||
      latestSessionRow.remoteHostId ||
      latestSessionRow.source === 'review' ||
      latestSessionRow.status === 'deleted' ||
      latestSessionRow.lastTurnEndedAt !== completionRevision ||
      (latestSessionRow.activeTurnStartedAt != null &&
        latestSessionRow.activeTurnStartedAt >= completionRevision) ||
      wasPromptPredictionSessionStopped(sessionId) ||
      activeOwnerScopeKey() !== ownerScope
    ) {
      return null;
    }
    if (latestSessionRow.updatedAt !== sessionRow.updatedAt) {
      log.debug('predict-prompt session updated during drain — rejecting', { sessionId });
      return null;
    }
    const latestDbAgentKind = predictionAgentKindOf(latestSessionRow.agentKind);
    if (latestDbAgentKind !== agentKind) {
      log.warn('predict-prompt agentKind changed after drain — rejecting', {
        sessionId,
        rendererAgentKind: agentKind,
        dbAgentKind: latestDbAgentKind,
      });
      return null;
    }

    const material = await regenerateTitleMaterial(
      sessionId,
      PREDICTION_RECENT_MESSAGE_LIMIT,
      latestTurnIsPendingCompletion,
    );
    if (activeOwnerScopeKey() !== ownerScope) return null;
    if (latestTurnIsPendingCompletion()) throw new PromptPredictionPendingError();
    const messages = material.recent.map((message) => ({
      role: message.role,
      content: message.text,
    }));
    return generatePromptPrediction({
      sessionId,
      agentKind,
      messages,
      ...(latestSessionRow.workingDir ? { workingDir: latestSessionRow.workingDir } : {}),
      materialDrainUpdatedAt: latestSessionRow.updatedAt,
      completionRevision,
    });
  })().catch((error: unknown) => {
    const current = _promptPredictionCache.get(sessionId);
    if (current?.promise === predictionPromise) {
      _promptPredictionCache.delete(sessionId);
    }
    throw error;
  });

  _promptPredictionCache.set(sessionId, {
    revision: completionRevision,
    ownerScope,
    agentKind,
    workingDir: sessionRow.workingDir ?? null,
    promise: predictionPromise,
  });
  return validateResult(predictionPromise);
}

export function registerMakerTitleIpc(options: RegisterMakerTitleIpcOptions = {}): void {
  // 这两条通道读供应商快照时会放行本机绑定自愈(写绑定文件、并为 Anthropic 起一次带凭证的
  // 清单发现),因此本机调用必须守住真实 Renderer sender。它们同时是 device-link allowlist
  // 的既有远程能力:远程身份由 dispatch 的开关 / 撤销 / allowlist 三道 gate + invoke async
  // context 证明；合成 event 没有 Electron sender,不能再重复套本机 sender 判据。
  ipcMain.handle(
    MAKER_INVOKE.GENERATE_TITLE,
    async (
      event: Electron.IpcMainInvokeEvent,
      rawRequest: unknown,
    ): Promise<{ title: string | null }> => {
      assertTitleIpcCaller(event);
      const { message, agentKind, sessionId } = parseGenerateTitleRequest(rawRequest);
      return { title: await generateMakerSessionTitle(message, agentKind, sessionId) };
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.REGENERATE_TITLE,
    async (
      event: Electron.IpcMainInvokeEvent,
      rawRequest: unknown,
    ): Promise<{ title: string | null }> => {
      assertTitleIpcCaller(event);
      const { sessionId } = parseRegenerateTitleRequest(rawRequest);
      // Snapshot on both sides of the durable FIFO. The pre-drain value preserves
      // a pending terminal boundary that settles while we wait; the post-drain
      // value catches a new turn that starts during the same window. OR keeps
      // either unsealed Assistant out of the DB material read.
      const pendingCompletionBeforeDrain =
        options.isSessionTurnPendingCompletion?.(sessionId) === true;
      await drainPersistQueue();
      let pendingCompletionObserved = pendingCompletionBeforeDrain;
      const latestTurnIsPendingCompletion = (): boolean => {
        if (!pendingCompletionObserved) {
          pendingCompletionObserved = options.isSessionTurnPendingCompletion?.(sessionId) === true;
        }
        return pendingCompletionObserved;
      };
      latestTurnIsPendingCompletion();
      return {
        title: await regenerateMakerSessionTitle(
          sessionId,
          defaultRegenerateDeps,
          latestTurnIsPendingCompletion,
        ),
      };
    },
  );
  // 自动起名:renderer 只负责给素材,占位/条件写/归属表全在 main(单一真相源)。
  // 本 handler 会改写会话标题并可能触发一次付费模型调用,属于新增特权入口 ——
  // 按 electron-security-and-process-boundaries §5 做 sender 断言 + 运行期 payload
  // 校验,不把 Renderer 传来的 sessionId / text 视为已授权(TS 类型不是运行期校验)。
  ipcMain.handle(
    MAKER_INVOKE.AUTO_TITLE,
    async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<SessionAutoTitleResult> => {
      assertTrustedAppRendererEvent(event);
      return runSessionAutoTitle(parseAutoTitleRequest(request));
    },
  );
  // 输入框推荐提示词:turn 结束后预测用户下一步输入,复用 title one-shot 基础设施。
  // 本 handler 会触发一次付费模型调用,按 electron-security-and-process-boundaries §5
  // 本机校验 sender，远程校验 dispatch 持有的身份上下文；素材与完成轮次仍由 DB 复核。
  // TODO: promptPrediction.ts 中新增的 system prompt 固定指令进入模型 system 段，
  // 按 docs/dev-rules/maker-core-and-agent-behavior.md §4 需在合并前取得维护者确认。
  // 跟踪: PR #1965 review thread #3791318742
  ipcMain.handle(
    MAKER_INVOKE.PREDICT_PROMPT,
    async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<{ prompt: string | null; retryable?: boolean }> => {
      assertTitleIpcCaller(event);
      const parsed = parsePredictPromptRequest(request);
      try {
        if (parsed.cancel) {
          notePromptPredictionSessionCancelled(parsed.sessionId, parsed.completionRevision, activeOwnerScopeKey());
          return { prompt: null };
        }
        return {
          prompt: await predictPromptForCompletedRevision(parsed, options),
        };
      } catch (error: unknown) {
        if (error instanceof PromptPredictionPendingError) return { prompt: null, retryable: true };
        // 将数据库不可用、查询失败等意外错误编码为 IPC error，避免 Electron
        // 将原始 Drizzle/SQLite 异常序列化到 Renderer 侧泄露内部细节。
        if (isIpcError(error)) throw error;
        log.error('predict-prompt handler failed', { sessionId: parsed.sessionId, error });
        throwIpcError('INTERNAL', 'Prompt prediction failed');
      }
    },
  );
}
