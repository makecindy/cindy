import type { SessionActivitySnapshot } from './sessionActivity.js';

/** A Cindy device owns the record and runtime. An SSH host never substitutes for deviceId. */
export interface SessionTarget {
  deviceId: string;
  sessionId: string;
}

/** Runtime identity is process scoped; generation alone is not a durable CAS token. */
export interface SessionExecutionIdentity {
  instanceId: string;
  generation: number;
}

/** Paths are meaningful only inside this device and, optionally, its SSH namespace. */
export interface SessionResourceRef {
  owningDeviceId: string;
  remoteHostId: string | null;
  kind: 'directory' | 'file' | 'attachment';
  locator: string;
  /** An existing transferred attachment or file service supplies this version. */
  version?: string;
}

/** Versioned wire DTOs are inferred from the same strict schema used by MCP and
 * device-link. Main-only callbacks and verified caller identity never enter it. */
export type SessionControlRequest = import('zod').infer<typeof import('./sessionControllerSchema.js').sessionControlRequestSchema>;
export type SessionCommand = SessionControlRequest['command'];
export type SessionCommandArguments = {
  [K in SessionCommand['operation']]: Extract<SessionCommand, { operation: K }>['args'];
};

export const SESSION_OPERATIONS = [
  'listRecords', 'listActive', 'inspect', 'capabilities',
  'createRecord', 'ensureRuntime', 'updateMetadata', 'setRecordStatus',
  'send', 'enqueue', 'steer', 'inspectQueue', 'editOwnedInput', 'withdrawOwnedInput',
  'moveInput', 'pauseQueue', 'resumeQueue', 'retryInput', 'clearInputError',
  'clearInputs', 'setInputLock', 'updateInputPresentation', 'deleteMessage',
  'requestStop', 'abortTurn', 'closeRuntime', 'listBackgroundTasks', 'stopBackgroundTask',
  'inspectRuntime', 'selectRuntime', 'inspectInteractions', 'resolveInteraction',
  'changePermission', 'inspectHistory', 'fork', 'rewind', 'compact', 'diagnose', 'subscribe',
] as const;
export type SessionOperation = typeof SESSION_OPERATIONS[number];

/** History/native inspection may resume a runtime, so it is deliberately absent. */
export const SESSION_READ_OPERATIONS: readonly SessionOperation[] = [
  'listRecords', 'listActive', 'inspect', 'capabilities', 'inspectQueue', 'inspectRuntime',
  'inspectInteractions', 'listBackgroundTasks', 'diagnose',
];

/** A capability is scoped to the caller, target, host version and current harness. */
export interface SessionCapability {
  operation: SessionOperation;
  supported: boolean;
  reason?: string;
}

export type SessionControllerErrorCode =
  | 'INVALID_ARGS' | 'NOT_FOUND' | 'NOT_AUTHORIZED' | 'CONFLICT'
  | 'HOST_NOT_READY' | 'UNSUPPORTED_CAPABILITY' | 'ROUTE_UNAVAILABLE'
  | 'DEVICE_OFFLINE' | 'DEVICE_UNRESPONSIVE' | 'CONTROL_DISABLED'
  | 'OWNER_SCOPE_CHANGED' | 'RESOURCE_UNREACHABLE' | 'UNKNOWN_OUTCOME'
  | 'INTERNAL';

export interface SessionControllerFailure {
  ok: false;
  errorCode: SessionControllerErrorCode;
  message: string;
  /** Correlation is distinct from business idempotency and execution identity. */
  requestId?: string;
  idempotencyKey?: string;
}

export type SessionControllerResult<T> = { ok: true; value: T } | SessionControllerFailure;

export interface SessionObservation {
  target: SessionTarget;
  /** Opaque owner epoch supplied by the host, never an authorization credential. */
  ownerEpoch: string;
  observedAtMs: number;
  connection: 'local' | 'online' | 'offline' | 'unresponsive';
  freshness: 'current' | 'stale';
}

/** Projection only: record status, live turn, queue, interactions and route stay separate. */
export interface SessionControllerSnapshot extends SessionObservation {
  remoteHostId: string | null;
  activity: SessionActivitySnapshot;
  runtimeLoaded: boolean;
  execution: SessionExecutionIdentity | null;
  queue: { paused: boolean; pendingCount: number; restoring: boolean };
  interactions: { id: string; kind: string }[];
  runtimeSelection: {
    generation: number;
    baseline: SessionRuntimeSelection;
    effective: SessionRuntimeSelection;
    pending: SessionRuntimeSelection | null;
    appliesAt: 'next_send' | 'turn_boundary' | null;
  } | null;
}

export interface SessionRuntimeSelection {
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
  fastMode: boolean;
}

/** Read from the existing watchdog. This DTO must not introduce a second timer. */
export interface SessionWatchdogObservation {
  state: string;
  timeoutMs: number;
  remainingMs: number;
  pendingInteractions: number;
  terminalErrorDraining: boolean;
  recovering?: boolean;
  terminalReason?: string | null;
  suspendGapObserved?: boolean;
}

export interface SessionDiagnosis {
  snapshot: SessionControllerSnapshot;
  conditions: Array<
    'waiting-for-user' | 'queue-paused' | 'runtime-selection-pending' | 'restoring'
    | 'host-unresponsive' | 'offline' | 'runtime-unloaded' | 'watchdog-suspended'
    | 'stale-observation' | 'active-turn' | 'idle'
    | 'sleep-gap' | 'turn-stalled' | 'recovering' | 'terminal-error'
  >;
  watchdog: SessionWatchdogObservation | null;
  /** Suggestions are capabilities, never instructions to automatically restart. */
  availableControls: SessionOperation[];
}

export interface SessionControlReceipt {
  target: SessionTarget;
  requestId: string;
  idempotencyKey?: string;
  phase: 'accepted' | 'queued' | 'dispatched' | 'completed';
  inputId?: string;
  execution?: SessionExecutionIdentity;
}

export type SessionControllerEvent = SessionObservation & {
  /** Changes only invalidate/describe projections; transport success is not a terminal event. */
  kind: 'record-changed' | 'input-accepted' | 'input-dispatched' | 'input-withdrawn'
    | 'turn-changed' | 'interaction-changed' | 'runtime-intent' | 'runtime-applied'
    | 'connection-invalidated' | 'snapshot-resync';
  execution?: SessionExecutionIdentity;
  inputId?: string;
};

/** No delimiter-based concatenation: device/session identifiers are opaque strings. */
export function sessionTargetKey(target: SessionTarget): string {
  return JSON.stringify([target.deviceId, target.sessionId]);
}

export function isSessionTarget(value: unknown): value is SessionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Partial<SessionTarget>;
  return typeof target.deviceId === 'string' && target.deviceId.length > 0
    && typeof target.sessionId === 'string' && target.sessionId.length > 0;
}

/** A stale offline observation must never be promoted to a current running instance. */
export function isObservedActiveSession(snapshot: SessionControllerSnapshot): boolean {
  return snapshot.freshness === 'current'
    && (snapshot.connection === 'local' || snapshot.connection === 'online')
    && snapshot.runtimeLoaded && snapshot.activity.currentTurnActive === true;
}

export function diagnoseSessionSnapshot(
  snapshot: SessionControllerSnapshot,
  watchdog: SessionWatchdogObservation | null,
  capabilities: readonly SessionCapability[],
): SessionDiagnosis {
  const conditions: SessionDiagnosis['conditions'] = [];
  if (snapshot.freshness === 'stale') conditions.push('stale-observation');
  if (snapshot.connection === 'offline') conditions.push('offline');
  if (snapshot.connection === 'unresponsive') conditions.push('host-unresponsive');
  if (snapshot.interactions.length || snapshot.activity.phase === 'needs-interaction') conditions.push('waiting-for-user');
  if (snapshot.queue.paused) conditions.push('queue-paused');
  if (snapshot.queue.restoring) conditions.push('restoring');
  if (snapshot.runtimeSelection?.pending) conditions.push('runtime-selection-pending');
  if (!snapshot.runtimeLoaded) conditions.push('runtime-unloaded');
  if (watchdog && watchdog.state !== 'armed' && watchdog.state !== 'idle') conditions.push('watchdog-suspended');
  if (watchdog?.suspendGapObserved) conditions.push('sleep-gap');
  if (watchdog?.recovering) conditions.push('recovering');
  if (['turn_no_event_timeout', 'bridge_turn_no_event_timeout'].includes(watchdog?.terminalReason ?? '')) conditions.push('turn-stalled');
  else if (snapshot.activity.phase === 'error') conditions.push('terminal-error');
  if (isObservedActiveSession(snapshot)) conditions.push('active-turn');
  if (!conditions.length) conditions.push('idle');
  const recoverable: readonly SessionOperation[] = ['send', 'steer', 'resumeQueue', 'requestStop', 'abortTurn'];
  return {
    snapshot, conditions, watchdog,
    availableControls: snapshot.freshness === 'current'
      && (snapshot.connection === 'local' || snapshot.connection === 'online')
      ? capabilities.filter(c => c.supported && recoverable.includes(c.operation)).map(c => c.operation)
      : [],
  };
}

/** A same-named file on a different device/SSH host is a different resource. */
export function isSessionResourceLocalTo(
  resource: SessionResourceRef,
  location: { deviceId: string; remoteHostId: string | null },
): boolean {
  return resource.owningDeviceId === location.deviceId
    && resource.remoteHostId === location.remoteHostId;
}
