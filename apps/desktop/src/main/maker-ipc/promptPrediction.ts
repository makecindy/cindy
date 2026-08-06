/**
 * promptPrediction —— 输入框推荐提示词的 one-shot 预测。
 *
 * 参考 provider-one-shot.ts 的实现模式:复用同一套 provider/凭证/model routing
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

import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { runProviderOneShot } from '../maker-host/provider-one-shot.js';
import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
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
    const text = m.content.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!text) continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.join('\n');
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
  workingDir?: string,
): { system: string; user: string } {
  const wdLine = workingDir ? `Current working directory: ${workingDir}` : null;

  const system = [
    'You are a terse predictive text engine. Return only the predicted user prompt.',
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
    'Match the user\'s tone, brevity, phrasing, and terminology based on their recent messages.',
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

  const { system, user } = buildPredictionPrompt(context, params.workingDir);

  // 截断到上限(char 数),防止超长上下文撑爆 prompt
  const userPrompt = user.slice(0, PREDICTION_CONTEXT_MAX_CHARS + 1024); // prompt 固定部分 ~200 chars

  log.debug('prompt prediction params', {
    context,
    system,
    user: userPrompt,
    agentKind: params.agentKind,
    sessionId: params.sessionId,
  });

  // 复用 title one-shot 通路,但覆盖 token/校验参数以适配预测场景:
  //   - maxTokens=96: 标题仅需 32 token,预测 ≤140 chars 需要更多
  //   - codexInstructions: 告诉模型这是预测而非标题
  //   - maxOutputChars=0: 跳过 validateTitleOutput(该函数面向单行标题,拒绝多行/长文本)
  //   - maxVisualChars=140: 截断到推荐提示词上限
  return runProviderOneShot(
    {
      sessionId: params.sessionId,
      agentKind: params.agentKind,
      prompt: userPrompt,
    },
    {
      readSessionProviderId: readSessionProviderIdFromDb,
      listConnectedProviders: listConnectedProvidersForAgent,
    },
    {
      maxTokens: 96,
      codexInstructions:
        'Output only the predicted next user message — no quotes, markdown, or commentary.',
      maxOutputChars: 0,
      maxVisualChars: 140,
      systemPrompt: system,
    },
  );
}
