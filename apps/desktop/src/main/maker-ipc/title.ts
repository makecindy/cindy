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
import { eq } from 'drizzle-orm';

import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { generateTitleViaProvider } from '../maker-host/title-one-shot.js';
import {
  regenerateTitleMaterial,
  type RegenerateTitleMaterial,
} from '../localDb/latestMessageText.js';
import { createLogger } from '../logger.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/title');

const TITLE_PROMPT_TEMPLATE = (msg: string) =>
  `为以下用户消息生成一个简短的对话标题（不超过20个字，不要加引号，不要加标点，直接输出标题）：\n\n${msg.slice(0, 200)}`;

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
 * 语言跟随对话内容。开场只在最近窗口没覆盖到会话开头时单独给出(短会话不重复);
 * transcript 按时间正序,模型能自然看出最后一条是否只是"继续"式短追问,另用一句
 * 指令兜底,避免标题被短追问带偏。
 */
const REGENERATE_TITLE_PROMPT = (opening: string | null, transcript: string) =>
  [
    '根据以下对话内容，用与对话相同的语言生成一个简短的对话标题（不超过20个字，不要加引号，不要加标点，直接输出标题）。',
    '标题要概括整个对话的核心主题，并兼顾最新进展；如果用户最后的消息只是「继续」「好的」这类简短确认，不要据此起题。',
    '',
    ...(opening ? [`对话开场: ${opening}`, ''] : []),
    '最近的对话:',
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
    const all = await getDesktopProviderService().listProviders();
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
      prompt: TITLE_PROMPT_TEMPLATE(trimmed),
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
  return row.agentKind === 'codex' ? 'codex' : 'claude-code';
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
          ? `用户: ${m.text.slice(0, REGENERATE_USER_SLICE)}`
          : `助手: ${m.text.slice(0, REGENERATE_ASSISTANT_SLICE)}`,
      )
      .join('\n');
    const title = (
      await deps.generateTitle(
        sessionId,
        agentKind,
        REGENERATE_TITLE_PROMPT(openingText, transcript),
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

export function registerMakerTitleIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.GENERATE_TITLE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      { message, agentKind, sessionId }: { message: string; agentKind: AgentKind; sessionId?: string },
    ): Promise<{ title: string | null }> => {
      return { title: await generateMakerSessionTitle(message, agentKind, sessionId) };
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.REGENERATE_TITLE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      { sessionId }: { sessionId: string },
    ): Promise<{ title: string | null }> => {
      return { title: await regenerateMakerSessionTitle(sessionId) };
    },
  );
}
