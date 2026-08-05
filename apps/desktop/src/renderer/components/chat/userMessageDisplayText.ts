/**
 * userMessageDisplayText
 * ---------------------------------------------------------------------------
 * user 消息「显示文本」的唯一推导处:气泡正文(UserMessage)与提问导航条预览
 * (messageNavRailModel)共用。两类特殊消息的显示文本与存库 content 不同:
 *   - hook 消息(IM 转入):正文优先 hookSource.userText(干净原文,与 agent
 *     prompt 分离);过渡期消息(有 hookSource 无 userText)回退正则剥
 *     <thread_context> 块;
 *   - Orca 通信行:content 是 {orcaSource, content} 的 JSON 封装,显示的是
 *     内层 content。
 * 各消费方自行解析会走偏 —— 导航条曾直接用原始 content,把 hook 消息的隐藏
 * prompt / thread 上下文和 Orca 行的 JSON 原文暴露进预览卡与 aria-label
 * (PR #830 review)。无 DOM 依赖,node 环境直接单测。
 */

export interface OrcaCommunicationContent {
  orcaSource: 'lead' | 'worker';
  content: string;
}

export function parseOrcaCommunicationContent(content: string): OrcaCommunicationContent | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.orcaSource !== 'lead' && record.orcaSource !== 'worker') return null;
    if (typeof record.content !== 'string') return null;
    return {
      orcaSource: record.orcaSource,
      content: record.content,
    };
  } catch {
    return null;
  }
}

/**
 * 过渡期 hook 消息的兜底:剥正文开头的 <thread_context> 块与紧随的提示行。
 * 刻意不带 /m:^ 只匹配字符串起始(主机拼装的块必在串首),带 /m 会让正文
 * 中间恰好以 <thread_context> 开头的行也被误剥(Copilot review;旧实现的
 * /m 系历史遗留,原样迁入本文件后一并修正)。
 */
const THREAD_CONTEXT_PREFIX_RE =
  /^<thread_context>[\s\S]*?<\/thread_context>\s*(?:\(thread 历史中的.*?\)\s*)?/;

/**
 * 输入按结构收敛到两个字段,不 import ChatMessage / props 类型:
 * UserMessage 传的是 props(content + hookSource),导航条传的是 ChatMessage,
 * 两者都结构性满足;也让本模块保持零依赖可单测。
 */
export interface UserDisplayTextSource {
  content: string;
  hookSource?: { userText?: string } | null;
}

export function resolveUserDisplayText(
  source: UserDisplayTextSource,
  // 渲染热路径(UserMessage 本就要单独解析 Orca 结果画卡片)可把已解析值
  // 传进来复用,免得每条 user 消息渲染都重复 JSON.parse(Copilot review);
  // 省略时自行解析,导航条 / chip 侧的单参调用形态不变。
  orcaCommunication: OrcaCommunicationContent | null = parseOrcaCommunicationContent(
    source.content,
  ),
): string {
  const rawDisplayContent = orcaCommunication?.content ?? source.content;
  if (!source.hookSource) return rawDisplayContent;
  return (
    source.hookSource.userText ?? rawDisplayContent.replace(THREAD_CONTEXT_PREFIX_RE, '').trim()
  );
}
