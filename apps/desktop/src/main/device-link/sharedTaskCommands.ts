import type { SharedTaskApi, SharedTaskCloseResult, SharedTaskHostCommand, SharedTaskHostState, SharedTaskOwnedItem } from '@cindy/device-link';
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
export function captureSharedTaskAgentCommand(sessionId: string, assertCaller: () => void, deps: {
  ready(): Promise<void>; online(): boolean; available(): boolean; host(): SharedTaskHost | null;
  runScoped<T>(assertCurrent: () => void, work: () => Promise<T>): Promise<T>;
}): (command: SharedTaskHostCommand) => Promise<unknown> {
  assertCaller();
  // Host acquisition can restart a background reconciler. It must happen outside
  // the tool's async scope, and before any authorization/relay wait, so an owner's
  // intervening closure cannot become permission to open sharing again.
  const host = deps.host();
  const assertHost = host?.captureManagementScope(sessionId);
  const previousId = host?.activeSharedTaskIds().find(id => host.detail(id)?.sessionId === sessionId);
  let previousShareChanged = false;
  const assertCurrent = () => { assertCaller(); assertHost?.(); };
  return async command => {
    await deps.ready();
    assertCurrent();
    if (!deps.online()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Shared task relay is offline');
    if (deps.available() && !host) throwIpcError('PRECONDITION_FAILED', 'Shared task host changed; query again');
    return deps.runScoped(assertCurrent, async () => {
      assertCurrent();
      let result: unknown;
      if (command.action === 'state') {
        const available = !!host && deps.available();
        const detail = available ? await host!.readState(sessionId) : null;
        // A known share disappearing/replaced while preparing an invitation must
        // not turn the old request into permission to open a new share.
        if (previousId && detail?.sharedTaskId !== previousId) previousShareChanged = true;
        result = { available, detail };
      } else {
        if (previousShareChanged) throw new Error('Shared task management changed');
        result = await executeSharedTaskHostCommand(command, { available: () => !!host && deps.available(), host: () => host! });
      }
      assertCurrent();
      return result;
    });
  };
}

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
