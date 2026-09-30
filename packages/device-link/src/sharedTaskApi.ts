import { parseSharedTaskSnapshot, SHARED_TASK_MAX_SNAPSHOT_GUESTS, type SharedTaskIdentity, type SharedTaskSnapshot } from './sharedTask.js';
import { sharedTaskDeviceId } from './protocol.js';

export const SHARED_TASK_HOST_CHANNEL = 'maker:shared-task';
export const SHARED_TASK_ACCOUNT_CHANNEL = 'shared-task:account';
export type SharedTaskHostCommand =
  | { action: 'state' | 'open'; sessionId: string }
  | { action: 'invite' | 'close'; sharedTaskId: string }
  | { action: 'remove'; sharedTaskId: string; memberId: string };
export type SharedTaskAccountCommand =
  | { action: 'list' }
  | { action: 'owned' }
  | { action: 'close'; sharedTaskId?: string; all?: true }
  | { action: 'get' | 'leave'; sharedTaskId: string }
  | { action: 'join'; invitation: string; displayName: string };
export interface SharedTaskHostState {
  available: boolean;
  detail: SharedTaskDetail | null;
}

export interface SharedTaskListItem extends SharedTaskIdentity { title: string; revision: number }
/** Items this profile hosts carry the local flag so the window can label this device. */
export type SharedTaskOwnedItem = SharedTaskListItem & { local: boolean };
export interface SharedTaskCloseResult { closed: string[]; failed: { sharedTaskId: string }[] }
export interface SharedTaskDetail extends SharedTaskSnapshot {
  readonly title: string;
  readonly memberLabels: readonly { memberId: string; displayName: string; joinedAt: number | null }[];
}
export interface SharedTaskApiOptions {
  /** Use Desktop serverApiFetch / Mobile apiFetch; no independent auth or retry stack. */
  request(path: string, options: { method: 'GET' | 'POST'; body?: unknown; isCurrent(): boolean }): Promise<unknown>;
  /** Captures account AND region generation; false rejects late success after logout/switch. */
  captureScope(): { isCurrent(): boolean };
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sharedTask response');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid sharedTask identifier');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid sharedTask label');
  return value;
}
function sharedTaskTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid sharedTask title');
  // The server currently accepts at most 128 UTF-16 code units. Shared-task
  // metadata is a bounded projection; keep the local session title untouched.
  const title = value.trim();
  let end = Math.min(title.length, 128);
  if (end < title.length && /[\uD800-\uDBFF]/.test(title[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(title[end] ?? '')) end--;
  return title.slice(0, end);
}
function integer(value: unknown, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('Invalid sharedTask number');
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid sharedTask list');
  return value;
}
function matching(value: unknown, expected: string): string {
  if (id(value) !== expected) throw new Error('SharedTask response scope mismatch');
  return expected;
}

export class SharedTaskScopeChangedError extends Error {
  constructor() { super('SharedTask account or region changed'); this.name = 'SharedTaskScopeChangedError'; }
}

/** Management API only; never authorizes full-device IPC or enables a legacy relay. */
export function createSharedTaskApi(options: SharedTaskApiOptions) {
  async function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, observe?: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const scope = options.captureScope();
    if (!scope.isCurrent()) throw new SharedTaskScopeChangedError();
    const value = await options.request(`/api/device-link/shared-tasks${path}`, {
      method, ...(body === undefined ? {} : { body }), isCurrent: () => scope.isCurrent(),
    });
    const parsed = row(value);
    // Creation cleanup must learn the committed ID even after an auth boundary.
    // This observer is host-owned bookkeeping, never a success delivery to UI.
    observe?.(parsed);
    if (!scope.isCurrent()) throw new SharedTaskScopeChangedError();
    return parsed;
  }
  const route = (sharedTaskId: string) => `/${encodeURIComponent(id(sharedTaskId))}`;
  return {
    async create(sessionId: string, title: string, observeCommitted?: (sharedTaskId: string) => void) {
      const value = await request('', 'POST', { sessionId: id(sessionId), title: sharedTaskTitle(title) }, (value) => {
        observeCommitted?.(id(value.sharedTaskId));
      });
      return { sharedTaskId: id(value.sharedTaskId), revision: integer(value.revision) };
    },
    async list(): Promise<SharedTaskListItem[]> {
      const value = await request('');
      const seen = new Set<string>();
      return array(value.sharedTasks, 10_000).map((item) => {
        const value = row(item);
        const sharedTaskId = id(value.sharedTaskId);
        if (seen.has(sharedTaskId)) throw new Error('Duplicate sharedTask');
        seen.add(sharedTaskId);
        return { sharedTaskId, sessionId: id(value.sessionId), ownerAccountId: id(value.ownerAccountId),
          hostDeviceId: sharedTaskDeviceId(value.hostDeviceId), title: label(value.title), revision: integer(value.revision) };
      });
    },
    async get(sharedTaskId: string): Promise<SharedTaskDetail> {
      const value = await request(route(sharedTaskId));
      matching(value.sharedTaskId, sharedTaskId);
      const snapshot = parseSharedTaskSnapshot(value);
      const memberLabels = array(value.guests, SHARED_TASK_MAX_SNAPSHOT_GUESTS).map((item) => {
        const member = row(item);
        return Object.freeze({ memberId: id(member.memberId), displayName: label(member.displayName),
          joinedAt: member.joinedAt === null ? null : integer(member.joinedAt, 0) });
      });
      return Object.freeze({ ...snapshot, title: label(value.title), memberLabels: Object.freeze(memberLabels) });
    },
    async invite(sharedTaskId: string) {
      const value = await request(`${route(sharedTaskId)}/invites`, 'POST', {});
      matching(value.sharedTaskId, sharedTaskId);
      if (typeof value.invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.invitation)) throw new Error('Invalid sharedTask invitation');
      return { sharedTaskId, invitation: value.invitation };
    },
    async join(invitation: string, displayName: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(invitation)) throw new Error('Invalid sharedTask invitation');
      const value = await request('/join', 'POST', { invitation, displayName: label(displayName) });
      if (value.status !== 'joined' || typeof value.created !== 'boolean') throw new Error('Invalid sharedTask admission');
      return { sharedTaskId: id(value.sharedTaskId), memberId: id(value.memberId), status: value.status,
        created: value.created };
    },
    async remove(sharedTaskId: string, memberId: string) {
      const value = await request(`${route(sharedTaskId)}/members/${encodeURIComponent(id(memberId))}/remove`, 'POST', {});
      if (value.status !== 'removed') throw new Error('Invalid sharedTask removal response');
      return { memberId: matching(value.memberId, memberId), status: 'removed' as const };
    },
    async leave(sharedTaskId: string) {
      const value = await request(`${route(sharedTaskId)}/leave`, 'POST', {});
      if (value.status !== 'left') throw new Error('Invalid sharedTask departure response');
      return { memberId: id(value.memberId), status: 'left' as const };
    },
    async close(sharedTaskId: string) {
      const value = await request(`${route(sharedTaskId)}/close`, 'POST', {});
      if (value.status !== 'closed') throw new Error('Invalid sharedTask closure response');
      return { sharedTaskId: matching(value.sharedTaskId, sharedTaskId), status: 'closed' as const };
    },
  };
}

export type SharedTaskApi = ReturnType<typeof createSharedTaskApi>;
