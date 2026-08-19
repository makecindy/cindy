/**
 * promptPrediction —— 输入框推荐提示词的 one-shot 预测。
 *
 * 参考 title-one-shot.ts 的实现模式:复用同一套 provider/凭证/model routing
 * 基础设施,走 provider catalog 中的 titleModel(最经济模型)做单次 HTTP 请求,
 * 预测用户下一步会输入的提示词。不自己发 HTTP,不额外配置 endpoint。
 *
 * 与标题生成的差异:
 *   - 触发时机:标题在首条用户消息发送时触发;推荐在 turn 完成后触发。
 *   - prompt 构建:提取最近对话上下文,让模型预测下一步用户输入。
 *   - 输出长度:标题 ≤20 字;推荐 ≤140 字符。
 *   - 错误处理:失败静默返回 null,不 fallback 任何默认文案。
 */

import type { AgentKind } from '@cindy/maker-core';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getResolvedMainLocale } from '../i18n.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { generateTitleViaProviderResult } from '../maker-host/title-one-shot.js';
import { connectedProvidersForAgent, nativeDefaultSourceId, type ProviderView } from '@cindy/model-providers';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc/prompt-prediction');

/** 推荐素材:最近对话截断长度(UTF-16 code unit)。 */
const PREDICTION_CONTEXT_MAX_CHARS = 2000;
/** 单条消息截断长度。 */
const PREDICTION_USER_MSG_MAX = 400;
const PREDICTION_ASSISTANT_MSG_MAX = 600;
/** 最近 N 轮 user↔assistant 配对数。 */
const PREDICTION_RECENT_PAIRS = 3;

type SlimMessage = { role: string; content: string };

/**
 * 从对话历史里提取最近几轮 user↔assistant 配对,截断后拼接成 prompt 素材。
 * 跳过 tool_use / tool_result / thinking / error / system 等非对话角色。
 */
function buildConversationContext(
  messages: SlimMessage[],
  maxPairs: number,
): string {
  const conversational = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  // 从末尾往前取 maxPairs*2 条(user+assistant)
  const recent = conversational.slice(-maxPairs * 2);
  if (recent.length === 0) return '';

  const lines: string[] = [];
  for (const m of recent) {
    const maxChars = m.role === 'user' ? PREDICTION_USER_MSG_MAX : PREDICTION_ASSISTANT_MSG_MAX;
    const text = m.content.replace(/\s+/g, ' ').trim();
    // 保留首尾:Assistant 长回复的结尾通常包含总结/待确认问题/下一步建议,
    // 仅保留开头会丢失关键上下文。
    const truncated =
      text.length <= maxChars
        ? text
        : m.role === 'assistant'
          ? text.slice(0, Math.floor(maxChars * 0.4)) + ' … ' + text.slice(-Math.floor(maxChars * 0.6))
          : text.slice(0, maxChars);
    if (!truncated) continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${truncated}`);
  }
  // 超长时从最旧侧裁剪，保留最新对话（刚完成的回复与结尾指令不丢失）。
  const context = lines.join('\n');
  return context.length > PREDICTION_CONTEXT_MAX_CHARS
    ? context.slice(-PREDICTION_CONTEXT_MAX_CHARS)
    : context;
}

function escapeReferenceData(value: string): string {
  return value.replace(/[&<>]/gu, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    return '&gt;';
  });
}

function buildPredictionPrompt(
  context: string,
  locale: string,
  workingDir?: string,
): { system: string; user: string } {
  const languageHints: Record<string, string> = {
    'zh-CN': "Match the user's language. The user types in Simplified Chinese.",
    'zh-TW': "Match the user's language. The user types in Traditional Chinese.",
    en: "Match the user's language. The user types in English.",
    ja: "Match the user's language. The user types in Japanese.",
    ko: "Match the user's language. The user types in Korean.",
  };
  const wdLine = workingDir ? `Current working directory: ${escapeReferenceData(workingDir)}` : null;

  // 系统指令写入 Anthropic Messages API 顶层 system 字段（非 Anthropic wire 忽略），
  // 不混入 user message，避免被 Anthropic API 拒绝。
  // TODO(PR #1965): 该固定 system prompt 指令进入模型 system 段，按
  // docs/dev-rules/maker-core-and-agent-behavior.md §4 需在合并前取得维护者确认。
  const system = [
    'You are a terse predictive text engine for a coding chat input.',
    'Return only the predicted next user message — no quotes, markdown, commentary, or multiple options.',
    'Keep it under 140 characters. Make it actionable for a coding agent.',
    languageHints[locale] ?? "Match the user's language and tone.",
  ].join('\n');

  const user = [
    'Predict the next message the user is likely to type.',
    wdLine,
    '',
    '<recent_conversation>',
    escapeReferenceData(context),
    '</recent_conversation>',
    '',
    'Return exactly one concise user prompt.',
    "Match the user's tone, brevity, phrasing, and terminology based on their recent messages.",
    'Do not copy prior messages verbatim.',
    'Make it actionable.',
    'Keep it under 140 characters.',
    'No quotes, markdown, commentary, explanations, or multiple options.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return { system, user };
}

/** 从 DB 读 sessions.provider_id。失败/空串 → null。 */
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

/** 某 agent 下已连接的供应商视图列表。失败 → []。 */
async function listConnectedProvidersForAgent(
  agentKind: AgentKind,
): Promise<ProviderView[]> {
  try {
    const all = await getDesktopProviderService().listProviders({ allowSideEffects: true });
    return connectedProvidersForAgent(all, agentKind);
  } catch {
    return [];
  }
}

export interface PromptPredictionParams {
  sessionId: string;
  agentKind: AgentKind;
  messages: SlimMessage[];
  workingDir?: string;
  /** title.ts 中 readMaterial 之后捕获的 session.updatedAt,用于 beforeDispatch 终末复核。
   * 传入此参数后 generatePromptPrediction 不再重新从 DB 读取 drain 时 updatedAt,
   * 避免素材物化后、provider/凭证解析期间新消息落盘导致轮次变化未被检测。 */
  materialDrainUpdatedAt?: number;
}

/**
 * 预测用户下一步可能输入的提示词。
 * 无已连接 provider / 无 titleModel / 凭证缺失 / HTTP 失败 / 空响应 → 返回 null。
 */
export async function generatePromptPrediction(
  params: PromptPredictionParams,
): Promise<string | null> {
  const context = buildConversationContext(params.messages, PREDICTION_RECENT_PAIRS);
  if (!context) {
    log.debug('prompt prediction skipped: no conversational context');
    return null;
  }

  const locale = getResolvedMainLocale();
  const { system: systemPrompt, user: userPrompt } = buildPredictionPrompt(
    context,
    locale,
    params.workingDir,
  );

  // 截断到上限(char 数),防止超长上下文撑爆 prompt。保留最新内容(从尾部截断),
  // 确保刚完成的回复与结尾指令不被丢弃。
  const truncated = userPrompt.slice(-(PREDICTION_CONTEXT_MAX_CHARS + 1024)); // prompt 固定部分 ~200 chars

  // 仅记录长度用于调试，不记录对话内容避免敏感数据泄漏。
  log.debug('prompt prediction params', {
    contextLen: context.length,
    systemLen: systemPrompt.length,
    userLen: truncated.length,
    agentKind: params.agentKind,
    sessionId: params.sessionId,
  });

  // 复用 title one-shot 通路,但覆盖 token/校验参数以适配预测场景:
  //   - maxTokens=96: 标题仅需 32 token,预测 ≤140 chars 需要更多
  //   - codexInstructions: 告诉模型这是预测而非标题
  //   - systemPrompt: Anthropic Messages API 顶层 system 字段(非 Anthropic wire 忽略)
  //   - maxOutputChars=512: 恢复 validateTitleOutput 输出校验(拦截多行/Markdown/role label),再交给 maxVisualChars=140 做展示截断
  //   - maxVisualChars=140: 截断到推荐提示词上限
  // 在 provider/凭证解析之前捕获 drain 时的 updatedAt，供 beforeDispatch 终末复核。
  // 若在 drain 之后、beforeDispatch 首次 DB 读之前用户发送了新消息，row.updatedAt
  // 和 finalRow.updatedAt 都会包含新值，仅做两次 DB 读互相比较无法检测到轮次变化。
  // 优先使用 title.ts 中素材物化后传入的 materialDrainUpdatedAt（覆盖素材物化→provider
  // 解析之间的空窗），未传入时回退到在此处从 DB 读取。
  let beforeDispatchDrainUpdatedAt: number | undefined;
  if (params.materialDrainUpdatedAt != null) {
    beforeDispatchDrainUpdatedAt = params.materialDrainUpdatedAt;
  } else {
    try {
      const [drainRow] = await getDbClient()
        .drizzle.select({ updatedAt: sessions.updatedAt })
        .from(sessions)
        .where(eq(sessions.id, params.sessionId))
        .limit(1);
      beforeDispatchDrainUpdatedAt = drainRow?.updatedAt ?? undefined;
    } catch {
      beforeDispatchDrainUpdatedAt = undefined;
    }
  }
  const result = await generateTitleViaProviderResult(
    {
      sessionId: params.sessionId,
      agentKind: params.agentKind,
      prompt: truncated,
    },
    {
      readSessionProviderId: readSessionProviderIdFromDb,
      listConnectedProviders: listConnectedProvidersForAgent,
      // 派发紧前复查:会话在 drain 与 provider/凭证解析期间可能被切换 agent/删除/转远程。
      // (sessionAgentSwitchHandler 会提交 agentKind 变更,deleteSession 会软删除)上方
      // title.ts handler 里 drain 后的资格复核到 provider 实际发出 HTTP 之间仍有一段异步窗口。
      // 这里在发出付费请求的紧前再回读一次 DB 完整资格字段:
      //   - agentKind: 会话被切换 agent 时中止,避免路由到切换前的 provider/账号
      //   - status: 会话被软删除时中止,避免外发已删转写
      //   - source: 会话被转为 review 时中止
      //   - remoteHostId: 会话被转为远程时中止
      //   - providerId: 会话 provider 被切换时中止,避免路由到过期 provider
      beforeDispatch: async ({ sessionId, agentKind, providerId: resolvedProviderId }) => {
        try {
          // drainUpdatedAt 在 provider/凭证解析之前捕获，用于终末复核。
          // 若在 drain 之后、beforeDispatch 首次 DB 读之前用户发送了新消息，
          // row.updatedAt 和 finalRow.updatedAt 都会包含新值，仅做 row↔finalRow
          // 比较无法检测到轮次变化。与 drainUpdatedAt 比较才可靠。
          const drainUpdatedAt = beforeDispatchDrainUpdatedAt;
          const [row] = await getDbClient()
            .drizzle.select({
              agentKind: sessions.agentKind,
              status: sessions.status,
              source: sessions.source,
              remoteHostId: sessions.remoteHostId,
              providerId: sessions.providerId,
              workingDir: sessions.workingDir,
              updatedAt: sessions.updatedAt,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (!row) return false;
          if (row.status === 'deleted') return false;
          if (row.source === 'review') return false;
          if (row.remoteHostId) return false;
          if (dbToMakerAgentKind(row.agentKind) !== agentKind) return false;
          // 用已解析的 providerId(来自 generateTitleViaProviderResult 的
          // 凭证解析口径)与当前 DB 的 providerId 比对。此前只比较两次 DB 读,
          // 会话在 provider 解析后、beforeDispatch 前被切换 provider 时,
          // 两次 DB 读都返回新值,比对通过,但凭证已用旧 provider 解析,
          // 导致付费请求路由到过期 provider/账号。
          if (row.providerId != null) {
            if (row.providerId !== resolvedProviderId) return false;
            // 额外复查：显式 provider 是否仍在已连接列表中。用户在凭证解析后
            // 断开/登出该显式 provider 时，DB providerId 仍等于 resolvedProviderId，
            // 但 connected-provider rail 已不含该 provider，继续派发会用过期凭证
            // 外发付费调用。按 fail-closed 中止。
            const providers = await listConnectedProvidersForAgent(agentKind);
            if (!providers.some((p) => p.id === resolvedProviderId)) return false;
          } else {
            // provider_id 为 null 表示使用默认 provider。若用户在凭证解析后
            // 断开/切换了默认 provider，resolvedProviderId 仍指向旧 provider，
            // 继续派发会外发到过期 provider/账号。重新计算当前有效默认 provider
            // 并与 resolvedProviderId 比对。
            const providers = await listConnectedProvidersForAgent(agentKind);
            const defaultProviderId = nativeDefaultSourceId(providers, agentKind);
            if (!defaultProviderId || defaultProviderId !== resolvedProviderId) return false;
          }
          // 紧前复查 workingDir：用户在 provider/凭证解析期间切换了工作目录，
          // 此时 buildPredictionPrompt 已嵌入旧 params.workingDir，继续派发
          // 会向 provider 外发过期本地路径。按 fail-closed 中止。
          if (row.workingDir !== (params.workingDir ?? null)) return false;
          // 终末复查：上方 listConnectedProvidersForAgent 是异步调用（实时读取
          // 凭证连接态且允许副作用），等待期间用户仍可能删除会话、切换 agent/provider、
          // 修改工作目录或把会话转为远程/review。在最后一个 await 之后再做一次无后续
          // await 的 DB 复核，把 TOCTOU 窗口缩到最小。
          const [finalRow] = await getDbClient()
            .drizzle.select({
              agentKind: sessions.agentKind,
              status: sessions.status,
              source: sessions.source,
              remoteHostId: sessions.remoteHostId,
              providerId: sessions.providerId,
              workingDir: sessions.workingDir,
              updatedAt: sessions.updatedAt,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (!finalRow) return false;
          if (finalRow.status === 'deleted') return false;
          if (finalRow.source === 'review') return false;
          if (finalRow.remoteHostId) return false;
          if (dbToMakerAgentKind(finalRow.agentKind) !== agentKind) return false;
          if (finalRow.providerId != null && finalRow.providerId !== resolvedProviderId) return false;
          // 会话在检查期间从显式 provider 切换到默认 provider（finalRow.providerId
          // 为 null 但 row.providerId 非 null），resolvedProviderId 仍指向旧显式
          // provider。此时无法再做异步 provider 解析（TOCTOU 最小化），按 fail-closed
          // 中止，避免用旧 provider 凭证外发付费调用。
          if (finalRow.providerId == null && row.providerId != null) return false;
          if (finalRow.workingDir !== (params.workingDir ?? null)) return false;
          // 终末复核消息轮次：与 drain 时的 updatedAt（provider/凭证解析之前捕获）比较。
          // 仅与 row.updatedAt（beforeDispatch 内首次 DB 读）比较无法检测到
          // drain 之后、首次 DB 读之前发来的新消息——此时两次读都返回同一新值。
          if (drainUpdatedAt && finalRow.updatedAt !== drainUpdatedAt) return false;
          return true;
        } catch {
          // 复查失败按 fail-closed 处理:宁可漏掉一次推荐,也不在归属不确定时外发付费调用。
          return false;
        }
      },
    },
    {
      maxTokens: 96,
      codexInstructions:
        'Output only the predicted next user message — no quotes, markdown, or commentary.',
      systemPrompt,
      maxOutputChars: 512,
      maxVisualChars: 140,
    },
  );
  return result.status === 'ok' ? result.title : null;
}
