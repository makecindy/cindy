import type { HookControlManager } from './manager.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';

/** Main validates both the input and workspace ownership before requesting a change. */
export async function setSlackCommunicationsFromIpc(
  manager: Pick<HookControlManager, 'snapshot' | 'setSlackCommunications'>,
  payload: unknown,
) {
  const p = requireObject(payload);
  if (typeof p.teamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.teamId) || typeof p.enabled !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'Expected Slack teamId and boolean enabled');
  }
  const view = manager.snapshot();
  if (!view.serverSlackCommunications) throwIpcError('HOOK_MULTI_TEAM_UNSUPPORTED', 'Slack server does not support device communications');
  if (!view.bindings.some((b) => b.teamId === p.teamId)) throwIpcError('INVALID_PARAMS', 'Unknown Slack workspace');
  const result = await manager.setSlackCommunications(p.teamId, p.enabled);
  if (!result.ok) throwIpcError('HOOK_NOT_CONNECTED', 'Could not update local Slack communications');
  return { hook: manager.snapshot() };
}
