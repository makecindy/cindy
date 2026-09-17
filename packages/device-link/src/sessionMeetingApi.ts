import { parseSessionMeetingSnapshot, type SessionMeetingIdentity, type SessionMeetingSnapshot } from './sessionMeeting.js';

export const SESSION_MEETING_HOST_CHANNEL = 'maker:session-meeting';
export const SESSION_MEETING_ACCOUNT_CHANNEL = 'session-meeting:account';
export type SessionMeetingHostCommand =
  | { action: 'state' | 'open'; sessionId: string }
  | { action: 'invite' | 'close'; meetingId: string }
  | { action: 'remove'; meetingId: string; memberId: string };
export type SessionMeetingAccountCommand =
  | { action: 'list' }
  | { action: 'get' | 'leave'; meetingId: string }
  | { action: 'join'; invitation: string; displayName: string };
export interface SessionMeetingHostState {
  available: boolean;
  detail: SessionMeetingDetail | null;
}

export interface SessionMeetingListItem extends SessionMeetingIdentity { title: string; revision: number }
export interface SessionMeetingDetail extends SessionMeetingSnapshot {
  readonly title: string;
  readonly memberLabels: readonly { memberId: string; displayName: string; joinedAt: number | null }[];
}
export interface SessionMeetingApiOptions {
  /** Use Desktop serverApiFetch / Mobile apiFetch; no independent auth or retry stack. */
  request(path: string, options: { method: 'GET' | 'POST'; body?: unknown; isCurrent(): boolean }): Promise<unknown>;
  /** Captures account AND region generation; false rejects late success after logout/switch. */
  captureScope(): { isCurrent(): boolean };
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid meeting response');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid meeting identifier');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid meeting label');
  return value;
}
function integer(value: unknown, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('Invalid meeting number');
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid meeting list');
  return value;
}
function matching(value: unknown, expected: string): string {
  if (id(value) !== expected) throw new Error('Meeting response scope mismatch');
  return expected;
}

export class SessionMeetingScopeChangedError extends Error {
  constructor() { super('Meeting account or region changed'); this.name = 'SessionMeetingScopeChangedError'; }
}

/** Management API only; never authorizes full-device IPC or enables a legacy relay. */
export function createSessionMeetingApi(options: SessionMeetingApiOptions) {
  async function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, observe?: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const scope = options.captureScope();
    if (!scope.isCurrent()) throw new SessionMeetingScopeChangedError();
    const value = await options.request(`/api/device-link/meetings${path}`, {
      method, ...(body === undefined ? {} : { body }), isCurrent: () => scope.isCurrent(),
    });
    const parsed = row(value);
    // Creation cleanup must learn the committed ID even after an auth boundary.
    // This observer is host-owned bookkeeping, never a success delivery to UI.
    observe?.(parsed);
    if (!scope.isCurrent()) throw new SessionMeetingScopeChangedError();
    return parsed;
  }
  const route = (meetingId: string) => `/${encodeURIComponent(id(meetingId))}`;
  return {
    async create(sessionId: string, title: string, observeCommitted?: (meetingId: string) => void) {
      const value = await request('', 'POST', { sessionId: id(sessionId), title: label(title) }, (value) => {
        observeCommitted?.(id(value.meetingId));
      });
      return { meetingId: id(value.meetingId), revision: integer(value.revision) };
    },
    async list(): Promise<SessionMeetingListItem[]> {
      const value = await request('');
      const seen = new Set<string>();
      return array(value.meetings, 10_000).map((item) => {
        const value = row(item);
        const meetingId = id(value.meetingId);
        if (seen.has(meetingId)) throw new Error('Duplicate meeting');
        seen.add(meetingId);
        return { meetingId, sessionId: id(value.sessionId), ownerAccountId: id(value.ownerAccountId),
          hostDeviceId: id(value.hostDeviceId), title: label(value.title), revision: integer(value.revision) };
      });
    },
    async get(meetingId: string): Promise<SessionMeetingDetail> {
      const value = await request(route(meetingId));
      matching(value.meetingId, meetingId);
      const snapshot = parseSessionMeetingSnapshot(value);
      const memberLabels = array(value.guests, 3).map((item) => {
        const member = row(item);
        return Object.freeze({ memberId: id(member.memberId), displayName: label(member.displayName),
          joinedAt: member.joinedAt === null ? null : integer(member.joinedAt, 0) });
      });
      return Object.freeze({ ...snapshot, title: label(value.title), memberLabels: Object.freeze(memberLabels) });
    },
    async invite(meetingId: string) {
      const value = await request(`${route(meetingId)}/invites`, 'POST', {});
      matching(value.meetingId, meetingId);
      if (typeof value.invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.invitation)) throw new Error('Invalid meeting invitation');
      return { meetingId, invitation: value.invitation };
    },
    async join(invitation: string, displayName: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(invitation)) throw new Error('Invalid meeting invitation');
      const value = await request('/join', 'POST', { invitation, displayName: label(displayName) });
      if (value.status !== 'joined' || typeof value.created !== 'boolean') throw new Error('Invalid meeting admission');
      return { meetingId: id(value.meetingId), memberId: id(value.memberId), status: value.status,
        created: value.created };
    },
    async remove(meetingId: string, memberId: string) {
      const value = await request(`${route(meetingId)}/members/${encodeURIComponent(id(memberId))}/remove`, 'POST', {});
      if (value.status !== 'removed') throw new Error('Invalid meeting removal response');
      return { memberId: matching(value.memberId, memberId), status: 'removed' as const };
    },
    async leave(meetingId: string) {
      const value = await request(`${route(meetingId)}/leave`, 'POST', {});
      if (value.status !== 'left') throw new Error('Invalid meeting departure response');
      return { memberId: id(value.memberId), status: 'left' as const };
    },
    async close(meetingId: string) {
      const value = await request(`${route(meetingId)}/close`, 'POST', {});
      if (value.status !== 'closed') throw new Error('Invalid meeting closure response');
      return { meetingId: matching(value.meetingId, meetingId), status: 'closed' as const };
    },
  };
}

export type SessionMeetingApi = ReturnType<typeof createSessionMeetingApi>;
