import { createLogger } from '../../logger';
import { randomUUID } from 'node:crypto';
import { ipcMain, BrowserWindow } from 'electron';
import { TASK_TAG_PRESETS, type TaskTagRequest, type TaskTagResult } from '@cindy/maker-shared';
import { getDbClient } from '../client/current';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import {
  tapWindowBroadcast,
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../../device-link/broadcast-tap.js';
import { broadcastSessionPatched } from './sessions';
import { withTaskMigrationBoundary } from '../../task-migration/writeBoundary';
import { assertTaskMigrationWritable } from '../../task-migration/journal';

const log = createLogger('taskTags');
export const TASK_TAG_CHANNEL = 'local-db:task-tags:execute';
/** All surfaces share validation, transactions and owner-scoped task patches. */
export async function executeTaskTags(
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
  const transact = () => client.tx('taskTags.execute', {
    ...request,
    newId: preset?.id ?? randomUUID(),
    callerSessionId,
  });
  // Assignment writes share one admission boundary across local, remote and tool callers.
  // Catalog operations remain owner-wide; migration does not freeze the label directory.
  let result: TaskTagResult;
  if (request.action === 'attach' || request.action === 'detach') {
    if (!Array.isArray(request.sessionIds) || !request.sessionIds.length || request.sessionIds.length > 100)
      throw new Error('[INVALID_PARAMS] Invalid task tag targets');
    const ids = [...new Set(request.sessionIds.map(id => typeof id === 'string' ? id.trim() : ''))];
    result = await withTaskMigrationBoundary(ids, async () => {
      assertCurrent();
      ids.forEach(assertTaskMigrationWritable);
      return transact();
    });
  } else {
    result = await transact();
  }
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
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (isTrustedAppRendererWindow(window))
          window.webContents.send('local-db:task-tags:changed', payload, scope.ownerStamp);
      } catch {
        log.warn('task tag renderer broadcast failed');
      }
    }
  }
  return result;
}
export function registerTaskTagsIpc(): void {
  ipcMain.handle(TASK_TAG_CHANNEL, async (event, request: TaskTagRequest) => {
    assertTrustedAppRendererEvent(event);
    return executeTaskTags(request);
  });
}
