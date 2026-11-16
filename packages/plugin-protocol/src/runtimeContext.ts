/** Data supplied by runtime providers. Origin is always attached by the Host. */
export interface GhostContextBlock { id: string; text: string }
export interface GhostMemoryEntry { id: string; title: string; content: string; type?: 'user' | 'feedback' | 'project' | 'reference' }
export interface GhostSystemPromptFragment {
  id: string;
  text: string;
  order: number;
  scope: 'selected-task';
  agentKinds?: Array<'cc' | 'codex' | 'pi'>;
}
export const GHOST_CONTEXT_MAX_CHARS = 32768;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export function parseGhostSystemPromptFragments(value: unknown): GhostSystemPromptFragment[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const result: GhostSystemPromptFragment[] = [];
  const ids = new Set<string>();
  let size = 0;
  for (const item of value) {
    if (!record(item) || !text(item.id, 128) || ids.has(item.id) || !text(item.text, GHOST_CONTEXT_MAX_CHARS)
      || !item.text.trim() || (size += item.text.length) > GHOST_CONTEXT_MAX_CHARS
      || typeof item.order !== 'number' || !Number.isSafeInteger(item.order) || item.scope !== 'selected-task'
      || (item.agentKinds !== undefined && (!Array.isArray(item.agentKinds) || !item.agentKinds.length
        || !item.agentKinds.every(kind => ['cc', 'codex', 'pi'].includes(kind))))) return undefined;
    ids.add(item.id);
    result.push({ id: item.id, text: item.text, order: item.order, scope: 'selected-task',
      ...(Array.isArray(item.agentKinds) ? { agentKinds: [...new Set(item.agentKinds)] as GhostSystemPromptFragment['agentKinds'] } : {}) });
  }
  return result;
}

export function parseGhostContextBlocks(value: unknown): GhostContextBlock[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  let size = 0;
  const ids = new Set<string>();
  const result: GhostContextBlock[] = [];
  for (const block of value) {
    if (!record(block) || !text(block.id, 128) || !text(block.text, GHOST_CONTEXT_MAX_CHARS)
      || ids.has(block.id) || (size += block.text.length) > GHOST_CONTEXT_MAX_CHARS) return undefined;
    ids.add(block.id);
    result.push({ id: block.id, text: block.text });
  }
  return result;
}

export function parseGhostMemoryEntries(value: unknown): GhostMemoryEntry[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  let size = 0;
  const ids = new Set<string>();
  const result: GhostMemoryEntry[] = [];
  for (const item of value) {
    if (!record(item) || !text(item.id, 128) || !text(item.title, 256) || !text(item.content, GHOST_CONTEXT_MAX_CHARS)
      || ids.has(item.id) || (size += item.content.length) > GHOST_CONTEXT_MAX_CHARS
      || (item.type !== undefined && (typeof item.type !== 'string' || !['user', 'feedback', 'project', 'reference'].includes(item.type)))) return undefined;
    ids.add(item.id);
    result.push({ id: item.id, title: item.title, content: item.content,
      ...(item.type ? { type: item.type as GhostMemoryEntry['type'] } : {}) });
  }
  return result;
}
