import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SessionSendResult } from '@cindy/maker-core';
import { WechatIlinkError } from '@cindy/wechat-ilink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  userDataDir: 'collab-send-outcome-test-user-data',
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
  collabService: null as null | {
    [key: string]: ReturnType<typeof vi.fn>;
  },
  learnEnabled: true,
  learnController: {} as object | null,
  consumeLearnInvocationGrant: vi.fn(async (
    _request: unknown,
    _sessionInstanceId: string | undefined,
  ) => ({ ok: true as const })),
  capturedProvidersConfig: null as null | Record<string, unknown>,
  afterSelectCompanion: null as null | (() => void),
  invitationSession: null as null | { instanceId: string; stablePermissionModeState: { mode: string; generation: number } },
  invitationInput: null as null | { key: string; boundary: string; permission: { isCurrent(): boolean; planModeEnabled: boolean; permissionMode: string } },
  invitationOwner: true,
  directSend: vi.fn(async () => ({ messageId: 'bridge-guid' })),
  personalFeishu: {
    getOwnerOpenId: () => 'ou_personal',
    sendMarkdownText: vi.fn(async () => ({ messageId: 'om_personal_text' })),
    sendFile: vi.fn(async () => ({ ok: true, messageId: 'om_personal_file' })),
  },
  companionFeishu: {
    getOwnerOpenId: () => 'ou_companion',
    sendMarkdownText: vi.fn(async () => ({ messageId: 'om_companion_text' })),
    sendFile: vi.fn(async () => ({ ok: true, messageId: 'om_companion_file' })),
  },
  wechat: { sendText: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mockState.userDataDir,
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockState.logger,
}));

vi.mock('../../maker-ipc/register.js', () => ({
  tryGetOrcaCollabService: () => mockState.collabService,
  readLocalTaskQueuePaused: () => undefined,
  isSessionInTurn: () => false,
  getTaskActionInputState: () => mockState.invitationInput ?? ({ key: 'owner-input', ownerInput: mockState.invitationOwner, boundary: 'runtime-1' }),
  getTaskActionSession: () => mockState.invitationSession ?? undefined,
  isActiveInputAccountScoped: () => mockState.invitationOwner,
  confirmTaskAction: vi.fn(async () => true),
  captureTaskActionPermissionRequest: vi.fn(async () => null),
}));

vi.mock('@cindy/mcps', async (importOriginal) => ({
  resolveLiziMcpSessionContext: (await importOriginal<typeof import('@cindy/mcps')>()).resolveLiziMcpSessionContext,
  setSessionPathAuthorizer: vi.fn(),
  createLiziMcpProviders: vi.fn((config: Record<string, unknown>) => {
    mockState.capturedProvidersConfig = config;
    return ['cindy_orca', 'cindy_computer', 'cindy_android'].map((name) => (
      {
        name,
        isEnabled: () => true,
        toClaudeSdkConfig: () => null,
      }
    ));
  }),
}));

vi.mock('../computer.desktop.js', () => ({ getComputerMcpDeps: vi.fn(() => ({})) }));
vi.mock('../android.js', () => ({ getAndroidMcpDeps: vi.fn(() => ({})) }));

vi.mock('../../maker-host/index.js', () => ({
  getPluginRegistry: () => ({
    isEnabled: () => true,
  }),
}));

vi.mock('../../scheduler-host/index.desktop.js', () => ({
  getScheduler: () => null,
}));
// This collaboration fixture exercises provider wiring without Desktop history/IPC setup.
vi.mock('../historyAttachment.desktop.js', () => ({ readDesktopHistoryAttachment: vi.fn() }));
vi.mock('../../maker-ipc/fork.js', () => ({ forkTaskAtMessage: vi.fn() }));
vi.mock('../../maker-ipc/rewind.js', () => ({ commitTaskRewind: vi.fn() }));

vi.mock('../../im/index.js', () => ({
  feishuIm: mockState.personalFeishu,
  wechatIm: mockState.wechat,
}));

vi.mock('../../im/shared/botImConnectionRuntime', () => ({
  getBotIMessageDirectTarget: (botId: string, route: string) => botId === 'brief-bot' && route === 'dm-route'
    ? { im: { sendDirectDelivery: mockState.directSend }, connection: '123456abcdef', origin: 'http://127.0.0.1:1', chat: 'recipient' } : null,
  getBotFeishuTransport: (botId: string) => {
    if (mockState.afterSelectCompanion) queueMicrotask(mockState.afterSelectCompanion);
    return botId === 'bot-feishu' ? mockState.companionFeishu : null;
  },
}));

vi.mock('../cindyProxyMedia.js', () => ({
  getCindyProxyMediaService: () => ({ mcp: {} }),
}));

vi.mock('../../maker-host/session-search.js', () => ({
  searchSessionsFn: vi.fn(),
}));

vi.mock('../../maker-host/lsp-mode-store.js', () => ({
  readLspModeSettings: () => ({ enabled: true }),
}));

vi.mock('../../skillhub/activationPreferences.js', () => ({
  isCindyLearnSkillEnabled: () => mockState.learnEnabled,
}));

vi.mock('../../learn-host/index.js', () => ({
  getLearnController: () => mockState.learnController,
}));

vi.mock('../../learn-host/invocationGrant.js', () => ({
  consumeLearnInvocationGrant: (request: unknown, sessionInstanceId: string | undefined) =>
    mockState.consumeLearnInvocationGrant(request, sessionInstanceId),
}));

vi.mock('../../localDb/chatHistoryReader.js', () => ({
  listWorkdirsForHistory: vi.fn(),
  listSessionsForHistory: vi.fn(),
  getMessagesForHistory: vi.fn(),
}));

vi.mock('../../localDb/chatHistorySearch.js', () => ({
  searchChatHistoryHybrid: vi.fn(),
}));

import {
  logCollabDispatchFailure,
  resolveCollabDispatchResult,
} from '../../maker-ipc/collabSendOutcome.js';
import { createDesktopMcpProviders } from '../mcp-providers.js';
import * as sessionMeta from '../../localDb/ipc/sessions.js';
import * as companionCloud from '../../companion-cloud/runtime.js';
import { createDbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import type { FeishuBotMcpHostDeps, WechatBotMcpHostDeps, XdtHelperMcpDeps } from '@cindy/mcps';
import { beginAppSessionBoundary, commitVolatileAppSession, ownerScopedUserDataPath } from '../../appSessionState.js';
import * as userDataPath from '../../userDataPath.js';
import { createPluginRegistry, resetPluginRegistry } from '../../maker-host/plugins/index.js';
import { getComputerMcpDeps } from '../computer.desktop.js';
import { getAndroidMcpDeps } from '../android.js';
import {
  CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY,
  CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY,
} from '../codexBuiltinToolPolicy.js';

const botCapabilities = {
  list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
  select: vi.fn(async () => ({ ok: true as const, joined: true, effective: 'next-turn' as const })),
};

// #7791, unit: the actual Desktop provider must preserve a rejected send's
// numeric code in both the MCP result and the log. The iLink tests stop at
// the thrown error, and cannot catch the Desktop log losing a nonzero ret.
it('records the same safe iLink rejection reason in the text result and log', async () => {
  mockState.wechat.sendText.mockRejectedValueOnce(
    new WechatIlinkError('SEND_REJECTED', 'private response detail', true, { ret: 1205 }),
  );
  createDesktopMcpProviders({
    botCapabilities,
    getMakerMemoryManager: vi.fn(),
    lspPool: {} as never,
    pluginRegistry: { isEnabled: () => false, getPlugins: () => [] } as never,
    invokeRemote: vi.fn(),
  });
  const wechat = mockState.capturedProvidersConfig!.wechatBot as WechatBotMcpHostDeps;

  expect(await wechat.sendMessage('fixture-peer', 'hello')).toEqual({
    ok: false,
    reason: 'SEND_REJECTED:1205',
  });
  expect(mockState.logger.warn).toHaveBeenLastCalledWith(
    'sendMessage failed target=...%s detail=%s',
    'ure-peer',
    'SEND_REJECTED:1205',
  );
});

// #9940, unit: exercise the real Desktop provider gate, registry factory and
// settings reader across owner commits. Existing registry tests only wrap a
// fixed registry, so they miss providers constructed before login. Driver
// factories are isolated; their injected call-time gates are also checked.
describe('Desktop providers across account changes', () => {
  // #12464 P1, unit: the ordinary task has no task-action context. Exercise
  // the wired batch and its synchronous write guard with overlapping task IDs.
  it.each(['owner', 'database'] as const)('stops local pin writes after a change of %s', async change => {
    const db = await createDbClient({ transport: 'worker-thread', useInlineWorker: true });
    const patch = vi.spyOn(sessionMeta, 'patchSessionMetaInDb');
    const written: string[] = [];
    try {
      commitVolatileAppSession('local');
      setCurrentDbClient(db, 'local');
      patch.mockImplementation(async (id, meta, options) => {
        // Reinstall the client during patch-meta preparation to isolate the DB
        // generation check from owner changes. A new binding may reuse a client.
        if (change === 'database' && id === 'second') setCurrentDbClient(db, 'local');
        options?.beforeWrite?.();
        written.push(id);
        if (change === 'owner' && id === 'first') commitVolatileAppSession('cloud', 'next-owner');
        return { pinnedAt: meta.pinnedAt } as Awaited<ReturnType<typeof sessionMeta.patchSessionMetaInDb>>;
      });
      createDesktopMcpProviders({ botCapabilities, getMakerMemoryManager: vi.fn(), lspPool: {} as never,
        pluginRegistry: { isEnabled: () => false, getPlugins: () => [] } as never, invokeRemote: vi.fn(),
      });
      const helper = mockState.capturedProvidersConfig!.xdtHelper as XdtHelperMcpDeps;
      const result = await helper.setSessionsPinned!({ deviceId: null, sessionIds: ['first', 'second', 'third'], pinned: true });
      expect(written).toEqual(['first']);
      expect(result).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', changed: [{ sessionId: 'first' }],
        failedSessionId: 'second', remainingSessionIds: ['third'] });
    } finally {
      patch.mockRestore();
      clearCurrentDbClient(db);
      commitVolatileAppSession('signed-out');
      await db.dispose();
    }
  });

  it.each(['claude-code', 'codex', 'pi'] as const)(
    'reads the current owner for %s without widening frozen or bridge policy',
    async (agentKind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-provider-owner-'));
      const userData = vi.spyOn(userDataPath, 'getUserDataDir').mockReturnValue(root);
      try {
        commitVolatileAppSession('cloud', 'enabled-owner');
        const enabledPath = ownerScopedUserDataPath();
        fs.mkdirSync(enabledPath, { recursive: true });
        fs.writeFileSync(path.join(enabledPath, 'builtin-tools-settings.json'), JSON.stringify({
          builtinTools: { computer: { enabled: true }, android: { enabled: true } },
        }));
        commitVolatileAppSession('cloud', 'disabled-owner');
        const disabledPath = ownerScopedUserDataPath();
        fs.mkdirSync(disabledPath, { recursive: true });
        fs.writeFileSync(path.join(disabledPath, 'builtin-tools-settings.json'), JSON.stringify({
          builtinTools: { computer: { enabled: false }, android: { enabled: false } },
        }));
        commitVolatileAppSession('signed-out');
        resetPluginRegistry();
        const providers = createDesktopMcpProviders({
          botCapabilities,
          getMakerMemoryManager: vi.fn(),
          lspPool: {} as never,
          get pluginRegistry() { return createPluginRegistry(); },
          invokeRemote: vi.fn(),
        });
        const machines = providers.filter((p) => ['cindy_computer', 'cindy_android'].includes(p.name));
        expect(machines).toHaveLength(2);
        const context = { agentKind, workingDir: path.join(root, 'project') };
        const enabled = () => machines.map((p) => p.isEnabled?.(context));
        const callContext = { agentKind };
        const computerGate = vi.mocked(getComputerMcpDeps).mock.calls.at(-1)![0]!.isComputerUseEnabled!;
        const androidGate = vi.mocked(getAndroidMcpDeps).mock.calls.at(-1)![0]!.isAndroidAutomationEnabled!;
        const callable = () => [computerGate(callContext), androidGate(callContext)];
        // Codex keeps its bridge-creation snapshot for busy turns; its outer
        // provider gate still excludes disabled machine tools when rebuilt.
        const disabledCalls = agentKind === 'codex' ? [true, true] : [false, false];
        expect(enabled()).toEqual([false, false]);
        expect(callable()).toEqual(disabledCalls);

        commitVolatileAppSession('cloud', 'enabled-owner');
        expect(enabled()).toEqual([true, true]);
        expect(callable()).toEqual([true, true]);
        for (const provider of machines) {
          expect(provider.isEnabled?.({ ...context, workingDir: '' })).toBe(true);
          expect(provider.isEnabled?.({ ...context, vendorOptions: {
            [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: ['memory'],
          } })).toBe(false);
          expect(provider.isEnabled?.({ ...context, vendorOptions: {
            [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['computer', 'android'],
          } })).toBe(false);
        }
        await createPluginRegistry().setEnabled('computer', false);
        await createPluginRegistry().setEnabled('android', false);
        expect(enabled()).toEqual([false, false]);
        expect(callable()).toEqual(disabledCalls);
        await createPluginRegistry().setEnabled('computer', true);
        await createPluginRegistry().setEnabled('android', true);
        expect(enabled()).toEqual([true, true]);

        commitVolatileAppSession('cloud', 'disabled-owner');
        expect(enabled()).toEqual([false, false]);
        expect(callable()).toEqual(disabledCalls);
        expect(machines.map((p) => p.isEnabled?.({ ...context, workingDir: '' }))).toEqual([false, false]);
        commitVolatileAppSession('signed-out');
        expect(enabled()).toEqual([false, false]);
        expect(callable()).toEqual(disabledCalls);
      } finally {
        commitVolatileAppSession('signed-out');
        resetPluginRegistry();
        userData.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

function collabMeta(overrides: Record<string, unknown> = {}) {
  return {
    source: 'maker-ipc/collab',
    context: 'enable_collab_mode/worker-session-1/delegate_task',
    ...overrides,
  };
}

function logMeta(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'orca-collab',
    entrypoint: 'enable_collab_mode',
    sessionId: 'worker-session-1',
    agentKind: 'codex',
    action: 'delegate_task',
    context: 'enable_collab_mode/worker-session-1/delegate_task',
    ...overrides,
  };
}

function createCollabService(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    startTeam: vi.fn(),
    createWorker: vi.fn(),
    listWorkers: vi.fn(),
    switchFocus: vi.fn(),
    sendToWorker: vi.fn(),
    idleWorker: vi.fn(),
    endTeam: vi.fn(),
    archiveWorker: vi.fn(),
    listAvailableModels: vi.fn(),
    getWorkspaceInfo: vi.fn(),
    getWorkerStatus: vi.fn(),
    readWorker: vi.fn(),
    listSessionQueue: vi.fn(),
    listSessionQueuedCounts: vi.fn(),
    updateSessionQueuedMessage: vi.fn(),
    cancelSessionQueuedMessage: vi.fn(),
    steerSession: vi.fn(),
    stopSessionTurn: vi.fn(),
    getSessionRuntime: vi.fn(),
    ...overrides,
  };
}

describe('collab send outcome semantics', () => {
  afterEach(() => {
    mockState.logger.warn.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.debug.mockClear();
    mockState.logger.error.mockClear();
    mockState.logger.trace.mockClear();
    mockState.logger.fatal.mockClear();
    mockState.collabService = null;
    mockState.learnEnabled = true;
    mockState.learnController = {};
    mockState.consumeLearnInvocationGrant.mockReset();
    mockState.consumeLearnInvocationGrant.mockResolvedValue({ ok: true });
    mockState.capturedProvidersConfig = null;
    mockState.invitationSession = null;
    mockState.invitationInput = null;
    mockState.invitationOwner = true;
    vi.clearAllMocks();
  });

  // #12112, unit: a move requested in chat must surface the same skill and upgrade action as the settings UI.
  it('explains an incompatible skill when the owner moves the buddy from chat', async () => {
    const active = vi.spyOn(companionCloud, 'activeCompanionCloud');
    try {
      const switchHome = vi.fn().mockResolvedValue({
        ok: false, code: 'SKILL_TARGET_OUTDATED', oversizedSkill: { slug: 'research-paper-writing', bodyBytes: 71_560 },
      });
      vi.mocked(companionCloud.activeCompanionCloud, { partial: true }).mockReturnValue({ switchHome });
      createDesktopMcpProviders({ botCapabilities, getMakerMemoryManager: vi.fn(), lspPool: {} as never,
        pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never, invokeRemote: vi.fn() });
      const tools = (mockState.capturedProvidersConfig!.xdtHelper as XdtHelperMcpDeps).teammateHome!;
      const result = await tools.move({ callerSessionId: 'task', teammateId: 'bot', targetDeviceId: 'laptop' });
      expect(result).toMatchObject({ ok: false, errorCode: 'SKILL_TARGET_OUTDATED', message: expect.stringMatching(/research-paper-writing.*71560.*Update Cindy/) });
      // #12842: a new home supplies the detail; an older home only reports FAILED.
      switchHome.mockResolvedValueOnce({ ok: false, code: 'FAILED', handOverFailure: 'HOME_NOT_READY' });
      const move = () => tools.move({ callerSessionId: 'task', teammateId: 'bot', targetDeviceId: 'laptop' });
      expect(await move()).toMatchObject({ ok: false, errorCode: 'HOME_NOT_READY', message: expect.stringMatching(/main computer.*original chat/) });
      switchHome.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
      expect(await move()).toMatchObject({ ok: false, errorCode: 'FAILED' });
    } finally { active.mockRestore(); }
  });

  // Unit: actual Desktop provider + worker DB. Host tests inject caller facts;
  // this covers production wiring of live instance, owner input and permissions.
  it('binds invitations to live task authority regardless of the Agent execution device', async () => {
    const client = await createDbClient({ transport: 'worker-thread', useInlineWorker: true });
    try {
      commitVolatileAppSession('cloud', 'invitation-test-owner');
      await client.exec('CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, role TEXT)');
      setCurrentDbClient(client, 'invitation-test-owner');
      mockState.invitationSession = { instanceId: 'instance', stablePermissionModeState: { mode: 'bypass', generation: 1 } };
      mockState.invitationInput = { key: 'input', boundary: 'instance:1', permission: { isCurrent: () => true, planModeEnabled: false, permissionMode: 'bypass' } };
      const invitation = 'A'.repeat(43);
      let changeDuringInvite = false;
      const command = vi.fn(async (request: { action: string }) => {
        if (request.action === 'state') return { available: true, detail: { sessionId: 'task', sharedTaskId: 'shared', status: 'active' } };
        if (changeDuringInvite) mockState.invitationSession!.stablePermissionModeState.generation++;
        return { sharedTaskId: 'shared', invitation, invitationLink: 'https://relay.example.test/shared-task/join#' + invitation };
      });
      createDesktopMcpProviders({ botCapabilities, getMakerMemoryManager: vi.fn(), lspPool: {} as never,
        pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never, invokeRemote: vi.fn(),
        captureSharedTaskCommand: () => command,
      });
      const sharedTask = (mockState.capturedProvidersConfig!.xdtHelper as XdtHelperMcpDeps).sharedTask!;
      const context = { agentKind: 'codex' as const, workingDir: '/fixture', sessionId: 'task', sessionInstanceId: 'instance', remoteHostId: 'ssh-workspace' };
      expect(await sharedTask(context, 'invite')).toMatchObject({ ok: true, sessionId: 'task', device: 'local', sharedTaskId: 'shared' });
      command.mockClear();
      mockState.invitationOwner = false;
      expect(await sharedTask(context, 'invite')).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
      mockState.invitationOwner = true;
      expect(await sharedTask({ ...context, sessionInstanceId: 'old' }, 'invite')).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
      mockState.invitationInput.permission.planModeEnabled = true;
      expect(await sharedTask(context, 'invite')).toMatchObject({ ok: false, errorCode: 'PLAN_MODE' });
      expect(command).not.toHaveBeenCalled();
      expect(await sharedTask(context, 'state')).toMatchObject({ ok: true });
      mockState.invitationInput.permission.planModeEnabled = false;
      changeDuringInvite = true;
      expect(await sharedTask(context, 'invite')).toMatchObject({ ok: false, errorCode: 'SHARED_TASK_RESULT_UNKNOWN' });
    } finally {
      mockState.invitationSession = null; mockState.invitationInput = null;
      commitVolatileAppSession('signed-out'); clearCurrentDbClient(client); await client.dispose();
    }
  });

  it('keeps cindy_orca registered when project policy is disabled at session startup', () => {
    const providers = createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => false, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const orcaProvider = providers.find((provider) => provider.name === 'cindy_orca');
    expect(mockState.capturedProvidersConfig?.xdtHelper).toMatchObject({ botCapabilities });


    expect(orcaProvider).toBeDefined();
    expect(
      orcaProvider?.isEnabled?.({
        agentKind: 'claude-code',
        workingDir: 'C:/projects/cindy',
      } as never),
    ).toBe(true);

  });

  it('maps send_to_worker images to the host imagePaths field at the collab boundary', async () => {
    const sendToWorker = vi.fn(async () => ({
      ok: true as const,
      agentKind: 'codex' as const,
      wakeKind: 'already-active' as const,
      targetTitle: null,
      targetLastUserSendAt: null,
    }));
    mockState.collabService = createCollabService({ sendToWorker });
    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => false, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const orca = mockState.capturedProvidersConfig?.orca as {
      sendToWorker: (params: Record<string, unknown>) => Promise<unknown>;
    };

    await orca.sendToWorker({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'worker-session-1',
      message: 'look',
      images: ['C:/tmp/a.png'],
    });
    expect(sendToWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'worker-session-1',
      message: 'look',
      imagePaths: ['C:/tmp/a.png'],
    });

    await orca.sendToWorker({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'worker-session-1',
      message: 'text only',
    });
    expect(sendToWorker).toHaveBeenLastCalledWith({
      callerLeadSessionId: 'lead-1',
      targetSessionId: 'worker-session-1',
      message: 'text only',
    });
  });

  // #6439: real Desktop host callbacks + worker DB, only the external IM service
  // is replaced. Covers missing awaits at host call sites, beyond resolver tests.
  it('sends canonical background text and files through companion host callbacks with a worker DB', async () => {
    const client = await createDbClient({ transport: 'worker-thread', useInlineWorker: true });
    try {
      commitVolatileAppSession('cloud', 'feishu-test-owner');
      await client.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT)');
      await client.exec('CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, role TEXT)');
      await client.exec('CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT)');
      await client.exec("INSERT INTO bot_profiles VALUES ('bot-feishu', 'active')");
      await client.exec("INSERT INTO sessions VALUES ('background-receipt', 'bot')");
      await client.exec("INSERT INTO bot_session_links VALUES ('background-receipt', 'bot-feishu', 'canonical')");
      setCurrentDbClient(client, 'feishu-test-owner');
      createDesktopMcpProviders({
        botCapabilities,
        getMakerMemoryManager: vi.fn(),
        lspPool: {} as never,
        pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
        invokeRemote: vi.fn(),
      });
      const feishu = mockState.capturedProvidersConfig!.feishuBot as FeishuBotMcpHostDeps;
      const session = { sessionId: 'background-receipt', sessionInstanceId: 'runtime' };
      const owner = await feishu.getOwnerOpenId(session);
      expect(owner).toBe('ou_companion');
      expect(await feishu.sendMessage(owner!, 'task complete', session.sessionId, session))
        .toMatchObject({ ok: true, messageId: 'om_companion_text' });
      expect(await feishu.sendFile(owner!, '/tmp/report.txt', 'report.txt', session))
        .toMatchObject({ ok: true, messageId: 'om_companion_file' });
      expect(mockState.companionFeishu.sendMarkdownText).toHaveBeenCalledWith('ou_companion', 'task complete');
      expect(mockState.companionFeishu.sendFile).toHaveBeenCalledWith('ou_companion', '/tmp/report.txt', 'report.txt');

      // A boundary may start after the resolver fulfills but before its caller
      // resumes. Both production send callbacks must recheck before dispatch.
      for (const transition of ['pending', 'generation'] as const) {
        for (const send of [
          () => feishu.sendMessage(owner!, 'must not send', session.sessionId, session),
          () => feishu.sendFile(owner!, '/tmp/report.txt', 'report.txt', session),
        ]) {
          let release: (() => void) | undefined;
          mockState.companionFeishu.sendMarkdownText.mockClear();
          mockState.companionFeishu.sendFile.mockClear();
          mockState.afterSelectCompanion = () => {
            if (transition === 'pending') release = beginAppSessionBoundary();
            else commitVolatileAppSession('cloud', 'feishu-test-owner', true);
          };
          try {
            expect(await send()).toMatchObject({ ok: false, reason: 'SEND_FAIL' });
            expect(mockState.companionFeishu.sendMarkdownText).not.toHaveBeenCalled();
            expect(mockState.companionFeishu.sendFile).not.toHaveBeenCalled();
          } finally {
            mockState.afterSelectCompanion = null;
            release?.();
          }
        }
      }

      // A paused profile may still have a live tool call and connected transport.
      // The persisted pause must block both sends even though its link survives.
      await client.exec("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-feishu'");
      try {
        await expect(feishu.getOwnerOpenId(session)).rejects.toThrow('Companion is not active');
        expect(await feishu.sendMessage(owner!, 'paused', session.sessionId, session))
          .toMatchObject({ ok: false, reason: 'SEND_FAIL' });
        expect(await feishu.sendFile(owner!, '/tmp/report.txt', 'report.txt', session))
          .toMatchObject({ ok: false, reason: 'SEND_FAIL' });
        expect(mockState.companionFeishu.sendMarkdownText).not.toHaveBeenCalled();
        expect(mockState.companionFeishu.sendFile).not.toHaveBeenCalled();
        expect(mockState.personalFeishu.sendMarkdownText).not.toHaveBeenCalled();
        expect(mockState.personalFeishu.sendFile).not.toHaveBeenCalled();
      } finally {
        await client.exec("UPDATE bot_profiles SET status = 'active' WHERE id = 'bot-feishu'");
      }

      // Same-account archive removes canonical membership without changing the
      // DB snapshot. An app-scoped recipient must not cross to personal credentials.
      await client.exec("UPDATE bot_session_links SET role = 'history' WHERE session_id = 'background-receipt'");
      for (const send of [
        () => feishu.sendMessage(owner!, 'must not switch bots', session.sessionId, session),
        () => feishu.sendFile(owner!, '/tmp/report.txt', 'report.txt', session),
      ]) {
        expect(await send()).toMatchObject({ ok: false, reason: 'SEND_FAIL' });
      }
      expect(mockState.personalFeishu.sendMarkdownText).not.toHaveBeenCalled();
      expect(mockState.personalFeishu.sendFile).not.toHaveBeenCalled();
    } finally {
      commitVolatileAppSession('signed-out');
      clearCurrentDbClient(client);
      await client.dispose();
    }
  });

  it('rejects start_skill_learning after the built-in Learn Skill is disabled', async () => {
    mockState.learnEnabled = false;
    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      skillLearning: (input: {
        callerSessionId: string;
        input: string;
        sourceKind: 'session';
      }) => Promise<Record<string, unknown>>;
    };

    await expect(xdtHelper.skillLearning({
      callerSessionId: 'session-1',
      input: '',
      sourceKind: 'session',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'SKILL_DISABLED',
      message: 'Cindy Learn is disabled in Local Skills.',
    });
  });

  it('authorizes Learn only for the live local Session instance bound to its dispatch grant', async () => {
    const isCurrentLocalSessionInstance = vi.fn(() => false);
    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
      isCurrentLocalSessionInstance,
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      authorizeSkillLearning: (input: {
        callerSessionId: string;
        input: string;
        sourceKind: 'freetext';
      }, context: { sessionInstanceId: string }) => Promise<Record<string, unknown>>;
    };
    const request = {
      callerSessionId: 'session-1',
      input: 'release flow',
      sourceKind: 'freetext' as const,
    };

    const context = { sessionInstanceId: 'instance-1' };
    await expect(xdtHelper.authorizeSkillLearning(request, context)).resolves.toMatchObject({
      ok: false,
      errorCode: 'USER_REQUEST_REQUIRED',
    });
    expect(isCurrentLocalSessionInstance).toHaveBeenLastCalledWith(
      'session-1',
      'instance-1',
    );
    expect(mockState.consumeLearnInvocationGrant).not.toHaveBeenCalled();

    isCurrentLocalSessionInstance.mockReturnValue(true);
    await expect(xdtHelper.authorizeSkillLearning(request, context)).resolves.toEqual({
      ok: true,
      sessionInstanceId: 'instance-1',
    });
    expect(mockState.consumeLearnInvocationGrant).toHaveBeenCalledWith(request, 'instance-1');
  });

  it('revalidates the authorized Session instance immediately before Learn starts', async () => {
    const startLearn = vi.fn(async () => ({ runId: 'run-1' }));
    mockState.learnController = { startLearn };
    const isCurrentLocalSessionInstance = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
      isCurrentLocalSessionInstance,
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      authorizeSkillLearning: (
        input: {
          callerSessionId: string;
          input: string;
          sourceKind: 'session';
        },
        context: { sessionInstanceId: string },
      ) => Promise<Record<string, unknown>>;
      skillLearning: (
        input: {
          callerSessionId: string;
          input: string;
          sourceKind: 'session';
        },
        authorization: { sessionInstanceId: string },
      ) => Promise<Record<string, unknown>>;
    };
    const request = {
      callerSessionId: 'session-1',
      input: '',
      sourceKind: 'session' as const,
    };

    const authorization = await xdtHelper.authorizeSkillLearning(request, {
      sessionInstanceId: 'instance-1',
    });
    expect(authorization).toEqual({ ok: true, sessionInstanceId: 'instance-1' });

    await expect(xdtHelper.skillLearning(request, {
      sessionInstanceId: 'instance-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'USER_REQUEST_REQUIRED',
      message: 'Cindy Learn is not authorized for this task instance.',
    });
    expect(isCurrentLocalSessionInstance).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'instance-1',
    );
    expect(startLearn).not.toHaveBeenCalled();
  });

  it('reports enable_collab_mode delegate_task created-and-dispatched distinctly', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: true } satisfies SessionSendResult),
      collabMeta(),
    );

    expect(result).toEqual({
      dispatched: true,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: true,
      },
    });
  });

  it('reports enable_collab_mode delegate_task created-but-not-dispatched distinctly', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult),
      collabMeta(),
    );

    expect(result).toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'enable_collab_mode/worker-session-1/delegate_task',
      },
    });
  });

  it('keeps createWorker initialTask accepted false out of running state', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult),
      collabMeta({
        context: 'create_worker/worker-session-2/initial_task',
      }),
    );

    expect(result.dispatchOutcome).toMatchObject({
      kind: 'session-dispatch',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      context: 'create_worker/worker-session-2/initial_task',
    });
  });

  it('maps thrown send errors, SESSION_RUNNING, and onAccepted rejects to typed host outcomes', async () => {
    const sessionRunningError = new Error('SESSION_RUNNING: prompt text USER_MESSAGE TOKEN_VALUE file body') as Error & { code?: string };
    sessionRunningError.code = 'SESSION_RUNNING';
    const genericSendError = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body');
    const onAcceptedReject = new Error('USER_MESSAGE token value file contents');

    await expect(resolveCollabDispatchResult(() => Promise.reject(sessionRunningError), collabMeta())).resolves.toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SESSION_RUNNING',
      },
    });
    await expect(resolveCollabDispatchResult(() => Promise.reject(genericSendError), collabMeta())).resolves.toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
      },
    });
    const onAcceptedResult = await resolveCollabDispatchResult(() => Promise.reject(onAcceptedReject), collabMeta());
    expect(onAcceptedResult).toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
      },
    });
  });

  it('logs required ownership fields without prompt text, full messages, tokens, or file contents', async () => {
    const err = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const result = await resolveCollabDispatchResult(() => Promise.reject(err), collabMeta());
    expect(result.dispatched).toBe(false);
    if (result.dispatched || result.queued) {
      throw new Error('expected dispatch failure');
    }

    logCollabDispatchFailure(
      mockState.logger,
      'enableOrca: delegateTask dispatch failed',
      logMeta(),
      result.dispatchOutcome,
      err,
    );

    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'enableOrca: delegateTask dispatch failed',
      expect.objectContaining({
        kind: 'host-send',
        source: 'maker-ipc/collab',
        owner: 'orca-collab',
        entrypoint: 'enable_collab_mode',
        sessionId: 'worker-session-1',
        agentKind: 'codex',
        action: 'delegate_task',
        code: 'SESSION_RUNNING',
        context: 'enable_collab_mode/worker-session-1/delegate_task',
        error: {
          errorName: 'Error',
          errorCode: 'SESSION_RUNNING',
          safeMessage: 'SESSION_RUNNING',
        },
      }),
    );
    const loggedPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(loggedPayload).not.toContain('PROMPT_SECRET');
    expect(loggedPayload).not.toContain('full user message');
    expect(loggedPayload).not.toContain('TOKEN_VALUE');
    expect(loggedPayload).not.toContain('file body');
  });

  it('preserves typed dispatch outcomes through the xdt-helper control provider wrapper', async () => {
    mockState.collabService = createCollabService({
      createWorker: vi.fn().mockResolvedValue({
        ok: true,
        workerSessionId: 'worker-session-1',
        workerId: 'worker-1',
        dispatched: false,
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: 'maker-ipc/collab',
          dispatched: false,
          reason: 'cancelled-before-dispatch',
          context: 'enable_collab_mode/worker-session-1/delegate_task',
          message: 'Session send was cancelled before vendor dispatch: enable_collab_mode/worker-session-1/delegate_task',
        },
      }),
    });

    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      createWorker: (params: {
        leadSessionId: string;
        role: string;
        agent: 'codex';
        label: string;
        initialTask: string;
      }) => Promise<Record<string, unknown>>;
    };

    const result = await orca.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'codex',
      label: 'dev',
      initialTask: 'do the work',
    });

    expect(result).toMatchObject({
      ok: true,
      workerSessionId: 'worker-session-1',
      workerId: 'worker-1',
      dispatched: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(result).not.toEqual(expect.objectContaining({ accepted: false }));
  });

  it('preserves typed createWorker failures through the xdt-helper control provider wrapper', async () => {
    mockState.collabService = createCollabService({
      createWorker: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
        message: 'Budget Codex models require API key mode',
      }),
    });

    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      createWorker: (params: {
        leadSessionId: string;
        role: string;
        agent: 'codex';
        label: string;
        model: string;
      }) => Promise<Record<string, unknown>>;
    };

    const result = await orca.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'codex',
      label: 'dev',
      model: 'gpt-5.1-codex-mini',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: 'Budget Codex models require API key mode',
    });
  });

  it('exposes cindy_orca diagnostics through read-only collab provider callbacks', async () => {
    mockState.collabService = createCollabService({
      getWorkspaceInfo: vi.fn().mockResolvedValue({
        ok: true,
        workflow: null,
        ui_capacity: 1,
        worker_count: 0,
        workers: [],
      }),
      getWorkerStatus: vi.fn().mockResolvedValue({
        ok: true,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        idle_ms: 42,
        restored_from_storage: true,
      }),
      readWorker: vi.fn().mockResolvedValue({
        ok: true,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        result: 'latest assistant output',
      }),
    });

    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      getWorkspaceInfo: (params: { leadSessionId: string }) => Promise<Record<string, unknown>>;
      getWorkerStatus: (params: { leadSessionId: string; workerId: string }) => Promise<Record<string, unknown>>;
      readWorker: (params: { leadSessionId: string; workerId: string }) => Promise<Record<string, unknown>>;
    };

    await expect(orca.getWorkspaceInfo({ leadSessionId: 'lead-without-active-team' })).resolves.toMatchObject({
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    });
    await expect(orca.getWorkerStatus({ leadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      session_status: 'not_running',
      restored_from_storage: true,
    });
    await expect(orca.readWorker({ leadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      result: 'latest assistant output',
    });
    expect(mockState.collabService.getWorkspaceInfo).toHaveBeenCalledWith({ leadSessionId: 'lead-without-active-team' });
    expect(mockState.collabService.getWorkerStatus).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
    expect(mockState.collabService.readWorker).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
    expect(mockState.collabService.startTeam).not.toHaveBeenCalled();
    expect(mockState.collabService.createWorker).not.toHaveBeenCalled();
  });

  it('exposes arbitrary session queue reads through cindy_helper without Lead ownership', async () => {
    mockState.collabService = createCollabService({
      listSessionQueue: vi.fn().mockResolvedValue({
        ok: true,
        messages: [{ queuedMessageId: 'q-1', position: 0 }],
      }),
      listSessionQueuedCounts: vi.fn().mockResolvedValue({
        ok: true,
        counts: { 'session-1': 1 },
      }),
    });

    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      sessionQueue: {
        listSessionQueue: (sessionId: string) => Promise<Record<string, unknown>>;
        listSessionQueuedCounts: (sessionIds: string[]) => Promise<Record<string, unknown>>;
      };
    };

    await expect(xdtHelper.sessionQueue.listSessionQueue('session-1')).resolves.toMatchObject({
      ok: true,
      messages: [{ queuedMessageId: 'q-1', position: 0 }],
    });
    await expect(
      xdtHelper.sessionQueue.listSessionQueuedCounts(['session-1']),
    ).resolves.toEqual({ ok: true, counts: { 'session-1': 1 } });
    expect(mockState.collabService.listSessionQueue).toHaveBeenCalledWith('session-1');
    expect(mockState.collabService.listSessionQueuedCounts).toHaveBeenCalledWith(['session-1']);
  });

  it('preserves retryable host-readiness errors at the cindy_helper control boundary', async () => {
    mockState.collabService = createCollabService({
      listSessionQueue: vi.fn().mockRejectedValue(new Error('DbClient not ready')),
      listSessionQueuedCounts: vi.fn().mockRejectedValue(new Error('localDb not ready')),
      stopSessionTurn: vi.fn().mockRejectedValue({
        code: 'HOST_NOT_READY',
        message: 'database owner unavailable',
      }),
      getSessionRuntime: vi.fn().mockRejectedValue(new Error('storage read failed')),
    });

    createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      sessionQueue: {
        listSessionQueue: (sessionId: string) => Promise<Record<string, unknown>>;
        listSessionQueuedCounts: (sessionIds: string[]) => Promise<Record<string, unknown>>;
      };
      sessionControl: {
        stopSessionTurn: (params: { targetSessionId: string }) => Promise<Record<string, unknown>>;
        getSessionRuntime: (params: { targetSessionId: string }) => Promise<Record<string, unknown>>;
      };
    };

    await expect(
      xdtHelper.sessionQueue.listSessionQueue('session-1'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionQueue.listSessionQueuedCounts(['session-1']),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionControl.stopSessionTurn({ targetSessionId: 'session-1' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionControl.getSessionRuntime({ targetSessionId: 'session-1' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });
});

// Tier 1, PR #12115: invoke the wired tool with a real SQLite link table.
// The transport's receipt tests cannot deny a stale caller or another bot's DM.
it('admits only a live owner input targeting its own active private lane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-imessage-owner-'));
  const userData = vi.spyOn(userDataPath, 'getUserDataDir').mockReturnValue(root);
  const db = await createDbClient({ transport: 'worker-thread', useInlineWorker: true });
  const client = new Client({ name: 'owner-check', version: '1' });
  let server: McpServer | undefined;
  try {
    commitVolatileAppSession('cloud', 'test-owner');
    setCurrentDbClient(db, 'test-owner');
    await db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT, source TEXT)");
    await db.exec("CREATE TABLE bot_session_links(session_id TEXT, bot_id TEXT, role TEXT, route_key TEXT, archived_at INTEGER)");
    await db.exec("CREATE TABLE bot_profiles(id TEXT PRIMARY KEY, status TEXT)");
    await db.exec("INSERT INTO sessions VALUES ('main','active','bot'),('dm','active','bot'),('foreign','active','bot'),('old','archived','bot')");
    await db.exec("INSERT INTO bot_profiles VALUES ('brief-bot','active'),('other-bot','active')");
    await db.exec(`INSERT INTO bot_session_links VALUES ('main','brief-bot','canonical',NULL,NULL),
      ('dm','brief-bot','channel','dm-route',NULL), ('foreign','other-bot','channel','dm-route',NULL), ('old','brief-bot','channel','dm-route',NULL)`);
    const provider = createDesktopMcpProviders({
      botCapabilities,
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true, getPlugins: () => [] } as never,
      invokeRemote: vi.fn(),
    }).find(p => p.name === 'cindy_imessage')!;
    const caller = { sessionId: 'main', sessionInstanceId: 'instance', agentKind: 'codex', workingDir: root };
    server = (provider.toClaudeSdkConfig(caller) as { instance: McpServer }).instance;
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    mockState.invitationSession = { instanceId: 'instance', stablePermissionModeState: { mode: 'auto', generation: 1 } };
    const deliver = (id: string) => client.callTool({ name: 'send_to_private_chat', arguments: { target_session_id: id, text: 'QA report' } });
    const expectDenied = async (id: string, error: string) => {
      expect(await deliver(id)).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error }) }],
      });
      expect(mockState.directSend).not.toHaveBeenCalled();
    };
    mockState.directSend.mockClear();
    mockState.invitationOwner = false;
    await expectDenied('dm', 'OWNER_INPUT_REQUIRED');
    mockState.invitationOwner = true;
    caller.sessionInstanceId = 'stale';
    await expectDenied('dm', 'OWNER_INPUT_REQUIRED');
    caller.sessionInstanceId = 'instance';
    await expectDenied('foreign', 'PRIVATE_CHAT_NOT_CONNECTED');
    await expectDenied('old', 'PRIVATE_CHAT_NOT_CONNECTED');
    await db.exec("UPDATE bot_session_links SET archived_at = 1 WHERE session_id = 'dm'");
    await expectDenied('dm', 'PRIVATE_CHAT_NOT_CONNECTED');
    await db.exec("UPDATE bot_session_links SET archived_at = NULL WHERE session_id = 'dm'");
    expect((await deliver('dm')).content).toEqual([{ type: 'text',
      text: JSON.stringify({ target_session_id: 'dm', messageId: 'bridge-guid', status: 'accepted_by_bridge' }) }]);
    expect(mockState.directSend).toHaveBeenCalledOnce();
  } finally {
    await client.close();
    await server?.close();
    mockState.invitationOwner = true;
    mockState.invitationSession = null;
    clearCurrentDbClient(db);
    await db.dispose();
    commitVolatileAppSession('signed-out');
    userData.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
