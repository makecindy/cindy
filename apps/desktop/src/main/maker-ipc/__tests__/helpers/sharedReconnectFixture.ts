import { vi } from 'vitest';
import { createProviderGroupGuestSwitch } from '../../../provider-group/guestSwitch';
import { createProviderGroupRouter } from '../../../provider-group/router';
import { createProviderGroupService, type ProviderGroupServiceDeps } from '../../../provider-group/service';
import { createUserMessageDurableWrite, type UserMessageDurableWritePorts } from '../../userMessageDurableWrite';

export function createSharedReconnectFixture() {
  const now = () => 0;
  const guestSwitch = createProviderGroupGuestSwitch(now);
  const directory: ProviderGroupServiceDeps['directory'] = {
    resolveMembers: async () => [],
    listCandidates: async () => [],
    readDeviceCatalog: async () => [],
    probe: async () => { throw new Error('Unexpected provider probe'); },
    memberLabel: member => member.key,
    invalidate: vi.fn(),
  };
  const readGroup = () => null;
  const isTurnRunning = () => false;
  const router = createProviderGroupRouter({
    directory, readGroup, isTurnRunning, listBindings: () => ({}), now, random: () => 0,
  });
  const service = createProviderGroupService({
    router, directory, readGroup, isTurnRunning, guestSwitch, now,
    readBinding: () => null,
    writeBinding: vi.fn(),
    isReleased: () => false,
    markReleased: vi.fn(),
    readSessionRow: async () => null,
    resolveImplicitProvider: async () => null,
    persistRoute: vi.fn(),
    hasAssistantHistory: async () => false,
    isFailoverEligible: async () => false,
    leaseRecovery: () => null,
    isLeaseCurrent: () => false,
    rearmContinue: () => null,
    cancelContinue: vi.fn(),
    switchAgentLocation: vi.fn(),
    continueSession: async () => 'no-progress',
    fallback: vi.fn(),
    readResetAt: () => null,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  const createDbMessage = vi.fn<UserMessageDurableWritePorts['createDbMessage']>(async (sessionId, message) => ({
    sessionId,
    clientId: message.clientId,
    role: message.role,
    content: message.content,
    id: 'row',
    toolUseId: null,
    agentMeta: message.agentMeta ?? null,
    createdAt: new Date(now()).toISOString(),
  }));
  const write = createUserMessageDurableWrite({
    autoResumeBookkeeping: { registerPendingOutcome: vi.fn(), releasePendingOutcome: vi.fn() },
    silentStopAutoResumeGuard: { noteUserSend: vi.fn() },
    interruptedTurnAutoResumeGuard: { noteUserSend: vi.fn() },
    usageLimitAutoResume: { noteUserAction: vi.fn() },
    getProviderGroupService: () => service,
    enqueueDurableWrite: async (_label, commit) => commit(null),
    getLastAssistantTranscriptUuid: () => 'anchor',
    getSessionDbAgentKind: () => 'codex',
    createDbMessage,
  });
  return { write, createDbMessage, service, guestSwitch };
}
