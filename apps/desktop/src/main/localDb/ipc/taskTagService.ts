import { randomUUID } from 'node:crypto';
import { TASK_TAG_PRESETS, type TaskTagRequest, type TaskTagResult } from '@cindy/maker-shared';
import { getDbClient } from '../client/current.js';
import { createLogger } from '../../logger.js';
import type { broadcastSessionPatched } from '../ipc/sessions.js';
import type * as BroadcastTap from '../../device-link/broadcast-tap.js';
import type { DataOwnerPushStamp } from '../../../shared/dataOwnerPush.js';

export const TASK_TAG_CHANNEL = 'local-db:task-tags:execute';
export function createTaskTagService(ports: Pick<typeof BroadcastTap,
  'captureDataOwnerBroadcastScope' | 'isDataOwnerBroadcastScopeCurrent' | 'tapWindowBroadcast'> & {
  broadcastSessionPatched: typeof broadcastSessionPatched;
  broadcastTagsChanged?: (payload: unknown, ownerStamp?: DataOwnerPushStamp) => void;
}) {
  const log = createLogger('taskTags');
  const { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent,
    tapWindowBroadcast, broadcastSessionPatched } = ports;
/**
 * All surfaces share validation, transactions and owner-scoped task patches.
 */
async function executeTaskTags(
  request: TaskTagRequest,
  callerSessionId?: string,
): Promise<TaskTagResult> {
  const scope = captureDataOwnerBroadcastScope();
  const assertCurrent = () => {
    if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('[NOT_FOUND] Owner changed');
  };
  assertCurrent();
  // Only known presets may claim a stable localized identity. Ordinary labels
  // retain generated IDs, including labels with the same visible name.
  const preset =
    request.action === 'create' && request.presetId !== undefined
      ? TASK_TAG_PRESETS.find((tag) => tag.id === request.presetId)
      : undefined;
  if (
    request.action === 'create' &&
    request.presetId !== undefined &&
    (!preset || request.name !== preset.name || request.color !== preset.color)
  ) {
    throw new Error('[INVALID_PARAMS] Invalid task tag preset');
  }
  const client = getDbClient();
  const result = await client.tx('taskTags.execute', {
    ...request,
    newId: preset?.id ?? randomUUID(),
    callerSessionId,
  });
  assertCurrent();
  if (['create', 'update', 'delete', 'attach', 'detach'].includes(request.action)) {
    for (const row of result.sessions)
      broadcastSessionPatched(row.sessionId, { tags: row.tags }, scope);
  }
  if (['create', 'update', 'delete', 'reorder', 'attach', 'detach'].includes(request.action)) {
    const payload = { tags: result.tags };
    // A closed renderer must not turn an already committed write into a failed request.
    try {
      tapWindowBroadcast('local-db:task-tags:changed', payload, scope.ownerStamp);
    } catch {
      log.warn('task tag device-link broadcast failed');
    }
    ports.broadcastTagsChanged?.(payload, scope.ownerStamp);
  }
  return result;
}
return { executeTaskTags };
}
