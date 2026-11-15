import type { ContextTextEstimate } from '@cindy/maker-shared/session-controls';

export interface PiPromptSource {
  source: string;
  text: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

// Display-only heuristic, deliberately separate from native usage/billing/window
// accounting. ASCII averages four characters per token; non-ASCII counts as one.
function estimate(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! < 128 ? 0.25 : 1;
  return Math.ceil(units);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const block = record(part);
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return block.thinking;
    if (block?.type === 'toolCall') return JSON.stringify({ name: block.name, arguments: block.arguments });
    // Image bytes, signatures and provider metadata are not text tokens.
    return '';
  }).filter(Boolean).join('\n');
}

/** Read Pi's active get_messages projection, never the unpruned session tree. */
export function estimatePiContext(messages: unknown, sources: PiPromptSource[]): ContextTextEstimate | undefined {
  if (!Array.isArray(messages)) return undefined;
  const sections = new Map<string, string>();
  const tools = new Map<string, RecordValue>();
  const totals = new Map<string, number>();
  let hasSystem = false;
  const add = (source: string, text: string) => {
    if (text.trim()) totals.set(source, (totals.get(source) ?? 0) + estimate(text));
  };
  const toolKey = (tool: RecordValue) => JSON.stringify([tool.namespace ?? '', tool.name]);
  for (const value of messages) {
    const message = record(value);
    if (!message) continue;
    if (message.role !== 'system') {
      add('messages', contentText(message.content));
      // Pi's native compaction / branch summary messages carry summary separately.
      if (typeof message.summary === 'string') add('messages', message.summary);
      continue;
    }
    hasSystem = true;
    add('native', contentText(message.content));
    for (const [key, text] of Object.entries(record(message.sections) ?? {})) {
      if (text === null) sections.delete(key);
      else if (typeof text === 'string') sections.set(key, text);
    }
    for (const value of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : []) {
      const tool = record(value);
      if (tool) tools.delete(toolKey(tool));
    }
    for (const value of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
      const tool = record(value);
      if (tool && typeof tool.name === 'string') tools.set(toolKey(tool), tool);
    }
  }
  // Older Pi versions may not expose system snapshots; avoid a misleading partial bill.
  if (!hasSystem) return undefined;
  for (const [key, text] of sections) {
    if (key === 'addendum') {
      let remaining = text;
      for (const source of sources) {
        const index = remaining.indexOf(source.text);
        if (!source.text || index < 0) continue;
        add(source.source, source.text);
        remaining = remaining.slice(0, index) + remaining.slice(index + source.text.length);
      }
      add('other', remaining.replace(/<\/?addendum>/g, ''));
    } else {
      add(key === 'skills' ? 'skills' : key === 'project_context' ? 'project' : 'native', text);
    }
  }
  for (const tool of tools.values()) {
    add('tools', JSON.stringify({ name: tool.name, namespace: tool.namespace,
      description: tool.description, parameters: tool.parameters }));
  }
  const order = ['delivery', 'host', 'plugins', 'memoryRules', 'memoryIndex', 'profile',
    'user', 'directories', 'native', 'skills', 'project', 'other', 'tools', 'messages'];
  return { method: 'text-heuristic', items: order.flatMap(source => {
    const tokens = totals.get(source);
    return tokens === undefined ? [] : [{ source, tokens }];
  }) };
}
