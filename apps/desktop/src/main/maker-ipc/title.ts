/**
 * registerMakerTitleIpc — maker:generate-title / maker:regenerate-title
 *
 * 给会话起一个 ≤ 20 字标题。标题 oneShot 已统一为「单次 HTTP 请求」:按本会话所属 provider
 * (WYSIWYG,与模型选择器高亮同口径:DB 显式选中优先,无则取已连接供应商的原生默认)
 * 取 catalog 配的 `titleModel`(最经济模型),用该 provider 自家凭证直起
 * (见 maker-host/provider-one-shot)。起不出来(零已连接 / 凭证缺失 / HTTP 失败 / 超时)
 * → 返回 null,renderer 回落「消息前 40 字」启发式。fire-and-forget,
 * 不阻塞主流程,也不向用户暴露失败。
 *
 * regenerate-title:重命名输入框的 Magic 按钮入口——素材来自 main 直读 DB 的
 * 「对话开场 + 最近几轮消息」(与 sessionTaskSummary 同一套 /clear、rewind
 * 可见性口径):开场锚定会话主题,最近窗口反映当前进展,避免只看最后一轮时
 * 被"继续""好的"这类短追问带偏。失败统一返 null,由 renderer 提示。
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
import { runProviderOneShot } from '../maker-host/provider-one-shot.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { createLogger } from '../logger.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { buildAutoTitlePrompt, buildRegenerateTitlePrompt } from './title-prompt.js';

import { MAKER_INVOKE } from './channels.js';
import {
  runSessionAutoTitle,
  type SessionAutoTitleRequest,
  type SessionAutoTitleResult,
} from './sessionAutoTitle.js';
import {
  generatePromptPrediction,
  type PromptPredictionParams,
} from './promptPrediction.js';

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
  return runProviderOneShot(
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
  ) => Promise<string | null>;
}

async function readSessionAgentKindFromDb(sessionId: string): Promise<AgentKind | null> {
  const [row] = await getDbClient()
    .drizzle.select({ agentKind: sessions.agentKind })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  return dbToMakerAgentKind(row.agentKind);
}

const defaultRegenerateDeps: RegenerateTitleDeps = {
  readSessionAgentKind: readSessionAgentKindFromDb,
  collectMaterial: regenerateTitleMaterial,
  generateTitle: (sessionId, agentKind, prompt) =>
    runProviderOneShot(
      { sessionId, agentKind, prompt },
      {
        readSessionProviderId: readSessionProviderIdFromDb,
        listConnectedProviders: listConnectedProvidersForAgent,
      },
    ),
};

/**
 * 按会话「开场 + 最近对话」重新起标题(重命名输入框 Magic 按钮)。
 * 会话不存在 / 没有任何对话素材 / 生成失败统一返回 null,不抛——renderer 据 null 提示重试。
 */
export async function regenerateMakerSessionTitle(
  sessionId: string,
  deps: RegenerateTitleDeps = defaultRegenerateDeps,
  latestTurnIsInFlight: boolean | (() => boolean) = false,
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const { recent, opening } = await deps.collectMaterial(
      sessionId,
      REGENERATE_RECENT_WINDOW,
      latestTurnIsInFlight,
    );
    // 空会话(草稿)没有素材,起不出有意义的标题
    if (recent.length === 0) return null;
    const agentKind = await deps.readSessionAgentKind(sessionId);
    if (!agentKind) return null;
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
    // Regenerate has a stricter product contract than the shared auto-title path:
    // one line, ≤20 Unicode characters, and no transcript/meta wrapper. The model is
    // not trusted to enforce this by prompt alone.
    return validateTitleOutput(generated, 20);
  } catch (err) {
    log.warn('regenerate session title failed (swallowed)', {
      sessionId,
      error: String(err),
    });
    return null;
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
/** 推荐提示词素材上限(消息条数)。 */
const PREDICTION_MESSAGES_MAX = 40;
/** 推荐提示词单条消息截断长度(UTF-16 code unit)。 */
const PREDICTION_MSG_SLICE = 600;
/** 推荐提示词 workingDir 截断长度。 */
const PREDICTION_WORKDIR_MAX = 512;

function parsePredictPromptRequest(raw: unknown): PromptPredictionParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('predict-prompt request required');
  }
  const { sessionId, agentKind, messages, workingDir } = raw as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_ID_MAX) {
    throw new Error('invalid sessionId');
  }
  if (!TITLE_AGENT_KINDS.includes(agentKind as AgentKind)) {
    throw new Error('invalid agentKind');
  }
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }
  const sliced = messages.slice(-PREDICTION_MESSAGES_MAX).map((m: unknown) => {
    if (typeof m !== 'object' || m === null) {
      throwIpcError('INVALID_PARAMS', 'messages entry must be an object');
    }
    const msg = m as Record<string, unknown>;
    return {
      role: typeof msg.role === 'string' ? msg.role : '',
      content: typeof msg.content === 'string' ? msg.content.slice(0, PREDICTION_MSG_SLICE) : '',
    };
  });
  return {
    sessionId,
    agentKind: agentKind as AgentKind,
    messages: sliced,
    ...(typeof workingDir === 'string' && workingDir.length <= PREDICTION_WORKDIR_MAX
      ? { workingDir }
      : {}),
  };
}
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
  // 做 sender 断言 + 运行期 payload 校验。
  ipcMain.handle(
    MAKER_INVOKE.PREDICT_PROMPT,
    async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<{ prompt: string | null }> => {
      assertTrustedAppRendererEvent(event);
      const params = parsePredictPromptRequest(request);
      return { prompt: await generatePromptPrediction(params) };
    },
  );
}
