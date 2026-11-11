/**
 * 上游拒绝「system 消息位置不合法」时的措辞识别与规范化判据。
 *
 * 两种上游、两种力度,混用会把既有保守策略放宽:
 *   - `'prefix'`  本地模板运行器(Ollama / Qwen 系):`System message must be at the beginning.`
 *     模板只要求开头是一段连续的 system。把拆开的前缀并成一条即可,不动中段。
 *   - `'leading'` Google 的 OpenAI 兼容层(AI SDK 报错透传):
 *     `system messages are only supported at the beginning of the conversation`
 *     这是**会话级**限制:任何位置出现 system 都不接受,只能全部提到最前。
 *
 * Claude Code 的 `mid-conversation-system` 会在 user 轮次之后持续注入 system 消息,
 * 命中 'leading' 时不合并就整轮失败、且下一轮原样复现(会话卡死)。
 */

import type { ChatMessage } from './types.js';

export type SystemOrderRejection = 'prefix' | 'leading';

/**
 * 单条 message 文本的判定。'leading' 那句常被上游二次编码成 JSON 字符串再当作
 * message,故按子串匹配而非锚定全串。
 */
export function classifySystemOrderMessage(message: string): SystemOrderRejection | null {
  const text = message.trim();
  if (/^system message must be at the beginning\.?$/i.test(text)) return 'prefix';
  if (/system messages? are only supported at the beginning of the conversation/i.test(text)) return 'leading';
  return null;
}

/**
 * 400 错误体 → 拒绝类型。message 可能是纯文本,也可能是被逐层二次编码的 JSON 字符串
 * (Google 兼容层经 AI SDK 抛出的形状就是两层),逐层展开后判定。
 */
export function classifySystemOrderError(status: number, text: string): SystemOrderRejection | null {
  if (status !== 400) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const error = (body as Record<string, unknown>).error;
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
    const message = (error as Record<string, unknown>).message;
    if (typeof message !== 'string') return null;
    const rejection = classifySystemOrderMessage(message);
    if (rejection) return rejection;
    try {
      body = JSON.parse(message);
    } catch {
      return null;
    }
  }
  return null;
}

/** 只重试前缀合并:把中段指令跨轮次前移会改变它的作用域。 */
export function hasConsecutiveSystemPrefix(messages: ChatMessage[]): boolean {
  let prefixLength = 0;
  while (messages[prefixLength]?.role === 'system') prefixLength += 1;
  return prefixLength > 1 && messages.every((message, index) => (
    index < prefixLength || (message.role !== 'system' && message.role !== 'developer')
  ));
}

/** 合并确实会改变消息列表:system/developer 不止出现在开头,或开头就有多条。 */
export function hasNonLeadingSystemMessage(messages: ChatMessage[]): boolean {
  const isSystem = (message: ChatMessage): boolean => message.role === 'system' || message.role === 'developer';
  const systems = messages.filter(isSystem).length;
  if (systems === 0) return false;
  const prefix = messages.findIndex((message) => !isSystem(message));
  // 全是 system:多条才需要合并。
  if (prefix === -1) return systems > 1;
  return prefix > 1 || messages.slice(prefix).some(isSystem);
}

/**
 * 是否值得按拒绝类型做一次规范化重试。
 *
 * 'prefix' 沿用既有保守策略,只并连续前缀。'leading' 是会话级拒绝,中段 system 不合并
 * 就整轮失败、会话卡死;此时把 system/developer 全部提到开头,代价是作用域前移,
 * 换来用户还能继续对话。
 */
export function shouldRetrySystemNormalization(
  rejection: SystemOrderRejection,
  messages: ChatMessage[],
): boolean {
  return rejection === 'prefix'
    ? hasConsecutiveSystemPrefix(messages)
    : hasNonLeadingSystemMessage(messages);
}
