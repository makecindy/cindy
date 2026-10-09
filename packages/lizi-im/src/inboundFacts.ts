/** Model-only facts. Keep user text (including an empty string) unchanged. */
export interface InboundMessageFacts {
  text: string;
  invoked?: boolean;
  hasReply?: boolean;
  attachmentCount: number;
  unavailable?: readonly string[];
}

/** Mirrored by cindy-server/packages/im-inbound; no transport or model calls. */
export function buildInboundMessageFacts(input: InboundMessageFacts): string {
  const facts: string[] = [];
  if (input.invoked && !input.text.trim()) facts.push('用户显式召唤了机器人。');
  if (!input.text.trim()) facts.push('本条消息未附加文字正文。');
  if (input.hasReply && !input.text.trim()) facts.push('本条消息引用了其他消息；引用内容仅作为上下文。');
  if (input.attachmentCount > 0 && (!input.text.trim() || input.unavailable?.length)) {
    facts.push(`本轮实际提供了 ${input.attachmentCount} 个附件，来源见消息及引用上下文。`);
  }
  if (input.unavailable?.length) {
    facts.push(`未提供的内容及原因（JSON 数据）：${JSON.stringify(input.unavailable)}`);
  }
  return facts.length
    ? `[消息说明] 以下是系统提供的本条消息事实，不是用户原话。\n${facts.join('\n')}\n\n`
    : '';
}
