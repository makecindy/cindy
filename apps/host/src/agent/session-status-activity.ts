import type { AgentEvent } from '@cindy/maker-core';
import type { ForegroundHostTaskActivity, SessionActivityPayload } from '@cindy/device-link';
import { DeferredSessionCompletions } from '../../../desktop/src/main/agent-island/deferredSessionCompletions.js';
import { toSessionActivity } from '../../../desktop/src/main/agent-island/sessionActivitySnapshot.js';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import type { AgentIslandSessionActivity, AgentIslandSessionPhase } from '../../../desktop/src/shared/agentIsland.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from '../../../desktop/src/main/agent-island/displayConfig.js';
import { shouldNotifyAgentIslandForSession } from '../../../desktop/src/main/agent-island/notificationPolicy.js';
import {
  acknowledgeAgentIslandSessionRead,
  applyAgentIslandEvent,
  applyAgentIslandInteractionDismissed,
  applyAgentIslandInteractionRequest,
  buildAllSessionActivitySnapshots,
  buildLocalAgentIslandTaskOverview,
  closeAgentIslandSessionPreservingUnread,
  createAgentIslandState,
  getNextAgentIslandTimerAt,
  patchAgentIslandMetadata,
  pruneAgentIslandSessions,
  removeAgentIslandSession,
  resetAgentIslandState,
  setAgentIslandSessionDisplaySuppressed,
  type AgentIslandInteractionRequest,
} from '../../../desktop/src/main/agent-island/state.js';
import { SessionActivityRelay } from '../../../desktop/src/main/agent-island/sessionActivityRelay.js';
import { projectHostTaskActivity } from '../../../desktop/src/main/device-link/taskActivity.js';
import {
  isSessionNotificationsMutedSync,
  noteSessionNotificationsMuted,
} from '../../../desktop/src/main/localDb/sessionFlagRegistry.js';
import { isKnownOrcaWorkerSession } from '../../../desktop/src/main/maker-ipc/orcaManualInterrupt.js';

type AgentIslandSessionMeta = Parameters<typeof applyAgentIslandEvent>[1];

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const STREAM_PUBLISH_COALESCE_MS = 250;
const MAX_META_CACHE = 512;
const MAX_HYDRATED_SESSIONS = 512;
const MAX_STOPPED_SESSIONS = 256;
const MAX_SILENT_STOP_PENDING = 256;

export interface HostSessionActivitySummary {
  phase: AgentIslandSessionPhase;
  attention: boolean;
}

export interface HostSessionActivityTrackerPorts {
  emit: (payload: SessionActivityPayload) => void;
  onForegroundActivityChanged?: () => void;
  sessionExists?: (sessionId: string) => Promise<boolean>;
  readSessionMeta?: (sessionId: string) => Promise<{
    title?: string | null;
    workingDir?: string | null;
    agentKind?: string | null;
  } | null>;
  hasPendingQueuedWork?: (sessionId: string) => boolean;
  isSessionMuted?: (sessionId: string) => boolean;
  isOrcaWorker?: (sessionId: string) => boolean;
  minIntervalMs?: number;
  streamCoalesceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface SessionMetaEntry {
  title?: string;
  workingDir?: string;
  agentKind?: AgentIslandSessionMeta['agentKind'];
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function lruAdd<K>(set: Set<K>, key: K, limit: number): void {
  set.delete(key);
  set.add(key);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function isCancelledTerminalEvent(event: AgentEvent): boolean {
  if (isTurnContinuationBoundaryEvent(event)) return false;
  if (event.type !== 'done' && event.type !== 'status') return false;
  const data = event.data as { cancelled?: unknown; status?: unknown } | undefined;
  return data?.cancelled === true || (event.type === 'done' && data?.status === 'cancelled');
}

function isRunningStatusEvent(event: AgentEvent): boolean {
  if (event.type !== 'status' || event.turnScope === 'background') return false;
  const data = event.data as { isRunning?: unknown } | undefined;
  return data?.isRunning === true;
}

function isTerminalErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  const data = event.data as { isTerminal?: unknown; willRetry?: unknown } | undefined;
  if (typeof data?.isTerminal === 'boolean') return data.isTerminal;
  if (typeof data?.willRetry === 'boolean') return !data.willRetry;
  return true;
}

function isStatusDoneEvent(event: AgentEvent): boolean {
  if (event.type !== 'status' || event.turnScope === 'background') return false;
  const data = event.data as { isRunning?: unknown; status?: unknown } | undefined;
  return data?.isRunning === false && data?.status === 'Done';
}

function normalizeAgentKind(value: unknown): AgentIslandSessionMeta['agentKind'] {
  if (value === 'claude-code' || value === 'codex' || value === 'pi' || value === 'acp') return value;
  if (value === 'cc') return 'claude-code';
  return undefined;
}

export function createHostSessionActivityTracker(ports: HostSessionActivityTrackerPorts) {
  const now = ports.now ?? (() => Date.now());
  const setTimer = ports.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = ports.clearTimer ?? ((timer) => clearTimeout(timer));
  const streamCoalesceMs = Math.max(0, ports.streamCoalesceMs ?? STREAM_PUBLISH_COALESCE_MS);
  const isSessionMuted = ports.isSessionMuted ?? isSessionNotificationsMutedSync;
  const isOrcaWorker = ports.isOrcaWorker ?? isKnownOrcaWorkerSession;
  const state = createAgentIslandState();
  const relay = new SessionActivityRelay(ports.emit, {
    ...(ports.minIntervalMs !== undefined ? { minIntervalMs: ports.minIntervalMs } : {}),
    now,
    setTimer,
    clearTimer,
  });
  const metaCache = new Map<string, SessionMetaEntry>();
  const hydratedSessions = new Set<string>();
  const hydratingSessions = new Set<string>();
  const stoppingSessions = new Set<string>();
  const stoppedSessions = new Map<string, number>();
  const silentStopPending = new Set<string>();
  const deferredCompletions = new DeferredSessionCompletions(id => ports.hasPendingQueuedWork?.(id) === true, MAX_SILENT_STOP_PENDING);
  const standaloneInteractionSessions = new Set<string>();
  const pendingAutoResumeErrors = new Map<string, AgentEvent>();
  let foregroundSummaryKey = '';
  let foregroundRevision = 0;
  let lastPublishedForegroundRevision = -1;
  let foregroundTimer: ReturnType<typeof setTimeout> | null = null;
  let pruneTimer: ReturnType<typeof setTimeout> | null = null;
  let streamPublishTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const hydrateMeta = (sessionId: string): AgentIslandSessionMeta => {
    const cached = metaCache.get(sessionId);
    if (cached) lruSet(metaCache, sessionId, cached, MAX_META_CACHE);
    return {
      sessionId,
      ...(cached?.title ? { title: cached.title } : {}),
      ...(cached?.workingDir ? { workingDir: cached.workingDir } : {}),
      ...(cached?.agentKind ? { agentKind: cached.agentKind } : {}),
    };
  };

  const updateMetaCache = (sessionId: string, patch: Record<string, unknown>) => {
    const prev = metaCache.get(sessionId) ?? {};
    const next: SessionMetaEntry = { ...prev };
    let changed = false;
    if (typeof patch.title === 'string' && patch.title.trim()) {
      next.title = patch.title.trim();
      changed = true;
    }
    if (typeof patch.workingDir === 'string' && patch.workingDir.trim()) {
      next.workingDir = patch.workingDir.trim();
      changed = true;
    }
    const agentKind = normalizeAgentKind(patch.agentKind);
    if (agentKind) {
      next.agentKind = agentKind;
      changed = true;
    }
    if (changed) lruSet(metaCache, sessionId, next, MAX_META_CACHE);
    return changed ? next : null;
  };

  const ensureSessionMetaHydrated = (sessionId: string) => {
    if (disposed || !ports.readSessionMeta) return;
    if (metaCache.get(sessionId)?.title || hydratedSessions.has(sessionId) || hydratingSessions.has(sessionId)) return;
    hydratingSessions.add(sessionId);
    void ports.readSessionMeta(sessionId).then((row) => {
      hydratingSessions.delete(sessionId);
      if (disposed) return;
      lruAdd(hydratedSessions, sessionId, MAX_HYDRATED_SESSIONS);
      if (!row) return;
      const updated = updateMetaCache(sessionId, row as Record<string, unknown>);
      if (updated && state.sessions.has(sessionId)) {
        if (patchAgentIslandMetadata(state, { sessionId, ...updated })) publishNow();
      }
    }).catch(() => {
      hydratingSessions.delete(sessionId);
    });
  };

  const syncDisplaySuppression = () => {
    for (const [sessionId, session] of state.sessions) {
      setAgentIslandSessionDisplaySuppressed(
        state,
        sessionId,
        session.sourceDeviceId === null && (
          isSessionMuted(sessionId)
          || !shouldNotifyAgentIslandForSession(AGENT_ISLAND_DISPLAY_CONFIG, isOrcaWorker(sessionId))
        ),
      );
    }
  };

  const getSessionActivitySnapshots = () => buildAllSessionActivitySnapshots(state).map(toSessionActivity);

  const buildNotificationActivityList = (): AgentIslandSessionActivity[] =>
    getSessionActivitySnapshots()
      .filter(item => shouldNotifyAgentIslandForSession(AGENT_ISLAND_DISPLAY_CONFIG, isOrcaWorker(item.sessionId)));

  const clearPruneTimer = () => {
    if (!pruneTimer) return;
    clearTimer(pruneTimer);
    pruneTimer = null;
  };

  const clearStreamPublishTimer = () => {
    if (!streamPublishTimer) return;
    clearTimer(streamPublishTimer);
    streamPublishTimer = null;
  };

  const schedulePruneTimer = () => {
    clearPruneTimer();
    if (disposed) return;
    const currentNow = now();
    const nextAt = getNextAgentIslandTimerAt(state, currentNow);
    if (nextAt === null) return;
    const delay = Math.min(Math.max(10, nextAt - currentNow), MAX_TIMER_DELAY_MS);
    pruneTimer = setTimer(() => {
      pruneTimer = null;
      if (disposed) return;
      pruneAgentIslandSessions(state, now());
      publishNow();
    }, delay);
    pruneTimer.unref?.();
  };

  const scheduleForegroundPublish = () => {
    if (disposed || !ports.onForegroundActivityChanged || foregroundTimer) return;
    foregroundTimer = setTimer(() => {
      foregroundTimer = null;
      if (disposed) return;
      ports.onForegroundActivityChanged?.();
    }, 80);
    foregroundTimer.unref?.();
  };

  const publishNow = () => {
    if (disposed) return;
    clearStreamPublishTimer();
    syncDisplaySuppression();
    relay.publish(buildNotificationActivityList());
    scheduleForegroundPublish();
    schedulePruneTimer();
  };

  const scheduleCoalescedPublish = () => {
    if (disposed) return;
    if (streamCoalesceMs === 0) {
      publishNow();
      return;
    }
    if (streamPublishTimer) return;
    streamPublishTimer = setTimer(() => {
      streamPublishTimer = null;
      if (disposed) return;
      publishNow();
    }, streamCoalesceMs);
    streamPublishTimer.unref?.();
  };

  const handleStopped = (sessionId: string) => {
    stoppingSessions.delete(sessionId);
    silentStopPending.delete(sessionId);
    deferredCompletions.delete(sessionId);
    standaloneInteractionSessions.delete(sessionId);
    pendingAutoResumeErrors.delete(sessionId);
    lruSet(stoppedSessions, sessionId, now(), MAX_STOPPED_SESSIONS);
    if (state.sessions.has(sessionId)) {
      closeAgentIslandSessionPreservingUnread(state, sessionId, now());
      publishNow();
    }
  };

  const applySettledCompletion = (sessionId: string, doneEvent: AgentEvent) => {
    if (deferredCompletions.deferIfPending(sessionId, doneEvent)) return;
    deferredCompletions.delete(sessionId);
    if (applyAgentIslandEvent(state, hydrateMeta(sessionId), doneEvent, now())) {
      ensureSessionMetaHydrated(sessionId);
      publishNow();
    }
  };

  const buildActivityMap = (): Map<string, HostSessionActivitySummary> => {
    const map = new Map<string, HostSessionActivitySummary>();
    if (disposed) return map;
    pruneAgentIslandSessions(state, now());
    for (const snapshot of buildAllSessionActivitySnapshots(state)) {
      map.set(snapshot.sessionId, { phase: snapshot.phase, attention: snapshot.attention });
    }
    return map;
  };

  return {
    handleEvent(event: Record<string, unknown>): void {
      if (disposed) return;
      const id = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
      if (!id) return;

      if (event.type === 'turn_stop_requested') {
        lruAdd(stoppingSessions, id, MAX_STOPPED_SESSIONS);
        return;
      }

      if (event.type === 'turn_stop_failed') {
        stoppingSessions.delete(id);
        return;
      }

      if (event.type === 'turn_stopped') {
        handleStopped(id);
        return;
      }

      if (event.type === 'queue_emptied') {
        const deferred = deferredCompletions.takeIfReady(id);
        if (deferred && !stoppedSessions.has(id) && !stoppingSessions.has(id)) {
          if (applyAgentIslandEvent(state, hydrateMeta(id), deferred.event, now())) publishNow();
        }
        return;
      }

      if (event.type === 'auto_resume_error_surfaced') {
        const held = pendingAutoResumeErrors.get(id);
        pendingAutoResumeErrors.delete(id);
        stoppingSessions.delete(id);
        stoppedSessions.delete(id);
        silentStopPending.delete(id);
        deferredCompletions.delete(id);
        standaloneInteractionSessions.delete(id);
        const detail = event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : null;
        const errorEvent = held ?? ({
          type: 'error',
          data: { ...(detail ?? {}), message: typeof detail?.message === 'string' ? detail.message : 'Turn failed', isTerminal: true },
        } as AgentEvent);
        if (applyAgentIslandEvent(state, hydrateMeta(id), errorEvent, now())) {
          ensureSessionMetaHydrated(id);
          publishNow();
        }
        return;
      }

      if (event.type === 'interaction_request' && event.request && typeof event.request === 'object') {
        const existing = state.sessions.get(id);
        const wasTurnRunning = existing?.running === true && !standaloneInteractionSessions.has(id);
        if (!wasTurnRunning) {
          lruAdd(standaloneInteractionSessions, id, MAX_STOPPED_SESSIONS);
        }
        stoppedSessions.delete(id);
        silentStopPending.delete(id);
        deferredCompletions.delete(id);
        applyAgentIslandInteractionRequest(state, hydrateMeta(id), event.request as AgentIslandInteractionRequest, now());
        ensureSessionMetaHydrated(id);
        publishNow();
        return;
      }

      if (event.type === 'interaction_dismissed' && typeof event.requestId === 'string') {
        const session = state.sessions.get(id);
        const hadPending = session?.pendingInteractionIds.has(event.requestId) === true;
        applyAgentIslandInteractionDismissed(state, id, event.requestId, now());
        const remaining = state.sessions.get(id)?.pendingInteractionIds.size ?? 0;
        if (standaloneInteractionSessions.has(id) && remaining === 0) {
          standaloneInteractionSessions.delete(id);
          if (state.sessions.has(id)) {
            closeAgentIslandSessionPreservingUnread(state, id, now());
            publishNow();
            return;
          }
        }
        if (hadPending) publishNow();
        return;
      }

      if (event.type === 'input_receipt') {
        if (event.status === 'interrupted') {
          if (event.autoResumeErrorSurfaced === true) return;
          handleStopped(id);
          return;
        }
        if (event.status === 'recorded' && silentStopPending.delete(id)) {
          if (!stoppedSessions.has(id) && !stoppingSessions.has(id)) {
            applySettledCompletion(id, { type: 'done', data: {} } as AgentEvent);
          }
          return;
        }
        return;
      }

      if (event.type === 'session_created' || event.type === 'session_changed') {
        const session = event.session && typeof event.session === 'object' ? event.session as Record<string, unknown> : null;
        const patch = event.patch && typeof event.patch === 'object' ? event.patch as Record<string, unknown> : null;
        const status = typeof patch?.status === 'string' ? patch.status : typeof event.status === 'string' ? event.status : null;
        const removed = event.action === 'delete' || event.action === 'discard_provisional' || status === 'deleted' || status === 'archived';
        if (removed) {
          stoppingSessions.delete(id);
          stoppedSessions.delete(id);
          silentStopPending.delete(id);
          deferredCompletions.delete(id);
          standaloneInteractionSessions.delete(id);
          pendingAutoResumeErrors.delete(id);
          metaCache.delete(id);
          hydratedSessions.delete(id);
          const hadState = state.sessions.has(id) || state.remoteUnreadTerminals.has(id);
          removeAgentIslandSession(state, id);
          if (hadState) {
            relay.ensureSessionTerminalClear(id);
            publishNow();
          }
          return;
        }
        const source = session ?? patch;
        if (source) {
          if (typeof source.notificationsMuted === 'boolean') {
            noteSessionNotificationsMuted(id, source.notificationsMuted);
          }
          const updated = updateMetaCache(id, source);
          if (state.sessions.has(id)) {
            const metaChanged = updated ? patchAgentIslandMetadata(state, { sessionId: id, ...updated }) : false;
            if (metaChanged || typeof source.notificationsMuted === 'boolean') publishNow();
          }
        }
        return;
      }

      const agentEvent = event.event && typeof event.event === 'object' ? event.event as AgentEvent : null;
      if (!agentEvent) return;

      if (agentEvent.turnScope === 'background' && (agentEvent.type === 'done' || isTerminalErrorEvent(agentEvent))) {
        return;
      }

      if (event.autoResumePending && agentEvent.type === 'error') {
        lruSet(pendingAutoResumeErrors, id, agentEvent, MAX_SILENT_STOP_PENDING);
        return;
      }

      if (isCancelledTerminalEvent(agentEvent)) {
        handleStopped(id);
        return;
      }

      if (stoppingSessions.has(id)) {
        if (isRunningStatusEvent(agentEvent) || agentEvent.type === 'tool_use') {
          stoppingSessions.delete(id);
        } else {
          return;
        }
      }

      if (stoppedSessions.has(id)) {
        if (isRunningStatusEvent(agentEvent) || agentEvent.type === 'tool_use') {
          stoppedSessions.delete(id);
        } else {
          if (agentEvent.type === 'done' || isTerminalErrorEvent(agentEvent)) {
            stoppedSessions.delete(id);
          }
          return;
        }
      }

      if (isRunningStatusEvent(agentEvent) || agentEvent.type === 'tool_use') {
        standaloneInteractionSessions.delete(id);
        silentStopPending.delete(id);
        deferredCompletions.delete(id);
        pendingAutoResumeErrors.delete(id);
      }

      if (event.silentStopPending === true && agentEvent.type === 'done') {
        lruAdd(silentStopPending, id, MAX_SILENT_STOP_PENDING);
        return;
      }

      if (isTerminalErrorEvent(agentEvent)) {
        silentStopPending.delete(id);
        deferredCompletions.delete(id);
        standaloneInteractionSessions.delete(id);
      }

      if (isStatusDoneEvent(agentEvent)) {
        return;
      }

      if (agentEvent.type === 'done' && !isTurnContinuationBoundaryEvent(agentEvent)) {
        silentStopPending.delete(id);
        standaloneInteractionSessions.delete(id);
        pendingAutoResumeErrors.delete(id);
        applySettledCompletion(id, agentEvent);
        return;
      }

      const prevPhase = state.sessions.get(id)?.phase;
      const prevAttention = state.sessions.get(id)?.unread ?? false;
      if (!applyAgentIslandEvent(state, hydrateMeta(id), agentEvent, now())) return;
      ensureSessionMetaHydrated(id);

      const nextSession = state.sessions.get(id);
      const urgent = prevPhase !== nextSession?.phase
        || prevAttention !== (nextSession?.unread ?? false)
        || isTerminalErrorEvent(agentEvent)
        || isRunningStatusEvent(agentEvent);
      if (urgent) publishNow();
      else scheduleCoalescedPublish();
    },

    async acknowledgeRead(sessionId: string, intent: 'explicit' | 'passive' = 'passive'): Promise<void> {
      if (disposed || !sessionId) return;
      const ack = acknowledgeAgentIslandSessionRead(state, sessionId, now(), { source: intent });
      if (ack === 'error-immune') return;
      if (ack === 'not-found') {
        if (ports.sessionExists) {
          const exists = await ports.sessionExists(sessionId).catch(() => false);
          if (!exists || disposed) return;
        }
        relay.ensureSessionTerminalClear(sessionId);
        return;
      }
      relay.ensureSessionTerminalClear(sessionId);
      if (ack === 'cleared') publishNow();
    },

    replay(emitFn: (payload: SessionActivityPayload) => void, sessionId?: string): void {
      if (disposed) return;
      syncDisplaySuppression();
      relay.replay(buildNotificationActivityList(), emitFn, sessionId);
    },

    getSessionActivitySnapshots,

    getSessionActivity(sessionId: string): HostSessionActivitySummary | null {
      if (disposed || !sessionId) return null;
      return buildActivityMap().get(sessionId) ?? null;
    },

    getSessionActivityMap(): Map<string, HostSessionActivitySummary> {
      return buildActivityMap();
    },

    getForegroundTaskActivity(onlyIfChanged = false): ForegroundHostTaskActivity | null {
      const currentNow = now();
      pruneAgentIslandSessions(state, currentNow);
      syncDisplaySuppression();
      const summary = projectHostTaskActivity(buildLocalAgentIslandTaskOverview(state, currentNow));
      const key = JSON.stringify(summary);
      if (key !== foregroundSummaryKey) {
        foregroundSummaryKey = key;
        foregroundRevision++;
      }
      if (onlyIfChanged) {
        if (foregroundRevision === lastPublishedForegroundRevision) return null;
        lastPublishedForegroundRevision = foregroundRevision;
      }
      return { ...summary, revision: foregroundRevision };
    },

    reset(): void {
      if (foregroundTimer) {
        clearTimer(foregroundTimer);
        foregroundTimer = null;
      }
      clearPruneTimer();
      clearStreamPublishTimer();
      stoppingSessions.clear();
      stoppedSessions.clear();
      silentStopPending.clear();
      deferredCompletions.clear();
      standaloneInteractionSessions.clear();
      pendingAutoResumeErrors.clear();
      metaCache.clear();
      hydratedSessions.clear();
      hydratingSessions.clear();
      relay.reset();
      resetAgentIslandState(state);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (foregroundTimer) {
        clearTimer(foregroundTimer);
        foregroundTimer = null;
      }
      clearPruneTimer();
      clearStreamPublishTimer();
      stoppingSessions.clear();
      stoppedSessions.clear();
      silentStopPending.clear();
      deferredCompletions.clear();
      standaloneInteractionSessions.clear();
      pendingAutoResumeErrors.clear();
      metaCache.clear();
      hydratedSessions.clear();
      hydratingSessions.clear();
      relay.dispose();
      resetAgentIslandState(state);
    },
  };
}
