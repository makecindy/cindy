/**
 * registerMakerTitleIpc — maker:generate-title / maker:regenerate-title
 *
 * 给会话起一个 ≤ 20 字标题。标题 oneShot 已统一为「单次 HTTP 请求」:按本会话所属 provider
 * (WYSIWYG,与模型选择器高亮同口径:DB 显式选中优先,无则取已连接供应商的原生默认)
 * 取 catalog 配的 `titleModel`(最经济模型),用该 provider 自家凭证直起
 * (见 maker-host/title-one-shot)。起不出来(零已连接 / 凭证缺失 / HTTP 失败 / 超时)
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

import type { SupportedLocale } from '../../shared/locale.js';
import { getResolvedMainLocale } from '../i18n.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { generateTitleViaProvider } from '../maker-host/title-one-shot.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';

import { MAKER_INVOKE } from './channels.js';
import {
  runSessionAutoTitle,
  type SessionAutoTitleRequest,
  type SessionAutoTitleResult,
} from './sessionAutoTitle.js';

const log = createLogger('maker-ipc/title');

const TITLE_LANGUAGE_BY_LOCALE: Record<SupportedLocale, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
};

const TITLE_PROMPT_TEMPLATE = (msg: string, locale: SupportedLocale) =>
  [
    'Generate a concise title for the user message below.',
    `Write the title in ${TITLE_LANGUAGE_BY_LOCALE[locale]}.`,
    'Use at most 20 characters. Output only the title, without quotation marks or ending punctuation.',
    '',
    msg.slice(0, 200),
  ].join('\n');

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
const REGENERATE_TITLE_PROMPT = (
  opening: string | null,
  transcript: string,
  locale: SupportedLocale,
) =>
  [
    'Generate a concise title for the conversation below.',
    `Write the title in ${TITLE_LANGUAGE_BY_LOCALE[locale]}.`,
    'Use at most 20 characters. Output only the title, without quotation marks or ending punctuation.',
    'Summarize the core topic of the whole conversation while reflecting the latest progress. If the final user message is only a brief confirmation such as "continue" or "okay", do not base the title on it.',
    '',
    ...(opening ? [`Conversation opening: ${opening}`, ''] : []),
    'Recent conversation:',
    transcript,
  ].join('\n');

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
      prompt: TITLE_PROMPT_TEMPLATE(trimmed, getResolvedMainLocale()),
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
  collectMaterial: (sessionId: string, recentLimit: number) => Promise<RegenerateTitleMaterial>;
  /** 用给定 prompt 走 title oneShot 通道。 */
  generateTitle: (sessionId: string, agentKind: AgentKind, prompt: string) => Promise<string | null>;
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
    generateTitleViaProvider(
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
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const agentKind = await deps.readSessionAgentKind(sessionId);
    if (!agentKind) return null;
    const { recent, opening } = await deps.collectMaterial(sessionId, REGENERATE_RECENT_WINDOW);
    // 空会话(草稿)没有素材,起不出有意义的标题
    if (recent.length === 0) return null;
    // 最近窗口已经覆盖到会话开头时,开场消息就在 transcript 里,不再单独给出。
    // 用 rowid 成员判断做精确判定——时间戳启发式在同毫秒批量落库(开场行被
    // 同时间戳的后续行挤出窗口)或 createdAt 为 null 时都会误判,review 已两次指出。
    const openingInWindow =
      opening.rowid != null && recent.some((m) => m.rowid === opening.rowid);
    const openingText =
      !openingInWindow && opening.text ? opening.text.slice(0, REGENERATE_OPENING_SLICE) : null;
    const transcript = recent
      .map((m) =>
        m.role === 'user'
          ? `User: ${m.text.slice(0, REGENERATE_USER_SLICE)}`
          : `Assistant: ${m.text.slice(0, REGENERATE_ASSISTANT_SLICE)}`,
      )
      .join('\n');
    const title = (
      await deps.generateTitle(
        sessionId,
        agentKind,
        REGENERATE_TITLE_PROMPT(openingText, transcript, getResolvedMainLocale()),
      )
    )?.trim();
    return title || null;
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

/**
 * 运行期校验 `maker:auto-title` 的 payload。结构、长度、枚举值不合法一律按
 * INVALID_PARAMS 拒绝,不让畸形值进到会改写标题 / 调用付费模型的副作用路径。
 */
function parseAutoTitleRequest(raw: unknown): SessionAutoTitleRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auto-title request required');
  }
  const { sessionId, text, agentKind, isUserText } = raw as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_ID_MAX) {
    throwIpcError('INVALID_PARAMS', 'invalid sessionId');
  }
  if (typeof text !== 'string') {
    throwIpcError('INVALID_PARAMS', 'invalid text');
  }
  if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
    throwIpcError('INVALID_PARAMS', 'invalid agentKind');
  }
  if (isUserText !== undefined && typeof isUserText !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid isUserText');
  }
  return {
    sessionId,
    // 截断而非拒绝:超长正文是正常输入,标题只需要开头一小段。
    text: (text as string).slice(0, AUTO_TITLE_TEXT_MAX),
    agentKind,
    ...(isUserText === undefined ? {} : { isUserText }),
  };
}

export function registerMakerTitleIpc(): void {
  // 这两条通道读供应商快照时会放行本机绑定自愈(写绑定文件、并为 Anthropic 起一次带凭证的
  // 清单发现),与下面的 AUTO_TITLE 同属特权入口,守卫口径也应当一致 —— 原先只有 AUTO_TITLE
  // 做了 sender 断言(PR #548 review)。两者都不在 device-link allowlist 里,可以直接用会抛的
  // 守卫。
  ipcMain.handle(
    MAKER_INVOKE.GENERATE_TITLE,
    async (
      event: Electron.IpcMainInvokeEvent,
      { message, agentKind, sessionId }: { message: string; agentKind: AgentKind; sessionId?: string },
    ): Promise<{ title: string | null }> => {
      assertTrustedAppRendererEvent(event);
      return { title: await generateMakerSessionTitle(message, agentKind, sessionId) };
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.REGENERATE_TITLE,
    async (
      event: Electron.IpcMainInvokeEvent,
      { sessionId }: { sessionId: string },
    ): Promise<{ title: string | null }> => {
      assertTrustedAppRendererEvent(event);
      return { title: await regenerateMakerSessionTitle(sessionId) };
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
}
