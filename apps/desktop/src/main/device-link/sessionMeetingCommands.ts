import type { SessionMeetingApi, SessionMeetingHostState } from '@cindy/device-link';
import type { SessionMeetingHost } from './sessionMeetingHost.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';

function command(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'Meeting command is required');
  return raw as Record<string, unknown>;
}
function id(value: unknown): string {
  const text = requireString(value, 'identifier');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throwIpcError('INVALID_PARAMS', 'Invalid meeting identifier');
  return text;
}

/** Owner management is never exposed through guest task invoke permissions. */
export async function executeSessionMeetingHostCommand(raw: unknown, deps: {
  available(): boolean; host(): SessionMeetingHost;
}): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'state') {
    const sessionId = id(input.sessionId);
    if (!deps.available()) return { available: false, detail: null } satisfies SessionMeetingHostState;
    const host = deps.host();
    const meetingId = host.activeMeetingIds().find((key) => host.detail(key)?.sessionId === sessionId);
    if (!meetingId) return { available: true, detail: null } satisfies SessionMeetingHostState;
    await host.refresh(meetingId);
    const detail = host.detail(meetingId);
    return { available: true, detail } satisfies SessionMeetingHostState;
  }
  if (!deps.available()) throwIpcError('UNSUPPORTED_CAPABILITY', 'Meeting mode requires updated clients and server');
  const host = deps.host();
  if (input.action === 'open') return { meetingId: await host.open(id(input.sessionId)) };
  const meetingId = id(input.meetingId);
  if (input.action === 'invite') return host.invite(meetingId);
  if (input.action === 'close') { await host.close(meetingId); return { ok: true }; }
  if (input.action === 'remove') { await host.remove(meetingId, id(input.memberId)); return { ok: true }; }
  throwIpcError('INVALID_PARAMS', 'Unknown meeting command');
}

/** Account API uses the caller's login, never the host's credentials. */
export async function executeSessionMeetingAccountCommand(raw: unknown, api: SessionMeetingApi, accountId?: string): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'list') return (await api.list()).filter((item) => item.ownerAccountId !== accountId);
  if (input.action === 'join') return api.join(requireString(input.invitation, 'invitation'), requireString(input.displayName, 'displayName'));
  const meetingId = id(input.meetingId);
  if (input.action === 'get') return api.get(meetingId);
  if (input.action === 'leave') return api.leave(meetingId);
  throwIpcError('INVALID_PARAMS', 'Unknown meeting account command');
}
