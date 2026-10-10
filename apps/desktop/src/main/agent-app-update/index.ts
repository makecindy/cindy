/**
 * Desktop wiring for the Agent app-update tools. Session facts (caller authority,
 * running tasks, Host cards) come from Maker Host; updater work goes through the
 * existing updateService entry points only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import type { XdtHelperMcpDeps } from '@cindy/mcps';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { t } from '../i18n.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { createLogger } from '../logger.js';
import {
  applyConfirmedAppUpdateForAgent,
  checkAppUpdateForAgent,
  readAutoRelaunchOnIdleForAgent,
  setAutoRelaunchOnIdleForAgent,
} from '../updateService.js';
import { compareAppUpdateVersions } from '../updateVersionPolicy.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import {
  createAgentAppUpdateService,
  type AgentAppUpdateDeps,
  type AgentAppUpdateMarker,
  type AgentAppUpdateService,
} from './agentAppUpdateService.js';

type AppUpdateCallbacks = NonNullable<XdtHelperMcpDeps['appUpdate']>;

const log = createLogger('agent-app-update');
const MARKER_FILE = 'agent-app-update.json';

export type AgentAppUpdateSessionHost = Pick<
  AgentAppUpdateDeps,
  'resolveCaller' | 'countOtherRunningTasks' | 'requestHostPermission' | 'waitForCallerTurnToEnd'
>;

let sessionHost: AgentAppUpdateSessionHost | null = null;
let service: AgentAppUpdateService | null = null;

function markerPath(): string {
  return ownerScopedUserDataPath(MARKER_FILE);
}

function parseMarker(raw: string | null): AgentAppUpdateMarker | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AgentAppUpdateMarker>;
    if (
      typeof value.requestId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.fromVersion !== 'string' ||
      typeof value.requestedAt !== 'number' ||
      typeof value.pid !== 'number'
    )
      return null;
    return {
      requestId: value.requestId,
      sessionId: value.sessionId,
      fromVersion: value.fromVersion,
      ...(typeof value.targetVersion === 'string' ? { targetVersion: value.targetVersion } : {}),
      requestedAt: value.requestedAt,
      pid: value.pid,
    };
  } catch {
    return null;
  }
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
    requestHostPermission: (...args) => requireSessionHost().requestHostPermission(...args),
    waitForCallerTurnToEnd: (caller) => requireSessionHost().waitForCallerTurnToEnd(caller),
    marker: {
      write: (marker) => {
        const file = markerPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        atomicWriteFileSync(file, JSON.stringify(marker));
      },
      read: () => {
        try {
          return parseMarker(readAtomicFileSync(markerPath()));
        } catch (error) {
          log.warn('agent app update marker read failed', { error: String(error) });
          return null;
        }
      },
      clear: () => {
        const file = markerPath();
        for (const target of [file, `${file}.bak`]) {
          try {
            fs.rmSync(target, { force: true });
          } catch (error) {
            log.warn('agent app update marker cleanup failed', { error: String(error) });
          }
        }
      },
    },
    notify: async (sessionId, clientId, text) => {
      const ownerScope = captureDataOwnerBroadcastScope();
      await createMessage(
        sessionId,
        { clientId, role: 'assistant', content: text },
        {
          broadcastOwnerScope: ownerScope,
          shouldBroadcast: () => isDataOwnerBroadcastScopeCurrent(ownerScope),
        },
      );
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
