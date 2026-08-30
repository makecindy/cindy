/**
 * promptPrediction —— 输入框推荐提示词的 one-shot 预测。
 *
 * 走共享辅助模型链（`requestUtilityText`），不再按当前任务目录挑最便宜模型。
 * 失败静默返回 null，不 fallback 任何默认文案。
 */

import type { AgentKind } from '@cindy/maker-core';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getResolvedMainLocale } from '../i18n.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';
import { readAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { wasPromptPredictionSessionStopped } from './promptPredictionStopLedger.js';

const log = createLogger('maker-ipc/prompt-prediction');

/** 推荐素材:最近对话截断长度(UTF-16 code unit)。 */
const PREDICTION_CONTEXT_MAX_CHARS = 2000;
/** 单条消息截断长度。 */
const PREDICTION_USER_MSG_MAX = 400;
const PREDICTION_ASSISTANT_MSG_MAX = 600;
/** 最近 N 轮 user↔assistant 配对数。 */
const PREDICTION_RECENT_PAIRS = 3;

type SlimMessage = { role: string; content: string };

type SessionPredictionRow = {
  agentKind: typeof sessions.agentKind._.data;
  status: typeof sessions.status._.data;
  source: typeof sessions.source._.data;
  remoteHostId: string | null;
  providerId: string | null;
  workingDir: string | null;
  updatedAt: number;
  activeTurnStartedAt: number | null;
  lastTurnEndedAt: number | null;
};

const SESSION_PREDICTION_COLUMNS = {
  agentKind: sessions.agentKind,
  status: sessions.status,
  source: sessions.source,
  remoteHostId: sessions.remoteHostId,
  providerId: sessions.providerId,
  workingDir: sessions.workingDir,
  updatedAt: sessions.updatedAt,
  activeTurnStartedAt: sessions.activeTurnStartedAt,
  lastTurnEndedAt: sessions.lastTurnEndedAt,
};

/**
 * 从对话历史里提取最近几轮 user↔assistant 配对,截断后拼接成 prompt 素材。
 * 跳过 tool_use / tool_result / thinking / error / system 等非对话角色。
 */
function buildConversationContext(messages: SlimMessage[], maxPairs: number): string {
  const conversational = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
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
          ? text.slice(0, Math.floor(maxChars * 0.4)) +
            ' … ' +
            text.slice(-Math.floor(maxChars * 0.6))
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
  const wdLine = workingDir
    ? `Current working directory: ${escapeReferenceData(workingDir)}`
    : null;

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

function sessionStillEligibleForPrediction(
  row: SessionPredictionRow | undefined,
  params: PromptPredictionParams,
): boolean {
  if (!row || row.status === 'deleted' || row.source === 'review' || row.remoteHostId) {
    return false;
  }
  if (dbToMakerAgentKind(row.agentKind) !== params.agentKind) return false;
  if (row.lastTurnEndedAt !== params.completionRevision) return false;
  if (
    row.activeTurnStartedAt != null
    && row.activeTurnStartedAt >= params.completionRevision
  ) return false;
  if (wasPromptPredictionSessionStopped(params.sessionId)) return false;
  if (row.workingDir !== (params.workingDir ?? null)) return false;
  return true;
}

export interface PromptPredictionParams {
  sessionId: string;
  agentKind: AgentKind;
  messages: SlimMessage[];
  workingDir?: string;
  /** 本次预测对应的 sessions.lastTurnEndedAt，provider 派发紧前再次复核。 */
  completionRevision: number;
  /** title.ts 中 readMaterial 之后捕获的 session.updatedAt,用于 beforeDispatch 终末复核。
   * 传入此参数后 generatePromptPrediction 不再重新从 DB 读取 drain 时 updatedAt,
   * 避免素材物化后、provider/凭证解析期间新消息落盘导致轮次变化未被检测。 */
  materialDrainUpdatedAt?: number;
}

/**
 * 预测用户下一步可能输入的提示词。
 * 辅助模型链不可用 / HTTP 失败 / 空响应 / 会话资格变化 → 返回 null。
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

  const modelsSnapshot = JSON.stringify(readAuxiliaryModelSettings().models);
  const [{ requestUtilityText }, { getMaker }] = await Promise.all([
    import('../utility-model/oneShotCandidates.js'),
    import('../maker-host/index.js'),
  ]);

  const result = await requestUtilityText(getMaker(), truncated, {
    maxTokens: 96,
    timeoutMs: 12_000,
    disableReasoning: true,
    reasoningEffort: 'minimal',
    systemPrompt,
    responseInstructions:
      'Output only the predicted next user message — no quotes, markdown, or commentary.',
    beforeDispatch: async () => {
      try {
        if (JSON.stringify(readAuxiliaryModelSettings().models) !== modelsSnapshot) {
          return false;
        }
        const [row] = await getDbClient()
          .drizzle.select(SESSION_PREDICTION_COLUMNS)
          .from(sessions)
          .where(eq(sessions.id, params.sessionId))
          .limit(1);
        if (!sessionStillEligibleForPrediction(row, params)) return false;

        const [finalRow] = await getDbClient()
          .drizzle.select(SESSION_PREDICTION_COLUMNS)
          .from(sessions)
          .where(eq(sessions.id, params.sessionId))
          .limit(1);
        if (!sessionStillEligibleForPrediction(finalRow, params)) return false;
        if (finalRow.providerId !== row.providerId) return false;
        if (
          beforeDispatchDrainUpdatedAt
          && finalRow.updatedAt !== beforeDispatchDrainUpdatedAt
        ) return false;
        return JSON.stringify(readAuxiliaryModelSettings().models) === modelsSnapshot;
      } catch {
        return false;
      }
    },
  });

  // HTTP 已经发出后仍可能收到其它窗口 / Device Link 的 Stop。费用无法撤回，但返回值
  // 必须丢弃，不能在用户明确停止后把推荐重新显示到输入框。
  if (wasPromptPredictionSessionStopped(params.sessionId)) return null;
  if (!result.ok) return null;
  const normalized = validateTitleOutput(result.text, 512);
  return normalized ? Array.from(normalized).slice(0, 140).join('') : null;
}
