import type { PluginUiEntry } from './PluginUiContributions';

export interface PluginUiCompletion {
  id: string;
  providerId: string;
  label: string;
  insertText: string;
  description?: string;
  instanceId: string;
  source: string;
}
export async function collectPluginUiCompletions(
  entries: readonly PluginUiEntry[], trigger: '/' | '@', query: string, signal: AbortSignal,
  call: (entry: PluginUiEntry, input: { trigger: '/' | '@'; query: string }, signal: AbortSignal) => Promise<unknown>,
): Promise<PluginUiCompletion[]> {
  if (signal.aborted) return [];
  const results = await Promise.all(entries.filter(entry => entry.contribution.trigger === trigger).map(async entry => {
    let result: {
      isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[];
    };
    try { result = await call(entry, { trigger, query }, signal) as typeof result; } catch { return []; }
    if (signal.aborted || result?.isError) return [];
    let value = result?.structuredContent;
    if (!value) {
      try { value = JSON.parse(result?.content?.find(item => item.type === 'text')?.text ?? ''); } catch { return []; }
    }
    const items = value && typeof value === 'object' && 'items' in value ? value.items : undefined;
    if (!Array.isArray(items)) return [];
    const ids = new Set<string>();
    return items.slice(0, 8).flatMap((item): PluginUiCompletion[] => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 64 || ids.has(item.id) || typeof item.label !== 'string' ||
          !item.label.trim() || item.label.length > 200 || typeof item.insertText !== 'string' || item.insertText.length > 32768 ||
          item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 2000)) return [];
      ids.add(item.id);
      return [{ id: item.id, providerId: entry.contribution.id, label: item.label, insertText: item.insertText,
        ...(item.description ? { description: item.description } : {}), instanceId: entry.instanceId, source: entry.ghost.manifest.name }];
    });
  }));
  return signal.aborted ? [] : results.flat();
}
