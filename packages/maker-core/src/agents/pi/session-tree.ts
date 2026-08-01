import type {
  SessionTreeEntryKind,
  SessionTreeHistoryMessage,
  SessionTreeNode,
  SessionTreeSnapshot,
} from '../../types/capabilities.js';

type UnknownRecord = Record<string, unknown>;

interface RawTreeNode {
  entry?: UnknownRecord;
  children?: unknown;
  label?: unknown;
  labelTimestamp?: unknown;
}

const PREVIEW_LIMIT = 180;

function recordOf(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const block = recordOf(raw);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
    else if (block.type === 'toolCall' && typeof block.name === 'string') parts.push(`↳ ${block.name}`);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n\n');
}

function oneLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT - 1)}…` : collapsed;
}

function entryKind(type: unknown): SessionTreeEntryKind {
  switch (type) {
    case 'message':
    case 'compaction':
    case 'branch_summary':
    case 'model_change':
    case 'thinking_level_change':
    case 'label':
    case 'custom':
      return type;
    default:
      return 'other';
  }
}

function describeEntry(entry: UnknownRecord): {
  role?: SessionTreeNode['role'];
  preview: string;
} {
  if (entry.type === 'message') {
    const message = recordOf(entry.message);
    if (!message) return { role: 'system', preview: '' };
    const role = message?.role;
    if (role === 'user') return { role: 'user', preview: oneLine(textFromContent(message.content)) };
    if (role === 'assistant') return { role: 'assistant', preview: oneLine(textFromContent(message.content)) };
    if (role === 'toolResult') {
      const name = typeof message.toolName === 'string' ? message.toolName : 'tool';
      const text = oneLine(textFromContent(message.content));
      return { role: 'tool', preview: text ? `${name}: ${text}` : name };
    }
    if (role === 'branchSummary' || role === 'compactionSummary') {
      return { role: 'summary', preview: oneLine(message.summary) };
    }
    return { role: 'system', preview: oneLine(textFromContent(message.content)) };
  }
  if (entry.type === 'branch_summary') {
    return { role: 'summary', preview: oneLine(entry.summary) };
  }
  if (entry.type === 'compaction') {
    return { role: 'summary', preview: oneLine(entry.summary) };
  }
  if (entry.type === 'model_change') {
    return { role: 'system', preview: oneLine(entry.modelId) };
  }
  if (entry.type === 'thinking_level_change') {
    return { role: 'system', preview: oneLine(entry.thinkingLevel) };
  }
  if (entry.type === 'label') return { role: 'system', preview: oneLine(entry.label) };
  const customType = typeof entry.customType === 'string' ? entry.customType : String(entry.type ?? 'entry');
  return { role: 'system', preview: customType };
}

function normalizeNode(raw: unknown): SessionTreeNode | null {
  const node = recordOf(raw) as RawTreeNode | null;
  const entry = recordOf(node?.entry);
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return null;
  const described = describeEntry(entry);
  const children = Array.isArray(node?.children)
    ? node.children.map(normalizeNode).filter((child): child is SessionTreeNode => child !== null)
    : [];
  return {
    id: entry.id,
    parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
    kind: entryKind(entry.type),
    ...(described.role ? { role: described.role } : {}),
    preview: described.preview,
    ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
    ...(typeof node?.label === 'string' ? { label: node.label } : {}),
    ...(typeof node?.labelTimestamp === 'string' ? { labelTimestamp: node.labelTimestamp } : {}),
    children,
  };
}

export function normalizePiSessionTree(data: unknown): SessionTreeSnapshot {
  const payload = recordOf(data);
  const roots = Array.isArray(payload?.tree)
    ? payload.tree.map(normalizeNode).filter((node): node is SessionTreeNode => node !== null)
    : [];
  const leafId = typeof payload?.leafId === 'string' ? payload.leafId : null;
  const parents = new Map<string, string | null>();
  const walk = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      parents.set(node.id, node.parentId);
      walk(node.children);
    }
  };
  walk(roots);
  const reversed: string[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor && parents.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    reversed.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return { roots, leafId, activePathIds: reversed.reverse() };
}

function rawNodeMap(data: unknown): Map<string, UnknownRecord> {
  const payload = recordOf(data);
  const map = new Map<string, UnknownRecord>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      const node = recordOf(raw);
      const entry = recordOf(node?.entry);
      if (entry && typeof entry.id === 'string') map.set(entry.id, entry);
      walk(node?.children);
    }
  };
  walk(payload?.tree);
  return map;
}

function timestampOf(entry: UnknownRecord): number {
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const message = recordOf(entry.message);
  return typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? message.timestamp
    : Date.now();
}

function safeToolArguments(value: unknown): Record<string, unknown> {
  return recordOf(value) ?? {};
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Pi usage.input 是未命中缓存输入；cacheRead/cacheWrite 同样占据当前 context。 */
export function piContextTokensFromTree(
  data: unknown,
  snapshot: SessionTreeSnapshot = normalizePiSessionTree(data),
): number {
  const entries = rawNodeMap(data);
  let contextTokens = 0;
  for (const entryId of snapshot.activePathIds) {
    const entry = entries.get(entryId);
    if (!entry || entry.type !== 'message') continue;
    const message = recordOf(entry.message);
    if (message?.role !== 'assistant') continue;
    const usage = recordOf(message.usage);
    if (!usage) continue;
    contextTokens = finiteNonNegative(usage.input)
      + finiteNonNegative(usage.cacheRead)
      + finiteNonNegative(usage.cacheWrite);
  }
  return contextTokens;
}

export function activePiHistoryFromTree(
  data: unknown,
  snapshot: SessionTreeSnapshot = normalizePiSessionTree(data),
): SessionTreeHistoryMessage[] {
  const entries = rawNodeMap(data);
  const out: SessionTreeHistoryMessage[] = [];
  let lastCreatedAt = 0;
  const push = (message: Omit<SessionTreeHistoryMessage, 'createdAt'>, timestamp: number): void => {
    const createdAt = Math.max(timestamp, lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    out.push({ ...message, createdAt });
  };

  for (const entryId of snapshot.activePathIds) {
    const entry = entries.get(entryId);
    if (!entry || entry.type !== 'message') continue;
    const message = recordOf(entry.message);
    if (!message) continue;
    const baseTs = timestampOf(entry);
    if (message.role === 'user') {
      push({
        clientId: `pi-tree-${entryId}-user`,
        role: 'user',
        // Pi 的树只保存模型可消费的 content block，不保存 Cindy 托管附件 URL。
        // 这里不要伪造空数组覆盖 DB 里原用户消息的 images/files；Desktop 的
        // treeRehydrate 会按 entry uuid/稳定 clientId 合并回原附件元数据。
        content: { text: textFromContent(message.content) },
        agentMeta: { uuid: entryId },
      }, baseTs);
      continue;
    }
    if (message.role === 'assistant') {
      const meta = {
        uuid: entryId,
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
        ...(typeof message.stopReason === 'string' ? { stopReason: message.stopReason } : {}),
        ...(recordOf(message.usage) ? { usage: message.usage as Record<string, unknown> } : {}),
      };
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (let index = 0; index < blocks.length; index += 1) {
        const block = recordOf(blocks[index]);
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          push({
            clientId: `pi-tree-${entryId}-text-${index}`,
            role: 'assistant',
            content: block.text,
            agentMeta: meta,
          }, baseTs + index);
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          push({
            clientId: `pi-tree-${entryId}-thinking-${index}`,
            role: 'thinking',
            content: {
              kind: 'thinking',
              text: block.thinking,
              durationMs: 0,
              isRedacted: block.redacted === true,
              finishedAt: baseTs + index,
            },
            agentMeta: meta,
          }, baseTs + index);
        } else if (block.type === 'toolCall' && typeof block.id === 'string') {
          const toolName = typeof block.name === 'string' ? block.name : 'tool';
          push({
            clientId: `pi-tree-${entryId}-tool-${index}`,
            role: 'tool_use',
            toolUseId: block.id,
            content: { toolUseId: block.id, toolName, input: safeToolArguments(block.arguments) },
            agentMeta: meta,
          }, baseTs + index);
        }
      }
      continue;
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      push({
        clientId: `pi-tree-${entryId}-result`,
        role: 'tool_result',
        toolUseId: message.toolCallId,
        content: textFromContent(message.content),
        agentMeta: { uuid: entryId },
      }, baseTs);
    }
  }
  return out;
}

export function findPiTreeEntry(data: unknown, entryId: string): UnknownRecord | null {
  return rawNodeMap(data).get(entryId) ?? null;
}

export function userDraftTextFromPiEntry(entry: UnknownRecord | null): string | undefined {
  if (entry?.type !== 'message') return undefined;
  const message = recordOf(entry.message);
  if (message?.role !== 'user') return undefined;
  const text = textFromContent(message.content).trim();
  return text.length > 0 ? text : undefined;
}
