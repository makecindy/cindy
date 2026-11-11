/** Electron presentation and caller validation around the common Subagent service. */
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  SUBAGENT_RUNS_CHANGED_CHANNEL,
  type SubagentRunsChangedPayload,
} from '@cindy/maker-shared/subagent-workspace';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, getActiveDataOwnerPushStamp } from '../../appSessionState.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import {
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import {
  createSubagentReadService,
  type DurableWriteEnqueue,
  type ParentPiSessionLivePredicate,
} from './subagentReadService.js';

let service = createSubagentReadService({
  getUserDataDir: () => app.getPath('userData'),
  activeOwnerScopeKey: () => activeOwnerScopeKey(),
  isBoundaryPending: () => isAppSessionBoundaryPending(),
});
export function __resetSubagentReconcileFingerprintsForTests(): void {
  service.resetReconcileFingerprints();
}

export function broadcastSubagentRunsChanged(
  payload: SubagentRunsChangedPayload,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  const ownerStamp = hasCapturedScope ? ownerScope.ownerStamp : getActiveDataOwnerPushStamp();
  // Controllers of this task receive the same change over device-link (session topic),
  // so their Subagent tab discovery can stop polling the list every few seconds.
  if (hasCapturedScope) tapWindowBroadcast(SUBAGENT_RUNS_CHANGED_CHANNEL, payload, ownerStamp);
  else tapWindowBroadcast(SUBAGENT_RUNS_CHANGED_CHANNEL, payload);
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

export function registerSubagentRunsIpc(
  options: {
    enqueueDurableWrite?: DurableWriteEnqueue;
    isParentPiSessionLive?: ParentPiSessionLivePredicate;
  } = {},
): void {
  service = createSubagentReadService({
    ...options,
    getUserDataDir: () => app.getPath('userData'),
    activeOwnerScopeKey,
  isBoundaryPending: isAppSessionBoundaryPending,
  });
  for (const name of ['list', 'detail', 'transcript'] as const) {
    ipcMain.handle(`local-db:subagent-runs:${name}`, async (event, input: unknown) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      return service[name](input);
    });
  }
}
