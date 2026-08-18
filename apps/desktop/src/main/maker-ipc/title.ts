/**
 * registerMakerTitleIpc — maker:generate-title / maker:regenerate-title
 *
 * 给会话起一个 ≤ 20 字标题。标题 oneShot 已统一为「单次 HTTP 请求」:按本会话所属 provider
 * (WYSIWYG,与模型选择器高亮同口径:DB 显式选中优先,无则取已连接供应商的原生默认)
 * 取 catalog 配的 `titleModel`(最经济模型),用该 provider 自家凭证直起
 * (见 maker-host/title-one-shot)。无标题 wire 的会话供应商回落官方 `xd`。
 * 起不出来(零已连接 / 官方也不可用 / 凭证缺失 / HTTP 失败 / 超时)
 * → 返回 null,renderer 回落「消息前 40 字」启发式。fire-and-forget,
 * 不阻塞主流程,也不向用户暴露失败。
 *
 * regenerate-title:重命名输入框的 Magic 按钮入口——素材来自 main 直读 DB 的
 * 「对话开场 + 最近几轮消息」(与 sessionTaskSummary 同一套 /clear、rewind
 * 可见性口径):开场锚定会话主题,最近窗口反映当前进展,避免只看最后一轮时
 * 被"继续""好的"这类短追问带偏。预期失败用 IPC 错误码区分,由 renderer 场景化提示。
 */

import { ipcMain } from 'electron';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { eq } from 'drizzle-orm';

import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import { getResolvedMainLocale } from '../i18n.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import {
  generateTitleViaProvider,
  generateTitleViaProviderResult,
  type TitleOneShotResult,
} from '../maker-host/title-one-shot.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { createLogger } from '../logger.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { buildAutoTitlePrompt, buildRegenerateTitlePrompt } from './title-prompt.js';

import { MAKER_INVOKE } from './channels.js';
import {
  runSessionAutoTitle,
  type SessionAutoTitleRequest,
  type SessionAutoTitleResult,
} from './sessionAutoTitle.js';
import { generatePromptPrediction } from './promptPrediction.js';

const log = createLogger('maker-ipc/title');

/** 自动起名素材截断长度(UTF-16 code unit,`String.slice` 口径;仅约束 prompt 素材上限,不是用户可见的"字数")。 */
const AUTO_TITLE_MESSAGE_SLICE = 200;

/** regenerate 素材窗口:最近 N 条非空 user/assistant 消息(不含被过滤的工具行)。 */
const REGENERATE_RECENT_WINDOW = 8;
/** 开场用户消息截断长度(字符)。 */
const REGENERATE_OPENING_SLICE = 300;
/** 窗口内单条用户消息截断长度(字符)。 */
const REGENERATE_USER_SLICE = 300;
/** 窗口内单条助手消息截断长度(字符)。 */
const REGENERATE_ASSISTANT_SLICE = 400;

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
  agentKind: AgentKind,
  sessionId?: string,
): Promise<string | null> {
  // 空消息(如仅图片/附件的首条输入)不发标题请求:LLM 收到空素材会把
  // "请提供用户消息内容"式回复当标题返回。直接放弃,调用方保留默认名。
  const trimmed = message.trim();
  if (!trimmed) return null;
  return generateTitleViaProvider(
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

/** regenerate 的依赖注入面——单测用内存实现替换 DB / LLM 调用。 */
export interface RegenerateTitleDeps {
  /** 读会话 agentKind。会话不存在 → null(直接放弃)。 */
  readSessionAgentKind: (sessionId: string) => Promise<AgentKind | null>;
  /** 素材包:对话开场 + 最近 limit 条非空消息(与 sessionTaskSummary 同可见性口径)。 */
  collectMaterial: (
    sessionId: string,
    recentLimit: number,
    latestTurnIsInFlight: boolean | (() => boolean),
  ) => Promise<RegenerateTitleMaterial>;
  /** 用给定 prompt 走 title oneShot 通道。 */
  generateTitle: (
    sessionId: string,
    agentKind: AgentKind,
    prompt: string,
  ) => Promise<TitleOneShotResult>;
}

async function readSessionAgentKindFromDb(sessionId: string): Promise<AgentKind | null> {
  const [row] = await getDbClient()
    .drizzle.select({ agentKind: sessions.agentKind, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.status === 'deleted') return null;
  return dbToMakerAgentKind(row.agentKind);
}

const defaultRegenerateDeps: RegenerateTitleDeps = {
  readSessionAgentKind: readSessionAgentKindFromDb,
  collectMaterial: regenerateTitleMaterial,
  generateTitle: (sessionId, agentKind, prompt) =>
    generateTitleViaProviderResult(
      { sessionId, agentKind, prompt },
      {
        readSessionProviderId: readSessionProviderIdFromDb,
        listConnectedProviders: listConnectedProvidersForAgent,
      },
    ),
};

/**
 * 按会话「开场 + 最近对话」重新起标题(重命名输入框 Magic 按钮)。
 * 预期失败走统一 IPC 错误码，让本机与 device-link 控制端都能展示场景化提示。
 */
export async function regenerateMakerSessionTitle(
  sessionId: string,
  deps: RegenerateTitleDeps = defaultRegenerateDeps,
  latestTurnIsInFlight: boolean | (() => boolean) = false,
): Promise<string> {
  if (!sessionId) throwIpcError('INVALID_PARAMS', 'sessionId is required');
  try {
    const { recent, opening } = await deps.collectMaterial(
      sessionId,
      REGENERATE_RECENT_WINDOW,
      latestTurnIsInFlight,
    );
    const agentKind = await deps.readSessionAgentKind(sessionId);
    if (!agentKind) {
      log.info('regenerate session title skipped', {
        sessionId,
        reason: 'session-not-found',
      });
      throwIpcError('NOT_FOUND', 'Session not found');
    }
    // 空会话(草稿)没有素材,起不出有意义的标题
    if (recent.length === 0) {
      log.info('regenerate session title skipped', {
        sessionId,
        reason: 'no-material',
      });
      throwIpcError('TITLE_NO_MATERIAL', 'No text messages are available for AI naming');
    }
    // 最近窗口已经覆盖到会话开头时,开场消息就在 transcript 里,不再单独给出。
    // 用 rowid 成员判断做精确判定——时间戳启发式在同毫秒批量落库(开场行被
    // 同时间戳的后续行挤出窗口)或 createdAt 为 null 时都会误判,review 已两次指出。
    const openingInWindow = opening.rowid != null && recent.some((m) => m.rowid === opening.rowid);
    const openingText =
      !openingInWindow && opening.text ? opening.text.slice(0, REGENERATE_OPENING_SLICE) : null;
    const transcript = recent
      .map((m) =>
        m.role === 'user'
          ? `User: ${m.text.slice(0, REGENERATE_USER_SLICE)}`
          : `Assistant: ${m.text.slice(0, REGENERATE_ASSISTANT_SLICE)}`,
      )
      .join('\n');
    const generated = await deps.generateTitle(
      sessionId,
      agentKind,
      buildRegenerateTitlePrompt(openingText, transcript, getResolvedMainLocale()),
    );
    if (generated.status !== 'ok') {
      const context = { sessionId, agentKind, reason: generated.status };
      if (generated.status === 'unsupported-provider') {
        log.info('regenerate session title skipped', context);
        throwIpcError(
          'TITLE_PROVIDER_UNSUPPORTED',
          'The current provider does not support AI naming',
        );
      }
      log.warn('regenerate session title generation failed', context);
      throwIpcError('INTERNAL', 'AI title generation failed');
    }
    // Regenerate has a stricter product contract than the shared auto-title path:
    // one line, ≤20 Unicode characters, and no transcript/meta wrapper. The model is
    // not trusted to enforce this by prompt alone.
    const title = validateTitleOutput(generated.title, 20);
    if (!title) {
      log.warn('regenerate session title rejected model output', {
        sessionId,
        agentKind,
        reason: 'invalid-output',
      });
      throwIpcError('INTERNAL', 'AI title generation failed');
    }
    return title;
  } catch (err) {
    if (isIpcError(err)) throw err;
    log.warn('regenerate session title failed', {
      sessionId,
      error: String(err),
    });
    throwIpcError('INTERNAL', 'AI title generation failed');
  }
}

/** 起名素材上限:超出部分对标题毫无价值,只会放大 prompt 与落库开销。 */
const AUTO_TITLE_TEXT_MAX = 2000;
/** sessionId 长度上限(UUID / cuid 都远小于此)。 */
const SESSION_ID_MAX = 128;

const TITLE_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const satisfies readonly AgentKind[];

interface GenerateTitleRequest {
  message: string;
  agentKind: AgentKind;
  sessionId?: string;
}

interface RegenerateTitleRequest {
  sessionId: string;
}

function parseSessionId(raw: unknown, optional = false): string | undefined {
  if (optional && raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw || raw.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid sessionId');
  }
  return raw;
}

function parseAgentKind(raw: unknown): AgentKind {
  if (!TITLE_AGENT_KINDS.includes(raw as AgentKind)) {
    throwIpcError('INVALID_PARAMS', 'invalid agentKind');
  }
  return raw as AgentKind;
}

/**
 * `generate-title` / `regenerate-title` 可经 device-link allowlist 从受控设备调用。
 * 远程来源只信主进程 AsyncLocalStorage 上下文,不信 payload 自报；本机调用仍要求真实
 * Electron 顶层 Renderer sender。
 */
function assertTitleIpcCaller(event: Electron.IpcMainInvokeEvent): void {
  if (!isDeviceLinkInvoke()) {
    assertTrustedAppRendererEvent(event);
  }
}

function parseGenerateTitleRequest(raw: unknown): GenerateTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'generate-title request required');
  }
  const { message, agentKind, sessionId } = raw as Record<string, unknown>;
  if (typeof message !== 'string') {
    throwIpcError('INVALID_PARAMS', 'invalid message');
  }
  const parsedSessionId = parseSessionId(sessionId, true);
  return {
    message: message.slice(0, AUTO_TITLE_TEXT_MAX),
    agentKind: parseAgentKind(agentKind),
    ...(parsedSessionId === undefined ? {} : { sessionId: parsedSessionId }),
  };
}

function parseRegenerateTitleRequest(raw: unknown): RegenerateTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'regenerate-title request required');
  }
  return { sessionId: parseSessionId((raw as Record<string, unknown>).sessionId)! };
}

/**
 * 运行期校验 `maker:auto-title` 的 payload。结构、长度、枚举值不合法一律按
 * INVALID_PARAMS 拒绝,不让畸形值进到会改写标题 / 调用付费模型的副作用路径。
 */
function parseAutoTitleRequest(raw: unknown): SessionAutoTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auto-title request required');
  }
  const { sessionId, text, agentKind, isUserText } = raw as Record<string, unknown>;
  if (typeof text !== 'string') {
    throwIpcError('INVALID_PARAMS', 'invalid text');
  }
  if (isUserText !== undefined && typeof isUserText !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid isUserText');
  }
  return {
    sessionId: parseSessionId(sessionId)!,
    // 截断而非拒绝:超长正文是正常输入,标题只需要开头一小段。
    text: (text as string).slice(0, AUTO_TITLE_TEXT_MAX),
    agentKind: parseAgentKind(agentKind),
    ...(isUserText === undefined ? {} : { isUserText }),
  };
}

/** 预测素材窗口:从 DB 读最近几条 user/assistant 消息(与 promptPrediction 的最近 3 轮配对对齐)。 */
const PREDICTION_RECENT_MESSAGE_LIMIT = 6;

/** 预测请求:仅 sessionId + agentKind + turnGen。素材(messages / workingDir)一律由 main 从 DB 读取,
 * 不信任 renderer 上报内容——受信 renderer 或 stale UI 可能携带其它会话转写 / 伪造 workdir,
 * 把非本会话内容送到本地 provider 触发付费调用。turnGen 仅用于 renderer 端结果校验
 * (丢弃旧轮过期结果),主进程级去重改用 DB 的 session.updatedAt(跨窗口一致)。 */
interface PredictPromptRequest {
  sessionId: string;
  agentKind: AgentKind;
  turnGen: number;
}

/** 主进程级去重:同一 session 同一去重键同时只能有一笔预测在途,
 * 避免多窗口重复付费调用。使用 DB session.updatedAt + renderer turnGen 联合去重:
 * updatedAt 排队场景下相邻轮次可能相同,但 turnGen 逐轮递增,联合后可区分真重复与
 * 不同轮次。Map<sessionId, {updatedAt, turnGen}>——新轮会替换旧条目,不阻塞新轮预测。 */
const _predictingPromptSessions = new Map<string, { updatedAt: number; turnGen: number }>();

function parsePredictPromptRequest(raw: unknown): PredictPromptRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'predict-prompt request must be a non-null object');
  }
  const { sessionId, agentKind, turnGen } = raw as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid or missing sessionId for predict-prompt');
  }
  if (!TITLE_AGENT_KINDS.includes(agentKind as AgentKind)) {
    throwIpcError('INVALID_PARAMS', `invalid agentKind for predict-prompt: ${String(agentKind)}`);
  }
  if (typeof turnGen !== 'number' || !Number.isFinite(turnGen) || turnGen < 0) {
    throwIpcError('INVALID_PARAMS', `invalid or missing turnGen for predict-prompt: ${String(turnGen)}`);
  }
  return { sessionId, agentKind: agentKind as AgentKind, turnGen };
}

export interface RegisterMakerTitleIpcOptions {
  /** True from turn dispatch until terminal delivery, including status:false → done. */
  isSessionTurnPendingCompletion?: (sessionId: string) => boolean;
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
  // 做 sender 断言 + 运行期 payload 校验 + DB 防御纵深(远程会话拒绝)。
  // TODO: promptPrediction.ts 中新增的 system prompt 固定指令进入模型 system 段，
  // 按 docs/dev-rules/maker-core-and-agent-behavior.md §4 需在合并前取得维护者确认。
  // 跟踪: PR #1965 review thread #3791318742
  ipcMain.handle(
    MAKER_INVOKE.PREDICT_PROMPT,
    async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<{ prompt: string | null }> => {
      assertTrustedAppRendererEvent(event);
      const { sessionId, agentKind, turnGen } = parsePredictPromptRequest(request);
      try {
      // 防御纵深:即使 renderer 有 UI 守卫,main 侧也需从 DB 确认 session 真实存在且非远程
      // (SSH / device-link),避免受信 renderer 绕过 UI 守卫携带远程会话内容触发付费调用。
      // 同时拒绝 review session:reviewer 会话的 composer 被禁用(disabled),不可编辑也不可发送,
      // 对其做预测是浪费付费调用。也拒绝 soft-deleted session:删除态会话的消息仍保留在 DB,
      // 但已从用户会话列表移除,对其做预测会外发已删除转写并产生付费调用。
      const [sessionRow] = await getDbClient()
        .drizzle.select({ remoteHostId: sessions.remoteHostId, source: sessions.source, agentKind: sessions.agentKind, workingDir: sessions.workingDir, status: sessions.status, updatedAt: sessions.updatedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      if (!sessionRow || sessionRow.remoteHostId || sessionRow.source === 'review' || sessionRow.status === 'deleted') {
        return { prompt: null };
      }
      // 防御纵深:校验 renderer 上报的 agentKind 与 DB 记录一致,避免受信 renderer 绕过
      // UI 守卫或 stale UI 状态将 Claude session 的对话内容发送给 Codex provider(反之亦然)。
      const dbAgentKind = dbToMakerAgentKind(sessionRow.agentKind);
      if (dbAgentKind !== agentKind) {
        log.warn('predict-prompt agentKind mismatch — rejecting', {
          sessionId,
          rendererAgentKind: agentKind,
          dbAgentKind,
        });
        return { prompt: null };
      }
      // 多窗口去重:同一 session 同一 DB 轮次只能有一笔预测在途。
      // updatedAt 是 DB 权威轮次标识:相同时拒绝(同一真实轮次,跨窗口 turnGen 不同
      // 也不放行,避免重复付费调用);不同时替换旧条目放行(新轮已开始)。
      // 注意:排队发送场景下相邻轮次可能共享 updatedAt(入队消息提前推进),此时后一轮
      // 预测会被拒绝。这是可接受的 tradeoff:避免重复付费调用优先于排队轮次的即时预测。
      if (_predictingPromptSessions.has(sessionId)) {
        const existing = _predictingPromptSessions.get(sessionId)!;
        if (existing.updatedAt === sessionRow.updatedAt) {
          return { prompt: null };
        }
        // 旧轮预测仍在途但新轮已开始,旧结果注定被 renderer 丢弃,放行新请求。
        log.debug('predict-prompt replacing stale in-flight prediction', {
          sessionId,
          oldUpdatedAt: existing.updatedAt,
          newUpdatedAt: sessionRow.updatedAt,
        });
      }
      _predictingPromptSessions.set(sessionId, { updatedAt: sessionRow.updatedAt, turnGen });
      try {
        // 素材只从 DB 读取,不信任 renderer 上报的 messages / workingDir:受信 renderer 或
        // stale UI 可能携带其它会话转写或伪造 workdir,把非本会话内容送到本地 provider 触发
        // 付费调用。先排空落盘队列,确保刚结束 turn 的最终回复已持久化,再读最近消息。
        // 与 REGENERATE_TITLE 对齐:在 drain 前后各拍一次 isSessionTurnPendingCompletion,
        // 捕获 drain 期间封存的终末消息——避免在 terminal delivery 短窗口内把施工中的
        // Assistant 行当作完整回复,预测基于不完整上下文落地后 renderer 不会再重试。
        const pendingCompletionBeforeDrain =
          options.isSessionTurnPendingCompletion?.(sessionId) === true;
        await drainPersistQueue();
        let pendingCompletionObserved = pendingCompletionBeforeDrain;
        const latestTurnIsPendingCompletion = (): boolean => {
          if (!pendingCompletionObserved) {
            pendingCompletionObserved =
              options.isSessionTurnPendingCompletion?.(sessionId) === true;
          }
          return pendingCompletionObserved;
        };
        latestTurnIsPendingCompletion();
        // drainPersistQueue 等待期间 session 可能被软删除或转为远程/review，
        // 或用户发起新 turn（session.updatedAt 变化）。上方基于 status / source /
        // remoteHostId 的防御纵深检查会过期（TOCTOU）。此处再从 DB 读取同一行
        // 的资格字段，并比对 updatedAt：若 session 在 drain 期间被修改（新 turn
        // 启动），中止预测，避免用旧上下文发起付费调用。
        const [latestSessionRow] = await getDbClient()
          .drizzle.select({
            remoteHostId: sessions.remoteHostId,
            source: sessions.source,
            status: sessions.status,
            agentKind: sessions.agentKind,
            workingDir: sessions.workingDir,
            updatedAt: sessions.updatedAt,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        if (
          !latestSessionRow ||
          latestSessionRow.remoteHostId ||
          latestSessionRow.source === 'review' ||
          latestSessionRow.status === 'deleted'
        ) {
          return { prompt: null };
        }
        // drain 期间 session 被修改（新 turn 启动 / 消息落盘等），中止预测。
        if (latestSessionRow.updatedAt !== sessionRow.updatedAt) {
          log.debug('predict-prompt session updated during drain — rejecting', {
            sessionId,
          });
          return { prompt: null };
        }
        // drain 期间 session 可能被切换 agent(sessionAgentSwitchHandler 会提交 agentKind 变更):
        // 上方 drain 前的 agentKind 校验已过期,这里用 drain 后的 DB agentKind 复核,与 renderer
        // 上报不一致时拒绝,避免把转写路由到切换前的 provider/账号触发付费调用。
        const latestDbAgentKind = dbToMakerAgentKind(latestSessionRow.agentKind);
        if (latestDbAgentKind !== agentKind) {
          log.warn('predict-prompt agentKind changed after drain — rejecting', {
            sessionId,
            rendererAgentKind: agentKind,
            dbAgentKind: latestDbAgentKind,
          });
          return { prompt: null };
        }
        const material = await regenerateTitleMaterial(
          sessionId,
          PREDICTION_RECENT_MESSAGE_LIMIT,
          latestTurnIsPendingCompletion,
        );
        const messages = material.recent.map((m) => ({ role: m.role, content: m.text }));
        return {
          prompt: await generatePromptPrediction({
            sessionId,
            agentKind,
            messages,
            ...(latestSessionRow.workingDir ? { workingDir: latestSessionRow.workingDir } : {}),
            materialDrainUpdatedAt: latestSessionRow.updatedAt,
          }),
        };
      } finally {
        // 同 session 的预测在上一笔在途时会被拒绝,正常情况下条目始终为请求时刻的
        // updatedAt + turnGen。此处保留相等性校验作为防御性编程。
        const current = _predictingPromptSessions.get(sessionId);
        if (current && current.updatedAt === sessionRow.updatedAt && current.turnGen === turnGen) {
          _predictingPromptSessions.delete(sessionId);
        }
      }
      } catch (error: unknown) {
        // 将数据库不可用、查询失败等意外错误编码为 IPC error，避免 Electron
        // 将原始 Drizzle/SQLite 异常序列化到 Renderer 侧泄露内部细节。
        if (isIpcError(error)) throw error;
        log.error('predict-prompt handler failed', { sessionId, error });
        throwIpcError('INTERNAL', 'Prompt prediction failed');
      }
    },
  );
}
