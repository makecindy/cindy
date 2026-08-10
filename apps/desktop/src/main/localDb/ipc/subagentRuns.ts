/** Read-only renderer IPC for Cindy-owned durable Subagent records. */

import { BrowserWindow, ipcMain } from 'electron';
import {
  SUBAGENT_RUNS_CHANGED_CHANNEL,
  type SubagentProvider,
  type SubagentRunDetailResponse,
  type SubagentRunsChangedPayload,
  type SubagentRunsListResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { getActiveDataOwnerPushStamp } from '../../appSessionState.js';
import {
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import {
  requireEnum,
  requireNonNegativeInt,
  requireObject,
  requireString,
} from '../../utils/ipcValidate.js';
import { getSubagentRunDetail, listSubagentRuns } from '../subagentRuns.js';

const SUBAGENT_PROVIDERS = [
  'claude-code',
  'codex',
  'pi',
] as const satisfies readonly SubagentProvider[];

export function broadcastSubagentRunsChanged(
  payload: SubagentRunsChangedPayload,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  const ownerStamp = hasCapturedScope
    ? ownerScope.ownerStamp
    : getActiveDataOwnerPushStamp();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) {
      try {
        window.webContents.send(SUBAGENT_RUNS_CHANGED_CHANNEL, payload, ownerStamp);
      } catch {
        // One closing renderer must not prevent invalidation of the others.
      }
    }
  }
}

export function broadcastSubagentRunsInvalidated(
  sessionId: string,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  broadcastSubagentRunsChanged(
    {
      sessionId,
      runId: null,
      created: false,
      firstForSession: false,
    },
    ownerScope,
  );
}

export function registerSubagentRunsIpc(): void {
  ipcMain.handle('local-db:subagent-runs:list', async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(input, 'subagent runs list input');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const cursor = body.cursor === undefined ? undefined : requireString(body.cursor, 'cursor');
    const limit = body.limit === undefined ? undefined : requireNonNegativeInt(body.limit, 'limit');
    const page = await listSubagentRuns(sessionId, { cursor, limit });
    return {
      supported: page !== null,
      runs: page?.runs ?? [],
      ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    } satisfies SubagentRunsListResponse;
  });

  ipcMain.handle('local-db:subagent-runs:detail', async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(input, 'subagent run detail input');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const provider = requireEnum(body.provider, SUBAGENT_PROVIDERS, 'provider');
    const runIdOrAlias = requireString(body.runIdOrAlias, 'runIdOrAlias');
    const run = await getSubagentRunDetail(sessionId, provider, runIdOrAlias);
    return {
      supported: run !== undefined,
      run: run ?? null,
    } satisfies SubagentRunDetailResponse;
  });
}
