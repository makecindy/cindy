import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createXdtHelperMcpServer, type PersonalRuleEdit } from '@cindy/mcps';
import { createMakerSendTransaction, type MakerSendTransactionDeps, type MakerSendTransactionSession } from '../makerSendTransaction';
import { MAIN_OWNED_SEND_CONTEXT } from '@cindy/maker-core';
import { createPersonalRuleChat } from '../personalRuleChat';
import { AgentInputCoordinator } from '../agent-input-coordinator';
import type { AgentInputQueuedMessage, AgentInputProjection } from '../../../shared/agentInputQueue';
import { stringifyUserContent } from '../../../renderer/lib/imageRef';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import { Method } from '../../../../../../packages/maker-core/src/agents/codex/app-server/protocol.js';
import type { ThreadEventHandlers } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import { PiAgent } from '../../../../../../packages/maker-core/src/agents/pi/index.js';
import type { AgentDeps } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { AutoReviewRequest, ManagedAutoReviewCheck } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../../../../../packages/maker-core/src/types/events.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

// Desktop -> core integration only. Reuse this IPC/store fixture rather than
// copying the large core test or importing a test module. Only Pi transport is
// simulated: the agent installs its real root dispatcher and all policy gates.
const piRpc = vi.hoisted(() => ({ onEvent: null as ((event: unknown) => void) | null,
  responses: [] as Array<Record<string, unknown>>, abortAccepted: true, abortReceipts: [] as boolean[] }));
vi.mock('../../../../../../packages/maker-core/src/agents/pi/transport.js', () => ({
  createPiStdioTransport: () => ({ writeLine: async () => {}, onLine: () => () => {}, onStderr: () => () => {},
    onClose: () => () => {}, close: async () => {}, pid: 1234, isClosed: () => false }),
  attachJsonlReader: () => {},
}));
vi.mock('../../../../../../packages/maker-core/src/agents/pi/rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(options: { onEvent(event: unknown): void }) { piRpc.onEvent = options.onEvent; }
    async request(command: { type: string }) {
      if (command.type === 'abort') {
        piRpc.abortReceipts.push(piRpc.abortAccepted);
        return { success: piRpc.abortAccepted, ...(piRpc.abortAccepted ? {} : { error: 'synthetic abort rejected' }) };
      }
      return { success: true, data: command.type === 'get_commands' ? { commands: [] }
        : command.type === 'get_state' ? { sessionFile: '/test/session.jsonl', isStreaming: false, isCompacting: false,
          pendingMessageCount: 0, model: { provider: 'cindy', id: 'm', contextWindow: 200000 } } : { entries: [] } };
    }
    send(response: Record<string, unknown>) { piRpc.responses.push(response); }
    async close() { this.isClosed = true; }
  },
}));
import type { RuleScope } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/types';
import type { AutoCommandConfirmation } from '../../../../../../packages/maker-core/src/types/events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalRuleStore } from '../../maker-host/approval-rule-store';
import { isTrustedAppRendererEventForLocation } from '../../security/trustedAppRenderer';
import type { SessionRowSnapshot } from '../../localDb/ipc/sessions';
import { MAKER_INVOKE } from '../channels';
import type { IpcHandler } from '../ipcHandlerRegistry';
import { registerApprovalRuleCommandHandler, captureRememberedAutoCommand, type ApprovalRuleCommandDeps } from '../approvalRuleCommandHandler';
import { IpcHarness } from './helpers/ipcHarness';
import { captureManagedApprovalOwner, isManagedApprovalOwnerCurrent } from '../../maker-host/managed-approval-owner';
import { createManagedBashDenyHooks } from '../../maker-host/claude-hooks/managed-bash-deny-hook';
import { requirementsOrigin } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements';
import { normalizeRuleGroup } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize';
import type { ApprovalRuleCommandResult } from '../../../shared/approvalRuleCommand';
import { createManagedAutoReviewPrecheck } from '../../maker-host/managed-auto-review';
import { withAutoReviewContext, type AutoReviewDelegate } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision';

const mainIdentity = vi.hoisted(() => ({
  deviceId: 'dev-isolated-test', relayId: null as string | null, pending: false,
  app: { mode: 'local', dataOwnerId: 'owner', generation: 1 },
  db: { userId: 'owner' }, dir: '',
}));
vi.mock('../../authManager', () => ({ getDeviceId: () => mainIdentity.deviceId }));
vi.mock('../../device-link/index', () => ({ getSelfDeviceId: () => mainIdentity.relayId }));
vi.mock('../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: () => mainIdentity.db }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ ...mainIdentity.app }),
  activeOwnerScopeKey: () => [mainIdentity.app.mode, mainIdentity.app.dataOwnerId, mainIdentity.app.generation].join(':'),
  isAppSessionBoundaryPending: () => mainIdentity.pending,
  ownerScopedUserDataPath: () => mainIdentity.dir,
}));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-command-'));
  dirs.push(dir);
  const harness = new IpcHarness();
  let registeredHandler: IpcHandler | undefined;
  const dbClient = {};
  let owner = 'owner:1';
  let inputGeneration = 0;
  let row: SessionRowSnapshot = {
    status: 'active', source: 'desktop', agentKind: 'cc', workingDir: '/project',
    title: 'Existing task', userSendAt: 1, workspaceKind: 'project', providerId: null,
    remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null,
  };
  let readCount = 0;
  let pendingRead: { at: number; change: () => void } | null = null;
  const deps: ApprovalRuleCommandDeps = {
    assertTrustedSender: vi.fn(), isDeviceLinkInvoke: () => false,
    captureOwner: () => ({ ownerId: 'owner', executionHostId: 'host', generation: owner, dbClient }),
    ownerCurrent: captured => owner === captured.generation && captured.dbClient === dbClient,
    getInputGeneration: () => inputGeneration,
    readSession: async () => { readCount++;
      if (pendingRead?.at === readCount) { const next = pendingRead.change; pendingRead = null; next(); }
      return { ...row }; },
    isProvisional: () => false,
    withSessionLock: async (_id, run) => run(),
    createStore: (captured, assertCurrent, consumer) => createApprovalRuleStore({
      ownerId: 'owner', ownerDataDir: dir, assertCurrent, localManagedCommandHostId: captured.executionHostId,
      ...(consumer ? { resolveManagedConsumer: () => consumer } : {}),
    }),
  };
  registerApprovalRuleCommandHandler({ handle: (channel, handler) => {
    harness.handle(channel, handler);
    registeredHandler = handler;
  } }, deps);
  const command = (text: string) => harness.invokeFrom(1, MAKER_INVOKE.APPROVAL_RULE_COMMAND,
    { sessionId: 'task', text });
  const store = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: dir, assertCurrent: () => {} });
  const scope = { ownerId: 'owner', executionHostId: 'host', harnesses: ['claude-code'] as const };
  return { command, store, scope, deps, dir,
    useMainOwner: () => {
      mainIdentity.app = { mode: 'local', dataOwnerId: 'owner', generation: 1 };
      mainIdentity.db = { userId: 'owner' }; mainIdentity.pending = false;
      mainIdentity.deviceId = 'dev-isolated-test'; mainIdentity.relayId = null; mainIdentity.dir = dir;
      deps.captureOwner = captureManagedApprovalOwner;
      deps.ownerCurrent = isManagedApprovalOwnerCurrent;
    },
    invokeEvent: (event: unknown, text: string) => registeredHandler!(event as never,
      { sessionId: 'task', text }),
    setRow: (change: Partial<SessionRowSnapshot>) => { row = { ...row, ...change }; },
    changeOwner: () => { owner = 'owner:2'; },
    clear: () => { inputGeneration++; row = { ...row, clearedAt: 100 }; },
    stop: () => { inputGeneration++; },
    convert: () => { row = { ...row, agentKind: 'codex' }; },
    onRead: (at: number, change: () => void) => { pendingRead = { at, change }; },
  };
}

// Unit integration value: IPC -> reopened store -> real Main precheck -> real
// Pi root RPC -> reviewer/confirmation. Existing B/C2 inject generic groups and
// cannot prove new-namespace consumption or initial storage-fault delivery.
// All HOME/data/cwd files are synthetic mkdtemp; no native Pi/model/network runs.
async function setupPiIntegration() {
  const h = setup();
  const workDir = fs.realpathSync(h.dir);
  h.setRow({ agentKind: 'pi', workingDir: workDir });
  const home = path.join(h.dir, 'pi-home'); fs.mkdirSync(home);
  const rg = path.join(home, 'rg'); fs.writeFileSync(rg, 'test ripgrep');
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = { id: 'task', instanceId: 'root', requestSessionId: 'pi-root', agentKind: 'pi', workDir, remoteHostId: null, agentDeviceId: null,
    autoReviewOwner: 'cindy' as const, stablePermissionModeState: { mode: 'auto', generation: 1 },
    stablePlanModeState: { enabled: false, generation: 1 }, getStatus: () => 'active' };
  const requests: AutoReviewRequest[] = [];
  let verdict: 'allow' | 'ask' | 'block' = 'allow';
  let builtinGeneration = 0;
  const review: AutoReviewDelegate = vi.fn(async request => { requests.push(request); return { verdict }; });
  review.precheckManagedAction = createManagedAutoReviewPrecheck({ captureOwner: () => ({ ...h.deps.captureOwner()!, ownerDataDir: h.dir }),
    ownerCurrent: h.deps.ownerCurrent, listSessions: () => [session],
    readSessionRow: async () => h.deps.readSession('task'), canonicalWorkDir: async dir => fs.realpathSync(dir) });
  const deps: AgentDeps = {
    auth: { getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' }),
      triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
    runtimeConfig: { endpoint: 'http://127.0.0.1:9', systemPrompt: 'Test fixture', managedExecutablePaths: { ripgrep: rg } },
    binaryPath: process.execPath, logger, resolvePiAgentHome: () => home,
    getPiManagedBuiltinBashGeneration: () => builtinGeneration, resolvePiGatewayModelApi: () => 'openai-responses',
    capabilityAdditions: { availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200000, efforts: [], defaultEffort: null,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxOutputTokens: 64000 }] }, reviewAutoPermissionAction: review,
  };
  piRpc.responses = []; piRpc.abortAccepted = true; piRpc.abortReceipts = [];
  const handle = await new PiAgent(deps).startSession({ sessionId: 'task', sessionInstanceId: 'root',
    workingDir: workDir, model: 'm', permissionMode: 'auto' });
  const cards: InteractionRequest[] = [];
  let confirm = async (_request: InteractionRequest): Promise<InteractionDecision> => ({ kind: 'permission', behavior: 'deny' });
  handle.setInteractionResolver!(async request => { cards.push(request); return confirm(request); });
  await handle.send({ type: 'user', content: 'Inspect only this isolated test directory.' });
  const set = (text: string, decision: 'allow' | 'ask' | 'deny' = 'allow', scope: 'user' | 'project' = 'user') =>
    h.command(requirementsCommand(scope, { id: 'integrated-pi', targets: ['pi'], text,
      clauses: [{ id: 'known', decision, exact: 'pwd', original: '明确的 pwd 条款' }] }));
  const remove = (scope: 'user' | 'project') => h.command(requirementsCommand(scope, { id: 'integrated-pi', targets: ['pi'] }, true));
  const fire = (id: string) => piRpc.onEvent!({ type: 'extension_ui_request', method: 'input', id, title: 'cindy:permission',
    placeholder: JSON.stringify({ toolName: 'bash', input: { command: 'pwd' }, resolvedCredentialPaths: [] }) });
  const response = async (id: string) => { await vi.waitFor(() => expect(piRpc.responses.find(row => row.id === id)).toBeDefined());
    return String(piRpc.responses.find(row => row.id === id)!.value); };
  const effective = () => createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
    localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: ['pi'], projectId: workDir },
      sessionId: 'task', sessionInstanceId: 'root' }) }).readPublishedManagedSnapshot();
  return { ...h, workDir, handle, session, review, requests, cards, set, remove, fire, response, effective,
    retireBuiltin: () => { builtinGeneration++; },
    confirm: (callback: typeof confirm) => { confirm = callback; }, verdict: (value: typeof verdict) => { verdict = value; } };
}

// Desktop direction: existing real IPC/store + Main precheck, actual Codex
// Agent registration. Only the transport Host is a narrow request/subscription
// stub (no approval merger, no native CLI). No core -> Desktop dependency.
async function setupCodexIntegration() {
  const h = setup(); const workDir = fs.realpathSync(h.dir);
  h.setRow({ agentKind: 'codex', workingDir: workDir });
  const session = { id: 'task', instanceId: 'root', requestSessionId: 'root-thread', agentKind: 'codex', workDir,
    remoteHostId: null, agentDeviceId: null, autoReviewOwner: 'cindy' as const,
    stablePermissionModeState: { mode: 'auto', generation: 1 }, stablePlanModeState: { enabled: false, generation: 1 }, getStatus: () => 'active' };
  const requests: AutoReviewRequest[] = []; const prechecks: ManagedAutoReviewCheck[] = [];
  let verdict: 'allow' | 'ask' | 'block' = 'allow';
  const review: AutoReviewDelegate = vi.fn(async request => { requests.push(request); return { verdict }; });
  const main = createManagedAutoReviewPrecheck({ captureOwner: () => ({ ...h.deps.captureOwner()!, ownerDataDir: h.dir }),
    ownerCurrent: h.deps.ownerCurrent, listSessions: () => [session], readSessionRow: async () => h.deps.readSession('task'),
    canonicalWorkDir: async dir => fs.realpathSync(dir) });
  review.precheckManagedAction = async request => { const value = await main(request); prechecks.push(value); return value; };
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const agent = new CodexAgent({ auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
    logout: async () => {}, getAuthEnv: async () => ({}) }, runtimeConfig: {}, binaryPath: process.execPath, logger, reviewAutoPermissionAction: review });
  let handlers: ThreadEventHandlers | undefined;
  const host = {
    ensureStarted: async () => ({ userAgent: 'fixture/0.159.2' }),
    ensureStartedWithTimeout: async () => ({ userAgent: 'fixture/0.159.2' }),
    request: async (method: string) => {
      if (method === Method.ThreadStart) return { thread: { id: 'root-thread' }, model: 'gpt-5.4', modelProvider: 'openai', cwd: workDir };
      if (method === Method.TurnStart) return { turn: { id: 'root-turn' } };
      if (method === Method.TurnSteer) return { turnId: 'root-turn' };
      if (method === Method.ConfigRead) return { config: {} };
      if (method === Method.McpServerStatusList) return { data: [], nextCursor: null };
      if (method === Method.SkillsList) return { data: [{ cwd: workDir, skills: [], errors: [] }] };
      if (method === Method.ThreadSettingsUpdate || method === Method.TurnInterrupt) return {};
      throw new Error('Unexpected fixture Host request: ' + method);
    },
    subscribeThread: (_id: string, value: ThreadEventHandlers) => { handlers = value; return { release() {} }; },
    unsubscribeThread: async () => {}, hasThreadSubscription: () => false,
    isCodexProxyActive: () => false, isCodexBrowserUseAvailable: () => false, getCodexBrowserUseVersion: () => null,
    getRemoteCompactionProviderId: () => null, getCindyRemoteCompactionProviderId: () => null, getLocalCompactionProviderId: () => null,
    getCustomProviderModelProviderId: () => null, getCustomProviderThreadPolicy: () => ({ dynamicIdentity: false, disableSubagents: false, disableModelOverrides: false }),
    getSessionMcpConfig: () => ({}), getSubagentModelFallback: () => undefined, getSubagentRoute: () => undefined,
    getObservedSubagentIdentity: () => undefined, getOpenAiWebSocketsEnabled: () => true, getConnectionId: () => 'isolated-codex-host',
    reserveDescendantLineage() {}, registerDescendantLineage() {}, discardPendingDescendantLineage() {}, retire: async () => {},
  };
  Object.defineProperty(agent, 'getHost', { value: async () => {
    (agent as unknown as { hosts: Map<string, unknown> }).hosts.set('local', host); return host;
  } });
  const handle = await agent.startSession({ sessionId: 'task', sessionInstanceId: 'root', workingDir: workDir, model: 'gpt-5.4', permissionMode: 'auto' });
  const events: AgentEvent[] = [];
  void (async () => { for await (const event of handle.events()) events.push(event); })();
  const cards: InteractionRequest[] = [];
  let confirm = async (_request: InteractionRequest): Promise<InteractionDecision> => ({ kind: 'permission', behavior: 'deny' });
  handle.setInteractionResolver!(async request => { cards.push(request); return confirm(request); });
  await handle.send({ type: 'user', content: 'Inspect only this isolated Codex directory.' });
  const set = (text: string, decision: 'allow' | 'ask' | 'deny' = 'allow', scope: 'user' | 'project' = 'user') =>
    h.command(requirementsCommand(scope, { id: 'integrated-codex', targets: ['codex'], text,
      clauses: [{ id: 'known', decision, exact: 'pwd', original: '显式 pwd 条款' }] }));
  const remove = (scope: 'user' | 'project') => h.command(requirementsCommand(scope, { id: 'integrated-codex', targets: ['codex'] }, true));
  const fire = (id: string) => handlers!.commandExecutionApproval!({ threadId: 'root-thread', turnId: 'root-turn', itemId: id,
    approvalId: 'approval-' + id, command: 'pwd', cwd: workDir });
  const mode = async () => { session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 }; await handle.setPermissionMode!('bypassPermissions'); };
  const effective = () => createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {}, localManagedCommandHostId: 'host',
    resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: ['codex'], projectId: workDir }, sessionId: 'task', sessionInstanceId: 'root' }) }).readPublishedManagedSnapshot();
  return { ...h, session, handle, workDir, review, requests, cards, events, prechecks, fire, set, remove, mode, effective,
    confirm: (value: typeof confirm) => { confirm = value; }, verdict: (value: typeof verdict) => { verdict = value; } };
}

// Unit integration: reuse the existing real owner store/Main/Codex callback fixture.
// Only Agent transport and DB persistence are injected; no native CLI or sockets.
async function setupChatIntegration(queued = false) {
  const h = await setupCodexIntegration();
  const messages = new Map<string, { role: string; content: unknown; agentMeta: unknown }>();
  let persistFailure = false;
  let acceptedInput: { clientId: string } | null = null;
  let afterPersist = () => {};
  let coordinator: AgentInputCoordinator | undefined;
  const dispatches: Array<{ message: unknown; options: unknown }> = [];
  const chat = createPersonalRuleChat({ ...h.deps, getSession: () => h.session,
    getInputGeneration: sid => coordinator ? coordinator.getGeneration(sid) : h.deps.getInputGeneration(sid),
    inputIdentity: () => coordinator ? coordinator.getAcceptedInputProvenance('task') : acceptedInput,
    ownerInput: () => coordinator?.isActiveInputOwnerAuthored('task') ? coordinator.getAcceptedInputProvenance('task') : null,
    createStore: (...args) => h.deps.createStore(...args),
    readMessage: async (_sid, clientId) => messages.get(clientId) ?? null });
  const session: MakerSendTransactionSession = { ...h.session, agentKind: 'codex', getStatus: () => 'active',
    stablePermissionModeState: { mode: 'auto', generation: 1 }, isTurnRunning: () => false,
    send: async (_message, options) => { await options?.onAccepted?.(); return { accepted: true }; } };
  const deps: MakerSendTransactionDeps = {
    capturePersonalRuleInput: (sid, message, options) => chat.captureSend(sid, message, options),
    statDirectory: dir => fs.promises.stat(dir),
    withRehydrateCloseSuppressed: (_sid, run) => run(),
    readWorkingDirectoryRecoveryCreateOpts: async () => ({ agentKind: 'codex', workingDir: h.workDir, model: 'gpt-5.4' }),
    getSession: () => session, closeSession: async () => {}, getSessionMeta: async () => ({ title: 'Synthetic chat' }),
    ensureRemoteReadyForSessionStart: async () => {}, checkWorkDirExists: async () => true,
    preflightBotRuntimeResources: async () => {}, isOrcaMcpHydrated: () => true,
    buildCreateOptsWithStderr: options => options, synthesizeOrcaVendorOptionsFromDb: async () => false,
    readSessionExtraDirsFromDb: async () => [], readSessionWorkingDirFromDb: async () => null,
    bootstrapSession: async () => ({ session, didInjectOrcaInstructions: false, didInjectProjectContext: false }),
    markOrcaRoleIfNeeded: async () => {}, broadcastSessionCreated: () => {}, prepareSendUserMessage: async (_sid, message) => message as string,
    createDbMessage: async (_sid, message) => { if (persistFailure) throw new Error('synthetic persist failure');
      messages.set(message.clientId, queued ? { ...message, agentMeta: JSON.stringify(message.agentMeta) } : message);
      acceptedInput = { clientId: message.clientId }; afterPersist(); },
    isSessionRunningError: () => false, log: { info() {}, warn() {} },
  };
  const transaction = createMakerSendTransaction(deps);
  const server = createXdtHelperMcpServer({ resolveSurface: async () => 'default',
    authorizeCall: async () => ({ ok: true }), personalApprovalRule: chat.edit },
    { agentKind: 'codex', workingDir: h.workDir, getSessionContext: () => ({
      agentKind: 'codex', workingDir: h.workDir, sessionId: 'task', sessionInstanceId: 'root' }) });
  const client = new Client({ name: 'personal-rule-chain', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  let queuedResult: { resolve(value: { accepted: boolean }): void; reject(error: unknown): void } | undefined;
  if (queued) coordinator = new AgentInputCoordinator({
    sendToAgent: async (sid, message, createOpts, options) => {
      dispatches.push({ message, options });
      try {
        const result = await transaction.sendToAgentAccepted(sid, message, createOpts, options);
        queuedResult?.resolve(result);
        return { kind: 'session-dispatch', source: 'chat-representation-unit', dispatched: true };
      } catch (error) { queuedResult?.reject(error); throw error; }
    },
    steerToAgent: async () => {}, abortSession: async () => {}, isTurnRunning: () => false,
    hasPendingInteraction: () => false, getAgentKind: () => 'codex', getSdkSessionId: async () => 'root-thread',
    emitProjection: (_projection: AgentInputProjection) => {},
  });
  const sendQueued = async (text: string, clientId: string, patch: Partial<AgentInputQueuedMessage> = {}) => {
    if (!coordinator) throw new Error('missing coordinator');
    await coordinator.ensureQueueRestored('task');
    coordinator.onTurnEvent('task', 'done');
    const result = new Promise<{ accepted: boolean }>((resolve, reject) => { queuedResult = { resolve, reject }; });
    coordinator.enqueue('task', { clientId, text, autoReviewUserText: text,
      persistedContent: stringifyUserContent(text, [], [], false, [], []), model: 'gpt-5.4', effort: 'medium',
      permissionMode: 'auto', workingDir: h.workDir,
      chatMessage: { clientId, role: 'user', content: text, isStreaming: false, createdAt: '2026-10-27T00:00:00.000Z' },
      createOpts: { agentKind: 'codex', workingDir: h.workDir, model: 'gpt-5.4', effort: 'medium', permissionMode: 'auto' }, ...patch });
    return result;
  };
  let input = 0;
  const send = (text: string, clientId = 'chat-' + ++input, source = 'desktop') => queued
    ? sendQueued(text, clientId, source === 'desktop' ? {} : { origin: { kind: 'session', senderSessionId: 'other', displayText: 'Other task', senderSessionTitle: 'Other' } })
    : transaction.sendToAgentAccepted('task',
    { type: 'user', content: text }, undefined, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: source as 'desktop' }, rawChannelText: text },
      persistUserMessage: { clientId, content: text, delivery: 'turn', origin: { kind: source as 'desktop' } },
    });
  const call = async (edit: PersonalRuleEdit, extras: object = {}) => {
    const result = await client.callTool({ name: 'call_tool', arguments: { name: 'edit_personal_approval_rule', args: { ...edit, ...extras } } });
    const first = result.content as Array<{ type: string; text?: string }>;
    return JSON.parse(first[0]!.text!) as Record<string, unknown>;
  };
  return { ...h, chat, send, sendQueued, call, messages, dispatches, coordinator, transactionDeps: deps, client,
    persistFailure: () => { persistFailure = true; }, retireInput: () => { acceptedInput = null; }, afterPersist: (fn: () => void) => { afterPersist = fn; },
    close: async () => { await client.close(); await server.close(); await h.handle.close(); } };
}

// Compare every persisted draft/marker/artifact byte; the lock itself is transient.
function approvalBytes(dir: string): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  const visit = (root: string) => {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push([path.relative(dir, file), fs.readFileSync(file).toString('base64')]);
    }
  };
  visit(path.join(dir, 'command-approval-runtime'));
  for (const suffix of ['', '.bak']) {
    const file = path.join(dir, 'command-approval-rules.json' + suffix);
    if (fs.existsSync(file)) files.push([path.relative(dir, file), fs.readFileSync(file).toString('base64')]);
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}
const requirementsCommand = (scope: 'user' | 'project', input: object, remove = false) =>
  '/approval-rule ' + (remove ? 'remove' : 'set') + ' ' + scope + ' --requirements ' + JSON.stringify(input);

describe('local approval command IPC', () => {
  // Supplemental phase-two contract: real accepted coordinator messages and
  // registered IPC/helper -> reopened file store, with injected DB/transport.
  // Covers previously missing ordinary/no-key operations and per-end status.
  it('adopts ordinary persistent expressions without technical keys and edits/deletes by exact owner-authored reference', async () => {
    const h = await setupChatIntegration(true);
    try {
      const body = '仅执行读取操作，\r\n不要执行危险命令，不要泄露 API key 内容 🧪  保留空格';
      const original = '记住：' + body;
      await h.send(original, 'ordinary');
      const beforeHelper = await h.effective();
      expect(beforeHelper.kind === 'published-managed' && beforeHelper.groups[0]!.clauses[0]!.original).toBe(original);
      const saved = await h.call({ action: 'set', scope: 'user' });
      expect(saved).toMatchObject({ ok: true, kind: 'saved' });
      const beforeStatus = approvalBytes(h.dir);
      expect(await h.call({ action: 'status', scope: 'user' })).toMatchObject({ ok: true, kind: 'status',
        statuses: expect.arrayContaining([expect.objectContaining({ harness: 'pi', state: 'not-effective' })]) });
      expect(approvalBytes(h.dir)).toEqual(beforeStatus);
      const initial = await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'], projectId: h.workDir });
      expect(initial.groups).toHaveLength(1);
      const id = initial.groups[0]!.id;
      expect(initial.groups[0]!.scope.harnesses).toEqual(['claude-code', 'codex', 'pi']);
      expect(initial.groups[0]!.clauses[0]!.original).toBe(original);
      await h.fire('ordinary-full-text');
      expect(h.requests.at(-1)!.personalRequirements?.groups).toContainEqual(expect.objectContaining({
        clauses: expect.arrayContaining([expect.objectContaining({ original })]) }));
      const replacement = '以后仅执行只读命令，不要改动文件，请一直按这条长期要求执行。';
      const editMessage = '修改个人规则「' + body + '」为：' + replacement;
      await h.send(editMessage, 'ordinary-edit');
      const autoEdited = await h.effective();
      expect(autoEdited.kind === 'published-managed' && autoEdited.groups[0]!.clauses[0]!.original).toBe(editMessage);
      const edited = await h.call({ action: 'set', scope: 'user', reference: body });
      expect(edited).toMatchObject({ ok: true, kind: 'saved', ruleId: id });
      expect((await h.effective()).kind).toBe('published-managed');
      const projectBody = '本项目先确认再写入';
      await h.send('修改项目规则「' + replacement + '」为：' + projectBody, 'ordinary-project');
      const projectView = await h.effective();
      expect(projectView.kind === 'published-managed' && projectView.groups).toHaveLength(1);
      expect(projectView.kind === 'published-managed' && projectView.groups[0]!.scope.projectId).toBe(h.workDir);
      expect(await h.call({ action: 'set', scope: 'project', reference: replacement })).toMatchObject({ ok: true, kind: 'saved' });
      await h.send('删除项目规则「' + projectBody + '」', 'ordinary-project-delete');
      const restored = await h.effective();
      expect(restored.kind === 'published-managed' && restored.groups[0]!.id).toBe(id);
      expect(await h.call({ action: 'delete', scope: 'project', reference: projectBody })).toMatchObject({ ok: true, kind: 'deleted' });
      await h.send('删除个人规则「' + replacement + '」', 'ordinary-delete');
      expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
      expect(await h.call({ action: 'delete', scope: 'user', reference: replacement })).toMatchObject({ ok: true, kind: 'deleted', ruleId: id });
      await h.send(replacement, 'ordinary-future');
      expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups[0]!.clauses[0]!.original).toBe(replacement);
      expect(await h.call({ action: 'set', scope: 'user' })).toMatchObject({ ok: true, kind: 'saved' });
    } finally { await h.close(); }
  });

  it('does not turn unkeyed discussion or a model-provided key/target into owner authorization', async () => {
    const h = await setupChatIntegration(true);
    try {
      await h.send('记住：不要执行危险命令', 'safe-body');
      const before = approvalBytes(h.dir);
      expect(await h.call({ action: 'set', key: 'invented', scope: 'user' })).toMatchObject({ ok: false });
      expect(await h.call({ action: 'set', harness: 'codex', scope: 'user' })).toMatchObject({ ok: false });
      for (const [index, text] of [
        '设置示例只是讨论，不要保存：个人长期规则：不要执行危险命令',
        '修改示例只是讨论，不要保存：个人长期规则：不要执行危险命令',
        '以后只是讨论个人规则，请一直按这条长期要求作为示例。',
        '记住：不要修改个人长期规则。',
      ].entries()) {
        await h.send(text, 'no-write-' + index);
        expect(await h.call({ action: 'set', scope: 'user' })).toMatchObject({ ok: false });
        expect(approvalBytes(h.dir)).toEqual(before);
      }
    } finally { await h.close(); }
  });

  it('uses the latest same-layer target edit without losing shared restoration or project precedence', async () => {
    const h = setup(); const project = fs.realpathSync(h.dir); h.setRow({ workingDir: project });
    const set = (text: string, targets?: string[], scope: 'user' | 'project' = 'user') =>
      h.command(requirementsCommand(scope, { id: 'overlap', text, ...(targets ? { targets } : {}) }));
    const read = async (target: 'claude-code' | 'codex' | 'pi') =>
      (await h.store.readSnapshot({ ...h.scope, harnesses: [target], projectId: project })).groups.map(group => group.clauses[0]!.original);
    await set('shared first');
    await set('codex later', ['codex']);
    expect(await read('codex')).toEqual(['codex later']);
    expect(await read('claude-code')).toEqual(['shared first']);
    await set('project codex', ['codex'], 'project');
    await set('shared latest');
    expect(await read('codex')).toEqual(['project codex']);
    expect(await read('pi')).toEqual(['shared latest']);
    await h.command(requirementsCommand('project', { id: 'overlap', targets: ['codex'] }, true));
    expect(await read('codex')).toEqual(['shared latest']);
    await h.command(requirementsCommand('user', { id: 'overlap' }, true));
    expect(await read('codex')).toEqual(['codex later']);
  });

  it('defaults legacy exact saves to all three consumers, preserving explicit single-end selection', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    expect(await h.command('/approval-rule deny user -- pwd')).toMatchObject({ kind: 'saved', ruleIds: expect.any(Array) });
    for (const target of ['claude-code', 'codex', 'pi'] as const) {
      const view = await h.store.readSnapshot({ ...h.scope, harnesses: [target] });
      expect(view.groups).toHaveLength(1);
      expect(view.groups[0]!.clauses[0]!.decision).toBe('deny');
    }
    await h.command('/approval-rule ask user --harness codex -- whoami');
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toHaveLength(2);
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] })).groups).toHaveLength(1);
  });

  it('reports contextual per-end availability read-only and never reports native loading', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    let runtime: NonNullable<ReturnType<NonNullable<ApprovalRuleCommandDeps['consumerState']>>> = {
      instanceId: 'root', harness: 'codex', active: true, local: true, mode: 'auto', plan: false, reviewOwner: 'cindy' };
    h.deps.consumerState = () => runtime;
    await h.command(requirementsCommand('user', { id: 'status', text: '只读原文' }));
    const bytes = approvalBytes(h.dir);
    const status = await h.command('/approval-rule status') as Extract<ApprovalRuleCommandResult, { kind: 'status' }>;
    expect(status.kind).toBe('status');
    expect(status.statuses).toEqual([
      expect.objectContaining({ harness: 'claude-code', reason: 'no-current-task', state: 'not-effective' }),
      expect.objectContaining({ harness: 'codex', reason: 'ready', state: 'available', nativeQualification: 'unverified' }),
      expect.objectContaining({ harness: 'pi', reason: 'no-current-task', state: 'not-effective' }),
    ]);
    for (const [change, reason] of [
      [{ mode: 'default' }, 'auto-required'], [{ mode: 'bypassPermissions' }, 'auto-required'],
      [{ plan: true }, 'plan-mode'], [{ reviewOwner: 'native' }, 'native-owned'],
    ] as const) {
      const before = runtime; runtime = { ...runtime, ...change };
      const next = await h.command('/approval-rule status') as typeof status;
      expect(next.statuses.find(value => value.harness === 'codex')).toMatchObject({ state: 'not-effective', reason });
      runtime = before;
    }
    expect(approvalBytes(h.dir)).toEqual(bytes);
    const snapshot = await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] });
    const old = snapshot.groups[0]!;
    const draft = normalizeRuleGroup(requirementsOrigin('unpublished-status'), old.scope, old.clauses);
    await h.store.applyManagedEdit(snapshot.revision, draft.scope, [draft]);
    const pendingBytes = approvalBytes(h.dir);
    const pending = await h.command('/approval-rule status') as typeof status;
    expect(pending.statuses.every(value => value.reason === 'pending-activation')).toBe(true);
    expect(approvalBytes(h.dir)).toEqual(pendingBytes);
    const artifact = path.join(h.dir, 'command-approval-runtime', 'revisions', String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
    fs.renameSync(artifact, artifact + '.bak');
    const missingBytes = approvalBytes(h.dir);
    const unavailable = await h.command('/approval-rule status') as typeof status;
    expect(unavailable.statuses.every(value => value.reason === 'storage-unavailable' && value.state === 'not-effective')).toBe(true);
    expect(approvalBytes(h.dir)).toEqual(missingBytes); // Read-only status does not repair files.
    // A fresh fixture exercises owner retirement across the status read below.
    const retired = setup(); retired.setRow({ workingDir: retired.dir }); retired.onRead(1, retired.changeOwner);
    await expect(retired.command('/approval-rule status')).rejects.toThrow();
  });

  // 2026-11-01 contract, unit: actual IPC and coordinator/Host -> reopened
  // effective store, not a copied parser. Previous tests required a single
  // explicit target and could not protect the new shared default.
  it('defaults a requirements composer save to one shared whole-text group', async () => {
    const h = setup();
    const work = fs.mkdtempSync(path.join(h.dir, 'shared-work-')); h.setRow({ workingDir: work });
    const text = '完整原文：不要执行危险命令 🧪';
    expect(await h.command(requirementsCommand('user', { id: 'shared-policy', text })))
      .toMatchObject({ kind: 'saved' });
    for (const target of ['claude-code', 'codex', 'pi'] as const) {
      const view = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
        localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({
          scope: { ownerId: 'owner', executionHostId: 'host', harnesses: [target], projectId: work },
          sessionId: 'task', sessionInstanceId: 'root' }) });
      const effective = await view.readPublishedManagedSnapshot();
      expect(effective.kind).toBe('published-managed');
      if (effective.kind !== 'published-managed') throw new Error('shared default was not published');
      expect(effective.groups).toHaveLength(1);
      expect(effective.groups[0]!.scope.harnesses).toEqual(['claude-code', 'codex', 'pi']);
      expect(effective.groups[0]!.clauses[0]!.original).toBe(text);
    }
  });

  it.each(['shared-policy', 'codex-policy'])('automatically persists a default shared chat rule and accepts only the matching registered helper candidate (%s)', async key => {
    const h = await setupChatIntegration(true);
    try {
      const text = '记住：个人长期规则 key ' + key + '：不要执行危险命令，保留完整原文 🧪';
      await h.send(text, 'shared-owner-input');
      const effective = await h.effective();
      expect(effective.kind).toBe('published-managed');
      if (effective.kind !== 'published-managed') throw new Error('shared chat rule was not effective');
      expect(effective.groups).toHaveLength(1);
      expect(effective.groups[0]!.scope.harnesses).toEqual(['claude-code', 'codex', 'pi']);
      expect(effective.groups[0]!.clauses[0]!.original).toBe(text);
      expect(await h.call({ action: 'set', key, scope: 'user' })).toMatchObject({ ok: true });
      expect(await h.call({ action: 'set', key, harness: 'codex', scope: 'user' })).toMatchObject({ ok: false });
      expect(await h.fire('shared-chat-consume')).toEqual({ decision: 'accept' });
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.personalRequirements?.groups).toEqual(effective.groups);
      expect(h.requests[0]!.userIntent).not.toBe(text);
      expect(h.cards).toHaveLength(0);
    } finally { await h.close(); }
  });

  // Value: actual accepted transaction -> Host evidence -> registered MCP call ->
  // reopened effective owner store -> actual registered Codex callback. The earlier
  // discovery red cannot prove any write, source authority or whole-text consumption.
  // Unit; synthetic files/messages only, no source extraction or native processes.
  it.each([
    '记住：只对 Codex 的个人 Auto 规则，设置 key release：  保留完整原文\r\n读取目录前应核对任务目标 🧪  ',
    '以后在 Codex 的个人 Auto 规则里，请一直按这条长期要求执行（key release）：读取目录前应核对任务目标，不要总结改写。',
    '记住：Codex 个人长期规则 key release：不要执行危险命令。',
  ])('saves explicit long-term chat verbatim through actual tool and consumes the group: %s', async original => {
    const h = await setupChatIntegration(true);
    try {
      const edit: PersonalRuleEdit = { action: 'set', key: 'release', harness: 'codex', scope: 'user' };
      expect(await h.send(original, 'owner-input')).toMatchObject({ accepted: true });
      expect(h.dispatches).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(h.dispatches[0]!.options, MAIN_OWNED_SEND_CONTEXT)).toBe(false);
      expect(h.messages.get('owner-input')!.content).toBe(stringifyUserContent(original, [], [], false, [], []));
      expect(typeof h.messages.get('owner-input')!.agentMeta).toBe('string');
      const automatic = await h.effective();
      expect(automatic.kind === 'published-managed' && automatic.groups[0]!.clauses[0]!.original).toBe(original);
      const result = await h.call(edit); expect(result).toMatchObject({ ok: true, kind: 'saved', clientId: 'owner-input' });
      expect(await h.call(edit)).toEqual(result);
      const effective = await h.effective(); expect(effective.kind).toBe('published-managed');
      if (effective.kind !== 'published-managed') throw new Error('missing active chat group');
      expect(effective.groups).toHaveLength(1);
      expect(effective.groups[0]!.clauses).toEqual([{ id: 'requirement', original, decision: 'requirement',
        reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'exec' } }]);
      expect(effective.revision).toBe(result.revision);
      expect(await h.call({ ...edit, harness: 'pi' })).toMatchObject({ ok: false });
      expect(await h.call(edit, { text: 'model summary', clientId: 'forged', ownerVerified: true })).toMatchObject({ ok: false });
      expect(await h.fire('chat-consume')).toEqual({ decision: 'accept' });
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.personalRequirements?.groups).toEqual(effective.groups);
      expect(h.requests[0]!.personalRequirements?.groups[0]?.clauses[0]?.original).toBe(original);
      expect(h.requests[0]!.userIntent).not.toBe(original);
      expect(h.cards).toHaveLength(0);
    } finally { await h.close(); }
  });

  // Unit regression for the accepted real-VM failure: production serialization ->
  // coordinator enqueue/dispatch -> transaction -> Host -> real reopened store.
  // DB I/O is injected with SQLite's observed string content/meta representation;
  // this does not claim real SQLite, renderer authentication, UI or native transport.
  it('rejects persisted JSON metadata provenance rather than treating the string as an empty object', async () => {
    const h = await setupChatIntegration(true);
    try {
      const text = '记住：Codex 个人长期规则 key release：不要执行危险命令。';
      h.afterPersist(() => { const row = h.messages.get('meta-red')!;
        row.agentMeta = JSON.stringify({ autoReviewUserText: text, autoResume: true }); });
      const pending = h.sendQueued(text, 'meta-red', { persistedContent: text });
      await expect(pending).rejects.toThrow('Personal rule save failed');
      const result = await h.call({ action: 'set', harness: 'codex', scope: 'user', key: 'release' });
      expect(result.ok).toBe(false);
      expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
    } finally { await h.close(); }
  });

  it('keeps legacy bare-text accepted replay idempotent without changing the stable group', async () => {
    const h = await setupChatIntegration();
    try {
      const text = '记住：Codex 个人长期规则 key release：legacy bare text';
      const edit: PersonalRuleEdit = { action: 'set', harness: 'codex', scope: 'user', key: 'release' };
      expect(await h.send(text, 'legacy')).toMatchObject({ accepted: true });
      const first = await h.call(edit); expect(first).toMatchObject({ ok: true });
      const before = approvalBytes(h.dir);
      expect(await h.call(edit)).toEqual(first);
      expect(await h.send(text, 'legacy')).toMatchObject({ accepted: true });
      expect(await h.call(edit)).toEqual(first);
      expect(approvalBytes(h.dir)).toEqual(before);
    } finally { await h.close(); }
  });

  // Same production queue/transaction boundary as the VM representation red.
  // Reject DB provenance mutations and non-text structures rather than flattening
  // them into owner authorization; the injected DB is not a real SQLite connection.
  it.each(['body', 'role', 'metadata-json', 'metadata-array', 'metadata-missing-text', 'origin', 'shared', 'plugin', 'bot', 'authored-text'] as const)(
    'does not write when persisted queued-message %s changes before verification', async scenario => {
      const h = await setupChatIntegration(true);
      try {
        const text = '记住：Codex 个人长期规则 key release：不要执行危险命令。';
        h.afterPersist(() => {
          const row = h.messages.get('mutated')!;
          if (scenario === 'body') row.content = stringifyUserContent(text + ' changed', [], [], false, [], []);
          else if (scenario === 'role') row.role = 'assistant';
          else if (scenario === 'metadata-json') row.agentMeta = '{';
          else if (scenario === 'metadata-array') row.agentMeta = '[]';
          else if (scenario === 'metadata-missing-text') row.agentMeta = '{}';
          else row.agentMeta = JSON.stringify({ autoReviewUserText: text,
            ...(scenario === 'origin' ? { origin: { kind: 'session' } }
              : scenario === 'shared' ? { sharedTaskAuthor: { id: 'other' } }
              : scenario === 'plugin' ? { sourcePlugin: 'third-party' }
              : scenario === 'bot' ? { botTaskCoordination: true }
              : { autoReviewUserText: 'assistant summary' }) });
        });
        await expect(h.send(text, 'mutated')).rejects.toThrow('Personal rule save failed');
        expect(await h.call({ action: 'set', key: 'release', harness: 'codex', scope: 'user' })).toMatchObject({ ok: false });
        expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
      } finally { await h.close(); }
    });

  it.each(['attachment', 'reference', 'array', 'malformed', 'slash'] as const)(
    'accepts the ordinary message but does not adopt its %s persistence as a plain-text rule', async scenario => {
      const h = await setupChatIntegration(true);
      try {
        const text = '记住：Codex 个人长期规则 key release：完整本人原文';
        const envelope = JSON.parse(stringifyUserContent(text, [], [], false, [], []));
        if (scenario === 'attachment') envelope.files = [{ name: 'attached.txt', path: '/synthetic/attached.txt' }];
        if (scenario === 'reference') envelope.replyQuote = { text: 'third-party quote' };
        if (scenario === 'slash') envelope.slashCommandRanges = [{ start: 0, end: 2 }];
        const persistedContent = scenario === 'array' ? JSON.stringify([{ type: 'text', text }])
          : scenario === 'malformed' ? '{"text":' : JSON.stringify(envelope);
        expect(await h.sendQueued(text, 'structured', { persistedContent })).toMatchObject({ accepted: true });
        expect(await h.call({ action: 'set', key: 'release', harness: 'codex', scope: 'user' })).toMatchObject({ ok: false });
        expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
      } finally { await h.close(); }
    });

  it.each(['owner', 'input-generation'] as const)(
    'does not save a queued input invalidated by %s after persistence', async scenario => {
      const h = await setupChatIntegration(true);
      try {
        const text = '记住：Codex 个人长期规则 key release：本人原文';
        h.afterPersist(() => {
          if (scenario === 'owner') h.changeOwner(); else h.coordinator!.clearSession('task');
        });
        const pending = h.send(text, 'retired');
        if (scenario === 'input-generation') await expect(pending).rejects.toThrow('SEND_CANCELLED_BEFORE_DISPATCH');
        else await expect(pending).resolves.toMatchObject({ accepted: true });
        expect(await h.call({ action: 'set', key: 'release', harness: 'codex', scope: 'user' })).toMatchObject({ ok: false });
        expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
      } finally { await h.close(); }
    });

  it.each(['owner', 'next-input', 'persisted-body', 'persisted-metadata'] as const)(
    'retires the queued-message receipt after %s changes without rewriting saved bytes', async scenario => {
      const h = await setupChatIntegration(true);
      try {
        const text = '记住：Codex 个人长期规则 key release：完整原文';
        const edit: PersonalRuleEdit = { action: 'set', key: 'release', harness: 'codex', scope: 'user' };
        await h.send(text, 'first');
        const automatic = await h.effective();
        expect(automatic.kind === 'published-managed' && automatic.groups[0]!.clauses[0]!.original).toBe(text);
        const before = approvalBytes(h.dir);
        if (scenario === 'owner') h.changeOwner();
        if (scenario === 'next-input') await h.send('请读取当前目录。', 'next');
        if (scenario === 'persisted-body') h.messages.get('first')!.content = text;
        if (scenario === 'persisted-metadata') h.messages.get('first')!.agentMeta = JSON.stringify({ autoResume: true });
        expect(await h.call(edit)).toMatchObject({ ok: false });
        expect(approvalBytes(h.dir)).toEqual(before);
      } finally { await h.close(); }
    });

  // Parent review regression, unit: the real accepted transaction must not
  // replace an existing group when remembering a prohibition/discussion only.
  // The earlier positive chat cases did not distinguish operation from content.
  // Existing negatives covered only remembering, not set/edit/future discussion headings.
  it.each([
    '记住：不要修改 Codex 的个人长期规则 key release。',
    '记住：这里只是讨论 Codex 的个人长期规则 key release，不要保存或改动它。',
    '设置示例只是讨论，不要保存或修改：Codex 个人长期规则 key release：仅讨论读取目录。',
    '修改示例只是讨论，不要保存或改动：Codex 个人长期规则 key release：仅讨论读取目录。',
    '以后只是讨论 Codex 的个人 Auto 规则，请一直按这条长期要求作为示例（key release）：不要保存或修改，仅讨论读取目录。',
  ])('leaves persisted release bytes and revision unchanged for a no-write chat intent: %s', async text => {
    const h = await setupChatIntegration(true);
    try {
      const edit: PersonalRuleEdit = { action: 'set', key: 'release', harness: 'codex', scope: 'user' };
      const original = '记住：Codex 个人长期规则 key release：保留旧版全文。';
      await h.send(original, 'existing-release');
      expect(await h.call(edit)).toMatchObject({ ok: true });
      const before = await h.effective(), bytes = approvalBytes(h.dir);
      if (before.kind !== 'published-managed') throw new Error('old release was not active');
      await h.send(text, 'no-write-input');
      const after = await h.effective(), tool = await h.call(edit);
      if (after.kind !== 'published-managed') throw new Error('old release disappeared');
      const observation = { beforeRevision: before.revision, afterRevision: after.revision,
        bytesEqual: JSON.stringify(approvalBytes(h.dir)) === JSON.stringify(bytes), toolSaved: tool.ok,
        beforeOriginal: before.groups[0]!.clauses[0]!.original, afterOriginal: after.groups[0]!.clauses[0]!.original };
      console.info('chat-no-write-intent-receipt', JSON.stringify(observation));
      expect(observation).toEqual({ beforeRevision: before.revision, afterRevision: before.revision,
        bytesEqual: true, toolSaved: false, beforeOriginal: original, afterOriginal: original });
      expect(after.groups).toEqual(before.groups);
    } finally { await h.close(); }
  });

  it.each([undefined, 'codex'] as const)('edits the stable key and restores the whole user group immediately (target %s)', async harness => {
    const h = await setupChatIntegration(true);
    try {
      const edit: PersonalRuleEdit = { action: 'set', key: 'release', ...(harness ? { harness } : {}), scope: 'user' };
      await h.send('记住：' + (harness ? 'Codex ' : '') + '个人长期规则 key release：user v1'); const first = await h.call(edit);
      const user1 = await h.effective(); expect(user1.kind).toBe('published-managed');
      await h.send('修改 ' + (harness ? 'Codex ' : '') + '个人长期规则 key release：user v2 原文'); const second = await h.call(edit);
      expect(second.ruleId).toBe(first.ruleId); expect(second.revision).not.toBe(first.revision);
      const draft = normalizeRuleGroup(requirementsOrigin('unrelated'), { ...h.scope, harnesses: ['codex'] },
        [{ id: 'requirement', original: 'unpublished draft', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'exec' } }]);
      const snapshot = await h.store.readSnapshot(draft.scope); await h.store.applyManagedEdit(snapshot.revision, draft.scope, [draft]);
      await h.send('设置 ' + (harness ? 'Codex ' : '') + '项目长期规则 key release：project whole');
      const project = await h.call({ ...edit, scope: 'project' }); expect(project.ok).toBe(true);
      const projected = await h.effective(); expect(projected.kind === 'published-managed' && projected.groups.map(g => g.clauses[0]!.original))
        .toEqual(['设置 ' + (harness ? 'Codex ' : '') + '项目长期规则 key release：project whole']);
      await h.send('删除 ' + (harness ? 'Codex ' : '') + '项目长期规则 key release');
      expect(await h.call({ ...edit, action: 'delete', scope: 'project' })).toMatchObject({ ok: true, kind: 'deleted', ruleId: project.ruleId });
      const restored = await h.effective(); expect(restored.kind === 'published-managed' && restored.groups.map(g => g.clauses[0]!.original))
        .toEqual(['修改 ' + (harness ? 'Codex ' : '') + '个人长期规则 key release：user v2 原文']);
      await h.send('删除 ' + (harness ? 'Codex ' : '') + '个人长期规则 key release'); expect(await h.call({ ...edit, action: 'delete' })).toMatchObject({ ok: true, kind: 'deleted' });
      const removed = await h.effective(); expect(removed.kind === 'published-managed' && removed.groups).toEqual([]);
      expect((await h.store.readSnapshot(draft.scope)).groups.some(g => g.id === draft.id)).toBe(true);
    } finally { await h.close(); }
  });

  // Unit / new shared-default contract: actual accepted chat -> Host -> store.
  // Same-target tests cannot detect shared user leaking into one-end project scope.
  it('masks a shared user group only for the explicit project target and restores it on delete', async () => {
    const h = await setupChatIntegration(true);
    try {
      const userText = '记住：个人长期规则 key release：用户完整原文';
      const projectText = '设置 Codex 项目长期规则 key release：项目完整原文';
      await h.send(userText, 'mixed-user');
      await h.send(projectText, 'mixed-project');
      const read = async (target: 'claude-code' | 'codex' | 'pi') => {
        const result = await createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
          localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({
            scope: { ownerId: 'owner', executionHostId: 'host', harnesses: [target], projectId: h.workDir },
            sessionId: 'task', sessionInstanceId: 'root' }) }).readPublishedManagedSnapshot();
        if (result.kind !== 'published-managed') throw new Error('mixed group not published');
        return result.groups;
      };
      const cc = await read('claude-code'), codex = await read('codex'), pi = await read('pi');
      console.info('mixed-project-groups', JSON.stringify({ cc: cc.map(g => g.clauses[0]!.original),
        codex: codex.map(g => g.clauses[0]!.original), pi: pi.map(g => g.clauses[0]!.original) }));
      expect(cc.map(g => g.clauses[0]!.original)).toEqual([userText]);
      expect(pi.map(g => g.clauses[0]!.original)).toEqual([userText]);
      expect(codex.map(g => g.clauses[0]!.original)).toEqual([projectText]);
      expect(await h.fire('mixed-project-callback')).toEqual({ decision: 'accept' });
      expect(h.requests.at(-1)?.personalRequirements?.groups).toEqual(codex);
      expect(h.requests.at(-1)?.userIntent).not.toBe(projectText);
      await h.send('删除 Codex 项目长期规则 key release', 'mixed-delete');
      expect(await read('codex')).toEqual(cc);
      expect(await read('claude-code')).toEqual(cc);
      expect(await read('pi')).toEqual(pi);
      expect(await h.fire('mixed-user-restored')).toEqual({ decision: 'accept' });
      expect(h.requests.at(-1)?.personalRequirements?.groups).toEqual(cc);
    } finally { await h.close(); }
  });

  it.each(['reference', 'forward', 'temporary', 'owner', 'input', 'persist', 'body', 'assistant'] as const)(
    'cannot claim a %s input as a persistent owner rule', async scenario => {
      const h = await setupChatIntegration();
      try {
        const original = '记住：Codex 个人长期规则 key release：complete owner words';
        const edit: PersonalRuleEdit = { action: 'set', key: 'release', harness: 'codex', scope: 'user' };
        if (scenario === 'owner') h.afterPersist(h.changeOwner);
        if (scenario === 'input') h.afterPersist(h.stop);
        if (scenario === 'persist') h.persistFailure();
        if (scenario === 'body' || scenario === 'assistant') h.afterPersist(() => {
          const row = h.messages.get('input')!;
          if (scenario === 'body') row.content = 'model replacement'; else row.role = 'assistant';
        });
        const text = scenario === 'reference' ? '> ' + original : scenario === 'temporary' ? '请读取当前目录。' : original;
        const pending = h.send(text, 'input', scenario === 'forward' ? 'session' : 'desktop');
        if (scenario === 'persist') await expect(pending).rejects.toThrow('synthetic persist failure');
        else if (scenario === 'body' || scenario === 'assistant') await expect(pending).rejects.toThrow('Personal rule save failed');
        else await pending;
        expect(await h.call(edit)).toMatchObject({ ok: false });
        expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toEqual([]);
      } finally { await h.close(); }
    },
  );

  it('retires accepted authority on the next input and refuses a changed persisted body on replay', async () => {
    const h = await setupChatIntegration();
    try {
      const original = '记住：Codex 个人长期规则 key release：original';
      const edit: PersonalRuleEdit = { action: 'set', key: 'release', harness: 'codex', scope: 'user' };
      await h.send(original, 'first'); expect(await h.call(edit)).toMatchObject({ ok: true });
      h.messages.get('first')!.content = 'assistant rewrite';
      expect(await h.call(edit)).toMatchObject({ ok: false });
      h.retireInput(); expect(await h.call(edit)).toMatchObject({ ok: false });
      await h.send('请读取目录。', 'next');
      expect(await h.call(edit)).toMatchObject({ ok: false });
      const effective = await h.effective();
      expect(effective.kind === 'published-managed' && effective.groups[0]!.clauses[0]!.original).toBe(original);
    } finally { await h.close(); }
  });

  it('does not narrow a default shared owner rule because its body mentions Codex', async () => {
    const h = await setupChatIntegration();
    try {
      await h.send('记住：个人长期规则 key release：读取 Codex 目录前核对目标');
      expect(await h.call({ action: 'set', key: 'release', harness: 'codex', scope: 'user' }))
        .toMatchObject({ ok: false, data: { hint: 'candidate-does-not-match-owner-request' } });
      expect(await h.call({ action: 'set', key: 'release', scope: 'user' })).toMatchObject({ ok: true });
      const effective = await h.effective();
      expect(effective.kind === 'published-managed' && effective.groups[0]!.scope.harnesses).toEqual(['claude-code', 'codex', 'pi']);
    } finally { await h.close(); }
  });

  it('rejects a real store CAS race without a saved ack and can retry without publishing the unrelated draft', async () => {
    const h = await setupChatIntegration();
    try {
      const original = h.deps.createStore;
      let raced = false;
      const scope = { ...h.scope, harnesses: ['codex' as const] };
      const unrelated = normalizeRuleGroup(requirementsOrigin('parallel'), scope, [{ id: 'requirement',
        original: 'concurrent unpublished draft', decision: 'requirement', reason: 'user-authored-verbatim',
        tool: { domain: 'exec', name: 'exec' } }]);
      h.deps.createStore = (...args) => {
        const store = original(...args);
        return { ...store, readSnapshot: async target => {
          const snapshot = await store.readSnapshot(target);
          if (!raced) { raced = true; await h.store.applyManagedEdit(snapshot.revision, scope, [unrelated]); }
          return snapshot;
        } };
      };
      await expect(h.send('记住：Codex 个人长期规则 key release：owner words')).rejects.toThrow('Personal rule save failed');
      expect(raced).toBe(true);
      expect((await h.store.readSnapshot(scope)).groups.map(group => group.id)).toEqual([unrelated.id]);
      expect(await h.call({ action: 'set', key: 'release', harness: 'codex', scope: 'user' })).toMatchObject({ ok: true });
      const active = await h.effective();
      expect(active.kind === 'published-managed' && active.groups.map(group => group.clauses[0]!.original))
        .toEqual(['记住：Codex 个人长期规则 key release：owner words']);
      expect((await h.store.readSnapshot(scope)).groups.some(group => group.id === unrelated.id)).toBe(true);
    } finally { await h.close(); }
  });

  // Unit integration: keep the final Host-await failure criterion at the
  // actual IPC/store/Main/registered callback; earlier tests pause before review.
  it.each(['unchanged', 'intent', 'same-text-new-input', 'directory'] as const)(
    'Codex integration: checks %s after the final Main read', async scenario => {
      const h = await setupCodexIntegration(); let reads = 0;
      let release!: () => void; let entered!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const check = h.review.precheckManagedAction!;
      h.review.precheckManagedAction = async request => {
        const result = await check(request);
        // Three shared reads, one direct-accept read, then final-response read.
        if (++reads === 5) { entered(); await barrier; }
        return result;
      };
      try {
        await h.set('Complete final-fence text');
        const pending = h.fire('last-read-' + scenario);
        await waiting;
        expect(reads).toBe(5); expect(h.requests).toHaveLength(1);
        expect(h.cards).toHaveLength(0);
        if (scenario === 'intent') await h.handle.steer({ type: 'user', content: 'Do not execute this command.' });
        if (scenario === 'same-text-new-input') await h.handle.steer({ type: 'user', content: 'Inspect only this isolated Codex directory.' });
        if (scenario === 'directory') await h.handle.setWritableDirs!([h.workDir]);
        release();
        expect(await pending).toEqual({ decision: scenario === 'unchanged' ? 'accept' : 'decline' });
        expect(h.requests).toHaveLength(1); expect(h.cards).toHaveLength(0);
      } finally { release(); await h.handle.close(); }
    });

  // Unit integration: production IPC -> store reopen -> Main -> actual registered
  // Codex callback. The previous component reds cannot prove this connection.
  it('Codex integration: sends the complete reopened group, version and project scope to the actual reviewer', async () => {
    const h = await setupCodexIntegration(); const original = '  Read(private) 保留全文 🧪\r\n末行 e\u0301  ';
    try {
      expect(await h.set(original)).toMatchObject({ kind: 'saved' });
      expect(await h.fire('v1')).toEqual({ decision: 'accept' });
      const effective = await h.effective(); expect(effective.kind).toBe('published-managed');
      expect(h.requests[0]?.personalRequirements?.groups).toEqual(effective.kind === 'published-managed' ? effective.groups : []);
      expect(h.requests[0]?.personalRequirements?.groups[0]?.clauses).toMatchObject([{ decision: 'requirement', original }, { decision: 'allow' }]);
      expect(h.requests[0]?.userIntent).toBe('Inspect only this isolated Codex directory.'); expect(h.cards).toHaveLength(0);
      const id = h.requests[0]!.personalRequirements!.groups[0]!.id;
      // A different native item/approval is a different cache identity.
      await h.fire('cached'); expect(h.requests).toHaveLength(2);
      await h.set('v2 complete'); await h.fire('v2'); expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.id).toBe(id);
      expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.clauses[0]?.original).toBe('v2 complete');
      await h.set('project only', 'allow', 'project'); await h.fire('project');
      expect(h.requests.at(-1)?.personalRequirements?.groups).toHaveLength(1);
      expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.clauses[0]?.original).toBe('project only');
      await h.remove('project'); await h.fire('restored'); expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.id).toBe(id);
      await h.remove('user'); const count = h.requests.length; expect(await h.fire('removed')).toEqual({ decision: 'accept' });
      expect(h.requests).toHaveLength(count); expect(h.cards).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  it.each(['deny', 'ask'] as const)('Codex integration: known %s in a complete group survives controlled allow', async decision => {
    const h = await setupCodexIntegration();
    try { await h.set('Whole group', decision); expect(await h.fire(decision)).toEqual({ decision: 'decline' });
      expect(h.requests).toHaveLength(decision === 'deny' ? 0 : 1); expect(h.cards).toHaveLength(decision === 'deny' ? 0 : 1);
    } finally { await h.handle.close(); }
  });

  it.each(['json-deny', 'json-allow', 'host-unavailable', 'recover-deny'] as const)('Codex integration: initial actual JSON fault reaches the actual card (%s)', async scenario => {
    const h = await setupCodexIntegration(); let file = ''; let bytes: Buffer | undefined;
    try {
      await h.set('Initial complete text'); file = path.join(h.dir, 'command-approval-runtime', 'revisions', String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
      bytes = fs.readFileSync(file);
      if (scenario === 'host-unavailable') {
        const snapshot = JSON.parse(bytes.toString()); const group = snapshot.groups[0];
        snapshot.groups[0] = { ...normalizeRuleGroup(group.origin, { ...group.scope, executionHostId: 'foreign-host' }, group.clauses), revision: group.revision };
        fs.writeFileSync(file, JSON.stringify(snapshot));
        expect(await h.effective()).toMatchObject({ kind: 'unavailable', reason: 'host-identity-conflict' });
      } else fs.writeFileSync(file, '{bad JSON');
      h.confirm(async request => { expect(request.kind).toBe('permission');
        expect(request.kind === 'permission' && request.metadata?.autoReviewUnavailable).toBe(true);
        expect(request.kind === 'permission' && request.autoCommand).toBeUndefined();
        if (scenario === 'recover-deny') { fs.writeFileSync(file, bytes!); await h.set('Restored new deny', 'deny'); }
        return { kind: 'permission', behavior: scenario === 'json-deny' || scenario === 'host-unavailable' ? 'deny' : 'allow' }; });
      expect(await h.fire('fault')).toEqual({ decision: scenario === 'json-allow' ? 'accept' : 'decline' });
      expect(h.cards).toHaveLength(1); expect(h.requests).toHaveLength(0);
      expect(h.events.filter(event => event.type === 'error').map(event => event.data))
        .toContainEqual(expect.objectContaining({ message: expect.stringMatching(/^\[AUTO_REVIEW_UNAVAILABLE\]/) }));
    } finally { if (bytes) fs.writeFileSync(file, bytes); await h.handle.close(); }
  });

  it('Codex integration: final promise window cannot refresh an artifact and release an old allow', async () => {
    const h = await setupCodexIntegration(); let file = ''; let bytes: Buffer | undefined; let armed = true; let reads = 0;
    const check = h.review.precheckManagedAction!;
    h.review.precheckManagedAction = async request => {
      const result = await check(request); reads++;
      if (reads !== 5 || result.kind === 'unavailable') return result;
      const current = result.isCurrent;
      return { ...result, isCurrent: () => { const valid = current();
        if (armed) { armed = false; queueMicrotask(() => fs.writeFileSync(file, '{changed in final continuation')); } return valid; } };
    };
    try {
      await h.set('Before final await'); file = path.join(h.dir, 'command-approval-runtime', 'revisions', String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
      bytes = fs.readFileSync(file);
      expect(await h.fire('final-window')).toEqual({ decision: 'decline' });
      expect(armed).toBe(false); expect(h.requests).toHaveLength(1); expect(h.cards).toHaveLength(0);
    } finally { if (bytes) fs.writeFileSync(file, bytes); await h.handle.close(); }
  });

  it.each(['owner-invalid', 'input-invalid', 'prepare-failure', 'legal-full'] as const)('Codex integration: first Main row await retains independent execution (%s)', async scenario => {
    const h = await setupCodexIntegration(); let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const read = h.deps.readSession; let once = true;
    h.deps.readSession = async id => { if (once) { once = false; entered(); await blocked; } return read(id); };
    if (scenario === 'prepare-failure') h.review.prepareRequest = async () => { await blocked; throw new Error('Synthetic preparation failure'); };
    try {
      const pending = h.fire('first-wait'); await started;
      if (scenario === 'owner-invalid') h.changeOwner();
      if (scenario === 'input-invalid') await h.handle.steer({ type: 'user', content: 'New accepted input' });
      await h.mode(); release();
      expect(await pending).toEqual({ decision: scenario === 'legal-full' ? 'accept' : 'decline' });
      expect(h.cards).toHaveLength(0); expect(h.requests).toHaveLength(0);
    } finally { release(); await h.handle.close(); }
  });

  it('Pi integration: consumes reopened complete text, caches only that version and restores project/user scope', async () => {
    const h = await setupPiIntegration();
    const original = '  Read(...) 也必须保留 🧪\r\nPi e\u0301 原文\n末行  ';
    try {
      expect(await h.set(original)).toMatchObject({ kind: 'saved' });
      h.fire('full-v1'); expect(await h.response('full-v1')).toBe('allow');
      const effective = await h.effective();
      expect(effective.kind).toBe('published-managed');
      expect(h.requests[0]?.personalRequirements?.groups).toEqual(effective.kind === 'published-managed' ? effective.groups : []);
      expect(h.requests[0]?.personalRequirements?.groups[0]?.clauses).toMatchObject([{ decision: 'requirement', original }, { decision: 'allow' }]);
      expect(h.requests[0]?.userIntent).toBe('Inspect only this isolated test directory.');
      expect(h.cards).toHaveLength(0);
      const id = h.requests[0]!.personalRequirements!.groups[0]!.id;
      h.fire('full-cached'); expect(await h.response('full-cached')).toBe('allow'); expect(h.requests).toHaveLength(1);
      await h.set('user v2'); h.fire('full-v2'); expect(await h.response('full-v2')).toBe('allow');
      expect(h.requests).toHaveLength(2); expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.id).toBe(id);
      await h.set('project only', 'allow', 'project'); h.fire('full-project'); expect(await h.response('full-project')).toBe('allow');
      expect(h.requests.at(-1)?.personalRequirements?.groups).toHaveLength(1);
      expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.clauses[0]?.original).toBe('project only');
      await h.remove('project'); h.fire('full-restored'); expect(await h.response('full-restored')).toBe('allow');
      expect(h.requests.at(-1)?.personalRequirements?.groups[0]?.clauses[0]?.original).toBe('user v2');
      await h.remove('user'); const count = h.requests.length;
      h.fire('full-removed'); expect(await h.response('full-removed')).toBe('allow'); expect(h.requests).toHaveLength(count);
      expect(h.cards).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  // Unit: default composer -> real store/Main -> registered Pi RPC handler.
  // The RPC transport is injected; this does not execute a host native CLI.
  it('Pi integration: consumes the shared default complete group', async () => {
    const h = await setupPiIntegration();
    const original = '共享原文：不要执行危险命令 🧪\r\n  保留末行  ';
    try {
      expect(await h.command(requirementsCommand('user', { id: 'shared-policy', text: original })))
        .toMatchObject({ kind: 'saved' });
      const effective = await h.effective();
      expect(effective.kind).toBe('published-managed');
      h.fire('shared-pi'); expect(await h.response('shared-pi')).toBe('allow');
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.personalRequirements?.groups).toEqual(effective.kind === 'published-managed' ? effective.groups : []);
      expect(h.requests[0]!.personalRequirements?.groups[0]?.scope.harnesses).toEqual(['claude-code', 'codex', 'pi']);
      expect(h.requests[0]!.personalRequirements?.groups[0]?.clauses[0]?.original).toBe(original);
      expect(h.requests[0]!.userIntent).toBe('Inspect only this isolated test directory.');
      expect(h.cards).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  it('Pi integration: known deny and ask survive a whole neutral group and reviewer allow', async () => {
    const h = await setupPiIntegration();
    try {
      await h.set('Complete deny requirement', 'deny'); h.fire('whole-deny');
      expect(await h.response('whole-deny')).toContain('auto-review-deny'); expect(h.requests).toHaveLength(0);
      await h.set('Complete ask requirement', 'ask'); h.confirm(async () => ({ kind: 'permission', behavior: 'allow' }));
      h.fire('whole-ask'); expect(await h.response('whole-ask')).toBe('allow');
      expect(h.requests).toHaveLength(1); expect(h.cards).toHaveLength(1);
      expect(h.requests[0]?.personalRequirements?.groups[0]?.clauses).toMatchObject([
        { decision: 'requirement', original: 'Complete ask requirement' }, { decision: 'ask' }]);
    } finally { await h.handle.close(); }
  });

  it.each(['json-deny', 'unavailable-allow', 'json-recover-deny'] as const)(
    'Pi integration: initial actual storage fault reaches a real card (%s)', async scenario => {
      const h = await setupPiIntegration(); let file = ''; let bytes: Buffer | undefined;
      try {
        await h.set('Initial full requirement');
        file = path.join(h.dir, 'command-approval-runtime', 'revisions', String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
        bytes = fs.readFileSync(file);
        if (scenario === 'unavailable-allow') {
          const snapshot = JSON.parse(bytes.toString()); const group = snapshot.groups[0];
          snapshot.groups[0] = { ...normalizeRuleGroup(group.origin, { ...group.scope, executionHostId: 'other-host' }, group.clauses), revision: group.revision };
          fs.writeFileSync(file, JSON.stringify(snapshot));
          expect(await h.effective()).toMatchObject({ kind: 'unavailable', reason: 'host-identity-conflict' });
        } else fs.writeFileSync(file, '{bad JSON');
        h.confirm(async request => {
          expect(request.kind).toBe('permission');
          expect(request.kind === 'permission' && request.autoCommand).toBeUndefined();
          expect(request.kind === 'permission' && request.metadata?.autoReviewUnavailable).toBe(true);
          if (scenario === 'json-recover-deny') { fs.writeFileSync(file, bytes!); await h.set('Recovered new deny', 'deny'); }
          return { kind: 'permission', behavior: scenario === 'json-deny' ? 'deny' : 'allow' };
        });
        h.fire('fault-first'); const result = await h.response('fault-first');
        expect(result).toEqual(scenario === 'unavailable-allow' ? 'allow' : expect.stringContaining(scenario === 'json-deny' ? 'user-deny' : 'auto-review-deny'));
        expect(h.cards).toHaveLength(1); expect(h.requests).toHaveLength(0);
        if (scenario === 'unavailable-allow') {
          h.fire('fault-second'); expect(await h.response('fault-second')).toBe('allow'); expect(h.cards).toHaveLength(2);
        }
      } finally { if (bytes) { fs.writeFileSync(file, bytes); expect(fs.readFileSync(file)).toEqual(bytes); } await h.handle.close(); }
    },
  );

  // Unit / bounded follow-up red: the FIRST real Main row read has captured
  // a qualified Auto owner, but no managed fence has been installed yet. A
  // FullAccess switch may withdraw policy; it cannot revive an old owner.
  // The earlier pending-review test starts after a lease and misses this window.
  it.each(['owner-invalid', 'identity-current'] as const)(
    'Pi initial fence: first precheck held across FullAccess (%s)', async scenario => {
      const h = await setupPiIntegration();
      let release!: () => void; let entered!: () => void; let first = true;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const reading = new Promise<void>(resolve => { entered = resolve; });
      try {
        await h.set('Initial precheck lease gap');
        const owner = h.deps.captureOwner()!;
        const checks: ManagedAutoReviewCheck[] = [];
        const realCheck = h.review.precheckManagedAction!;
        h.review.precheckManagedAction = async request => { const result = await realCheck(request); checks.push(result); return result; };
        const realRead = h.deps.readSession;
        h.deps.readSession = async id => {
          if (first) { first = false; entered(); await gate; }
          return realRead(id);
        };
        h.fire('first-precheck-full'); await reading;
        expect(h.deps.ownerCurrent(owner)).toBe(true);
        expect(checks).toHaveLength(0);
        expect(h.requests).toHaveLength(0); expect(h.cards).toHaveLength(0);
        expect(piRpc.responses.find(response => response.id === 'first-precheck-full')).toBeUndefined();
        await h.handle.setPermissionMode?.('bypassPermissions');
        h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 };
        if (scenario === 'owner-invalid') h.changeOwner();
        expect(h.deps.ownerCurrent(owner)).toBe(scenario === 'identity-current');
        release();
        const result = await h.response('first-precheck-full');
        expect(checks).toHaveLength(1);
        if (scenario === 'owner-invalid') {
          expect(checks[0]).toMatchObject({ kind: 'unavailable', pi: { state: 'unverified' } });
          expect.soft(result).not.toBe('allow');
        }
        else expect(result).toBe('allow');
        expect(h.requests).toHaveLength(0); expect(h.cards).toHaveLength(0);
        expect(piRpc.responses.filter(response => response.id === 'first-precheck-full')).toHaveLength(1);
      } finally { release(); await h.handle.close(); }
    },
  );

  // Unit: retirement withdraws the personal-policy contribution, not this
  // already accepted RPC's owner identity. Earlier tests retire after a lease.
  it.each(['owner-invalid', 'identity-current'] as const)(
    'Pi initial fence: first prepare spans builtin retirement (%s)', async scenario => {
      const h = await setupPiIntegration();
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      let execution: NonNullable<AutoReviewRequest['managedToolExecution']>['piExecution'];
      try {
        await h.set('Retirement must withdraw this known deny, not execution identity', 'deny');
        const check = vi.fn(h.review.precheckManagedAction!);
        h.review.precheckManagedAction = check;
        h.review.prepareRequest = async request => { execution = request.managedToolExecution?.piExecution; entered(); await gate; return request; };
        h.fire('first-prepare-retired'); await preparing;
        expect(execution?.isCurrent()).toBe(true); expect(check).toHaveBeenCalledOnce();
        h.retireBuiltin();
        if (scenario === 'owner-invalid') h.changeOwner();
        expect(execution?.isCurrent()).toBe(true); // Host owner is independent of the RPC/input lease.
        release();
        const result = await h.response('first-prepare-retired');
        expect(result).toEqual(scenario === 'identity-current' ? 'allow' : expect.stringMatching(/^(system|auto-review)-deny:/));
        expect(check).toHaveBeenCalledTimes(scenario === 'identity-current' ? 5 : 1);
        const checked = await check.mock.results[0]!.value;
        expect(checked).toMatchObject(scenario === 'owner-invalid'
          ? { kind: 'unavailable', pi: { state: 'unverified' } } : { kind: 'clear' });
        if (checked.kind !== 'unavailable') {
          expect(checked.isExecutionCurrent?.()).toBe(true);
          expect(checked).not.toHaveProperty('personalRequirements');
          expect(checked).not.toHaveProperty('revision');
        }
        expect(h.requests).toHaveLength(0); expect(h.cards).toHaveLength(0);
        expect(piRpc.responses.filter(row => row.id === 'first-prepare-retired')).toHaveLength(1);
      } finally { release(); await h.handle.close(); }
    },
  );

  // Unit: preparation can suspend before the first Main lease arrives. Neither a
  // failed prepare nor a new input may lose the RPC guard on a FullAccess switch;
  // a delegate without the managed precheck remains on its native path.
  it.each(['accepted-input', 'prepare-failure', 'unwired'] as const)(
    'Pi initial fence: first prepare held across FullAccess (%s)', async scenario => {
      const h = await setupPiIntegration();
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      try {
        await h.set('Initial prepare guard');
        if (scenario === 'unwired') delete h.review.precheckManagedAction;
        const check = h.review.precheckManagedAction;
        const checks = vi.fn(check);
        if (check) h.review.precheckManagedAction = checks;
        h.review.prepareRequest = async request => {
          entered(); await gate;
          if (scenario === 'prepare-failure') throw new Error('synthetic first preparation failure');
          return request;
        };
        h.fire('first-prepare-full'); await preparing;
        expect(checks).toHaveBeenCalledTimes(scenario === 'unwired' ? 0 : 1);
        expect(h.requests).toHaveLength(0); expect(h.cards).toHaveLength(0);
        expect(piRpc.responses.find(response => response.id === 'first-prepare-full')).toBeUndefined();
        await h.handle.setPermissionMode?.('bypassPermissions');
        h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 };
        if (scenario === 'accepted-input') await h.handle.send({ type: 'user', content: 'A newly accepted input supersedes the pending request.' });
        release();
        const result = await h.response('first-prepare-full');
        expect(result).toEqual(scenario === 'unwired' ? 'allow' : expect.stringContaining('system-deny'));
        if (scenario === 'prepare-failure' || scenario === 'unwired') expect(checks).toHaveBeenCalledTimes(scenario === 'unwired' ? 0 : 1);
        expect(h.requests).toHaveLength(0); expect(h.cards).toHaveLength(0);
        expect(piRpc.responses.filter(response => response.id === 'first-prepare-full')).toHaveLength(1);
      } finally { release(); await h.handle.close(); }
    },
  );

  // Unit: the accepted-input execution lease must honor Host Stop even before
  // agent_start. Native frame ordering is not inferred from this RPC fixture.
  // Abort rejection must rollback only its marker; settlement and the next
  // accepted input must remain usable. All tools use the real root dispatcher.
  it.each(['pending-stop', 'started-stop', 'abort-rejected', 'no-stop'] as const)(
    'Pi Stop lease: current RPC and next accepted input (%s)', async scenario => {
      const h = await setupPiIntegration();
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      let execution: NonNullable<AutoReviewRequest['managedToolExecution']>['piExecution'];
      try {
        await h.set('Stop applies only to this execution, not future tools');
        if (scenario === 'started-stop') piRpc.onEvent!({ type: 'agent_start' });
        h.review.prepareRequest = async request => { execution = request.managedToolExecution?.piExecution; entered(); await gate; return request; };
        const outcomes: ManagedAutoReviewCheck[] = [];
        const realCheck = h.review.precheckManagedAction!;
        h.review.precheckManagedAction = async request => { const value = await realCheck(request); outcomes.push(value); return value; };
        h.fire('stop-lease-old'); await preparing;
        expect(execution?.isCurrent()).toBe(true);
        expect(piRpc.responses.find(row => row.id === 'stop-lease-old')).toBeUndefined();
        // Isolate Stop from Host mirror timing: the first independent Main
        // lease must be healthy while this RPC is still held in preparation.
        await vi.waitFor(() => expect(outcomes).toHaveLength(1));
        expect(outcomes[0]).toMatchObject({ kind: 'clear' });
        expect(outcomes[0]!.kind !== 'unavailable' && outcomes[0]!.isExecutionCurrent?.()).toBe(true);
        await h.handle.setPermissionMode?.('bypassPermissions');
        h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 };
        const stopped = scenario === 'pending-stop' || scenario === 'started-stop';
        if (scenario !== 'no-stop') {
          piRpc.abortAccepted = scenario !== 'abort-rejected';
          await h.handle.abort?.();
          expect(piRpc.abortReceipts).toEqual([stopped]); // Actual abort RPC receipt, after Host mark/rollback.
        } else expect(piRpc.abortReceipts).toEqual([]);
        expect.soft(execution?.isCurrent()).toBe(!stopped);
        release();
        const result = await h.response('stop-lease-old');
        expect(result).toEqual(stopped ? expect.stringContaining('system-deny') : 'allow');
        expect(h.cards).toHaveLength(0); expect(h.requests).toHaveLength(0);
        // Explicit terminal/start frames exercise component lifecycle; they are
        // not evidence of the native emitter's chronological guarantee.
        piRpc.onEvent!({ type: 'agent_settled' });
        await h.handle.setPermissionMode?.('auto');
        h.session.stablePermissionModeState = { mode: 'auto', generation: 3 };
        await h.handle.send({ type: 'user', content: 'A fresh accepted input after the completed or rejected Stop.' });
        piRpc.onEvent!({ type: 'agent_start' });
        h.fire('stop-lease-next'); expect(await h.response('stop-lease-next')).toBe('allow');
        expect(h.requests).toHaveLength(1); expect(h.cards).toHaveLength(0);
        expect(h.requests[0]?.userIntent).toMatchObject({ currentUserMessage: 'A fresh accepted input after the completed or rejected Stop.' });
        for (const id of ['stop-lease-old', 'stop-lease-next']) expect(piRpc.responses.filter(row => row.id === id)).toHaveLength(1);
      } finally { release(); await h.handle.close(); }
    },
  );

  it.each(['stop', 'cwd', 'full-access', 'full-access-owner'] as const)(
    'Pi integration: pending review preserves independent identity (%s)', async scenario => {
      const h = await setupPiIntegration(); let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      vi.mocked(h.review).mockImplementation(async request => { h.requests.push(request); await pending; return { verdict: 'allow' }; });
      let moved = false;
      try {
        await h.set('Pending whole requirement'); h.fire('pending-identity');
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        if (scenario === 'stop') await h.handle.abort?.();
        if (scenario === 'cwd') { fs.renameSync(h.dir, h.dir + '.moved'); fs.mkdirSync(h.dir); moved = true; }
        if (scenario.startsWith('full-access')) {
          await h.handle.setPermissionMode?.('bypassPermissions');
          h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 };
          if (scenario === 'full-access-owner') h.changeOwner();
        }
        release();
        const result = await h.response('pending-identity');
        if (scenario === 'full-access') expect(result).toBe('allow'); else expect(result).not.toBe('allow');
        expect(h.cards).toHaveLength(0);
      } finally {
        release();
        if (moved) { fs.rmSync(h.dir, { recursive: true, force: true }); fs.renameSync(h.dir + '.moved', h.dir); }
        await h.handle.close();
      }
    },
  );

  it('Pi integration: a changed owner in the last promise continuation cannot release a reviewed allow', async () => {
    const h = await setupPiIntegration(); let reviewed = false; let armed = true;
    const real = h.review.precheckManagedAction!;
    const delegate = h.review;
    delegate.precheckManagedAction = async request => {
      const checked = await real(request);
      if (checked.kind === 'unavailable') return checked;
      const current = checked.isCurrent;
      return { ...checked, isCurrent: () => { const result = current();
        if (reviewed && armed) { armed = false; queueMicrotask(() => h.changeOwner()); } return result; } };
    };
    h.review.prepareRequest = async request => { if (h.requests.length) reviewed = true; return request; };
    try {
      await h.set('Final window text'); h.fire('final-owner');
      expect(await h.response('final-owner')).toContain('system-deny');
      expect(h.requests).toHaveLength(1); expect(h.cards).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  // Unit / Codex first-red A: trusted composer IPC -> real store reopen.
  // Missing single-Codex grammar is an editing red, not runtime qualification.
  // CC/Pi keyed identity and exact/multi-target protection remain in old tests.
  it('Codex requirements A: saves explicit Codex text and reopens the effective original', async () => {
    const h = setup(); h.setRow({ agentKind: 'codex', workingDir: h.dir });
    const original = '  Codex 完整原文 🧪\r\n保留 e\u0301 与首尾空格  ';
    const result = await h.command(requirementsCommand('user', { id: 'codex-first', targets: ['codex'], text: original }));
    expect.soft(result).toMatchObject({ kind: 'saved' });
    const reopened = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir,
      assertCurrent: () => {}, localManagedCommandHostId: 'host',
      resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: ['codex'], projectId: fs.realpathSync(h.dir) },
        sessionId: 'task', sessionInstanceId: 'instance' }) });
    expect.soft((await reopened.readSnapshot({ ...h.scope, harnesses: ['codex'] })).groups).toMatchObject([
      { origin: requirementsOrigin('codex-first'), scope: { harnesses: ['codex'] },
        clauses: [{ decision: 'requirement', original, tool: { domain: 'exec', name: 'exec' } }] },
    ]);
    expect.soft(await reopened.readPublishedManagedSnapshot()).toMatchObject({ kind: 'published-managed',
      groups: [{ clauses: [{ decision: 'requirement', original }] }] });
  });

  // Unit / Pi first-red A: the trusted composer IPC must persist an explicitly
  // targeted Pi requirement. CC-only grammar coverage cannot prove Pi editing;
  // this is an editing/protocol red, not evidence of runtime tool qualification.
  it('Pi requirements A: saves explicit Pi text through IPC and reopens the effective group', async () => {
    const h = setup(); h.setRow({ agentKind: 'pi', workingDir: h.dir });
    const original = '  Pi 完整要求 🧪\r\n保留 e\u0301 与末尾空格  ';
    const result = await h.command(requirementsCommand('user', { id: 'pi-first', targets: ['pi'], text: original }));
    expect.soft(result).toMatchObject({ kind: 'saved' });
    const reopened = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir,
      assertCurrent: () => {}, localManagedCommandHostId: 'host',
      resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: ['pi'], projectId: fs.realpathSync(h.dir) },
        sessionId: 'task', sessionInstanceId: 'instance' }) });
    expect.soft((await reopened.readSnapshot({ ...h.scope, harnesses: ['pi'] })).groups).toMatchObject([
      { origin: requirementsOrigin('pi-first'), scope: { harnesses: ['pi'] },
        clauses: [{ decision: 'requirement', original, tool: { domain: 'exec', name: 'bash' } }] },
    ]);
    expect.soft(await reopened.readPublishedManagedSnapshot()).toMatchObject({ kind: 'published-managed',
      groups: [{ clauses: [{ decision: 'requirement', original }] }] });
  });

  it('Codex requirements: rejects duplicate/unknown targets and forged fields without changing stored bytes', async () => {
    const h = setup(); h.setRow({ agentKind: 'codex', workingDir: h.dir });
    const input = { id: 'stable-codex', targets: ['codex'], text: 'complete text' };
    const first = await h.command(requirementsCommand('user', input)); expect(first).toMatchObject({ kind: 'saved' });
    expect(await h.command(requirementsCommand('user', { ...input, text: 'edited complete text' })))
      .toMatchObject({ kind: 'saved', ruleId: (first as { ruleId: string }).ruleId });
    const before = approvalBytes(h.dir);
    for (const targets of [['codex', 'codex'], [], ['unknown']]) {
      expect(await h.command(requirementsCommand('user', { ...input, targets }))).toMatchObject({ kind: 'unsupported' });
      expect(approvalBytes(h.dir)).toEqual(before);
    }
    for (const change of [{ id: '../forged' }, { origin: 'native' }, { text: '  ' },
      { clauses: [{ id: 'known', decision: 'allow', exact: 'pwd', original: 'known', qualification: 'native' }] }]) {
      expect(await h.command(requirementsCommand('user', { ...input, ...change }))).toMatchObject({ kind: 'unsupported' });
      expect(approvalBytes(h.dir)).toEqual(before);
    }
  });

  it('Pi requirements A control: preserves CC keyed identity and exact syntax while rejecting malformed targets', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    const input = { id: 'same-key', targets: ['claude-code'], text: 'CC 原文' };
    const first = await h.command(requirementsCommand('user', input));
    expect(first).toMatchObject({ kind: 'saved' });
    const second = await h.command(requirementsCommand('user', { ...input, text: 'CC 修改' }));
    expect(second).toMatchObject({ kind: 'saved', ruleId: (first as { ruleId: string }).ruleId });
    h.setRow({ agentKind: 'pi' });
    expect(await h.command('/approval-rule deny user --harness pi -- pwd')).toMatchObject({ kind: 'saved' });
    const before = approvalBytes(h.dir);
    for (const targets of [[], ['pi', 'pi'], ['unknown']]) {
      expect(await h.command(requirementsCommand('user', { ...input, targets }))).toMatchObject({ kind: 'unsupported' });
      expect(approvalBytes(h.dir)).toEqual(before);
    }
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['claude-code'] })).groups)
      .toMatchObject([{ clauses: [{ original: 'CC 修改' }] }]);
  });

  // Unit / first-red contract (2026-10-26): direct trusted-composer IPC must
  // activate neutral text, not invent an exact allow/ask. Existing exact tests
  // cannot detect the missing requirements grammar. Minimal input: one CC target
  // and one JSON-encoded multiline text; reopen the real owner store afterwards.
  it('sets neutral requirements through IPC and reopens the complete effective original', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    const original = '  发布前核对“本轮结果” 🧪\r\n保留 e\u0301、"引号"与\\路径\n末行  ';
    const text = '/approval-rule set user --requirements ' + JSON.stringify({
      id: 'release-policy', targets: ['claude-code'], text: original,
    });
    expect(text.length).toBeLessThanOrEqual(2048);
    expect(text).not.toContain('\n');
    const result = await h.command(text);
    expect.soft(result).toMatchObject({ kind: 'saved' });
    const reopened = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir,
      assertCurrent: () => {}, localManagedCommandHostId: 'host',
      resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: ['claude-code'], projectId: fs.realpathSync(h.dir) },
        sessionId: 'task', sessionInstanceId: 'instance' }) });
    const draft = await reopened.readSnapshot({ ...h.scope, harnesses: ['claude-code'] });
    expect.soft(draft.groups).toMatchObject([{ origin: { harness: 'cindy' },
      scope: { harnesses: ['claude-code'] }, clauses: [{ original, decision: 'requirement' }] }]);
    const effective = await reopened.readPublishedManagedSnapshot();
    expect.soft(effective).toMatchObject({ kind: 'published-managed', groups: [{ clauses: [{ original, decision: 'requirement' }] }] });
    if (effective.kind === 'published-managed') {
      expect(effective.revision).toBe(draft.revision);
      expect(effective.groups).toHaveLength(1);
      expect(effective.groups[0]!.clauses).toHaveLength(1);
      expect(effective.groups[0]!.clauses[0]).not.toHaveProperty('matcher');
      expect(Buffer.from(effective.groups[0]!.clauses[0]!.original, 'utf8')).toEqual(Buffer.from(original, 'utf8'));
    }
  });
  // Unit: stable keyed edits through the actual composer IPC/store, including
  // draft/effective project references. Old exact tests do not cover a whole
  // free-text group that must keep its identity when every clause changes.
  it.each(['claude-code', 'pi', 'codex'] as const)('replaces keyed groups and restores only the same user key after project removal (%s)', async harness => {
    const h = setup(); h.setRow({ workingDir: h.dir, agentKind: harness === 'claude-code' ? 'cc' : harness });
    const tool = harness === 'pi' ? 'bash' as const : harness === 'codex' ? 'exec' as const : 'Bash' as const;
    const set = (id: string, text: string, scope: 'user' | 'project' = 'user') =>
      h.command(requirementsCommand(scope, { id, targets: [harness], text })) as Promise<ApprovalRuleCommandResult>;
    const remove = (id: string, scope: 'user' | 'project') =>
      h.command(requirementsCommand(scope, { id, targets: [harness] }, true));
    const effective = (projectId: string) => createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir,
      assertCurrent: () => {}, resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: [harness], projectId },
        sessionId: 'task', sessionInstanceId: 'instance' }) }).readPublishedManagedSnapshot();
    const texts = async (projectId: string) => {
      const value = await effective(projectId);
      if (value.kind !== 'published-managed') throw new Error('Missing effective requirements');
      return value.groups.map(group => group.clauses[0]!.original).sort();
    };
    await h.command('/approval-rule deny user -- git push');
    const first = await set('release', 'user v1');
    const user = await h.store.readSnapshot({ ...h.scope, harnesses: [harness] });
    const draftProject = normalizeRuleGroup(requirementsOrigin('release'), { ...h.scope, harnesses: [harness], projectId: path.join(h.dir, 'other-project') },
      [{ id: 'requirement', original: 'unrelated project draft', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: tool } }]);
    await h.store.applyManagedEdit(user.revision, draftProject.scope, [draftProject]);
    const second = await set('release', 'user v2');
    expect(first.kind === 'saved' && first.ruleId).toBe(second.kind === 'saved' && second.ruleId);
    await set('other', 'other key');
    expect(await texts(draftProject.scope.projectId!)).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'other key', 'user v2']);
    const project = await set('release', 'project v1', 'project');
    expect(project.kind === 'saved' && project.ruleId).not.toBe(first.kind === 'saved' && first.ruleId);
    await set('release', 'user v3');
    expect(await texts(fs.realpathSync(h.dir))).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'other key', 'project v1']);
    expect(await texts(path.join(h.dir, 'unrelated'))).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'other key', 'user v3']);
    await remove('release', 'project');
    expect(await texts(fs.realpathSync(h.dir))).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'other key', 'user v3']);
    await set('release', 'independent project', 'project');
    await remove('release', 'user');
    expect(await texts(fs.realpathSync(h.dir))).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'independent project', 'other key']);
    const reopened = await h.store.readSnapshot({ ...h.scope, harnesses: [harness], projectId: fs.realpathSync(h.dir) });
    expect(reopened.managedOverrides?.some(entry => entry.replacesSourceId)).toBe(false);
    await remove('release', 'project');
    expect(await texts(fs.realpathSync(h.dir))).toEqual([(harness === 'codex' ? 'exec' : 'Bash') + '(git push)', 'other key']);
  });

  it('rejects unsupported requirement targets, keys and forged clauses with zero persisted writes', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    await h.command('/approval-rule deny user -- git push');
    const base = { id: 'release', targets: ['claude-code'], text: 'Keep all original text.' };
    const invalid: object[] = [
      ...[[], ['unknown'], ['claude-code', 'claude-code']].map(targets => ({ ...base, targets })),
      ...['', '../key', 'white space', '中文', 'a'.repeat(65)].map(id => ({ ...base, id })),
      { ...base, text: ' \r\n ' }, { ...base, origin: { harness: 'claude-code' } },
      ...[{ exact: 'pwd && echo x' }, { autoAskExceptions: [] }, { origin: 'native' }, { qualification: 'trusted' },
        { decision: 'requirement' }, { decision: ['deny'] }, { id: 'requirement' }].map(change => ({ ...base,
          clauses: [{ id: 'known', decision: 'allow', exact: 'pwd', original: 'Bash(pwd)', ...change }] })),
      { ...base, clauses: [{ id: 'same', decision: 'allow', exact: 'pwd', original: 'one' },
        { id: 'same', decision: 'deny', exact: 'pwd', original: 'two' }] },
    ];
    const before = approvalBytes(h.dir);
    for (const value of invalid) {
      expect(await h.command(requirementsCommand('user', value))).toMatchObject({ kind: 'unsupported' });
      expect(approvalBytes(h.dir)).toEqual(before);
    }
    for (const suffix of ['{"id":"release","targets":["pi"],"targets":["claude-code"],"text":"x"}',
      '{"id":"release","targets":["claude-code"],"text":"first","te\\u0078t":"last"}']) {
      expect(await h.command('/approval-rule set user --requirements ' + suffix)).toMatchObject({ kind: 'unsupported' });
      expect(approvalBytes(h.dir)).toEqual(before);
    }
    expect(await h.command(requirementsCommand('user', { ...base, text: '' }, true))).toMatchObject({ kind: 'unsupported' });
    expect(approvalBytes(h.dir)).toEqual(before);
  });

  it.each(['claude-code', 'pi', 'codex'] as const)('accepts sixteen explicit known clauses and exactly 2048 input characters without truncation (%s)', async harness => {
    const h = setup(); h.setRow({ workingDir: h.dir, agentKind: harness === 'claude-code' ? 'cc' : harness });
    const tool = harness === 'pi' ? 'bash' as const : harness === 'codex' ? 'exec' as const : 'Bash' as const;
    const clauses = Array.from({ length: 16 }, (_, i) => ({ id: 'c' + i, decision: 'allow', exact: 'pwd', original: 'Bash(pwd)' }));
    expect(await h.command(requirementsCommand('user', { id: 'known', targets: [harness], text: 'complete', clauses }))).toMatchObject({ kind: 'saved' });
    const before = approvalBytes(h.dir);
    expect(await h.command(requirementsCommand('user', { id: 'known', targets: [harness], text: 'complete', clauses: [...clauses, { ...clauses[0], id: 'extra' }] }))).toMatchObject({ kind: 'unsupported' });
    expect(approvalBytes(h.dir)).toEqual(before);
    const base = { id: 'boundary', targets: [harness], text: '' };
    const unicode = '🧪\u2028\u2029';
    const text = unicode + 'x'.repeat(2048 - requirementsCommand('user', base).length - unicode.length);
    const command = requirementsCommand('user', { ...base, text });
    expect(command).toHaveLength(2048);
    expect(await h.command(command)).toMatchObject({ kind: 'saved' });
    const saved = approvalBytes(h.dir);
    expect(await h.command(requirementsCommand('user', { ...base, text: text + 'x' }))).toMatchObject({ kind: 'unsupported' });
    expect(approvalBytes(h.dir)).toEqual(saved);
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [harness] })).groups.find(group => group.origin.sourceId === 'requirements:boundary')?.clauses[0]?.original).toBe(text);
  });

  it.each(['owner', 'Stop', 'row', 'directory'] as const)('rejects a late %s change before a user requirement write', async change => {
    const h = setup(); const cwd = path.join(h.dir, 'work'); fs.mkdirSync(cwd); h.setRow({ workingDir: cwd });
    await h.command('/approval-rule deny user -- git push');
    const before = approvalBytes(h.dir);
    h.onRead(8, () => {
      if (change === 'owner') h.changeOwner();
      if (change === 'Stop') h.stop();
      if (change === 'row') h.convert();
      if (change === 'directory') { fs.renameSync(cwd, cwd + '-old'); fs.mkdirSync(cwd); }
    });
    await expect(h.command(requirementsCommand('user', { id: 'release', targets: ['claude-code'], text: 'new text' }))).rejects.toThrow();
    expect(approvalBytes(h.dir)).toEqual(before);
  });

  it('keeps foreign-host requirements visible as an identity conflict instead of silently dropping them', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    const foreign = normalizeRuleGroup(requirementsOrigin('release'), { ...h.scope, harnesses: ['claude-code'], executionHostId: 'old-host' },
      [{ id: 'requirement', original: 'old host restriction', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'Bash' } }]);
    await h.store.applyManagedEdit(0, foreign.scope, [foreign], [], undefined, true);
    const before = approvalBytes(h.dir);
    expect(await h.command(requirementsCommand('user', { id: 'release', targets: ['claude-code'], text: 'new text' })))
      .toMatchObject({ kind: 'error', code: 'host-identity-conflict' });
    expect(approvalBytes(h.dir)).toEqual(before);
  });

  it('does not overwrite a concurrent revision with a requirement edit', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    await h.command('/approval-rule deny user -- git push');
    const marker = h.store.getAppliedState(); const create = h.deps.createStore;
    h.deps.createStore = (...args) => {
      const store = create(...args);
      return { ...store, applyManagedEdit: async (...edit) => {
        const draft = normalizeRuleGroup(requirementsOrigin('concurrent'), { ...h.scope, harnesses: ['claude-code'] },
          [{ id: 'requirement', original: 'concurrent draft', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'Bash' } }]);
        await h.store.applyManagedEdit(edit[0], draft.scope, [draft]);
        return store.applyManagedEdit(...edit);
      } };
    };
    await expect(h.command(requirementsCommand('user', { id: 'release', targets: ['claude-code'], text: 'stale edit' }))).rejects.toThrow();
    expect(h.store.getAppliedState()).toEqual(marker);
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: ['claude-code'] })).groups.some(group => group.origin.sourceId === 'requirements:release')).toBe(false);
  });

  it.each(['artifact', 'draft', 'marker'] as const)('does not claim activation or publish unrelated drafts after requirement %s failure', async failure => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    const input = { id: 'release', targets: ['claude-code'], text: 'old complete original' };
    const nativeFile = path.join(h.dir, 'native-settings.json'); fs.writeFileSync(nativeFile, '{"permissions":{"deny":["Bash(git push)"]}}');
    await h.command(requirementsCommand('user', input));
    const revision = h.store.getAppliedState().generatedRevision!;
    const artifact = path.join(h.dir, 'command-approval-runtime', 'revisions', String(revision), 'snapshot.json');
    const beforeArtifact = fs.readFileSync(artifact), beforeNative = fs.readFileSync(nativeFile);
    const draft = normalizeRuleGroup(requirementsOrigin('unrelated'), { ...h.scope, harnesses: ['claude-code'] },
      [{ id: 'requirement', original: 'do not activate', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'Bash' } }]);
    const snapshot = await h.store.readSnapshot(draft.scope); await h.store.applyManagedEdit(snapshot.revision, draft.scope, [draft]);
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const target = String(to);
      if (target.endsWith(path.sep + ({ artifact: 'snapshot.json', draft: 'command-approval-rules.json', marker: 'publish-state.json' }[failure])))
        throw Object.assign(new Error('requirement write failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try { await expect(h.command(requirementsCommand('user', { ...input, text: 'new original' }))).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(h.store.getAppliedState().generatedRevision).toBe(revision);
    expect(fs.readFileSync(artifact)).toEqual(beforeArtifact); expect(fs.readFileSync(nativeFile)).toEqual(beforeNative);
    expect(await h.command(requirementsCommand('user', { ...input, text: 'new original' }))).toMatchObject({ kind: 'saved' });
    const active = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: ['claude-code'] }, { qualifiedSourceIds: [] });
    expect(active.kind === 'published' && active.snapshot.groups.map(group => group.clauses[0]!.original)).toEqual(['new original']);
    expect((await h.store.readSnapshot(draft.scope)).groups.some(group => group.id === draft.id)).toBe(true);
  });

  // Flat explicit mappings must reject ambiguous keys before any owner bytes change.
  it.each([
    '{}', '[]', 'null', '{"pi":null}', '{"pi":[]}', '{"pi":{"command":"pwd"}}',
    '{"pi":""}', '{"pi":"  "}', '{"unknown":"pwd"}',
    '{"__proto__":"pwd"}', '{"constructor":"pwd"}',
    '{"pi":"pwd","pi":"git status"}',
    '{"pi":"pwd","p' + String.fromCharCode(92) + 'u0069":"git status"}',
    '{"pi":"pwd",}', '{"pi":"pwd"} -- git status',
    '{"claude-code":"git status","pi":"touch x && touch y"}',
    '{"pi":"' + 'x'.repeat(2048) + '"}',
  ])('rejects an invalid explicit mapping without changing saved or effective bytes: %s', async json => {
    const h = setup();
    await h.command('/approval-rule deny user -- git push');
    const draft = path.join(h.dir, 'command-approval-rules.json');
    const marker = path.join(h.dir, 'command-approval-runtime/publish-state.json');
    const before = [fs.readFileSync(draft), fs.readFileSync(marker)];
    expect(await h.command('/approval-rule allow user --targets ' + json)).toMatchObject({ kind: 'unsupported' });
    expect([fs.readFileSync(draft), fs.readFileSync(marker)]).toEqual(before);
  });

  it('rejects mixed grammars and missing removals atomically, and normalizes target order', async () => {
    const h = setup();
    const targets = '{"pi":"git status","claude-code":"git push"}';
    for (const text of [
      '/approval-rule allow user --harness pi --targets ' + targets,
      '/approval-rule allow user --targets ' + targets + ' --harness pi',
      '/approval-rule allow user --targets -- ' + targets,
    ]) expect(await h.command(text)).toMatchObject({ kind: 'unsupported', reason: 'syntax' });
    await h.command('/approval-rule deny user --harness claude-code -- git push');
    const draft = path.join(h.dir, 'command-approval-rules.json');
    const marker = path.join(h.dir, 'command-approval-runtime/publish-state.json');
    const before = [fs.readFileSync(draft), fs.readFileSync(marker)];
    await expect(h.command('/approval-rule remove user --targets ' + targets)).rejects.toThrow();
    expect([fs.readFileSync(draft), fs.readFileSync(marker)]).toEqual(before);
    const first = await h.command('/approval-rule allow user --targets ' + targets) as ApprovalRuleCommandResult;
    const second = await h.command('/approval-rule ask user --targets { "claude-code" : "git push", "pi" : "git status" }') as ApprovalRuleCommandResult;
    expect(first.kind === 'saved' && first.ruleIds).toEqual(second.kind === 'saved' && second.ruleIds);
    await h.command('/approval-rule deny user --harness claude-code -- git push');
    const snapshot = await h.store.readSnapshot({ ...h.scope, harnesses: ['claude-code', 'pi'] });
    expect(snapshot.groups.map(group => [group.scope.harnesses?.[0], group.clauses[0]?.decision]).sort())
      .toEqual([['claude-code', 'deny'], ['pi', 'ask']]);
  });

  it.each(['owner', 'input', 'row', 'directory'] as const)('rejects the entire explicit project mapping on a late %s change', async change => {
    const h = setup();
    const cwd = path.join(h.dir, 'work'); fs.mkdirSync(cwd); h.setRow({ workingDir: cwd });
    await h.command('/approval-rule deny project -- git push');
    const before = fs.readFileSync(path.join(h.dir, 'command-approval-runtime/publish-state.json'));
    h.onRead(8, () => {
      if (change === 'owner') h.changeOwner();
      if (change === 'input') h.clear();
      if (change === 'row') h.convert();
      if (change === 'directory') { fs.renameSync(cwd, cwd + '-old'); fs.mkdirSync(cwd); }
    });
    await expect(h.command('/approval-rule allow project --targets {"pi":"git status","claude-code":"git push"}')).rejects.toThrow();
    expect(fs.readFileSync(path.join(h.dir, 'command-approval-runtime/publish-state.json'))).toEqual(before);
  });

  // Real IPC/store batch, not three sequential saves: one failure must never activate a subset.
  it.each(['user', 'project'] as const)('atomically activates explicit target commands in %s scope with legacy IDs', async kind => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    await h.command('/approval-rule deny ' + kind + ' --harness claude-code -- git push');
    const projectId = kind === 'project' ? fs.realpathSync(h.dir) : undefined;
    const initial = await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses], projectId });
    const originalId = initial.groups[0]!.id;
    const draft = normalizeRuleGroup({ ...initial.groups[0]!.origin, sourceId: 'unrelated-draft', locator: 'cindy://unrelated-draft' },
      initial.groups[0]!.scope, initial.groups[0]!.clauses);
    await h.store.applyManagedEdit(initial.revision, draft.scope, [draft]);
    const targets = { codex: "/bin/bash -lc 'touch sentinel'", pi: 'git status', 'claude-code': 'git push' };
    let ids: string[] | undefined;
    for (const decision of ['ask', 'allow', 'deny', 'remove'] as const) {
      const result = await h.command('/approval-rule ' + decision + ' ' + kind + ' --targets ' + JSON.stringify(targets)) as ApprovalRuleCommandResult;
      expect(result).toMatchObject({ kind: 'saved', ruleId: originalId, ruleIds: expect.any(Array) });
      if (result.kind !== 'saved') throw new Error('Batch not saved');
      if (!ids) ids = result.ruleIds;
      expect(result.ruleIds).toEqual(ids);
      expect(h.store.getAppliedState().generatedRevision).toBe(result.revision);
      for (const harness of ['claude-code', 'pi', 'codex'] as const) {
        const active = await createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
          resolveManagedConsumer: () => ({ scope: { ...h.scope, harnesses: [harness], projectId: fs.realpathSync(h.dir) },
            sessionId: 'task', sessionInstanceId: 'instance' }) }).readPublishedManagedSnapshot();
        expect(active.kind).toBe('published-managed');
        if (active.kind === 'published-managed') {
          expect(active.revision).toBe(result.revision);
          expect(active.groups.map(group => group.clauses[0]?.decision)).toEqual(decision === 'remove' ? [] : [decision]);
          expect(active.groups.some(group => group.id === draft.id)).toBe(false);
        }
      }
    }
  });
  // Real IPC/store: an explicit cwd override must mask only this Cindy source and activate just its delta.
  it.each(['cc', 'pi', 'codex'] as const)('activates exact project rules independently for %s and preserves source lifecycle', async agentKind => {
    const h = setup();
    const a = path.join(h.dir, 'A'), b = path.join(h.dir, 'B'), child = path.join(a, 'child');
    fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(b);
    h.setRow({ agentKind, workingDir: a });
    const target = agentKind === 'cc' ? 'claude-code' : agentKind;
    const scope: RuleScope = { ...h.scope, harnesses: [target] };
    const read = async (cwd: string) => createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
      resolveManagedConsumer: () => ({ scope: { ...scope, projectId: fs.realpathSync(cwd) }, sessionId: 'task', sessionInstanceId: 'instance' }) }).readPublishedManagedSnapshot();
    const decisions = async (cwd: string) => { const result = await read(cwd);
      return result.kind === 'published-managed' ? result.groups.map(group => group.clauses[0]?.decision) : []; };
    expect(await h.command('/approval-rule deny user -- git push')).toMatchObject({ kind: 'saved' });
    const user = (await h.store.readSnapshot(scope)).groups[0]!;
    expect(await h.command('/approval-rule allow project -- git push')).toMatchObject({ kind: 'saved' });
    expect(await decisions(a)).toEqual(['allow']);
    expect(await decisions(b)).toEqual(['deny']); expect(await decisions(child)).toEqual(['deny']);
    expect(await h.command('/approval-rule remove user -- git push')).toMatchObject({ kind: 'saved' });
    expect(await decisions(a)).toEqual(['allow']); expect(await decisions(b)).toEqual([]);
    expect(await h.command('/approval-rule deny user -- git push')).toMatchObject({ kind: 'saved' });
    expect((await h.store.readSnapshot(scope)).groups[0]?.id).toBe(user.id);
    expect(await decisions(a)).toEqual(['allow']);
    expect(await h.command('/approval-rule remove project -- git push')).toMatchObject({ kind: 'saved' });
    expect(await decisions(a)).toEqual(['deny']);
    expect(await h.command('/approval-rule ask project -- git status')).toMatchObject({ kind: 'saved' });
    expect(await h.command('/approval-rule deny user -- git status')).toMatchObject({ kind: 'saved' });
    expect((await decisions(a)).sort()).toEqual(['ask', 'deny']);
    expect((await decisions(b)).sort()).toEqual(['deny', 'deny']);
  });
  it.each(['owner', 'row', 'directory'] as const)('keeps the active user deny when project %s changes under the write lease', async edge => {
    const h = setup(); const cwd = path.join(h.dir, 'cwd'); fs.mkdirSync(cwd);
    h.setRow({ workingDir: cwd });
    await h.command('/approval-rule deny user -- git push');
    const before = h.store.getAppliedState();
    // Each command reads the strict task row four times, last under the owner lock.
    h.onRead(8, () => {
      if (edge === 'owner') h.changeOwner();
      if (edge === 'row') h.setRow({ source: 'review' });
      if (edge === 'directory') { fs.renameSync(cwd, cwd + '-old'); fs.mkdirSync(cwd); }
    });
    await expect(h.command('/approval-rule allow project -- git push')).rejects.toThrow();
    expect(h.store.getAppliedState()).toEqual(before);
  });
  it('does not let an old remember card overwrite a newly edited project target', async () => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    await h.command('/approval-rule ask project -- git push');
    const card = await captureRememberedAutoCommand(h.deps, 'task', { sessionInstanceId: 'instance',
      harness: 'claude-code', command: 'git push', cwd: h.dir, isCurrent: () => true }, () => true, 'instance');
    expect(card?.projectId).toBe(fs.realpathSync(h.dir));
    await h.command('/approval-rule deny project -- git push');
    await expect(card!.save()).rejects.toThrow();
    const snapshot = await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses], projectId: fs.realpathSync(h.dir) });
    expect(snapshot.groups[0]?.clauses[0]?.decision).toBe('deny');
  });
  // Native wrapper support is Codex-only and never accepts more shell syntax than the exact observed form.
  it.each([
    ['cc', "/bin/bash -lc 'touch sentinel'"], ['pi', "/bin/bash -lc 'touch sentinel'"],
    ['codex', "/bin/bash -lc 'touch sentinel; pwd'"], ['codex', "/bin/bash -c 'touch sentinel'"],
    ['codex', "/bin/sh -lc 'touch sentinel'"], ['codex', "/bin/bash -lc 'touch sentinel'\n"],
  ] as const)('keeps unsupported %s wrapper on the original path: %s', async (agentKind, command) => {
    const h = setup(); h.setRow({ agentKind, workingDir: h.dir });
    const harness = agentKind === 'cc' ? 'claude-code' : agentKind;
    expect(await captureRememberedAutoCommand(h.deps, 'task', { sessionInstanceId: 'instance', harness,
      command, cwd: h.dir, isCurrent: () => true }, () => true, 'instance')).toBeNull();
    expect(await h.command('/approval-rule allow user -- ' + command)).toMatchObject({ kind: 'unsupported' });
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [harness] })).groups).toEqual([]);
  });
  // Real Main capture -> persisted artifact -> existing consumer; not a save helper spy.
  it.each(['cc', 'pi', 'codex', 'codex-wrapped'] as const)('remembers only the exact %s command, survives reopen and can be removed', async scenario => {
    const agentKind = scenario === 'codex-wrapped' ? 'codex' : scenario;
    const h = setup(); h.setRow({ agentKind, workingDir: h.dir });
    const harness: 'claude-code' | 'pi' | 'codex' = agentKind === 'cc' ? 'claude-code' : agentKind;
    const evidence: AutoCommandConfirmation = { sessionInstanceId: 'instance', harness, command: scenario === 'codex-wrapped'
      ? "/bin/bash -lc 'touch /home/xd.guest/approval-test-work/CINDY_REMEMBER_TARGET_c20261026a'"
      : 'git push origin draft', cwd: h.dir, isCurrent: () => true };
    const card = await captureRememberedAutoCommand(h.deps, 'task', evidence, () => true, 'instance');
    expect(card).not.toBeNull();
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] })).groups).toEqual([]); // allow once has not called save
    await card!.save();
    const reopened = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: h.dir, assertCurrent: () => {},
      resolveManagedConsumer: () => ({ scope: { ...h.scope, projectId: h.dir, harnesses: [harness] }, sessionId: 'task', sessionInstanceId: 'instance' }) });
    const active = await reopened.readPublishedManagedSnapshot();
    expect(active.kind === 'published-managed' && active.groups[0]?.clauses[0]).toMatchObject({ decision: 'allow',
      matcher: { mode: 'exact', pattern: evidence.command } });
    if (scenario === 'codex-wrapped') {
      const session = { id: 'task', instanceId: 'instance', requestSessionId: 'native', agentKind: 'codex', workDir: h.dir,
        remoteHostId: null, agentDeviceId: null, autoReviewOwner: 'cindy' as const,
        stablePermissionModeState: { mode: 'auto', generation: 1 }, stablePlanModeState: { enabled: false, generation: 1 },
        getStatus: () => 'active' };
      const check = createManagedAutoReviewPrecheck({
        captureOwner: () => ({ ...h.deps.captureOwner()!, ownerDataDir: h.dir }), ownerCurrent: h.deps.ownerCurrent,
        listSessions: () => [session], readSessionRow: h.deps.readSession, canonicalWorkDir: async dir => fs.realpathSync(dir),
      });
      const request = { sessionId: 'task', agentKind: 'codex' as const, model: 'm', userIntent: '', workspaceRoots: [h.dir],
        platform: 'linux' as const, action: { kind: 'exec' as const, command: evidence.command },
        managedToolExecution: { sessionInstanceId: 'instance', toolName: 'exec', input: { command: evidence.command, cwd: h.dir },
          codexApproval: { threadId: 'thread', turnId: 'turn', itemId: 'item', hostGeneration: 1, inputGeneration: 1,
            directoryGeneration: 1, isCurrent: () => true } } };
      expect(await check(request)).toMatchObject({ kind: 'clear', personalRequirements: { groups: [expect.objectContaining({
        clauses: [expect.objectContaining({ decision: 'allow', matcher: { kind: 'cc-command', mode: 'exact', pattern: evidence.command } })] })] } });
      expect(await h.command('/approval-rule ask user --harness ' + harness + ' -- ' + evidence.command)).toMatchObject({ kind: 'saved' });
      const asked = await reopened.readPublishedManagedSnapshot();
      expect(asked.kind === 'published-managed' && asked.groups[0]?.clauses[0]?.decision).toBe('ask');
      expect(await check(request)).toMatchObject({ kind: 'ask' });
    }
    expect(await h.command('/approval-rule remove user --harness ' + harness + ' -- ' + evidence.command)).toMatchObject({ kind: 'saved' });
    const removed = await reopened.readPublishedManagedSnapshot();
    expect(removed.kind === 'published-managed' && removed.groups).toEqual([]);
  });

  it.each(['owner', 'stopped', 'mode', 'row', 'new-deny', 'edited'] as const)('does not remember a %s stale card', async edge => {
    const h = setup(); h.setRow({ workingDir: h.dir });
    let current = true;
    const card = await captureRememberedAutoCommand(h.deps, 'task', { sessionInstanceId: 'instance', harness: 'claude-code',
      command: 'git push', cwd: h.dir, isCurrent: () => current }, () => true, 'instance');
    if (edge === 'owner') h.changeOwner();
    if (edge === 'stopped' || edge === 'mode') current = false;
    if (edge === 'row') h.setRow({ source: 'review' });
    if (edge === 'new-deny') await h.command('/approval-rule deny user -- git push');
    await expect(card!.save(edge === 'edited' ? { command: 'git push --force' } : undefined)).rejects.toThrow();
    const snapshot = await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] });
    expect(snapshot.groups.some(g => g.clauses[0]?.decision === 'allow')).toBe(false);
  });

  it('activates a Codex task exact exec rule without publishing or broadening CC scope', async () => {
    const h = setup(); h.setRow({ agentKind: 'codex' });
    expect(await h.command('/approval-rule deny user --harness codex -- git status')).toMatchObject({ kind: 'saved' });
    const snapshot = await h.store.readSnapshot({ ...h.scope, harnesses: ['codex'] });
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toMatchObject({ scope: { harnesses: ['codex'] },
      origin: { sourceId: expect.stringMatching(/^exact-codex-command:/) },
      clauses: [{ tool: { domain: 'exec', name: 'exec' }, matcher: { mode: 'exact', pattern: 'git status' } }] });
    expect(h.store.getAppliedState().generatedRevision).toBe(snapshot.revision);
    const id = snapshot.groups[0]!.id;
    for (const decision of ['allow', 'ask', 'remove'] as const) {
      expect(await h.command('/approval-rule ' + decision + ' user --harness codex -- git status')).toMatchObject({ kind: 'saved', ruleId: id });
      const active = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: ['codex'] }, { qualifiedSourceIds: [] });
      expect(active.kind === 'published' && active.snapshot.groups.map(group => group.clauses[0]?.decision))
        .toEqual(decision === 'remove' ? [] : [decision]);
    }
  });

  it('immediately activates Pi task edits and removes the same explicitly targeted ID', async () => {
    const h = setup();
    const cc = await h.command('/approval-rule deny user --harness claude-code -- git push') as ApprovalRuleCommandResult;
    h.setRow({ agentKind: 'pi' });
    let piId: string | undefined;
    for (const decision of ['ask', 'allow', 'deny'] as const) {
      const result = await h.command('/approval-rule ' + decision + ' user --harness pi -- git push') as ApprovalRuleCommandResult;
      expect(result.kind).toBe('saved');
      if (result.kind !== 'saved') return;
      piId ??= result.ruleId;
      expect(result.ruleId).toBe(piId);
      const active = await h.store.readPublishedSnapshot({ ...h.scope, projectId: '/project', harnesses: ['pi'] }, { qualifiedSourceIds: [] });
      expect(active.kind === 'published' && active.snapshot.groups[0]?.clauses[0]?.decision).toBe(decision);
    }
    h.setRow({ agentKind: 'cc' });
    expect(await h.command('/approval-rule remove user --harness pi -- git push')).toMatchObject({ kind: 'saved', ruleId: piId });
    const ccActive = await h.store.readPublishedSnapshot({ ...h.scope, projectId: '/project', harnesses: ['claude-code'] }, { qualifiedSourceIds: [] });
    expect(cc.kind === 'saved' && ccActive.kind === 'published' && ccActive.snapshot.groups.map(group => group.id)).toEqual([cc.kind === 'saved' ? cc.ruleId : '']);
    const piActive = await h.store.readPublishedSnapshot({ ...h.scope, projectId: '/project', harnesses: ['pi'] }, { qualifiedSourceIds: [] });
    expect(piActive.kind === 'published' && piActive.snapshot.groups).toEqual([]);
  });
  // Unit: explicit Pi target must preserve the existing CC rule and ID.
  it('saves and publishes Pi separately from an explicit CC target', async () => {
    const h = setup();
    const cc = await h.command('/approval-rule deny user --harness claude-code -- git push') as ApprovalRuleCommandResult;
    const pi = await h.command('/approval-rule deny user --harness pi -- git push') as ApprovalRuleCommandResult;
    expect(cc).toMatchObject({ kind: 'saved' });
    expect(pi).toMatchObject({ kind: 'saved' });
    if (cc.kind !== 'saved' || pi.kind !== 'saved') return;
    expect(pi.ruleId).not.toBe(cc.ruleId);
    expect(await h.command('/approval-rule publish')).toMatchObject({ kind: 'published', revision: 2 });
    const ccSaved = await h.store.readSnapshot({ ...h.scope, harnesses: ['claude-code'] });
    const piSaved = await h.store.readSnapshot({ ...h.scope, harnesses: ['pi'] });
    expect(ccSaved.groups.map(g => g.id)).toEqual([cc.ruleId]);
    expect(piSaved.groups.map(g => g.id)).toEqual([pi.ruleId]);
  });
  it('returns the named host conflict for save and publish without modifying old data', async () => {
    const h = setup();
    const old = normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'exact-bash:old',
      locator: 'cindy://personal-approval/exact-bash/old', dialectVersion: '1', decisionDomain: 'personal-approval' },
    { ...h.scope, executionHostId: 'old-relay-id', harnesses: ['claude-code'] },
    [{ id: 'old', original: 'Bash(git push)', decision: 'deny', tool: { domain: 'exec', name: 'Bash' },
      matcher: { kind: 'cc-command', mode: 'exact', pattern: 'git push' } }]);
    await h.store.applyManagedEdit(0, old.scope, [old]);
    await h.store.publish(1);
    const captured = h.deps.captureOwner()!;
    expect(captured.executionHostId).toBe('host');
    for (const text of ['/approval-rule deny user -- git push', '/approval-rule publish']) {
      expect(await h.command(text)).toEqual({ kind: 'error', code: 'host-identity-conflict' });
    }
    expect((await h.store.readSnapshot(old.scope)).groups).toEqual([{ ...old, revision: 1 }]);
    expect(h.store.getAppliedState().generatedRevision).toBe(1);
  });
  // Unit regression: VM Skip Sign-In has no relay ack. Previous fixtures invented
  // an owner and missed the production capture. Public IPC save/publish and hook
  // must share the isolated Main device ID without starting Electron or a CLI.
  it.each(['native', 'cindy', 'pi'] as const)('saves offline through the production owner boundary and denies for %s after relay reconnects', async target => {
    const h = setup(); h.useMainOwner();
    const workDir = target === 'pi' ? fs.realpathSync(h.dir) : '/project';
    expect(await h.command(target === 'pi' ? '/approval-rule deny user --harness pi -- git push'
      : '/approval-rule deny user -- git push')).toMatchObject({ kind: 'saved' });
    const owner = captureManagedApprovalOwner()!;
    expect(owner.executionHostId).toBe('dev-isolated-test');
    mainIdentity.relayId = 'relay-online';
    expect(isManagedApprovalOwnerCurrent(owner)).toBe(true);
    expect(await h.command('/approval-rule publish')).toMatchObject({ kind: 'published' });
    mainIdentity.relayId = 'relay-reconnected';
    expect(captureManagedApprovalOwner()?.executionHostId).toBe(owner.executionHostId);
    const session = { id: 'task', instanceId: 'instance', requestSessionId: 'sdk',
      agentKind: target === 'pi' ? 'pi' : 'claude-code', workDir, remoteHostId: null, agentDeviceId: null,
      autoReviewOwner: target === 'native' ? 'native' as const : 'cindy' as const, stablePermissionModeState: { mode: 'auto', generation: 1 },
      stablePlanModeState: { enabled: false, generation: 1 }, getStatus: () => 'active' };
    const deps = { captureOwner: captureManagedApprovalOwner,
      ownerCurrent: isManagedApprovalOwnerCurrent, listSessions: () => [session],
      readSessionRow: async () => ({ status: 'active', source: 'desktop', agentKind: target === 'pi' ? 'pi' : 'cc',
        workingDir: workDir } as SessionRowSnapshot), canonicalWorkDir: async (dir: string) => dir };
    if (target === 'pi') {
      const delegate: AutoReviewDelegate = async () => ({ verdict: 'allow' });
      delegate.precheckManagedAction = createManagedAutoReviewPrecheck(deps);
      expect(await withAutoReviewContext({ sessionId: 'task', agentKind: 'pi', model: 'm',
        userIntent: '', action: { kind: 'exec', command: 'git push' }, workspaceRoots: ['/project'],
        platform: 'linux', managedToolExecution: { sessionInstanceId: 'instance', toolName: 'bash',
          input: { command: 'git push' }, piExecution: { rpcId: 'offline-test', input: { command: 'git push' }, isCurrent: () => true, isAuto: () => true } } }, delegate, async () => ({ verdict: 'allow' })))
        .toMatchObject({ verdict: 'block', reason: expect.stringContaining('personal rule') });
    } else {
      const hook = createManagedBashDenyHooks(deps).PreToolUse![0]!.hooks[0]!;
      expect(await hook({ hook_event_name: 'PreToolUse', session_id: 'sdk', tool_name: 'Bash',
        tool_input: { command: 'git push' } } as never, 'tool-1', { signal: new AbortController().signal }))
        .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
    mainIdentity.deviceId = 'another-profile';
    expect(isManagedApprovalOwnerCurrent(owner)).toBe(false);
  });

  it.each(['owner', 'database', 'boundary'] as const)(
    'rejects a production %s change during the awaited row check without writing', async change => {
      const h = setup(); h.useMainOwner();
      h.onRead(4, () => {
        if (change === 'owner') mainIdentity.app = { mode: 'cloud', dataOwnerId: 'other', generation: 2 };
        if (change === 'database') mainIdentity.db = { userId: 'owner' };
        if (change === 'boundary') mainIdentity.pending = true;
      });
      await expect(h.command('/approval-rule deny user -- git push')).rejects.toThrow();
      expect(fs.existsSync(mainIdentity.dir + '/command-approval-rules.json')).toBe(false);
    });
  // Immediate editing contract: the public local command must commit only its
  // own delta, not an unrelated unpublished draft. Unit: real IPC -> real store.
  it('activates an exact ask and deletion without a publish command', async () => {
    const h = setup();
    expect(await h.command('/approval-rule ask user -- git push')).toMatchObject({ kind: 'saved' });
    const published = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] }, { qualifiedSourceIds: [] });
    expect(published.kind).toBe('published');
    if (published.kind === 'published') expect(published.snapshot.groups[0]?.clauses[0]?.decision).toBe('ask');
    expect(await h.command('/approval-rule remove user -- git push')).toMatchObject({ kind: 'saved' });
    const removed = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] }, { qualifiedSourceIds: [] });
    expect(removed.kind === 'published' && removed.snapshot.groups).toEqual([]);
  });

  it('immediately activates a cold ordinary task deny and keeps legacy publish compatible', async () => {
    const h = setup();
    const saved = await h.command('/approval-rule deny user -- git push');
    expect(saved).toMatchObject({ kind: 'saved', revision: 1 });
    const draft = await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] });
    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0]?.clauses[0]).toMatchObject({ decision: 'deny',
      matcher: { kind: 'cc-command', mode: 'exact', pattern: 'git push' } });
    expect(h.store.getAppliedState()).toMatchObject({ generatedRevision: 1 });
    expect(await h.store.readPublishedManagedSnapshot()).toMatchObject({ kind: 'unavailable' });
    expect(await h.command('/approval-rule publish')).toMatchObject({ kind: 'published', revision: 1 });
  });

  it('keeps the old CC identity through allow, deny, removal and re-creation', async () => {
    const h = setup();
    const first = await h.command('/approval-rule deny user -- git push') as ApprovalRuleCommandResult;
    for (const decision of ['allow', 'remove', 'ask'] as const) {
      const result = await h.command('/approval-rule ' + decision + ' user -- git push') as ApprovalRuleCommandResult;
      expect(result.kind).toBe('saved');
      if (first.kind === 'saved' && result.kind === 'saved') expect(result.ruleId).toBe(first.ruleId);
      const active = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] }, { qualifiedSourceIds: [] });
      expect(active.kind === 'published' && active.snapshot.groups.map(group => group.clauses[0]?.decision))
        .toEqual(decision === 'remove' ? [] : [decision]);
    }
  });

  it('never returns saved when activation fails and retains the effective deny', async () => {
    const h = setup();
    await h.command('/approval-rule deny user -- git push');
    const before = h.store.getAppliedState();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/publish-state.json')) throw Object.assign(new Error('activation failure'), { code: 'EIO' });
      return rename(from, to);
    });
    try { await expect(h.command('/approval-rule allow user -- git push')).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(h.store.getAppliedState()).toEqual(before);
    const active = await h.store.readPublishedSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] }, { qualifiedSourceIds: [] });
    expect(active.kind === 'published' && active.snapshot.groups[0]?.clauses[0]?.decision).toBe('deny');
  });

  it.each(['cc', 'pi'] as const)('does not retarget a default %s command when its task converts during the write lease', async agentKind => {
    const h = setup();
    h.setRow({ agentKind });
    h.onRead(4, () => h.setRow({ agentKind: agentKind === 'cc' ? 'pi' : 'cc' }));
    await expect(h.command('/approval-rule ask user -- git push')).rejects.toThrow();
    for (const harness of ['claude-code', 'pi'] as const)
      expect((await h.store.readSnapshot({ ...h.scope, harnesses: [harness] })).groups).toEqual([]);
    expect(h.store.getAppliedState().generatedRevision).toBeUndefined();
  });
  it.each(['clear', 'changeOwner', 'convert'] as const)(
    'refuses a %s during an awaited task-row read before writing', async change => {
      const h = setup();
      // The fourth strict row read occurs inside the store's owner lock,
      // immediately before the managed snapshot mutation.
      h.onRead(4, h[change]);
      await expect(h.command('/approval-rule deny user -- git push')).rejects.toThrow();
      expect((await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] })).groups).toEqual([]);
    },
  );

  it('rejects remote and untrusted callers before touching the store', async () => {
    const h = setup();
    h.deps.isDeviceLinkInvoke = () => true;
    await expect(h.command('/approval-rule publish')).rejects.toThrow();
    expect(h.deps.assertTrustedSender).not.toHaveBeenCalled();
  });

  it('rejects an external top-level IPC sender without writing', async () => {
    const h = setup();
    h.deps.assertTrustedSender = vi.fn(event => {
      if (!isTrustedAppRendererEventForLocation(event as never, {
        devServerUrl: null, packagedRendererFile: '/app/renderer/index.html',
      }))
        throw new Error('PERMISSION_DENIED: untrusted renderer');
    });
    const mainFrame = { url: 'https://attacker.example/', parent: null };
    await expect(h.invokeEvent({ sender: { mainFrame }, senderFrame: mainFrame },
      '/approval-rule deny user -- git push'))
      .rejects.toThrow('PERMISSION_DENIED');
    expect(h.deps.assertTrustedSender).toHaveBeenCalledTimes(1);
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] })).groups).toEqual([]);
  });

  it.each([
    ['review source', { source: 'review' }],
    ['bot source', { source: 'bot' }],
    ['remote host', { remoteHostId: 'other-host' }],
    ['remote agent', { agentDeviceId: 'other-device' }],
  ] as const)('refuses a %s task row without writing', async (_name, change) => {
    const h = setup();
    h.setRow(change);
    await expect(h.command('/approval-rule deny user -- git push'))
      .resolves.toMatchObject({ kind: 'unsupported', reason: 'context' });
    expect((await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] })).groups).toEqual([]);
  });
});
