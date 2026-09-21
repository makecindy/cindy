import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  startTask: vi.fn(),
  update: vi.fn(),
  prepend: vi.fn(),
  get: vi.fn(),
  saveDraft: vi.fn(),
  /** Main creates the per-task worktree; tests only need a deterministic path per run. */
  prepareWorkspace: vi.fn(async (runId: string) => ({
    path: `/Users/test/Cindy/worktrees/${runId}`,
    branch: `cindy-make/${runId}`,
    baseCommit: '0123456789ab',
  })),
}));
vi.mock('@/lib/sessionService', () => ({
  create: h.create,
  update: h.update,
  get: h.get,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: h.prepend } }));
vi.mock('@/lib/messageService', () => ({ create: vi.fn(), updateContent: vi.fn() }));
vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: (text: string) => ({ text, images: [], files: [] }),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  saveDraft: h.saveDraft,
  plainTextToTiptapDoc: (text: string) => ({ type: 'doc', content: [{ type: 'text', text }] }),
}));
vi.mock('@/lib/makerTransport', () => ({
  makerApiFor: () => ({
    getPendingInteractions: vi.fn(async () => []),
    input: {
      getProjection: vi.fn(async (sessionId: string) => ({
        sessionId,
        pendingQueue: [],
        steeringQueueClientIds: [],
        queuePaused: false,
        queueExpanded: false,
        queueInteractionLocks: [],
        queueEditLocks: [],
        queueAbortPending: false,
        error: null,
        recovery: null,
        errorRetryText: null,
      })),
    },
  }),
  getSessionFor: vi.fn(async () => ({ agentKind: 'cc', remoteHostId: null })),
  listMessagesFor: vi.fn(async () => []),
  isRemoteSession: () => false,
  isRemoteSessionSticky: () => false,
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import { tryStartCindyMakeCommand } from '../cindyMakeCommand';
import {
  chooseMakeUpstream,
  ensureMakeTask,
  prepareMakeSourceInStream,
  startMakeDoctorInStream,
  startMakeCodeSession,
} from '../cindyMakeDoctorStream';

type DoctorApi = NonNullable<Parameters<typeof startMakeDoctorInStream>[2]>;
type Listener = Parameters<DoctorApi['onDesktopCommandTriggered']>[0];
type Result = Awaited<ReturnType<DoctorApi['executeDesktopCommand']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function report(runId: string, status: MakeDoctorReport['status'] = 'completed'): MakeDoctorReport {
  return {
    runId,
    status,
    platform: 'win32',
    arch: 'x64',
    checks: [{ id: 'git', status: status === 'running' ? 'checking' : 'passed' }],
  };
}

/** Exercise the actual store and IPC client; only Main's asynchronous boundary is simulated. */
function mainApi() {
  const listeners = new Set<Listener>();
  const runs = new Map<string, ReturnType<typeof deferred<Result>>>();
  const commands = new Map<string, 'cindy-make' | 'cindy-make-doctor'>();
  const api: DoctorApi = {
    onDesktopCommandTriggered: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    executeDesktopCommand: vi.fn((_name, ctx) => {
      commands.set(ctx.doctorRunId!, _name as 'cindy-make' | 'cindy-make-doctor');
      const run = deferred<Result>();
      runs.set(ctx.doctorRunId!, run);
      return run.promise;
    }),
  };
  return {
    api,
    push(
      runId: string,
      status: MakeDoctorReport['status'] = 'running',
      extra: Partial<MakeDoctorReport> = {},
    ) {
      for (const listener of listeners) {
        listener({
          command: commands.get(runId)!,
          doctorReport: { ...report(runId, status), ...extra },
        });
      }
    },
    async complete(runId: string, extra: Partial<MakeDoctorReport> = {}) {
      runs.get(runId)!.resolve({ success: true, doctorReport: { ...report(runId), ...extra } });
      await runs.get(runId)!.promise;
    },
    async close() {
      for (const [runId, run] of runs) {
        run.resolve({ success: true, doctorReport: report(runId) });
      }
      await vi.waitFor(() => expect(listeners.size).toBe(0));
    },
  };
}

const sessionIds: string[] = [];
let sequence = 0;
let main: ReturnType<typeof mainApi>;
function sid() {
  const id = `doctor-stream-${++sequence}`;
  sessionIds.push(id);
  return id;
}
const messages = (sessionId: string) => makerChatStore.getSnapshot(sessionId).messages;
const cardReport = (sessionId: string) =>
  messages(sessionId).find((message) => message.systemCardType === 'cindy-make-doctor')
    ?.systemCardData?.report as MakeDoctorReport | undefined;

beforeEach(() => {
  h.startTask.mockReset().mockImplementation(async () => sid());
  setDataOwnerGeneration('doctor-test-owner');
  h.create.mockReset().mockImplementation(async (options) => ({ id: sid(), ...options }));
  h.get.mockReset().mockResolvedValue({
    agentKind: 'codex',
    model: 'selected-model',
    effort: 'high',
    permissionMode: 'ask',
    fastMode: false,
    planModeEnabled: false,
    providerId: null,
    remoteHostId: null,
  });
  h.saveDraft.mockClear();
  h.update.mockReset();
  h.prepend.mockClear();
  vi.mocked(messageService.create).mockClear();
  vi.mocked(messageService.updateContent).mockClear();
  main = mainApi();
  h.prepareWorkspace.mockClear();
  vi.stubGlobal('window', {
    electronAPI: {
      maker: main.api,
      prepareCindyMakeWorkspace: h.prepareWorkspace,
      startCindyMakeTask: h.startTask,
    },
  });
  vi.spyOn(makerChatStore, 'sendMessage').mockResolvedValue(true);
});
afterEach(async () => {
  setDataOwnerGeneration(null);
  await main.close();
  for (const id of sessionIds.splice(0)) makerChatStore.purgeSession(id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('doctor cards in the message stream', () => {
  it.each(['home', 'existing-task'])(
    'opens preflight from %s without creating a task or timeline card',
    async (entry) => {
      const sessionId = sid();
      const created = { id: sessionId, agentKind: 'codex', title: 'fix scrolling' };
      h.create.mockResolvedValue(created);
      h.update.mockResolvedValue(created);
      const result = await tryStartCindyMakeCommand({
        text: '/cindy-make fix scrolling',
        commands: [{ name: 'cindy-make', kind: 'desktop', description: 'Make' }],
        sessionId: entry === 'home' ? undefined : sessionId,
        deviceId: null,
        hasUnsupportedContent: false,
        isCurrent: () => true,
        createOptions: { workspaceKind: 'dialogue', agentKind: 'codex' },
      });
      expect(result).toEqual({
        kind: 'preflight', request: 'fix scrolling',
        sessionId: entry === 'home' ? undefined : sessionId,
        createOptions: { workspaceKind: 'dialogue', agentKind: 'codex' },
      });
      expect(messages(sessionId)).toHaveLength(0);
      expect(messageService.create).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
      expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
      expect(h.prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it('restores a persisted Make card from the task history', () => {
    const [restored] = makerChatStore.__mapServerMessagesForTest([
      {
        id: 'db-card',
        clientId: 'card-client',
        role: 'assistant',
        content: {
          __cindyMakeCard: {
            type: 'cindy-make',
            data: { request: 'fix the build', decision: 'wait' },
          },
        },
        agentMeta: null,
        createdAt: new Date().toISOString(),
      },
    ] as never);
    expect(restored).toMatchObject({
      clientId: 'card-client',
      systemCardType: 'cindy-make',
      systemCardData: { request: 'fix the build', decision: 'wait' },
    });
  });

  it('persists a Make card on creation and updates the same message row', async () => {
    const id = sid();
    const runId = startMakeDoctorInStream(
      id,
      { command: 'cindy-make', request: 'fix the build' },
      main.api,
    )!;

    await vi.waitFor(() => expect(messageService.create).toHaveBeenCalledOnce());
    const card = messages(id)[0];
    expect(card).toMatchObject({
      clientId: expect.any(String),
      systemCardType: 'cindy-make',
    });
    expect(messageService.create).toHaveBeenCalledWith(id, {
      clientId: card.clientId,
      role: 'assistant',
      content: {
        __cindyMakeCard: {
          type: 'cindy-make',
          data: expect.objectContaining({ request: 'fix the build' }),
        },
      },
    });

    makerChatStore.updateSystemCardData(id, card.clientId, {
      decision: 'wait',
      report: { ...(card.systemCardData?.report as MakeDoctorReport), runId },
    });
    await vi.waitFor(() => expect(messageService.updateContent).toHaveBeenCalledOnce());
    expect(messageService.updateContent).toHaveBeenCalledWith(
      id,
      card.clientId,
      expect.objectContaining({
        __cindyMakeCard: expect.objectContaining({ type: 'cindy-make' }),
      }),
    );
  });

  it('keeps a choice made after the final push when the invocation receipt arrives later', async () => {
    const id = sid();
    const runId = startMakeDoctorInStream(
      id,
      { command: 'cindy-make', request: 'scrolling' },
      main.api,
    )!;
    const upstream = { status: 'notFound' as const, items: [] };
    makerChatStore.updateSystemCardData(id, messages(id)[0].clientId!, {
      report: { ...report(runId), upstream },
    });
    // This card has no checkout yet; without a window the historical prepare
    // path is inert, which keeps the assertion about the recorded choice alone.
    vi.unstubAllGlobals();
    chooseMakeUpstream(id, runId, 'personal');
    await main.complete(runId, { upstream });
    expect(messages(id)[0].systemCardData?.decision).toBe('personal');
  });
  it('keeps the historical checks and upstream results when handing source preparation to Main', async () => {
    const id = sid();
    const runId = 'source-run';
    const upstream = { status: 'found' as const, items: [] };
    makerChatStore.insertSystemCard(id, 'cindy-make', {
      request: '修复消息流闪烁',
      report: { ...report(runId), upstream },
    });
    expect(await prepareMakeSourceInStream(id, runId)).toBeTruthy();
    expect(messages(id)[0].systemCardData?.report).toMatchObject({
      upstream,
      checks: report(runId).checks,
    });
    expect(h.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ originSessionId: id, runId, request: '修复消息流闪烁' }),
    );
    expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
  });
  it('does not create a card for a bare Make request', () => {
    const id = sid();
    expect(
      startMakeDoctorInStream(id, { command: 'cindy-make', request: '' }, main.api),
    ).toBeNull();
    expect(messages(id)).toHaveLength(0);
    expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });
  it('records one choice only for a finished search; stale and duplicate choices do nothing', () => {
    const id = sid();
    const clientId = makerChatStore.insertSystemCard(id, 'cindy-make', {
      report: { ...report('choice'), upstream: { status: 'found', items: [] } },
      request: 'scrolling',
    });
    chooseMakeUpstream(id, 'stale', 'personal');
    expect(messages(id)[0].systemCardData?.decision).toBeUndefined();
    chooseMakeUpstream(id, 'choice', 'wait');
    chooseMakeUpstream(id, 'choice', 'personal');
    expect(messages(id)[0].systemCardData?.decision).toBe('wait');
    expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
    makerChatStore.updateSystemCardData(id, clientId!, {
      decision: undefined,
      report: { ...report('choice', 'running'), upstream: { status: 'searching', items: [] } },
    });
    chooseMakeUpstream(id, 'choice', 'personal');
    expect(messages(id)[0].systemCardData?.decision).toBeUndefined();
  });
  it('keeps the Make request and card type through progress, cancellation and an in-place retry', async () => {
    const id = sid();
    const request = '  修复滚动\n支持 <b>原文</b>  ';
    const oldRun = startMakeDoctorInStream(id, { command: 'cindy-make', request }, main.api)!;
    const original = messages(id)[0];
    const nextRow = makerChatStore.insertSystemCard(id, 'help');
    expect(original).toMatchObject({ systemCardType: 'cindy-make', systemCardData: { request } });
    main.push(oldRun);
    expect(messages(id)[0].systemCardData).toMatchObject({
      request,
      report: { platform: 'win32' },
    });
    main.push(oldRun, 'cancelled');
    const newRun = startMakeDoctorInStream(id, { retryRunId: oldRun }, main.api)!;
    await main.complete(oldRun);
    expect(messages(id)[0].systemCardData).toMatchObject({
      request,
      report: { runId: newRun, status: 'running' },
    });
    await main.complete(newRun);
    expect(messages(id)[0]).toMatchObject({
      clientId: original.clientId,
      systemCardType: 'cindy-make',
      systemCardData: { request, report: { runId: newRun, status: 'completed' } },
    });
    expect(messages(id).map((message) => message.clientId)).toEqual([original.clientId, nextRow]);
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
    expect(messageService.create).toHaveBeenCalled();
    expect(main.api.executeDesktopCommand).toHaveBeenCalledWith('cindy-make', {
      doctorRunId: newRun,
      makeRequest: request,
    });
  });

  it('inserts once and updates the same row without moving past subsequent messages', async () => {
    const id = sid();
    const before = makerChatStore.insertSystemCard(id, 'help');
    const runId = startMakeDoctorInStream(id, undefined, main.api)!;
    const original = messages(id)[1];
    expect(original).toMatchObject({ role: 'assistant', systemCardType: 'cindy-make-doctor' });
    expect(cardReport(id)).toMatchObject({ runId, status: 'running' });
    const after = makerChatStore.insertSystemCard(id, 'status');
    const rowOrder = [before, original.clientId, after];

    main.push(runId);
    expect(cardReport(id)?.checks[0].status).toBe('checking');
    expect(messages(id).map((message) => message.clientId)).toEqual(rowOrder);
    await main.complete(runId);
    expect(cardReport(id)?.status).toBe('completed');
    expect(messages(id).map((message) => message.clientId)).toEqual(rowOrder);
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
    expect(messageService.create).toHaveBeenCalled();
  });

  it('keeps progress in the originating task after switching views and loading empty history', async () => {
    const first = sid();
    const second = sid();
    const leaveFirst = makerChatStore.enterView(first);
    const firstRun = startMakeDoctorInStream(first, undefined, main.api)!;
    leaveFirst();
    const leaveSecond = makerChatStore.enterView(second);
    try {
      const secondRun = startMakeDoctorInStream(second, undefined, main.api)!;
      main.push(firstRun);
      expect(cardReport(first)?.platform).toBe('win32');
      expect(cardReport(second)?.platform).toBe('');
      makerChatStore.ensureInitialMessages(first);
      await vi.waitFor(() => expect(makerChatStore.getSnapshot(first).historyLoaded).toBe(true));
      expect(messages(first)).toHaveLength(1);
      await main.complete(firstRun);
      expect(cardReport(first)?.status).toBe('completed');
      expect(cardReport(second)).toMatchObject({ runId: secondRun, status: 'running' });
    } finally {
      leaveSecond();
    }
  });

  it('retries in place and prevents double clicks or an old completion from replacing the new run', async () => {
    const id = sid();
    const oldRun = startMakeDoctorInStream(id, undefined, main.api)!;
    const clientId = messages(id)[0].clientId;
    expect(startMakeDoctorInStream(id, { retryRunId: oldRun }, main.api)).toBeNull();
    main.push(oldRun, 'cancelled');
    const newRun = startMakeDoctorInStream(id, { retryRunId: oldRun }, main.api)!;
    expect(newRun).not.toBe(oldRun);
    expect(startMakeDoctorInStream(id, { retryRunId: oldRun }, main.api)).toBeNull();
    await main.complete(oldRun);
    expect(cardReport(id)).toMatchObject({ runId: newRun, status: 'running' });
    main.push(newRun);
    await main.complete(newRun);
    expect(messages(id)).toHaveLength(1);
    expect(messages(id)[0].clientId).toBe(clientId);
    expect(cardReport(id)).toMatchObject({ runId: newRun, status: 'completed' });
  });

  it.each(['remove-card', 'purge-task'])('ignores late results after %s', async (action) => {
    const id = sid();
    const runId = startMakeDoctorInStream(id, undefined, main.api)!;
    if (action === 'remove-card') {
      makerChatStore.removeMessageByClientId(id, messages(id)[0].clientId);
    } else {
      makerChatStore.purgeSession(id);
    }
    main.push(runId);
    await main.complete(runId);
    expect(messages(id)).toHaveLength(0);
    expect(startMakeDoctorInStream(id, { retryRunId: runId }, main.api)).toBeNull();
  });

  it('does not publish old-account progress into a replacement task with the same id', async () => {
    const id = sid();
    const oldRun = startMakeDoctorInStream(id, undefined, main.api)!;
    setDataOwnerGeneration('different-owner');
    makerChatStore.purgeSession(id);
    const newRun = startMakeDoctorInStream(id, undefined, main.api)!;
    main.push(oldRun);
    await main.complete(oldRun);
    expect(messages(id)).toHaveLength(1);
    expect(cardReport(id)).toMatchObject({ runId: newRun, status: 'running', platform: '' });
  });
});

describe('doctor task placement', () => {
  const createOptions = {
    workspaceKind: 'dialogue',
    agentKind: 'codex',
    model: 'selected-model',
  } as const;

  it('reuses the current task without creating another task', async () => {
    const id = sid();
    expect(await ensureMakeTask({ sessionId: id, createOptions, isCurrent: () => true })).toBe(id);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('creates a home-page task container with the selected settings, without an Agent turn', async () => {
    const created = { id: sid(), ...createOptions };
    h.create.mockResolvedValue(created);
    const id = await ensureMakeTask({ createOptions, isCurrent: () => true });
    expect(h.create).toHaveBeenCalledWith(createOptions);
    expect(h.prepend).toHaveBeenCalledWith(created);
    expect(id).toBe(created.id);
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });

  it('applies the Make request as the new task title', async () => {
    const created = { id: sid(), ...createOptions };
    const titled = { ...created, title: 'fix scrolling' };
    h.create.mockResolvedValue(created);
    h.update.mockResolvedValue(titled);

    const id = await ensureMakeTask({
      createOptions,
      title: 'fix scrolling',
      isCurrent: () => true,
    });

    expect(h.update).toHaveBeenCalledWith(created.id, { title: 'fix scrolling' });
    expect(h.prepend).toHaveBeenCalledWith(titled);
    expect(id).toBe(created.id);
  });

  it.each(['success', 'failure'])(
    'does not publish an old-account task after title update %s',
    async (outcome) => {
      const created = { id: sid(), ...createOptions };
      const pending = deferred<void>();
      h.create.mockResolvedValue(created);
      h.update.mockImplementation(async () => {
        await pending.promise;
        if (outcome === 'failure') throw new Error('title update failed');
        return { ...created, title: 'fix scrolling' };
      });
      const result = ensureMakeTask({
        createOptions,
        title: 'fix scrolling',
        isCurrent: () => true,
      });
      await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
      setDataOwnerGeneration('different-owner');
      pending.resolve();
      expect(await result).toBeNull();
      expect(h.prepend).not.toHaveBeenCalled();
    },
  );

  it('does not create a task for a stale composer or report success after creation fails', async () => {
    expect(await ensureMakeTask({ createOptions, isCurrent: () => false })).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
    h.create.mockRejectedValue(new Error('create failed'));
    await expect(ensureMakeTask({ createOptions, isCurrent: () => true })).rejects.toThrow(
      'create failed',
    );
    expect(h.prepend).not.toHaveBeenCalled();
  });

  it.each(['account', 'view'])(
    'does not return a navigation target after a %s switch during creation',
    async (boundary) => {
      let current = true;
      const pending = deferred<{ id: string }>();
      h.create.mockReturnValue(pending.promise);
      const result = ensureMakeTask({ createOptions, isCurrent: () => current });
      if (boundary === 'account') setDataOwnerGeneration('different-owner');
      else current = false;
      const created = { id: sid() };
      pending.resolve(created);
      expect(await result).toBeNull();
      // An already-created task still belongs in its owner's sidebar, not a new account's.
      if (boundary === 'account') expect(h.prepend).not.toHaveBeenCalled();
      else expect(h.prepend).toHaveBeenCalledWith(created);
      expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
    },
  );
});

describe('personal code task handoff', () => {
  const runId = 'code-ready';
  const request = '  修复滚动\n保留 <b>原文</b>  ';
  function readyCard(extra: Record<string, unknown> = {}) {
    const id = sid();
    makerChatStore.insertSystemCard(id, 'cindy-make', {
      request,
      decision: 'personal',
      report: { ...report(runId), source: { status: 'ready', path: '/source' } },
      ...extra,
    });
    return id;
  }

  it('hands off only after the personal choice; Main owns preparation and first dispatch', async () => {
    const id = sid();
    const workflowRun = startMakeDoctorInStream(id, { command: 'cindy-make', request }, main.api)!;
    main.push(workflowRun, 'running', { upstream: { status: 'searching', items: [] } });
    expect(await chooseMakeUpstream(id, workflowRun, 'personal')).toBeNull();
    expect(h.startTask).not.toHaveBeenCalled();
    await main.complete(workflowRun, {
      source: { status: 'ready', path: '/source' },
      upstream: { status: 'notFound', items: [] },
    });
    const created = await chooseMakeUpstream(id, workflowRun, 'personal');
    expect(created).toBeTruthy();
    expect(h.startTask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ originSessionId: id, runId: workflowRun, request }),
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
    expect(main.api.executeDesktopCommand).toHaveBeenCalledOnce();
    expect(await chooseMakeUpstream(id, workflowRun, 'personal')).toBeNull();
  });

  it('waiting for upstream does not start a task', async () => {
    const id = readyCard({
      decision: undefined,
      report: { ...report(runId), upstream: { status: 'found', items: [] } },
    });
    await chooseMakeUpstream(id, runId, 'wait');
    expect(messages(id)[0].systemCardData?.decision).toBe('wait');
    expect(h.startTask).not.toHaveBeenCalled();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });

  it('hands off historical cards before their missing source is prepared', async () => {
    const id = readyCard({
      decision: undefined,
      report: { ...report(runId), upstream: { status: 'notFound', items: [] } },
    });
    expect(await chooseMakeUpstream(id, runId, 'personal')).toBeTruthy();
    expect(h.startTask).toHaveBeenCalledOnce();
    expect(main.api.executeDesktopCommand).not.toHaveBeenCalled();
  });

  it('coalesces clicks and never replays a persisted task', async () => {
    const id = readyCard();
    const creation = deferred<string>();
    h.startTask.mockReturnValueOnce(creation.promise);
    const first = startMakeCodeSession(id, runId);
    expect(startMakeCodeSession(id, runId)).toBe(first);
    const target = sid();
    creation.resolve(target);
    expect(await first).toBe(target);
    expect(await startMakeCodeSession(id, runId)).toBe(target);
    expect(h.startTask).toHaveBeenCalledOnce();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves the exact request, derives a readable title and keeps title generation disabled', async () => {
    const id = readyCard();
    const target = await startMakeCodeSession(id, runId);
    expect(target).toBeTruthy();
    expect(h.startTask).toHaveBeenCalledWith({
      originSessionId: id,
      runId,
      request,
      title: '[code] 修复滚动 保留 <b>原文</b>',
    });
    expect(makerChatStore.getSnapshot(target!).autoTitleDisabled).toBe(true);
    expect(messages(id)[0].systemCardData?.codeSessionId).toBe(target);
  });

  it('keeps an already-started task navigable when the sidebar refresh fails', async () => {
    const id = readyCard();
    h.get.mockRejectedValueOnce(new Error('refresh failed'));
    const target = await startMakeCodeSession(id, runId);
    expect(target).toBeTruthy();
    expect(messages(id)[0].systemCardData?.codeSessionError).toBe(false);
    expect(h.startTask).toHaveBeenCalledOnce();
  });

  it('allows a failed IPC start to retry without sending from Renderer', async () => {
    const id = readyCard();
    h.startTask.mockRejectedValueOnce(new Error('start failed'));
    expect(await startMakeCodeSession(id, runId)).toBeNull();
    expect(messages(id)[0].systemCardData?.codeSessionError).toBe(true);
    expect(await startMakeCodeSession(id, runId)).toBeTruthy();
    expect(h.startTask).toHaveBeenCalledTimes(2);
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });

  it("does not publish another account's task after an owner switch", async () => {
    const id = readyCard();
    const creation = deferred<string>();
    h.startTask.mockReturnValueOnce(creation.promise);
    const result = startMakeCodeSession(id, runId);
    setDataOwnerGeneration('another-owner');
    creation.resolve(sid());
    expect(await result).toBeNull();
    expect(h.prepend).not.toHaveBeenCalled();
    expect(makerChatStore.sendMessage).not.toHaveBeenCalled();
  });
});
