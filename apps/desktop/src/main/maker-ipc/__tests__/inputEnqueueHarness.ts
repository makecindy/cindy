import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { AgentInputCoordinator, markManualSchedulerContinuation } from '../agent-input-coordinator.desktop.js';
import { stampTrustedDesktopQueuedOrigin, stampTrustedDeviceLinkQueuedOrigin } from '../makerSendTransaction.js';
import { stampMobileClientOrigin } from '../mobileClientPromptNote.js';
import { isAutomaticInputOriginKind, type AgentInputCreateOpts, type AgentInputProjection, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { SchedulerQueuedPreparation } from '../schedulerQueuedPreparation.js';
import type { SavedUsageLimitWait } from '../usageLimitRecoveryStore.js';
import type { UsageLimitAutoResume } from '../usageLimitAutoResume.js';
import { createSchedulerQueueBridge } from '../schedulerQueueBridge.js';
import { MAKER_INVOKE } from '../channels.js';
import { parseOrcaRemoteLead } from '../../../shared/orcaRemoteWorker.js';
import { stampSharedTaskInput } from '../sharedTaskInput.js';
import type { SharedTaskPeerCapture } from '../../device-link/sharedTaskDispatch.js';

// Execute the production IPC handler while injecting only its host services.
// Shared by queue tests and the real scheduler-runner continuation regression.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const enqueueChannel = source.indexOf('    MAKER_INVOKE.INPUT_ENQUEUE,');
const enqueueStart = source.lastIndexOf('  ipcMain.handle(', enqueueChannel);
const enqueueEnd = source.indexOf('\n  );', enqueueChannel);
if (enqueueChannel < 0 || enqueueStart < 0 || enqueueEnd < enqueueChannel) throw new Error('INPUT_ENQUEUE registration not found');
const compiled = transpileModule(source.slice(enqueueStart, enqueueEnd + '\n  );'.length), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

// Run the production terminal-error wiring, not a copy of its scheduler branch.
const quotaHandlerStart = source.indexOf('    onUsageLimitedTurnError: (sessionId, signals, item, candidateToken) => {');
const quotaHandlerEnd = source.indexOf('    onResumableTurnErrorDiscarded:', quotaHandlerStart);
if (quotaHandlerStart < 0 || quotaHandlerEnd < quotaHandlerStart) throw new Error('Quota terminal handler not found');
const compiledQuotaHandler = transpileModule(`return ({${source.slice(quotaHandlerStart, quotaHandlerEnd)}}).onUsageLimitedTurnError;`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
const groupFallbackStart = source.indexOf('function waitForUsageLimitAfterGroup(');
const groupFallbackEnd = source.indexOf('export function isSchedulerAutoResumePending(', groupFallbackStart);
if (groupFallbackStart < 0 || groupFallbackEnd < groupFallbackStart) throw new Error('Group quota fallback not found');
const compiledGroupFallback = transpileModule(
  `${source.slice(groupFallbackStart, groupFallbackEnd)}\nreturn waitForUsageLimitAfterGroup;`,
  { compilerOptions: { target: ScriptTarget.ES2022 } },
).outputText;

export function createUsageLimitedTurnErrorHarness(bindings: Record<string, unknown>) {
  const fallback = new Function(...Object.keys(bindings), compiledGroupFallback)(...Object.values(bindings)) as UsageLimitAutoResume['onTurnError'];
  // These fixtures exercise the ordinary scheduler/group quota route, not the
  // account-pool-specific replay fence. Leave the host port replaceable.
  const ports = { mixedProviderCanRetryTurn: () => true, ...bindings, waitForUsageLimitAfterGroup: fallback };
  const handler = new Function(...Object.keys(ports), compiledQuotaHandler)(...Object.values(ports)) as
    NonNullable<ConstructorParameters<typeof AgentInputCoordinator>[0]['onUsageLimitedTurnError']>;
  return Object.assign(handler, { fallback });
}

const stopStart = source.indexOf('  ipcMain.handle(MAKER_INVOKE.INPUT_STOP,');
const stopEnd = source.indexOf('  ipcMain.handle(MAKER_INVOKE.INPUT_RESUME,', stopStart);
if (stopStart < 0 || stopEnd < stopStart) throw new Error('INPUT_STOP handler not found');
const compiledStop = transpileModule(source.slice(stopStart, stopEnd), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

const quotaStart = source.indexOf('async function restoreSavedUsageLimitWait(');
const quotaEnd = source.indexOf('/** Run after account/DB readiness', quotaStart);
if (quotaStart < 0 || quotaEnd < quotaStart) throw new Error('Quota restore entry not found');
const compiledQuotaRestore = transpileModule(`${source.slice(quotaStart, quotaEnd)}\nreturn restoreSavedUsageLimitWait;`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

export function createSavedQuotaRestoreHarness(coordinator: AgentInputCoordinator, options: {
  readAll: () => SavedUsageLimitWait[];
  validate: () => Promise<boolean>;
}) {
  const bindings = {
    agentInputCoordinatorHolder: coordinator,
    usageLimitRecoverySuspended: false,
    savedUsageLimitWaits: new Map(),
    app: { isPackaged: true },
    usageLimitRecoveryStore: { readAll: options.readAll, take: async () => true },
    activeOwnerScopeKey: () => 'owner',
    isSavedUsageLimitWaitValid: options.validate,
    isUsageLimitAutoResumeEligible: async () => true,
    forgetSavedUsageLimitWait: () => {},
    usageLimitAutoResume: { restore: () => true },
  };
  return new Function(...Object.keys(bindings), compiledQuotaRestore)(...Object.values(bindings)) as
    (sid: string) => Promise<void>;
}

export function createInputRetryHarness(coordinator: AgentInputCoordinator) {
  const channel = source.indexOf('    MAKER_INVOKE.INPUT_RETRY_LAST_ERROR,');
  const start = source.lastIndexOf('  ipcMain.handle(', channel);
  const end = source.indexOf('\n  );', channel);
  if (channel < 0 || start < 0 || end < channel) throw new Error('INPUT_RETRY_LAST_ERROR handler not found');
  const program = transpileModule(source.slice(start, end + '\n  );'.length), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  type Handler = (event: unknown, sessionId: string, options: unknown) => Promise<AgentInputProjection>;
  let handler!: Handler;
  const bindings = {
    ipcMain: { handle: (_channel: string, callback: Handler) => { handler = callback; } },
    MAKER_INVOKE, inputCoordinator: coordinator, requireSessionId: (id: string) => id,
    isDeviceLinkInvoke: () => false, assertRemoteInputControlBoundary: async () => {},
  };
  new Function(...Object.keys(bindings), program)(...Object.values(bindings));
  return (sessionId: string, options: unknown) => handler({}, sessionId, options);
}

export function createInputStopHarness(coordinator: AgentInputCoordinator, options: {
  remote?: boolean;
  awaitQueuePersistence?: (sid: string) => Promise<void>;
  savedQuotaWait?: { id: string; sessionId: string };
  cancelQuotaWait?: (sid: string, id: string) => Promise<boolean>;
  quotaReadError?: Error;
} = {}) {
  let stop!: (event: object, sid: string, opts?: unknown) => Promise<AgentInputProjection>;
  const noop = () => undefined;
  const bindings = {
    ipcMain: { handle: (_name: string, fn: typeof stop) => { stop = fn; } },
    MAKER_INVOKE: { INPUT_STOP: 'maker:input:stop' },
    inputCoordinator: coordinator,
    requireSessionId: (sid: string) => sid,
    isDeviceLinkInvoke: () => options.remote ?? true,
    assertRemoteInputControlBoundary: async () => {},
    interruptUpstreamMergeTurn: async () => {},
    reviewRunControl: { noteReviewerStopRequested: noop },
    notePromptPredictionSessionStopped: noop,
    getGhostPipeDispatcher: () => ({ cancelSessionCalls: noop }),
    resetAutomaticRecoveryForExplicitStop: noop,
    pauseGoalBeforeExplicitStop: async () => {},
    getAgentIslandService: () => null,
    awaitAgentInputQueueSnapshotPersistence: options.awaitQueuePersistence ?? (async () => {}),
    usageLimitRecoveryStore: {
      readAll: () => options.savedQuotaWait ? [options.savedQuotaWait] : [],
      readAllStrict: () => {
        if (options.quotaReadError) throw options.quotaReadError;
        return options.savedQuotaWait ? [options.savedQuotaWait] : [];
      },
      take: options.cancelQuotaWait ?? (async () => true),
    },
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    log: { warn: noop },
  };
  new Function(...Object.keys(bindings), compiledStop)(...Object.values(bindings));
  return (sid: string, opts?: unknown) => stop({}, sid, opts);
}

export function createInputEnqueueHarness(coordinator: AgentInputCoordinator, options: {
  remote?: boolean;
  mobile?: boolean;
  controllerDeviceId?: string;
  sharedTask?: { capture: SharedTaskPeerCapture; task: AgentInputCreateOpts };
  awaitQueuePersistence?: (sid: string) => Promise<void>;
  getInputSessionRow?: () => Promise<{ clearedAt: number | null; agentKind?: string; orcaRemoteLead?: string }>;
  resumeInterruptedScheduleRun?: typeof import('../../scheduler-host/index.desktop.js').resumeInterruptedScheduleRun;
  getSessionFsSnapshot?: () => Promise<{ planModeEnabled?: boolean } | null>;
} = {}) {
  const { remote = true, mobile = false, resumeInterruptedScheduleRun = async () => null } = options;
  const noop = () => undefined;
  const sameItem = (item: AgentInputQueuedMessage) => item;
  const owner = {};
  const acceptedCallbacks = new Map<string, () => void | Promise<void>>();
  const preparations = new Map<string, SchedulerQueuedPreparation>();
  const discardWatchers = new Map();
  const schedulerBridge = createSchedulerQueueBridge({
    coordinator, isSessionBusy: () => false, getSessionMeta: async () => null,
    getSessionRowSnapshot: async () => null, createId: () => 'unused-scheduler-id',
    preparations, discardWatchers, discardAcceptedCallback: id => { acceptedCallbacks.delete(id); },
    enqueue: async () => { throw new Error('Manual Continue must enqueue through its IPC handler'); },
  });
  const bindings = {
    inputCoordinator: coordinator,
    CONTINUE_AFTER_APP_EXIT_PROMPT,
    markManualSchedulerContinuation,
    resumeInterruptedScheduleRun,
    getSessionFsSnapshot: options.getSessionFsSnapshot ?? (async () => ({ planModeEnabled: false })),
    schedulerQueueBridgeHolder: schedulerBridge,
    schedulerQueuedPromptDiscardWatchers: discardWatchers,
    schedulerQueuedPromptPreparations: preparations,
    orcaInterAgentDispatcher: {
      registerQueuedOrcaInterAgentAcceptedCallback: (id: string, fn: () => void | Promise<void>) => acceptedCallbacks.set(id, fn),
      discardQueuedOrcaInterAgentAcceptedCallback: (id: string) => acceptedCallbacks.delete(id),
    },
    log: { warn: noop },
    requireSessionId: (id: string) => id,
    requireQueuedMessage: sameItem,
    prepareSharedTaskInput: (_sid: string, item: AgentInputQueuedMessage) =>
      options.sharedTask
        ? stampSharedTaskInput(item, options.sharedTask.capture, options.sharedTask.task)
        : item,
    getCurrentDbClientSnapshot: () => owner,
    isDeviceLinkInvoke: () => remote,
    getDeviceLinkInvokeContext: () => remote ? {
      controllerDeviceId: options.controllerDeviceId ?? 'lead-computer',
      sharedTask: options.sharedTask?.capture,
    } : null,
    parseOrcaRemoteLead,
    isMobileControllerInvoke: () => mobile,
    readDeviceLinkInvokeSourceDevice: () => mobile
      ? { deviceId: 'phone', name: 'Phone', platform: 'android' }
      : { deviceId: 'lead-computer', name: 'Lead Computer', platform: 'windows' },
    readClaimedUiLanguage: noop,
    readClaimedClassicalStyle: noop,
    getResolvedMainLocale: () => 'zh-CN',
    getMainClassicalStyle: () => 'prose',
    getInputSessionRow: options.getInputSessionRow ?? (async () => ({ clearedAt: null })),
    withSendToSessionLock: (_id: string, run: () => Promise<unknown>) => run(),
    getMakerIfReady: () => null,
    beginRemoteSendTrace: noop,
    remoteInputClientIdWasPersisted: () => false,
    hasInputDeliveryCancellation: () => false,
    awaitAgentInputQueueSnapshotPersistence: options.awaitQueuePersistence ?? noop,
    materializeQueuedOssAttachmentsDeferred: (_sid: string, item: AgentInputQueuedMessage) => ({ item }),
    hydrateQueuedAgentReferences: sameItem,
    stampTurnUiLanguage: sameItem,
    stampTrustedDesktopQueuedOrigin,
    stampTrustedDeviceLinkQueuedOrigin,
    stampMobileClientOrigin,
    isAutomaticInputOriginKind,
    prepareDeviceLinkAutoTitle: async () => noop,
    queuedAttachmentOwnership: { activateCurrentOwner: noop },
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    ...Object.fromEntries([
      'assertReviewExternalInputAllowed', 'assertTrustedAppRendererEvent', 'withSessionPermissionChange',
      'assertRemoteInputClearNotInFlight',
      'readRemoteInputClearBoundaryPrecondition', 'observeLocalInputClearBoundary',
      'assertExpectedRemoteInputClearBoundary', 'registerQueuedAttachmentOwnership',
      'discardSpecificQueuedAttachmentOwnership', 'markQueuedAttachmentDurableAfterSnapshot',
    ].map(name => [name, noop])),
  };
  type EnqueueHandler = (event: object, sid: string, item: AgentInputQueuedMessage, opts?: unknown) => Promise<AgentInputProjection>;
  const handlers = new Map<string, EnqueueHandler>();
  const ipcMain = { handle: (channel: string, fn: EnqueueHandler) => handlers.set(channel, fn) };
  new Function('ipcMain', 'MAKER_INVOKE', ...Object.keys(bindings), compiled)(ipcMain, MAKER_INVOKE, ...Object.values(bindings));
  const enqueue = handlers.get(MAKER_INVOKE.INPUT_ENQUEUE);
  if (!enqueue) throw new Error('INPUT_ENQUEUE handler was not registered');
  return { enqueue, acceptedCallbacks, preparations, schedulerBridge };
}
