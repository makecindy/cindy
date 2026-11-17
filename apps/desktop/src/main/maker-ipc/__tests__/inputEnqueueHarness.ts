import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { AgentInputCoordinator, markManualSchedulerContinuation } from '../agent-input-coordinator.desktop.js';
import { stampTrustedDesktopQueuedOrigin, stampTrustedDeviceLinkQueuedOrigin } from '../makerSendTransaction.js';
import { stampMobileClientOrigin } from '../mobileClientPromptNote.js';
import { isAutomaticInputOriginKind, type AgentInputProjection, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { SchedulerQueuedPromptRequest } from '../register.js';
import type { SavedUsageLimitWait } from '../usageLimitRecoveryStore.js';

// Execute the production IPC handler while injecting only its host services.
// Shared by queue tests and the real scheduler-runner continuation regression.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('    MAKER_INVOKE.INPUT_ENQUEUE,');
const handlerStart = source.indexOf('    async (event, sessionId: unknown, item: unknown, opts?: unknown) => {', start);
const handlerEnd = source.indexOf('\n  );', handlerStart);
if (start < 0 || handlerStart < start || handlerEnd < handlerStart) throw new Error('INPUT_ENQUEUE handler not found');
const handler = source.slice(handlerStart, handlerEnd).trim().replace(/,$/, '');
const compiled = transpileModule(`return (${handler});`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

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
  resumeInterruptedScheduleRun?: typeof import('../../scheduler-host/index.desktop.js').resumeInterruptedScheduleRun;
  getSessionFsSnapshot?: () => Promise<{ planModeEnabled?: boolean } | null>;
} = {}) {
  const { remote = true, mobile = false, resumeInterruptedScheduleRun = async () => null } = options;
  const noop = () => undefined;
  const sameItem = (item: AgentInputQueuedMessage) => item;
  const owner = {};
  const acceptedCallbacks = new Map<string, () => void | Promise<void>>();
  const preparations = new Map<string, Pick<SchedulerQueuedPromptRequest, 'onPreparing' | 'onPreparationFailed'>>();
  const bindings = {
    inputCoordinator: coordinator,
    CONTINUE_AFTER_APP_EXIT_PROMPT,
    markManualSchedulerContinuation,
    resumeInterruptedScheduleRun,
    getSessionFsSnapshot: options.getSessionFsSnapshot ?? (async () => ({ planModeEnabled: false })),
    schedulerQueuedPromptDiscardWatchers: new Map(),
    schedulerQueuedPromptPreparations: preparations,
    orcaInterAgentDispatcher: {
      registerQueuedOrcaInterAgentAcceptedCallback: (id: string, fn: () => void | Promise<void>) => acceptedCallbacks.set(id, fn),
      discardQueuedOrcaInterAgentAcceptedCallback: (id: string) => acceptedCallbacks.delete(id),
    },
    log: { warn: noop },
    requireSessionId: (id: string) => id,
    requireQueuedMessage: sameItem,
    prepareSharedTaskInput: (_sid: string, item: AgentInputQueuedMessage) => item,
    getCurrentDbClientSnapshot: () => owner,
    isDeviceLinkInvoke: () => remote,
    isMobileControllerInvoke: () => mobile,
    readDeviceLinkInvokeSourceDevice: () => mobile
      ? { deviceId: 'phone', name: 'Phone', platform: 'android' }
      : { deviceId: 'lead-computer', name: 'Lead Computer', platform: 'windows' },
    readClaimedUiLanguage: noop,
    readClaimedClassicalStyle: noop,
    getResolvedMainLocale: () => 'zh-CN',
    getMainClassicalStyle: () => 'prose',
    getInputSessionRow: async () => ({ clearedAt: null }),
    getMakerIfReady: () => null,
    beginRemoteSendTrace: noop,
    remoteInputClientIdWasPersisted: () => false,
    hasInputDeliveryCancellation: () => false,
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
      'awaitAgentInputQueueSnapshotPersistence', 'assertRemoteInputClearNotInFlight',
      'readRemoteInputClearBoundaryPrecondition', 'observeLocalInputClearBoundary',
      'assertExpectedRemoteInputClearBoundary', 'registerQueuedAttachmentOwnership',
      'discardSpecificQueuedAttachmentOwnership', 'markQueuedAttachmentDurableAfterSnapshot',
    ].map(name => [name, noop])),
  };
  const enqueue = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as
    (event: object, sid: string, item: AgentInputQueuedMessage, opts?: unknown) => Promise<AgentInputProjection>;
  return { enqueue, acceptedCallbacks, preparations };
}
