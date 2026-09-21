import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';

export const PASSPORT_MAX_TASKS = 8;
const WIDTHS = [40, 80, 16, 192] as const;
const ITEM_BYTES = 328;
const STATES: Record<AgentIslandSessionActivity['phase'], string> = {
  running: 'running', 'needs-interaction': 'waiting', completed: 'done', error: 'failed',
};
export interface PassportTask { id: string; title: string; status: string; message: string }
/** One selectable task as the Mac knows it; the title stays null until the user names it. */
export interface PassportTaskSource { id: string; title: string | null }
const RANK: Record<AgentIslandSessionActivity['phase'], number> = {
  'needs-interaction': 0, error: 1, running: 2, completed: 3,
};
/**
 * The Mac's task catalog decides what the device may show; island activity only
 * supplies the live state, because an idle session leaves the island within its TTL.
 * Catalog order already carries recency, so listed tasks keep a stable, useful order.
 */
export function passportTasks(
  catalog: readonly PassportTaskSource[],
  activity: readonly AgentIslandSessionActivity[],
  selectedId?: string,
): PassportTask[] {
  const live = new Map(activity.map((item) => [item.sessionId, item]));
  const usable = catalog.filter((task) => task.id && Buffer.byteLength(task.id) < 40);
  const order = (id: string): [number, number] => {
    const item = live.get(id)!;
    return [RANK[item.phase], -(item.lastActivityAtMs ?? 0)];
  };
  const active = usable.filter((task) => live.has(task.id)).sort((left, right) => {
    const [leftRank, leftAt] = order(left.id);
    const [rightRank, rightAt] = order(right.id);
    return leftRank - rightRank || leftAt - rightAt;
  });
  const visible = [...active, ...usable.filter((task) => !live.has(task.id))].slice(0, PASSPORT_MAX_TASKS);
  const selected = usable.find((task) => task.id === selectedId);
  if (selected && !visible.some((task) => task.id === selectedId)) {
    if (visible.length === PASSPORT_MAX_TASKS) visible.pop();
    visible.push(selected);
  }
  return visible.map((task) => {
      const item = live.get(task.id);
      // A task without live activity is not running: the island drops it when the turn ends.
      return { id: task.id, title: task.title ?? '', status: item ? STATES[item.phase] : 'done',
        message: item ? item.currentActionSummary ?? item.compactDetail : '' };
    });
}
/** Preserve observed terminal states after the activity overlay clears them.
 * The current catalog remains authoritative for archive/delete/owner changes.
 */
export class PassportTaskHistory {
  private terminal = new Map<string, AgentIslandSessionActivity>();
  observe(activity: readonly AgentIslandSessionActivity[]): void {
    for (const item of activity) {
      this.terminal.delete(item.sessionId);
      if (item.phase === 'completed' || item.phase === 'error') this.terminal.set(item.sessionId, item);
    }
    while (this.terminal.size > 100) this.terminal.delete(this.terminal.keys().next().value!);
  }
  tasks(catalog: readonly PassportTaskSource[], activity: readonly AgentIslandSessionActivity[], selectedId?: string): PassportTask[] {
    const known = new Set(catalog.map((task) => task.id));
    for (const id of this.terminal.keys()) if (!known.has(id)) this.terminal.delete(id);
    const current = new Map(this.terminal);
    for (const item of activity) current.set(item.sessionId, item);
    return passportTasks(catalog, [...current.values()], selectedId);
  }
  clear(): void { this.terminal.clear(); }
}

export function encodeSnapshot(tasks: readonly PassportTask[]): Buffer {
  if (tasks.length > PASSPORT_MAX_TASKS) throw new Error('Too many Passport tasks');
  const frame = Buffer.alloc(4 + tasks.length * ITEM_BYTES);
  frame.writeUInt16LE(frame.length - 2, 0); frame[2] = 1; frame[3] = tasks.length;
  const ids = new Set<string>();
  tasks.forEach((task, i) => {
    if (!task.id || task.id.includes('\0') || Buffer.byteLength(task.id) >= 40 || ids.has(task.id))
      throw new Error('Invalid Passport task ID');
    ids.add(task.id);
    let offset = 4 + i * ITEM_BYTES;
    [task.id, task.title, task.status, task.message].forEach((text, field) => {
      let size = 0;
      for (const char of text.replaceAll('\0', '')) {
        const bytes = Buffer.from(char);
        if (size + bytes.length >= WIDTHS[field]) break;
        bytes.copy(frame, offset + size); size += bytes.length;
      }
      offset += WIDTHS[field];
    });
  });
  return frame;
}
export type PassportAction = { kind: 'action'; action: number; id: string; token: number };

/** Three rows plus the page counter fit the device font line height; each page stays inside the v1 192-byte field. */
export function passportTextPage(text: string, requested: number): { page: number; count: number; message: string } {
  const pages: string[] = [];
  let page = '', columns = 0, rows = 1;
  const flush = (): void => { pages.push(page); page = ''; columns = 0; rows = 1; };
  for (const char of text.replaceAll('\0', '').replaceAll('\r', '')) {
    if (char !== '\n' && columns >= 13) {
      if (rows === 3) flush();
      else { page += '\n'; rows++; columns = 0; }
    }
    if (Buffer.byteLength(page + char) > 156) flush();
    if (char === '\n') {
      if (rows === 3) flush();
      else { page += char; rows++; columns = 0; }
    } else { page += char; columns++; }
  }
  if (page || !pages.length) pages.push(page);
  const index = Math.max(0, Math.min(pages.length - 1, requested));
  return { page: index, count: pages.length, message: `[${index + 1}/${pages.length}]\n${pages[index]}` };
}

export function parseHelperLine(line: string): { kind: 'ready' | 'idle' | 'disconnected' } | { kind: 'open'; id: string } | PassportAction | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('kind' in value)) return null;
    if (value.kind === 'ready' || value.kind === 'idle' || value.kind === 'disconnected') return { kind: value.kind };
    if (value.kind === 'open' && 'id' in value && typeof value.id === 'string' &&
        value.id.length > 0 && Buffer.byteLength(value.id) < 40 && !value.id.includes('\0'))
      return { kind: 'open', id: value.id };
    if (value.kind === 'action' && 'id' in value && typeof value.id === 'string' &&
        value.id.length > 0 && Buffer.byteLength(value.id) < 40 && !value.id.includes('\0') &&
        'action' in value && typeof value.action === 'number' && Number.isInteger(value.action) && value.action >= 1 && value.action <= 6 &&
        'token' in value && typeof value.token === 'number' && Number.isInteger(value.token) && value.token >= 0 && value.token <= 0xffffffff) {
      return { kind: 'action', action: value.action, id: value.id, token: value.token };
    }
  } catch { /* Invalid child output has no authority. */ }
  return null;
}
