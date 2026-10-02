import {
  diagnoseSessionSnapshot,
  type SessionCapability,
  type SessionControllerSnapshot,
  type SessionDiagnosis,
  type SessionExecutionIdentity,
  type SessionWatchdogObservation,
} from '@cindy/maker-shared/session-controller';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { SessionAdmissionError, type SessionOperationScope } from './controller.js';

export interface SessionObservationRuntime {
  instanceId: string;
  getTurnGeneration(): number;
  isTurnRunning(): boolean;
  getWatchdogObservation(): SessionWatchdogObservation;
}

export interface SessionObservationDeps {
  deviceId(): string;
  ownerEpoch(): string | null;
  now(): number;
  getRuntime(id: string): SessionObservationRuntime | null;
  listRuntimeIds(): string[];
  readActivity(id: string): Promise<SessionActivitySnapshot>;
  readRemoteHostId(id: string): Promise<string | null>;
  readSelection(id: string): Promise<SessionControllerSnapshot['runtimeSelection']>;
  readQueue(id: string): Promise<SessionControllerSnapshot['queue']>;
  readInteractions(id: string): SessionControllerSnapshot['interactions'];
  capabilities(id: string): Promise<SessionCapability[]>;
}

function execution(runtime: SessionObservationRuntime | null): SessionExecutionIdentity | null {
  return runtime ? { instanceId: runtime.instanceId, generation: runtime.getTurnGeneration() } : null;
}

/** Reads the current owners. No status cache, watchdog, runtime wake or queue drain. */
export function createSessionObservationService(deps: SessionObservationDeps) {
  async function inspect(scope: SessionOperationScope, id: string): Promise<SessionControllerSnapshot> {
    const ownerEpoch = deps.ownerEpoch();
    if (!ownerEpoch) throw new SessionAdmissionError('HOST_NOT_READY', 'Session owner is unavailable');
    const before = execution(deps.getRuntime(id));
    const [runtimeSelection, queue, remoteHostId] = await Promise.all([deps.readSelection(id), deps.readQueue(id), deps.readRemoteHostId(id)]);
    if (!runtimeSelection && !deps.getRuntime(id)) {
      throw new SessionAdmissionError('NOT_FOUND', 'Session is unavailable');
    }
    // Activity is sampled after slower record/queue reads, then live identity is checked
    // again. A racing restart/turn gives an explicitly stale observation, never a
    // combination advertised as the currently running execution.
    const activity = await deps.readActivity(id);
    await scope.authorize();
    if (deps.ownerEpoch() !== ownerEpoch) throw new SessionAdmissionError('OWNER_SCOPE_CHANGED', 'Session owner changed');
    const runtime = deps.getRuntime(id);
    const after = execution(runtime);
    const stable = before?.instanceId === after?.instanceId && before?.generation === after?.generation;
    const interactions = deps.readInteractions(id);
    return {
      target: { deviceId: deps.deviceId(), sessionId: id }, ownerEpoch,
      observedAtMs: deps.now(), connection: 'local', freshness: stable ? 'current' : 'stale',
      activity: { ...activity, currentTurnActive: runtime?.isTurnRunning() === true },
      remoteHostId, runtimeLoaded: runtime !== null, execution: after, queue, interactions, runtimeSelection,
    };
  }

  async function capabilities(scope: SessionOperationScope, id: string): Promise<SessionCapability[]> {
    return Promise.all((await deps.capabilities(id)).map(async capability => ({
      ...capability, supported: capability.supported && await scope.allows(capability.operation, [id]),
    })));
  }

  async function listActive(scope: SessionOperationScope): Promise<SessionControllerSnapshot[]> {
    const snapshots: SessionControllerSnapshot[] = [];
    // Read only the live registry. Historical running flags never enter this list.
    for (const id of deps.listRuntimeIds()) {
      if (!await scope.allows('inspect', [id])) continue;
      const snapshot = await inspect(scope, id);
      if (snapshot.runtimeLoaded && snapshot.freshness === 'current' && await scope.allows('inspect', [id])) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  async function diagnose(scope: SessionOperationScope, id: string): Promise<SessionDiagnosis> {
    const supported = await capabilities(scope, id);
    const snapshot = await inspect(scope, id);
    const runtime = deps.getRuntime(id);
    const sameExecution = runtime?.instanceId === snapshot.execution?.instanceId
      && runtime?.getTurnGeneration() === snapshot.execution?.generation;
    const watchdog = sameExecution ? runtime?.getWatchdogObservation() ?? null : null;
    return diagnoseSessionSnapshot(snapshot, watchdog, supported);
  }
  return { inspect, diagnose, listActive, capabilities };
}
