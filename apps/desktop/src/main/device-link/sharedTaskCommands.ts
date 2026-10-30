import type { SharedTaskApi, SharedTaskCloseResult, SharedTaskHostState, SharedTaskOwnedItem } from '@cindy/device-link';
import type { SharedTaskHost } from './sharedTaskHost.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';

function command(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'SharedTask command is required');
  return raw as Record<string, unknown>;
}
function id(value: unknown): string {
  const text = requireString(value, 'identifier');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throwIpcError('INVALID_PARAMS', 'Invalid sharedTask identifier');
  return text;
}

/** Owner management is never exposed through guest task invoke permissions. */
export async function executeSharedTaskHostCommand(raw: unknown, deps: {
  available(): boolean; host(): SharedTaskHost;
}): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'state') {
    const sessionId = id(input.sessionId);
    if (!deps.available()) return { available: false, detail: null } satisfies SharedTaskHostState;
    const host = deps.host();
    const sharedTaskId = host.activeSharedTaskIds().find((key) => host.detail(key)?.sessionId === sessionId);
    if (!sharedTaskId) return { available: true, detail: null } satisfies SharedTaskHostState;
    await host.refresh(sharedTaskId);
    const detail = host.detail(sharedTaskId);
    return { available: true, detail } satisfies SharedTaskHostState;
  }
  if (!deps.available()) throwIpcError('UNSUPPORTED_CAPABILITY', 'SharedTask mode requires updated clients and server');
  const host = deps.host();
  if (input.action === 'open') return { sharedTaskId: await host.open(id(input.sessionId)) };
  const sharedTaskId = id(input.sharedTaskId);
  if (input.action === 'invite') return host.invite(sharedTaskId);
  if (input.action === 'close') { await host.close(sharedTaskId); return { ok: true }; }
  if (input.action === 'remove') { await host.remove(sharedTaskId, id(input.memberId)); return { ok: true }; }
  throwIpcError('INVALID_PARAMS', 'Unknown sharedTask command');
}

/** Account API uses the caller's login, never the host's credentials. */
export async function executeSharedTaskAccountCommand(raw: unknown, api: SharedTaskApi, accountId?: string, deps?: {
  /** Shared tasks hosted by THIS profile; closable through the local host journal. */
  hostedIds?(): string[];
  closeHosted?(sharedTaskId: string): Promise<void>;
}): Promise<unknown> {
  const input = command(raw);
  if (input.action === 'list') return (await api.list()).filter((item) => item.ownerAccountId !== accountId);
  if (input.action === 'owned') {
    if (!accountId) return [] satisfies SharedTaskOwnedItem[];
    const hosted = deps?.hostedIds?.() ?? [];
    return (await api.list())
      .filter((item) => item.ownerAccountId === accountId)
      .map((item) => ({ ...item, local: hosted.includes(item.sharedTaskId) })) satisfies SharedTaskOwnedItem[];
  }
  if (input.action === 'close') {
    const result: SharedTaskCloseResult = { closed: [], failed: [] };
    const targets = input.all === true
      ? (await api.list()).filter((item) => item.ownerAccountId === accountId).map((item) => item.sharedTaskId)
      : [id(input.sharedTaskId)];
    for (const sharedTaskId of targets) {
      try {
        // Locally hosted tasks must go through the host so the closure is
        // journaled and guests are revoked before the server answers.
        if (deps?.hostedIds?.().includes(sharedTaskId) && deps.closeHosted) await deps.closeHosted(sharedTaskId);
        else await api.close(sharedTaskId);
        result.closed.push(sharedTaskId);
      } catch { result.failed.push({ sharedTaskId }); }
    }
    return result;
  }
  if (input.action === 'join') return api.join(requireString(input.invitation, 'invitation'), requireString(input.displayName, 'displayName'));
  const sharedTaskId = id(input.sharedTaskId);
  if (input.action === 'get') return api.get(sharedTaskId);
  if (input.action === 'leave') return api.leave(sharedTaskId);
  throwIpcError('INVALID_PARAMS', 'Unknown sharedTask account command');
}
