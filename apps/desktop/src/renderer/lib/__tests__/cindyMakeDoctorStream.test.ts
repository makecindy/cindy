import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

const h = vi.hoisted(() => ({ create: vi.fn(), prepend: vi.fn() }));
vi.mock('@/lib/sessionService', () => ({
  create: h.create,
  get: vi.fn(async () => ({ agentKind: 'cc', remoteHostId: null })),
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { prependCreated: h.prepend } }));
vi.mock('@/lib/messageService', () => ({ create: vi.fn() }));
vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/imageRef', () => ({
  parseUserContent: (text: string) => ({ text, images: [], files: [] }),
}));
vi.mock('@/lib/composerDraftStore', () => ({ setRemoteOptimisticAttachmentUrls: vi.fn() }));
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
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as messageService from '@/lib/messageService';
import {
  chooseMakeUpstream,
  ensureMakeTask,
  startMakeDoctorInStream,
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
    push(runId: string, status: MakeDoctorReport['status'] = 'running') {
      for (const listener of listeners) {
        listener({ command: commands.get(runId)!, doctorReport: report(runId, status) });
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
  setDataOwnerGeneration('doctor-test-owner');
  h.create.mockReset();
  h.prepend.mockClear();
  main = mainApi();
  vi.spyOn(makerChatStore, 'sendMessage');
});
afterEach(async () => {
  setDataOwnerGeneration(null);
  await main.close();
  for (const id of sessionIds.splice(0)) makerChatStore.purgeSession(id);
  vi.restoreAllMocks();
});

describe('doctor cards in the message stream', () => {
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
    chooseMakeUpstream(id, runId, 'personal');
    await main.complete(runId, { upstream });
    expect(messages(id)[0].systemCardData?.decision).toBe('personal');
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
    expect(messageService.create).not.toHaveBeenCalled();
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
    expect(messageService.create).not.toHaveBeenCalled();
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
