import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { AgentInputCoordinator, markManualSchedulerContinuation } from '../agent-input-coordinator.js';
import { stampTrustedDesktopQueuedOrigin, stampTrustedDeviceLinkQueuedOrigin } from '../makerSendTransaction.js';
import { stampMobileClientOrigin } from '../mobileClientPromptNote.js';
import { isAutomaticInputOriginKind, type AgentInputProjection, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { SchedulerQueuedPromptRequest } from '../register.js';

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

export function createInputEnqueueHarness(coordinator: AgentInputCoordinator, options: {
  remote?: boolean;
  mobile?: boolean;
  resumeInterruptedScheduleRun?: typeof import('../../scheduler-host/index.js').resumeInterruptedScheduleRun;
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
