import type { Maker } from '@cindy/maker-core';
import {
  createClaudeIdleReleaseWatcher,
  createIdleReleaseRuntimeClose,
  createOrdinaryIdleReleaseTaskCheck,
  DEFAULT_CODEX_IDLE_RELEASE_MINUTES,
  DEFAULT_PLUGIN_ENGINE_IDLE_RELEASE_MINUTES,
  ORDINARY_CLAUDE_TASK_SQL,
  ORDINARY_CODEX_TASK_SQL,
  ORDINARY_PLUGIN_ENGINE_TASK_SQL,
} from '../../../desktop/src/main/maker-ipc/claudeIdleReleaseWatcher.ts';
import {
  createPiIdleReleaseCandidateQueries,
  createPiIdleReleaseClose,
  createPiIdleReleaseWatcher,
  DEFAULT_PI_IDLE_RELEASE_MINUTES,
} from '../../../desktop/src/main/maker-ipc/piIdleReleaseWatcher.ts';
import {
  hasIdleReleaseQueuedWork,
  hasPendingIdleReleaseInput,
  hasScheduledIdleReleaseAutoResume,
  type IdleReleaseInputCoordinator,
} from '../../../desktop/src/main/maker-ipc/idleReleaseInputGates.ts';
import { getClaudeSessionBackgroundActivity } from '../../../desktop/src/main/maker-host/claude-session-background-activity.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { createLogger } from '../../../desktop/src/main/logger.ts';

const log = createLogger('host-idle-release');

/**
 * The desktop's idle-runtime release (register.ts: the Claude, Codex and Pi watchers) for one
 * owner's input runtime: ordinary local tasks idle for 30 minutes (Claude: the
 * claude-idle-release.json override in the profile root) release their runtime, and the next send
 * resumes the native session. Same watchers, same gates and the same send lock as the desktop.
 *
 * The desktop's facts arrive as ports: whether the turn is still settling (the desktop's
 * isSessionTurnPendingCompletion; the Host executor's running turn), whether an Agent interaction
 * is pending, and whether a credential switch waits for the task's turn to end.
 */
export function createHostIdleRelease(deps: {
  coordinator: IdleReleaseInputCoordinator;
  getMaker(): Maker | null | undefined;
  isTurnPendingCompletion(sessionId: string): boolean;
  hasPendingInteraction(sessionId: string): boolean;
  hasPendingCredentialSwitch?(sessionId: string): boolean;
  readClaudeMinutes(): number;
  /** Tests only: the clocks the watchers read (the desktop's performance.now and Date.now). */
  clock?: { monotonic(): number; wall(): number };
}) {
  const { coordinator } = deps;
  const monotonic = deps.clock ? () => deps.clock!.monotonic() : () => performance.now();
  const wall = deps.clock ? () => deps.clock!.wall() : Date.now;
  const maker = () => {
    const current = deps.getMaker();
    if (!current) throw new Error('agent runtime is not ready');
    return current;
  };
  const makerPorts = {
    closeSessionIfCurrent: ((...args) => maker().closeSessionIfCurrent(...args)) as Maker['closeSessionIfCurrent'],
  };
  const listSessions = () => deps.getMaker()?.listActiveSessions() ?? [];
  const getSession = (id: string) => deps.getMaker()?.getSession(id);
  const hasPendingInput = (id: string) => hasPendingIdleReleaseInput(coordinator, id);
  const pendingCredentialSwitch = (id: string) => deps.hasPendingCredentialSwitch?.(id) === true;
  const close = createIdleReleaseRuntimeClose(makerPorts, withRehydrateCloseSuppressed);

  const claude = createClaudeIdleReleaseWatcher({
    listSessions, getSession,
    readMinutes: deps.readClaudeMinutes,
    isOrdinaryTask: createOrdinaryIdleReleaseTaskCheck(getDbClient, ORDINARY_CLAUDE_TASK_SQL),
    hasPendingInput,
    isHostBusy: (id) => deps.isTurnPendingCompletion(id)
      || deps.hasPendingInteraction(id)
      || Boolean(getClaudeSessionBackgroundActivity(id))
      || hasIdleReleaseQueuedWork(coordinator, id)
      || pendingCredentialSwitch(id),
    withLock: withSendToSessionLock,
    close,
    now: monotonic,
    released: (sessionId, idleMs) => log.info('claudeIdleWatcher: released idle runtime', { sessionId, idleMs }),
    warn: (message) => log.warn(message),
  });
  const codex = createClaudeIdleReleaseWatcher({
    agentKind: 'codex',
    listSessions, getSession,
    readMinutes: () => DEFAULT_CODEX_IDLE_RELEASE_MINUTES,
    isOrdinaryTask: createOrdinaryIdleReleaseTaskCheck(getDbClient, ORDINARY_CODEX_TASK_SQL),
    hasPendingInput,
    isHostBusy: (id) => deps.isTurnPendingCompletion(id)
      || deps.hasPendingInteraction(id)
      || hasIdleReleaseQueuedWork(coordinator, id)
      || pendingCredentialSwitch(id),
    withLock: withSendToSessionLock,
    close,
    now: monotonic,
    released: (sessionId, idleMs) => log.info('codexIdleWatcher: released idle runtime', { sessionId, idleMs }),
    warn: (message) => log.warn(message),
  });
  const pluginEngine = createClaudeIdleReleaseWatcher({
    agentKind: 'acp',
    listSessions, getSession,
    readMinutes: () => DEFAULT_PLUGIN_ENGINE_IDLE_RELEASE_MINUTES,
    isOrdinaryTask: createOrdinaryIdleReleaseTaskCheck(getDbClient, ORDINARY_PLUGIN_ENGINE_TASK_SQL),
    hasPendingInput,
    isHostBusy: (id) => deps.isTurnPendingCompletion(id)
      || deps.hasPendingInteraction(id)
      || hasIdleReleaseQueuedWork(coordinator, id)
      || pendingCredentialSwitch(id),
    withLock: withSendToSessionLock,
    close,
    now: monotonic,
    released: (sessionId, idleMs) => log.info('pluginEngineIdleWatcher: released idle runtime', { sessionId, idleMs }),
    warn: (message) => log.warn(message),
  });
  const pi = createPiIdleReleaseWatcher({
    closeSession: createPiIdleReleaseClose(makerPorts, withRehydrateCloseSuppressed),
    readIdleReleaseMinutes: () => DEFAULT_PI_IDLE_RELEASE_MINUTES,
    ...createPiIdleReleaseCandidateQueries(getDbClient),
    getSession: (sessionId) => getSession(sessionId) ?? null,
    withSessionLock: withSendToSessionLock,
    hasPendingInput,
    hasScheduledAutoResume: (sessionId) => hasScheduledIdleReleaseAutoResume(coordinator, sessionId),
    now: wall,
    timer: { setInterval, clearInterval },
    log,
  });

  return {
    /** Starts the watchers once this owner's agent runtime is ready. */
    start() { pi.start(); claude.start(); codex.start(); pluginEngine.start(); },
    /** Stops them before the owner's runtime is disposed (shutdown, sign-out, account switch). */
    stop() { claude.stop(); codex.stop(); pluginEngine.stop(); pi.stop(); },
    /** One scan of each watcher, for tests. */
    async scanNow() { await claude.scanNow(); await codex.scanNow(); await pluginEngine.scanNow(); await pi.scanNow(); },
  };
}
