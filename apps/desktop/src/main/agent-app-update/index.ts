/**
 * Desktop wiring for the Agent app-update tools. Session facts (caller authority,
 * running tasks, Host cards) come from Maker Host; updater work goes through the
 * existing updateService entry points only.
 */
import { app } from 'electron';

import type { XdtHelperMcpDeps } from '@cindy/mcps';

import { eq } from 'drizzle-orm';

import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../device-link/broadcast-tap.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { t } from '../i18n.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { createLogger } from '../logger.js';
import { readRelaunchBackgroundActivity } from '../relaunchBusyActivityIpc.js';
import {
  applyConfirmedAppUpdateForAgent,
  checkAppUpdateForAgent,
  readAutoRelaunchOnIdleForAgent,
  setAutoRelaunchOnIdleForAgent,
} from '../updateService.js';
import { compareAppUpdateVersions } from '../updateVersionPolicy.js';
import {
  createAgentAppUpdateService,
  type AgentAppUpdateDeps,
  type AgentAppUpdateMarker,
  type AgentAppUpdateOwner,
  type AgentAppUpdateService,
} from './agentAppUpdateService.js';
import { addRestartRecord, listRestartRecords, removeRestartRecord } from './restartRecords.js';

/** Owner binding: broadcast scope for current-ness checks and the owner's own marker path. */
interface DesktopAgentAppUpdateOwner extends AgentAppUpdateOwner {
  readonly scope: DataOwnerBroadcastScope;
  readonly markerPath: string;
}

type AppUpdateCallbacks = NonNullable<XdtHelperMcpDeps['appUpdate']>;

const log = createLogger('agent-app-update');
const MARKER_FILE = 'agent-app-update.json';

export type AgentAppUpdateSessionHost = Pick<
  AgentAppUpdateDeps,
  'resolveCaller' | 'countOtherRunningTasks' | 'requestHostPermission' | 'waitForCallerTurnToEnd'
>;

let sessionHost: AgentAppUpdateSessionHost | null = null;
let service: AgentAppUpdateService | null = null;

function captureOwner(): DesktopAgentAppUpdateOwner | null {
  if (isAppSessionBoundaryPending()) return null;
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) return null;
  return {
    ownerId,
    scope: captureDataOwnerBroadcastScope(),
    markerPath: ownerScopedUserDataPath(MARKER_FILE),
  };
}

function isOwnerCurrent(owner: AgentAppUpdateOwner): boolean {
  return (
    !isAppSessionBoundaryPending() &&
    isDataOwnerBroadcastScopeCurrent((owner as DesktopAgentAppUpdateOwner).scope)
  );
}

function markerPathOf(owner: AgentAppUpdateOwner): string {
  return (owner as DesktopAgentAppUpdateOwner).markerPath;
}

function assertOwnerCurrent(owner: AgentAppUpdateOwner): void {
  if (!isOwnerCurrent(owner))
    throw new Error('The account that confirmed the update is no longer active');
}

function requireSessionHost(): AgentAppUpdateSessionHost {
  if (!sessionHost) throw new Error('Agent app update host is not ready');
  return sessionHost;
}

function getService(): AgentAppUpdateService {
  service ??= createAgentAppUpdateService({
    appVersion: () => app.getVersion(),
    platform: process.platform,
    pid: process.pid,
    now: () => Date.now(),
    check: checkAppUpdateForAgent,
    apply: applyConfirmedAppUpdateForAgent,
    readAutoUpdate: readAutoRelaunchOnIdleForAgent,
    writeAutoUpdate: setAutoRelaunchOnIdleForAgent,
    resolveCaller: (caller) => sessionHost?.resolveCaller(caller) ?? 'unavailable',
    countOtherRunningTasks: (sessionId) => requireSessionHost().countOtherRunningTasks(sessionId),
    hasBackgroundWork: async () => (await readRelaunchBackgroundActivity()).busy,
    requestHostPermission: (...args) => requireSessionHost().requestHostPermission(...args),
    waitForCallerTurnToEnd: (caller) => requireSessionHost().waitForCallerTurnToEnd(caller),
    captureOwner,
    isOwnerCurrent,
    marker: {
      list: (owner) => listRestartRecords(markerPathOf(owner)),
      add: (owner, record) => addRestartRecord(markerPathOf(owner), record),
      remove: (owner, requestId) => removeRestartRecord(markerPathOf(owner), requestId),
    },
    notify: async (owner, sessionId, clientId, text) => {
      assertOwnerCurrent(owner);
      const [task] = await getDbClient()
        .drizzle.select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      assertOwnerCurrent(owner);
      if (!task) return 'task-missing';
      const scope = (owner as DesktopAgentAppUpdateOwner).scope;
      await createMessage(
        sessionId,
        { clientId, role: 'assistant', content: text },
        {
          broadcastOwnerScope: scope,
          shouldBroadcast: () => isOwnerCurrent(owner),
          // Re-checked around the write; an account switch rolls the row back.
          beforePublish: async () => assertOwnerCurrent(owner),
        },
      );
      return 'written';
    },
    compareVersions: compareAppUpdateVersions,
    translate: (key) => t(key),
    logger: log,
  });
  return service;
}

/** Maker Host supplies live-session facts once its Maker exists. */
export function setAgentAppUpdateSessionHost(host: AgentAppUpdateSessionHost | null): void {
  sessionHost = host;
}

/** cindy_helper app_update callbacks. */
export function createAgentAppUpdateCallbacks(
  isCurrentSession: AppUpdateCallbacks['isCurrentSession'],
): AppUpdateCallbacks {
  return {
    isCurrentSession,
    check: (caller) => getService().check(caller),
    install: (caller) => getService().install(caller),
    setAutoUpdate: (caller, enabled) => getService().setAutoUpdate(caller, enabled),
  };
}

/** Called after the owner's database is ready; reports an install started before the last restart. */
export async function deliverPendingAgentAppUpdateResult(): Promise<void> {
  try {
    await getService().deliverPendingResult();
  } catch (error) {
    log.warn('agent app update result delivery failed', { error: String(error) });
  }
}
