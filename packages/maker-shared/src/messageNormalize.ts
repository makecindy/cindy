export interface MessageNormalizeSourceMessageLike {
  id?: string | null;
  clientId?: string | null;
  role: string;
  content?: unknown;
  toolUseId?: string | null;
  createdAt?: string;
}

export interface MessageNormalizeToolUse {
  toolUseId?: string;
  toolName: string;
  input: unknown;
}

export interface MessageToolResultPairing<
  TMessage extends MessageNormalizeSourceMessageLike = MessageNormalizeSourceMessageLike,
> {
  resultByToolUseId: ReadonlyMap<string, string>;
  adjacencyResultByMessageKey: ReadonlyMap<string, string>;
  toolNameByUseId: ReadonlyMap<string, string>;
  resultContentFor(message: TMessage, tool: MessageNormalizeToolUse): string | undefined;
  /**
   * tool_result 是否已到达。与 `resultContentFor` 的区别：**不过 `shouldHideToolResult`
   * 滤网**—— orca 通讯工具的空结果虽不展示内容，但工具确已执行完，状态判定
   * （running/done）必须计入，否则这类行会永久显示进行中。
   */
  hasResultFor(message: TMessage, tool: MessageNormalizeToolUse): boolean;
}

export interface MessageToolResultPairingOptions {
  contentToPreview?(content: unknown): string;
}

export function sortMessagesByCreatedAt<
  TMessage extends MessageNormalizeSourceMessageLike,
>(messages: readonly TMessage[]): TMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const byTime = String(a.message.createdAt ?? '').localeCompare(String(b.message.createdAt ?? ''));
      return byTime === 0 ? a.index - b.index : byTime;
    })
    .map(({ message }) => message);
}

export function messageNormalizeKey(message: MessageNormalizeSourceMessageLike): string {
  return readNonEmptyString(message.id)
    ?? readNonEmptyString(message.clientId)
    ?? `${message.role}:${message.createdAt ?? ''}`;
}

export function parseMessageToolUse(message: MessageNormalizeSourceMessageLike): MessageNormalizeToolUse {
  const content = readRecord(message.content);
  const toolUseId = readNonEmptyString(message.toolUseId) ?? readNonEmptyString(content?.toolUseId);
  const toolName = readNonEmptyString(content?.toolName) ?? '';
  return {
    toolUseId: toolUseId ?? undefined,
    toolName,
    input: content?.input ?? null,
  };
}

export function buildMessageToolResultPairing<
  TMessage extends MessageNormalizeSourceMessageLike,
>(
  sortedMessages: readonly TMessage[],
  options: MessageToolResultPairingOptions = {},
): MessageToolResultPairing<TMessage> {
  const resultByToolUseId = new Map<string, string>();
  const toolNameByUseId = new Map<string, string>();
  const contentToPreview = options.contentToPreview ?? messageContentToPreview;

  for (const message of sortedMessages) {
    if (message.role !== 'tool_use') continue;
    const tool = parseMessageToolUse(message);
    if (tool.toolUseId) toolNameByUseId.set(tool.toolUseId, tool.toolName);
  }

  // settled 集合独立于内容 map：即使结果被 shouldHideToolResult 隐藏，工具也已完成。
  const settledToolUseIds = new Set<string>();

  for (const message of sortedMessages) {
    if (message.role !== 'tool_result') continue;
    const toolUseId = readToolResultUseId(message);
    if (!toolUseId) continue;
    settledToolUseIds.add(toolUseId);
    const content = contentToPreview(message.content);
    if (shouldHideToolResult(toolNameByUseId.get(toolUseId) ?? '', content)) continue;
    resultByToolUseId.set(toolUseId, content);
  }

  const adjacencyResultByMessageKey = new Map<string, string>();
  const settledAdjacencyMessageKeys = new Set<string>();
  for (let index = 0; index < sortedMessages.length; index++) {
    const message = sortedMessages[index];
    if (message.role !== 'tool_use') continue;
    const tool = parseMessageToolUse(message);
    // byId 已 settled(含结果被隐藏)的不走邻接,防止把相邻其它工具的 result
    // 错配给它。但**不能**对所有带 id 的消息无条件跳过:desktop 持久层把一条
    // tool_result 归并多个 toolUseId 时只存 primary id(messagePersistBroadcaster),
    // secondary 工具就是靠邻接兜底拿到共享结果与 settled 状态 —— 这与 desktop
    // renderer(MessageStream Pass 2)的口径一致。代价是「带 id 的 pending 工具
    // 恰好紧邻其它工具 result」时会短暂借到别人的内容,live 中该工具自己的
    // result 按 id 到达后即覆盖自愈,与桌面行为一致。
    if (tool.toolUseId && settledToolUseIds.has(tool.toolUseId)) continue;

    const adjacent = sortedMessages[index + 1];
    if (adjacent?.role !== 'tool_result') continue;
    settledAdjacencyMessageKeys.add(messageNormalizeKey(message));
    const content = contentToPreview(adjacent.content);
    if (shouldHideToolResult(tool.toolName, content)) continue;
    adjacencyResultByMessageKey.set(messageNormalizeKey(message), content);
  }

  return {
    resultByToolUseId,
    adjacencyResultByMessageKey,
    toolNameByUseId,
    resultContentFor(message, tool) {
      if (tool.toolUseId) {
        const byId = resultByToolUseId.get(tool.toolUseId);
        if (byId !== undefined) return byId;
      }
      return adjacencyResultByMessageKey.get(messageNormalizeKey(message));
    },
    hasResultFor(message, tool) {
      if (tool.toolUseId && settledToolUseIds.has(tool.toolUseId)) return true;
      return settledAdjacencyMessageKeys.has(messageNormalizeKey(message));
    },
  };
}

export function messageContentToPreview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(messageContentToPreview).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') return record.text;
    if (record.type === 'thinking' && typeof record.thinking === 'string') return record.thinking;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    return JSON.stringify(content, null, 2);
  }
  return content == null ? '' : String(content);
}

export function shouldHideToolResult(toolName: string, content: string): boolean {
  return isOrcaCommunicationTool(toolName) && isEmptyOrcaCommunicationResult(content);
}

export function isOrcaCommunicationTool(toolName: string): boolean {
  const normalized = toolName.replace(/^mcp__/, 'mcp:').replace(/__/g, ':');
  return normalized === 'mcp:orca_worker_bridge:send_to_lead'
    || normalized === 'mcp:orca_worker_bridge:read_lead'
    || normalized === 'mcp:orca_worker_bridge:lead_status'
    || toolName === 'send_to_lead'
    || toolName === 'read_lead'
    || toolName === 'lead_status';
}

export function isEmptyOrcaCommunicationResult(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const hasUserFacingContent = ['message', 'result', 'text', 'content', 'error', 'detail']
      .some((key) => typeof record[key] === 'string' && record[key].trim().length > 0);
    if (hasUserFacingContent) return false;
    return record.ok === true;
  } catch {
    return false;
  }
}

function readToolResultUseId(message: MessageNormalizeSourceMessageLike): string | null {
  return readNonEmptyString(message.toolUseId) ?? readNonEmptyString(readRecord(message.content)?.toolUseId);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
